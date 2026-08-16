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
// ⚡ IN-MEMORY CACHE ENGINE
// ==========================================
const citizenCache = {
    data: null,      // Array of raw Firestore citizen documents/objects
    timestamp: 0     // Epoch timestamp when cache was set
};

// Cache Time-To-Live in milliseconds (e.g., 30 seconds)
const CACHE_TTL_MS = 30 * 1000;

/**
 * Invalidates the citizen list cache when mutations occur (Create/Update/Delete/Archive/Status Change)
 */
function invalidateCitizenCache() {
    citizenCache.data = null;
    citizenCache.timestamp = 0;
}

// ==========================================
// 🛠️ HELPER FUNCTIONS
// ==========================================

/**
 * Optimized Helper to build active socket UIDs Set once per batch request
 */
const getActiveSocketUidsSet = (io) => {
    const activeUids = new Set();
    try {
        if (!io || !io.sockets || !io.sockets.sockets) return activeUids;
        for (const socket of io.sockets.sockets.values()) {
            if (socket.userData?.uid) {
                activeUids.add(socket.userData.uid);
            }
        }
    } catch (err) {
        console.warn("Error reading active sockets:", err.message);
    }
    return activeUids;
};

/**
 * Helper function to check online status (isActive)
 */
const checkUserOnlineStatus = (authUid, docId, firestoreIsActive = false, activeSocketUidsSet = null) => {
    try {
        const io = socketInit.getIO();
        if (!io) return Boolean(firestoreIsActive);

        // 1. Fast Set lookup if precomputed (Optimized for GET /citizens batch)
        if (activeSocketUidsSet) {
            if ((authUid && activeSocketUidsSet.has(authUid)) || (docId && activeSocketUidsSet.has(docId))) {
                return true;
            }
        } else {
            // Fallback individual lookup
            const connectedSockets = Array.from(io.sockets.sockets.values());
            const isConnectedViaSocket = connectedSockets.some((s) => {
                const sUid = s.userData?.uid;
                return (authUid && sUid === authUid) || (docId && sUid === docId);
            });
            if (isConnectedViaSocket) return true;
        }

        // 2. Fallback check: Socket.IO rooms
        const rooms = io.sockets.adapter.rooms;
        if (rooms) {
            const hasUidRoom = authUid ? (rooms.get(authUid)?.size || 0) > 0 : false;
            const hasDocRoom = docId ? (rooms.get(docId)?.size || 0) > 0 : false;
            if (hasUidRoom || hasDocRoom) return true;
        }

        // 3. Fallback to Firestore stored state
        return Boolean(firestoreIsActive);
    } catch (err) {
        return Boolean(firestoreIsActive);
    }
};

/**
 * Helper function to atomically generate the next CID00000000 sequence
 */
const getNextCitizenID = async (db) => {
    const counterRef = db.collection('counters').doc('citizens');

    return await db.runTransaction(async (transaction) => {
        const counterDoc = await transaction.get(counterRef);
        
        let currentCount = 0;
        if (counterDoc.exists) {
            currentCount = counterDoc.data().currentCount || 0;
        }

        const nextCount = currentCount + 1;
        const formattedID = `CID${String(nextCount).padStart(8, '0')}`;

        transaction.set(counterRef, { currentCount: nextCount }, { merge: true });

        return formattedID;
    });
};

/**
 * Helper function to resolve a document reference by doc.id OR by formatted citizenID
 */
const resolveCitizenDoc = async (db, idOrCitizenID) => {
    const directDocRef = db.collection('citizens').doc(idOrCitizenID);
    const directDoc = await directDocRef.get();

    if (directDoc.exists) {
        return { docRef: directDocRef, doc: directDoc };
    }

    const querySnapshot = await db.collection('citizens')
        .where('citizenID', '==', idOrCitizenID)
        .limit(1)
        .get();

    if (!querySnapshot.empty) {
        const matchedDoc = querySnapshot.docs[0];
        return { docRef: matchedDoc.ref, doc: matchedDoc };
    }

    return { docRef: null, doc: null };
};

// ==========================================
// 📡 ROUTE HANDLERS
// ==========================================

// 📡 READ ALL CITIZENS (WITH CACHING & LIMITS)
router.get('/citizens', async (req, res) => {
    try {
        const db = getFirestore();
        const now = Date.now();
        const parsedLimit = parseInt(req.query.queryLimit, 10) || 100; // Query limit cap to prevent huge reads

        let rawCitizensList = [];

        // Check if cached data exists and is still valid
        if (citizenCache.data && (now - citizenCache.timestamp < CACHE_TTL_MS)) {
            rawCitizensList = citizenCache.data;
        } else {
            const snapshot = await db.collection('citizens').limit(parsedLimit).get();

            rawCitizensList = snapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    ...data,
                    createdAt: data.createdAt && typeof data.createdAt.toDate === 'function' 
                        ? data.createdAt.toDate() 
                        : data.createdAt || null
                };
            });

            // Update cache store
            citizenCache.data = rawCitizensList;
            citizenCache.timestamp = now;
        }

        // Dynamically compute real-time socket online status without hitting Firestore
        let activeSocketUidsSet = new Set();
        try {
            const io = socketInit.getIO();
            activeSocketUidsSet = getActiveSocketUidsSet(io);
        } catch (e) {
            // Socket.IO might not be initialized yet
        }

        const citizensList = rawCitizensList.map(item => {
            const targetUid = item.authUid || item.id;
            const isOnline = checkUserOnlineStatus(targetUid, item.id, item.isActive, activeSocketUidsSet);

            const formattedCitizenID = 
                item.citizenID || 
                item.citizenId || 
                (item.id.startsWith('CID') ? item.id : 'CID00000000');

            return {
                id: item.id, 
                citizenID: formattedCitizenID,
                authUid: item.authUid || item.id,
                fullName: item.fullName || 'No Name Provided',
                email: item.email || 'N/A',
                phoneNumber: item.phoneNumber || 'No Phone Record',
                zone: item.zone || 'Unassigned Sector',
                status: item.status || (item.isDisabled ? 'Disabled' : 'Active'),
                isDisabled: item.isDisabled ?? false,
                isActive: isOnline,
                isArchived: item.isArchived || false,
                dpaAccepted: item.dpaAccepted || false,
                createdVia: item.createdVia || 'Admin Portal',
                createdBy: item.createdBy || 'System Admin',
                createdAt: item.createdAt
            };
        });

        res.setHeader('X-Total-Count', citizensList.length);
        res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');
        
        return res.json(citizensList);
    } catch (err) {
        console.error("Error fetching citizens from Firestore:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📡 READ ONE CITIZEN
router.get('/citizens/:id', async (req, res) => {
    try {
        const db = getFirestore();
        const { doc } = await resolveCitizenDoc(db, req.params.id);

        if (!doc || !doc.exists) {
            return res.status(404).json({ message: 'Citizen record not found' });
        }

        const data = doc.data();
        const targetUid = data.authUid || doc.id;
        const isOnline = checkUserOnlineStatus(targetUid, doc.id, data.isActive);

        const formattedCitizenID = 
            data.citizenID || 
            data.citizenId || 
            (doc.id.startsWith('CID') ? doc.id : 'CID00000000');

        return res.json({ 
            id: doc.id, 
            ...data, 
            citizenID: formattedCitizenID,
            isActive: isOnline
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 📡 CREATE NEW CITIZEN (Using Auth UID as document ID)
router.post('/citizens', async (req, res) => {
    const auth = getAuth();
    const db = getFirestore();
    let userRecord = null;

    try {
        const { email, password, fullName, phoneNumber, zone, isDisabled = false } = req.body;

        if (!email || !password || !fullName) {
            return res.status(400).json({ error: 'Missing required fields: email, password, and fullName.' });
        }

        userRecord = await auth.createUser({
            email,
            password,
            displayName: fullName,
            disabled: Boolean(isDisabled)
        });

        // Set document ID directly to userRecord.uid for fast client lookups
        const documentId = userRecord.uid;
        const citizenID = await getNextCitizenID(db);

        const citizenData = {
            citizenID,
            citizenId: citizenID,
            authUid: userRecord.uid,
            fullName,
            email,
            phoneNumber: phoneNumber || 'No Phone Record',
            zone: zone || 'Global / Unassigned',
            status: isDisabled ? 'Disabled' : 'Active',
            isDisabled: Boolean(isDisabled),
            isActive: false,
            isArchived: false,
            dpaAccepted: true,
            createdVia: 'Admin Portal',
            createdBy: req.user?.email || req.user?.uid || 'Admin',
            createdAt: FieldValue.serverTimestamp()
        };

        await db.collection('citizens').doc(documentId).set(citizenData);

        // Invalidate cache so GET /citizens pulls newly created records
        invalidateCitizenCache();

        // ⚡ Real-Time Socket Broadcast
        try {
            const io = socketInit.getIO();
            if (io) {
                io.to('admins').emit('citizen_created', { id: documentId, isActive: false, ...citizenData });
            }
        } catch (socketErr) {
            console.warn("Socket broadcast skipped:", socketErr.message);
        }

        return res.status(201).json({ id: documentId, isActive: false, ...citizenData, success: true });
    } catch (err) {
        console.error("Error creating citizen:", err);

        if (userRecord && userRecord.uid) {
            try {
                await auth.deleteUser(userRecord.uid);
            } catch (cleanupErr) {
                console.error("Failed to cleanup auth user during rollback:", cleanupErr);
            }
        }

        return res.status(400).json({ error: err.message });
    }
});

// ✉️ DISPATCH EMAIL VERIFICATION LINK (To target new email)
router.post('/citizens/:uid/send-verification-email', async (req, res) => {
    try {
        const { uid } = req.params;
        const { newEmail } = req.body;
        const auth = getAuth();
        const db = getFirestore();

        // 🔒 Verify requester is updating their own profile or is admin
        if (req.user.uid !== uid && !req.user.admin) {
            return res.status(403).json({ error: 'Unauthorized to modify this user account.' });
        }

        if (!newEmail || !newEmail.includes('@')) {
            return res.status(400).json({ error: 'A valid target email address is required.' });
        }

        const user = await auth.getUser(uid);
        if (user.email === newEmail) {
            return res.status(400).json({ error: 'New email address must be different from current email.' });
        }

        // Generate the secure link for updating/verifying email
        const actionCodeSettings = {
            url: process.env.FIREBASE_CONTINUE_URL || 'https://your-app-domain.com/login',
            handleCodeInApp: true,
        };

        const link = await auth.generateEmailVerificationLink(newEmail, actionCodeSettings);

        // Store pending email verification state in Firestore
        const { docRef } = await resolveCitizenDoc(db, uid);
        const targetRef = docRef || db.collection('citizens').doc(uid);

        await targetRef.set({
            pendingEmail: newEmail,
            emailVerificationSentAt: FieldValue.serverTimestamp(),
            updatedBy: req.user?.email || req.user?.uid || 'User'
        }, { merge: true });

        // Invalidate cache since user state changed
        invalidateCitizenCache();

        console.log(`✉️ Email verification link generated for ${newEmail}: ${link}`);

        return res.json({
            success: true,
            message: 'Verification email generated successfully. Check recipient inbox/spam.',
            link // Included for testing/sending via custom nodemailer transport
        });
    } catch (err) {
        console.error("Verification Email Generation Error:", err);
        return res.status(400).json({ error: err.message || 'Failed to dispatch verification email.' });
    }
});

// 🔄 COMPATIBILITY ROUTER FOR EMAIL UPDATES
router.put('/citizens/:uid/update-email', async (req, res) => {
    return res.status(400).json({
        error: 'Direct email overwrite disabled. Please use client-side Flutter verifyBeforeUpdateEmail() or /citizens/:uid/send-verification-email to confirm via email link.'
    });
});

// 📡 TOGGLE CITIZEN ACCOUNT STATUS (PATCH)
router.patch('/citizens/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { isDisabled, status, actionTag } = req.body;
        const auth = getAuth();
        const db = getFirestore();

        const { docRef, doc } = await resolveCitizenDoc(db, id);

        if (!doc || !doc.exists) {
            return res.status(404).json({ error: `Citizen ${id} not found in database.` });
        }

        const citizenData = doc.data();
        const citizenID = citizenData.citizenID || citizenData.citizenId || id;

        const targetIsDisabled = typeof isDisabled === 'boolean' 
            ? isDisabled 
            : !citizenData.isDisabled;
        
        const targetStatus = status || (targetIsDisabled ? 'Disabled' : 'Active');
        const logTag = actionTag || (targetIsDisabled ? `ADMIN_DISABLE_${citizenID}` : `ADMIN_ENABLE_${citizenID}`);

        const targetAuthUid = citizenData.authUid || doc.id;
        if (targetAuthUid) {
            try {
                await auth.updateUser(targetAuthUid, { disabled: targetIsDisabled });
                if (targetIsDisabled) {
                    await auth.revokeRefreshTokens(targetAuthUid);
                }
            } catch (authErr) {
                console.error(`Firebase Auth sync failed for UID ${targetAuthUid}:`, authErr);
            }
        }

        const updatePayload = {
            isDisabled: targetIsDisabled,
            status: targetStatus,
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: req.user?.email || req.user?.uid || 'Admin'
        };

        await docRef.update(updatePayload);

        // Invalidate cached citizen list
        invalidateCitizenCache();

        const isOnline = checkUserOnlineStatus(targetAuthUid, doc.id, citizenData.isActive);

        // ⚡ Real-time socket updates
        try {
            const io = socketInit.getIO();
            if (io) {
                io.to('admins').emit('citizen_status_updated', {
                    id: doc.id,
                    citizenID,
                    actionTag: logTag,
                    isActive: isOnline,
                    ...updatePayload
                });

                if (targetIsDisabled && targetAuthUid) {
                    const socketPayload = {
                        uid: targetAuthUid,
                        isDisabled: true,
                        status: targetStatus,
                        message: 'Your account has been disabled by an administrator.'
                    };

                    // 🔒 Emit strictly to user's targeted room
                    io.to(targetAuthUid).emit('account:disabled', socketPayload);
                }
            }
        } catch (socketErr) {
            console.warn("Socket emission skipped:", socketErr.message);
        }

        return res.json({
            id: doc.id,
            citizenID,
            isDisabled: targetIsDisabled,
            status: targetStatus,
            actionTag: logTag,
            isActive: isOnline,
            success: true,
            message: `Citizen account ${targetIsDisabled ? 'disabled' : 'enabled'} successfully.`
        });
    } catch (err) {
        console.error("Status Patch Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📡 UPDATE CITIZEN (PUT)
router.put('/citizens/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { email, password, fullName, phoneNumber, zone, status, isDisabled } = req.body;
        const auth = getAuth();
        const db = getFirestore();

        // 1. Find document reference
        const { docRef, doc } = await resolveCitizenDoc(db, id);

        if (!doc || !doc.exists) {
            return res.status(404).json({ error: 'Citizen record not found in Firestore.' });
        }

        const citizenData = doc.data();
        const targetAuthUid = citizenData.authUid || doc.id;

        // 2. Direct Update to Firebase Auth
        if (targetAuthUid) {
            const authUpdate = {};
            if (email) authUpdate.email = email;
            if (fullName) authUpdate.displayName = fullName;
            if (password && password.length >= 6) authUpdate.password = password;
            if (typeof isDisabled === 'boolean') authUpdate.disabled = isDisabled;

            if (Object.keys(authUpdate).length > 0) {
                await auth.updateUser(targetAuthUid, authUpdate);
            }
        }

        // 3. Direct Update to Firestore Collection (`citizens`)
        const firestoreUpdate = {
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: req.user?.email || req.user?.uid || 'Admin'
        };

        // Explicitly map passed fields to prevent silent skips
        if (email !== undefined) firestoreUpdate.email = email;
        if (fullName !== undefined) firestoreUpdate.fullName = fullName;
        if (phoneNumber !== undefined) firestoreUpdate.phoneNumber = phoneNumber;
        if (zone !== undefined) firestoreUpdate.zone = zone;
        if (status !== undefined) firestoreUpdate.status = status;
        if (typeof isDisabled === 'boolean') {
            firestoreUpdate.isDisabled = isDisabled;
            firestoreUpdate.status = status || (isDisabled ? 'Disabled' : 'Active');
        }

        // Save directly to Firestore document
        await docRef.update(firestoreUpdate);

        // Invalidate cache so updated citizen records reflect on next list fetch
        invalidateCitizenCache();

        // 4. Real-time Socket Broadcasts
        try {
            const io = socketInit.getIO();
            if (io) {
                const payload = { id: doc.id, uid: targetAuthUid, ...firestoreUpdate };

                io.to('admins').emit('citizen_updated', payload);
                if (targetAuthUid) {
                    io.to(targetAuthUid).emit('citizen_updated', payload);
                    io.to(targetAuthUid).emit('profile_updated', payload);
                }
            }
        } catch (socketErr) {
            console.warn("Socket broadcast skipped:", socketErr.message);
        }

        return res.json({ 
            id: doc.id, 
            success: true, 
            message: 'Updated successfully in both Auth and Firestore.' 
        });

    } catch (err) {
        console.error("Update Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📡 DELETE CITIZEN
router.delete('/citizens/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const db = getFirestore();
        const auth = getAuth();
        const { docRef, doc } = await resolveCitizenDoc(db, id);
        
        if (!doc || !doc.exists) {
            return res.status(404).json({ message: 'Citizen target missing match' });
        }

        const data = doc.data();
        await docRef.delete();

        // Invalidate cache
        invalidateCitizenCache();

        const targetAuthUid = data.authUid || doc.id;
        if (targetAuthUid) {
            try {
                await auth.deleteUser(targetAuthUid);
            } catch (authErr) {
                console.warn(`Auth user delete skipped for UID ${targetAuthUid}:`, authErr.message);
            }
        }

        try {
            const io = socketInit.getIO();
            if (io) {
                io.to('admins').emit('citizen_deleted', { id: doc.id });
            }
        } catch (socketErr) {
            console.warn("Socket broadcast skipped:", socketErr.message);
        }

        return res.json({ id: doc.id, success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 📦 ARCHIVE CITIZEN
router.post('/citizens/:id/archive', async (req, res) => {
    try {
        const { id } = req.params;
        const db = getFirestore();
        const auth = getAuth();

        const { docRef: citizenRef, doc } = await resolveCitizenDoc(db, id);

        if (!doc || !doc.exists) {
            return res.status(404).json({ error: 'Citizen not found in active registry' });
        }

        const data = doc.data();
        const targetAuthUid = data.authUid || doc.id;

        if (targetAuthUid) {
            try {
                await auth.updateUser(targetAuthUid, { disabled: true });
                await auth.revokeRefreshTokens(targetAuthUid);
            } catch (authErr) {
                console.warn(`⚠️ [AUTH WARNING] Could not lock Auth UID ${targetAuthUid}:`, authErr.message);
            }
        }

        const archiveRef = db.collection('archived_citizens').doc(doc.id);
        const batch = db.batch();

        batch.set(archiveRef, {
            ...data,
            status: 'Archived',
            isDisabled: true,
            isArchived: true,
            archivedAt: FieldValue.serverTimestamp(),
            archivedBy: req.user?.email || req.user?.uid || 'Admin',
            originalCollection: 'citizens'
        });
        
        batch.delete(citizenRef);

        await batch.commit();

        // Invalidate active citizens cache
        invalidateCitizenCache();

        try {
            const io = socketInit.getIO();
            if (io) {
                io.to('admins').emit('citizen_archived', { id: doc.id, citizenID: data.citizenID || id });

                if (targetAuthUid) {
                    const socketPayload = {
                        uid: targetAuthUid,
                        isArchived: true,
                        isDisabled: true,
                        status: 'Archived',
                        message: 'Your account has been archived. You have been signed out.'
                    };

                    // 🔒 Emit strictly to user's targeted room
                    io.to(targetAuthUid).emit('account:disabled', socketPayload);
                }
            }
        } catch (socketErr) {
            console.warn("Socket broadcast skipped:", socketErr.message);
        }

        return res.json({ id: doc.id, success: true, message: 'Citizen archived and Firebase Auth access locked out successfully.' });
    } catch (err) {
        console.error("Archive Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;