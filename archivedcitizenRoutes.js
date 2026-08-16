const express = require('express');
const router = express.Router();
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const socketInit = require('./socket');

// Firebase Auth Middleware
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

// 🔒 Secure all archived citizen endpoints
router.use(verifyToken);

// Enhanced resolver supporting all ID case variations (id, citizenID, citizenId, cid)
const resolveArchivedDoc = async (db, idOrCitizenID) => {
    const archiveCollections = ['archived_citizens', 'archived_admin_citizens'];

    for (const collName of archiveCollections) {
        // 1. Check direct document ID lookup
        const directDocRef = db.collection(collName).doc(idOrCitizenID);
        const directDoc = await directDocRef.get();

        if (directDoc.exists) {
            return { docRef: directDocRef, doc: directDoc, collectionName: collName };
        }

        // 2. Query fallback for citizenID variations
        for (const fieldName of ['citizenID', 'citizenId', 'cid', 'id']) {
            const querySnapshot = await db.collection(collName)
                .where(fieldName, '==', idOrCitizenID)
                .limit(1)
                .get();

            if (!querySnapshot.empty) {
                const matchedDoc = querySnapshot.docs[0];
                return { docRef: matchedDoc.ref, doc: matchedDoc, collectionName: collName };
            }
        }
    }

    return { docRef: null, doc: null, collectionName: null };
};

// 📡 READ ALL ARCHIVED CITIZENS
router.get('/archived', async (req, res) => {
    try {
        const db = getFirestore();
        
        const [citizensSnapshot, adminCitizensSnapshot] = await Promise.all([
            db.collection('archived_citizens').get(),
            db.collection('archived_admin_citizens').get()
        ]);

        const parseDocData = (doc, defaultCollection) => {
            const data = doc.data();
            return {
                id: doc.id,
                citizenID: data.citizenID || data.citizenId || data.cid || doc.id,
                authUid: data.authUid || data.uid || null, // Normalizing Auth UID
                fullName: data.fullName || 'No Name Provided',
                email: data.email || 'N/A',
                phoneNumber: data.phoneNumber || 'No Phone Record',
                zone: data.zone || 'Unassigned Sector',
                status: 'Archived',
                isDisabled: data.isDisabled ?? true,
                isActive: false,
                isArchived: true,
                originalCollection: data.originalCollection || defaultCollection,
                archivedBy: data.archivedBy || 'System Admin',
                archivedAt: data.archivedAt && typeof data.archivedAt.toDate === 'function'
                    ? data.archivedAt.toDate()
                    : null,
                createdAt: data.createdAt && typeof data.createdAt.toDate === 'function'
                    ? data.createdAt.toDate()
                    : null
            };
        };

        const archivedList = [
            ...citizensSnapshot.docs.map(doc => parseDocData(doc, 'citizens')),
            ...adminCitizensSnapshot.docs.map(doc => parseDocData(doc, 'admin_citizens'))
        ];

        res.setHeader('X-Total-Count', archivedList.length);
        res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');

        return res.json(archivedList);
    } catch (err) {
        console.error("Error fetching archived citizens:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📡 READ ONE ARCHIVED CITIZEN
router.get('/archived/:id', async (req, res) => {
    try {
        const db = getFirestore();
        const { doc, collectionName } = await resolveArchivedDoc(db, req.params.id);

        if (!doc || !doc.exists) {
            return res.status(404).json({ message: 'Archived record not found' });
        }

        const data = doc.data();
        return res.json({
            id: doc.id,
            ...data,
            authUid: data.authUid || data.uid || null,
            isActive: false,
            isArchived: true,
            archiveVault: collectionName
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 🔄 RESTORE CITIZEN RECORD
router.post('/:id/restore', async (req, res) => {
    try {
        const { id } = req.params;
        const { actionTag, forceEnable = true } = req.body || {}; // Default forceEnable to true
        const db = getFirestore();
        const auth = getAuth();

        const { docRef: archivedRef, doc, collectionName } = await resolveArchivedDoc(db, id);

        if (!doc || !doc.exists) {
            return res.status(404).json({ error: `Archived citizen record ${id} not found.` });
        }

        const data = doc.data();
        const citizenID = data.citizenID || data.citizenId || data.cid || id;
        const targetAuthUid = data.authUid || data.uid || null;

        const targetCollection = data.originalCollection || (collectionName === 'archived_admin_citizens' ? 'admin_citizens' : 'citizens');
        const activeRef = db.collection(targetCollection).doc(doc.id);

        const logTag = actionTag || `ADMIN_RESTORE_${citizenID}`;

        // 🟢 FIX: Set account to enabled (isDisabled = false) upon restore
        const isTargetDisabled = forceEnable ? false : Boolean(data.isDisabled);
        const restoredStatus = isTargetDisabled ? 'Disabled' : 'Active';

        if (targetAuthUid) {
            try {
                // Re-enable the user in Firebase Auth
                await auth.updateUser(targetAuthUid, { disabled: isTargetDisabled });
            } catch (authErr) {
                console.warn(`⚠️ [AUTH WARNING] Failed to sync Firebase Auth user status for UID ${targetAuthUid}:`, authErr.message);
            }
        }

        const restoredData = { ...data };
        delete restoredData.archivedAt;
        delete restoredData.archivedBy;
        delete restoredData.originalCollection;

        restoredData.status = restoredStatus;
        restoredData.isDisabled = isTargetDisabled;
        restoredData.isArchived = false;
        restoredData.restoredAt = FieldValue.serverTimestamp();
        restoredData.restoredBy = req.user?.email || req.user?.uid || 'Admin';

        const batch = db.batch();
        batch.set(activeRef, restoredData);
        batch.delete(archivedRef);

        await batch.commit();

        try {
            const io = socketInit.getIO();

            io.to('admins').emit('citizen_restored', {
                id: doc.id,
                citizenID,
                actionTag: logTag,
                targetCollection,
                ...restoredData
            });

            const eventName = targetCollection === 'admin_citizens' ? 'admin_citizen_updated' : 'citizen_updated';
            io.to('admins').emit(eventName, {
                id: doc.id,
                citizenID,
                status: restoredStatus,
                isDisabled: isTargetDisabled,
                isArchived: false
            });
        } catch (socketErr) {
            console.warn("Socket broadcast skipped:", socketErr.message);
        }

        return res.json({
            id: doc.id,
            citizenID,
            actionTag: logTag,
            targetCollection,
            status: restoredStatus,
            isDisabled: isTargetDisabled,
            success: true,
            message: `Citizen record successfully restored to ${targetCollection}.`
        });
    } catch (err) {
        console.error("Restore Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 🗑️ PERMANENTLY DELETE ARCHIVED CITIZEN
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { actionTag } = req.body || {};
        const db = getFirestore();
        const auth = getAuth();

        const { docRef: archivedRef, doc } = await resolveArchivedDoc(db, id);

        if (!doc || !doc.exists) {
            return res.status(404).json({ error: `Archived record ${id} not found.` });
        }

        const data = doc.data();
        const citizenID = data.citizenID || data.citizenId || data.cid || id;
        const targetAuthUid = data.authUid || data.uid || null; // Normalizing Auth UID
        const logTag = actionTag || `ADMIN_DELETE_PERMANENT_${citizenID}`;

        if (targetAuthUid) {
            try {
                await auth.deleteUser(targetAuthUid);
            } catch (authErr) {
                // If user was already deleted from Auth, continue deleting from Firestore
                console.warn(`⚠️ [AUTH WARNING] Could not delete Auth UID ${targetAuthUid}:`, authErr.message);
            }
        }

        await archivedRef.delete();

        try {
            const io = socketInit.getIO();
            io.to('admins').emit('citizen_permanently_deleted', {
                id: doc.id,
                citizenID,
                actionTag: logTag
            });
        } catch (socketErr) {
            console.warn("Socket broadcast skipped:", socketErr.message);
        }

        return res.json({
            id: doc.id,
            citizenID,
            actionTag: logTag,
            success: true,
            message: 'Record permanently deleted from Firestore archive and Firebase Authentication.'
        });
    } catch (err) {
        console.error("Permanent Delete Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;