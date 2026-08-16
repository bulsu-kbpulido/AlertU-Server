const express = require('express');
const router = express.Router();
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const socketInit = require('./socket'); // Socket engine reference

// ==========================================
// 🔒 FIREBASE AUTHENTICATION MIDDLEWARE
// ==========================================
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Unauthorized: Missing token' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await getAuth().verifyIdToken(idToken);
        req.user = decodedToken; 
        next();
    } catch (error) {
        console.error('Token verification failed:', error);
        return res.status(403).json({ message: 'Unauthorized: Invalid token' });
    }
};

// Protect all router endpoints
router.use(verifyToken);

// ==========================================
// 🛠️ HELPER FUNCTIONS
// ==========================================

/**
 * Helper function to atomically generate the next RID00000000 sequence
 */
const getNextReportID = async (db) => {
    const counterRef = db.collection('counters').doc('reports');

    return await db.runTransaction(async (transaction) => {
        const counterDoc = await transaction.get(counterRef);
        
        let currentCount = 0;
        if (counterDoc.exists) {
            currentCount = counterDoc.data().currentCount || 0;
        }

        const nextCount = currentCount + 1;
        const formattedID = `RID${String(nextCount).padStart(8, '0')}`;

        transaction.set(counterRef, { currentCount: nextCount }, { merge: true });

        return formattedID;
    });
};

/**
 * Helper to resolve citizen details (CID or UID) to ensure accurate metadata
 */
const getCitizenProfile = async (db, uidOrCitizenID) => {
    // Check by doc ID or authUid first
    let docRef = db.collection('citizens').doc(uidOrCitizenID);
    let doc = await docRef.get();

    if (doc.exists) {
        return { citizenDocId: doc.id, ...doc.data() };
    }

    // Fallback: Query by citizenID (e.g., CID00000006)
    const snapshot = await db.collection('citizens')
        .where('citizenID', '==', uidOrCitizenID)
        .limit(1)
        .get();

    if (!snapshot.empty) {
        const matched = snapshot.docs[0];
        return { citizenDocId: matched.id, ...matched.data() };
    }

    return null;
};

/**
 * Helper to check if caller is an Admin or reading their own data
 */
const isAuthorizedUserOrAdmin = (req, targetUid, targetCitizenID) => {
    if (req.user?.admin || req.user?.role === 'admin') return true;
    if (req.user?.uid === targetUid) return true;
    if (targetCitizenID && req.user?.citizenID === targetCitizenID) return true;
    return false;
};

// ==========================================
// 📡 ROUTE HANDLERS
// ==========================================

// 📡 GET CURRENT LOGGED-IN CITIZEN'S OWN REPORTS
// Endpoint: GET /api/citizen-reports/my-reports
router.get('/my-reports', async (req, res) => {
    try {
        const db = getFirestore();
        const userUid = req.user.uid;

        // Retrieve citizen profile to get their CID (e.g., CID00000006)
        const profile = await getCitizenProfile(db, userUid);
        const citizenID = profile?.citizenID || profile?.citizenId || null;

        // Perform parallel queries to catch reports tagged with either authUid or citizenID
        const reportsRef = db.collection('reports');
        const [uidQuery, cidQuery] = await Promise.all([
            reportsRef.where('authUid', '==', userUid).get(),
            citizenID ? reportsRef.where('citizenID', '==', citizenID).get() : Promise.resolve({ docs: [] })
        ]);

        // Merge and deduplicate results by document ID
        const reportsMap = new Map();

        [...uidQuery.docs, ...cidQuery.docs].forEach(doc => {
            if (!reportsMap.has(doc.id)) {
                const data = doc.data();
                reportsMap.set(doc.id, {
                    id: doc.id,
                    reportID: data.reportID || data.reportId || doc.id,
                    citizenID: data.citizenID || citizenID || 'CID00000000',
                    submitterName: data.submitterName || profile?.fullName || 'Anonymous Submitter',
                    submitterPhone: data.submitterPhone || profile?.phoneNumber || 'N/A',
                    submitterEmail: data.submitterEmail || profile?.email || req.user.email || 'N/A',
                    hazard: data.hazard || data.incidentType || 'Unspecified Hazard',
                    verifiedIncidentType: data.verifiedIncidentType || data.hazard || 'Pending Assessment',
                    severity: data.severity || 'Medium',
                    status: data.status || 'Pending',
                    location: data.location || { address: 'Location details unavailable', latitude: 0, longitude: 0 },
                    mediaUrl: data.mediaUrl || null,
                    voicenoteUrl: data.voicenoteUrl || null,
                    isSensitive: Boolean(data.isSensitive),
                    createdAt: data.createdAt && typeof data.createdAt.toDate === 'function' ? data.createdAt.toDate() : data.createdAt
                });
            }
        });

        const reportList = Array.from(reportsMap.values()).sort((a, b) => {
            return (new Date(b.createdAt) || 0) - (new Date(a.createdAt) || 0);
        });

        res.setHeader('X-Total-Count', reportList.length);
        res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');

        return res.json(reportList);
    } catch (err) {
        console.error("Error fetching citizen's own reports:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📡 GET REPORTS BY SPECIFIC CITIZEN ID OR UID (Admin / Specific Citizen Lookup)
// Endpoint: GET /api/citizen-reports/citizen/:identifier
router.get('/citizen/:identifier', async (req, res) => {
    try {
        const { identifier } = req.params; // Can be CID00000006 or Auth UID
        const db = getFirestore();

        const profile = await getCitizenProfile(db, identifier);
        const targetUid = profile?.authUid || (identifier.startsWith('CID') ? null : identifier);
        const targetCitizenID = profile?.citizenID || (identifier.startsWith('CID') ? identifier : null);

        // Security check
        if (!isAuthorizedUserOrAdmin(req, targetUid, targetCitizenID)) {
            return res.status(403).json({ error: 'Forbidden: You cannot access reports for another citizen.' });
        }

        const reportsRef = db.collection('reports');
        const queries = [];

        if (targetUid) queries.push(reportsRef.where('authUid', '==', targetUid).get());
        if (targetCitizenID) queries.push(reportsRef.where('citizenID', '==', targetCitizenID).get());

        const querySnapshots = await Promise.all(queries);
        const reportsMap = new Map();

        querySnapshots.forEach(snapshot => {
            snapshot.docs.forEach(doc => {
                if (!reportsMap.has(doc.id)) {
                    const data = doc.data();
                    reportsMap.set(doc.id, {
                        id: doc.id,
                        reportID: data.reportID || data.reportId || doc.id,
                        citizenID: data.citizenID || targetCitizenID || 'CID00000000',
                        authUid: data.authUid || targetUid,
                        submitterName: data.submitterName || profile?.fullName || 'Anonymous',
                        hazard: data.hazard || data.incidentType || 'General Emergency',
                        status: data.status || 'Pending',
                        location: data.location || {},
                        createdAt: data.createdAt && typeof data.createdAt.toDate === 'function' ? data.createdAt.toDate() : data.createdAt,
                        ...data
                    });
                }
            });
        });

        const results = Array.from(reportsMap.values());
        res.setHeader('X-Total-Count', results.length);
        return res.json(results);
    } catch (err) {
        console.error("Error fetching citizen reports by identifier:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📡 CREATE A NEW REPORT LINKED TO THE AUTHENTICATED CITIZEN
// Endpoint: POST /api/citizen-reports
router.post('/', async (req, res) => {
    try {
        const db = getFirestore();
        const userUid = req.user.uid;

        // Resolve submitter's profile (e.g., CID00000006, Juan)
        const profile = await getCitizenProfile(db, userUid);
        const citizenID = profile?.citizenID || profile?.citizenId || 'CID00000000';
        const submitterName = profile?.fullName || req.user.name || 'Juan Citizen';

        // Auto-generate sequentially formatted RID (e.g. RID00000009)
        const reportID = await getNextReportID(db);

        const {
            hazard,
            incidentType,
            description,
            latitude,
            longitude,
            address,
            mediaUrl,
            voicenoteUrl,
            isSensitive = false
        } = req.body;

        if (!hazard && !incidentType) {
            return res.status(400).json({ error: 'Missing required incident category or hazard details.' });
        }

        const reportPayload = {
            reportID,
            reportId: reportID,
            citizenID,                   // e.g., CID00000006
            authUid: userUid,            // Firebase Auth UID
            submitterName,               // e.g., Juan
            submitterEmail: profile?.email || req.user.email || 'N/A',
            submitterPhone: profile?.phoneNumber || 'N/A',
            hazard: hazard || incidentType,
            incidentType: incidentType || hazard,
            verifiedIncidentType: hazard || incidentType,
            description: description || 'No detailed description provided.',
            status: 'Pending',
            severity: 'Medium',
            verifiedSeverity: 'Medium',
            isSensitive: Boolean(isSensitive),
            mediaUrl: mediaUrl || null,
            voicenoteUrl: voicenoteUrl || null,
            location: {
                latitude: Number(latitude) || 0,
                longitude: Number(longitude) || 0,
                address: address || 'Unspecified location address'
            },
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        };

        const trackingPayload = {
            ReportId: reportID,
            reportID,
            CID: citizenID,
            citizenID,
            authUid: userUid,
            submitterName,
            incidentType: incidentType || hazard,
            status: 'Pending',
            createdAt: FieldValue.serverTimestamp()
        };

        // 🔄 Atomic Batch Write: Write to both 'reports' and 'citizenreporttracking'
        const batch = db.batch();

        // 1️⃣ Document in 'reports' collection
        const reportRef = db.collection('reports').doc(reportID);
        batch.set(reportRef, reportPayload);

        // 2️⃣ Document in 'citizenreporttracking' collection
        const trackingRef = db.collection('citizenreporttracking').doc(reportID);
        batch.set(trackingRef, trackingPayload);

        await batch.commit();

        // ⚡ Emit Real-Time Socket Broadcasts to Admins & Targeted Citizen
        try {
            const io = socketInit.getIO();

            const eventData = {
                id: reportID,
                ...reportPayload,
                createdAt: new Date()
            };

            // Broadcast to Admin Monitoring Rooms
            io.to('admins').emit('report_created', eventData);

            // Emit to citizen's room using both Auth UID and CID
            if (userUid) {
                io.to(userUid).emit('my_report_created', eventData);
            }
            if (citizenID && citizenID !== 'CID00000000') {
                io.to(citizenID).emit('my_report_created', eventData);
            }
        } catch (socketErr) {
            console.warn("Socket broadcast skipped:", socketErr.message);
        }

        return res.status(201).json({
            success: true,
            message: `Report ${reportID} successfully created for Citizen ${citizenID} (${submitterName}).`,
            report: {
                id: reportID,
                ...reportPayload,
                createdAt: new Date()
            }
        });

    } catch (err) {
        console.error("Error creating report:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📡 GET SINGLE REPORT DETAILS BY REPORT ID (e.g. RID00000009)
// Endpoint: GET /api/citizen-reports/:reportId
router.get('/:reportId', async (req, res) => {
    try {
        const { reportId } = req.params;
        const db = getFirestore();

        let docRef = db.collection('reports').doc(reportId);
        let doc = await docRef.get();

        if (!doc.exists) {
            // Fallback query if stored under different key
            const snapshot = await db.collection('reports')
                .where('reportID', '==', reportId)
                .limit(1)
                .get();

            if (!snapshot.empty) {
                doc = snapshot.docs[0];
            } else {
                return res.status(404).json({ error: `Report ${reportId} not found.` });
            }
        }

        const data = doc.data();

        // Security Authorization Check
        if (!isAuthorizedUserOrAdmin(req, data.authUid, data.citizenID)) {
            return res.status(403).json({ error: 'Unauthorized: You do not have access to view this report.' });
        }

        return res.json({
            id: doc.id,
            reportID: data.reportID || doc.id,
            ...data,
            createdAt: data.createdAt && typeof data.createdAt.toDate === 'function' ? data.createdAt.toDate() : data.createdAt
        });
    } catch (err) {
        console.error("Error fetching single report:", err);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;