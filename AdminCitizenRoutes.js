const express = require('express');
const router = express.Router();
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const socketInit = require('./socket'); // Socket engine reference

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

// Protect all citizen endpoints
router.use(verifyToken);

/**
 * Optimized Helper: Builds a Set of active UIDs once per GET /citizens request
 */
const getActiveSocketUidsSet = (io) => {
    const activeUids = new Set();
    try {
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
        const hasUidRoom = authUid ? (rooms.get(authUid)?.size || 0) > 0 : false;
        const hasDocRoom = docId ? (rooms.get(docId)?.size || 0) > 0 : false;

        if (hasUidRoom || hasDocRoom) return true;

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
 * Helper function to resolve a document reference by doc.id OR by formatted citizenID in the 'citizens' collection
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

// 📡 READ ALL CITIZENS
router.get('/citizens', async (req, res) => {
    try {
        const db = getFirestore();
        const snapshot = await db.collection('citizens').get();

        let activeSocketUidsSet = new Set();
        try {
            const io = socketInit.getIO();
            activeSocketUidsSet = getActiveSocketUidsSet(io);
        } catch (e) {
            // Socket IO might not be ready
        }
        
        const citizensList = snapshot.docs.map(doc => {
            const data = doc.data();
            const targetUid = data.authUid || doc.id;
            const isOnline = checkUserOnlineStatus(targetUid, doc.id, data.isActive, activeSocketUidsSet);

            const formattedCitizenID = 
                data.citizenID || 
                data.citizenId || 
                (doc.id.startsWith('CID') ? doc.id : 'CID00000000');

            return {
                id: doc.id,
                citizenID: formattedCitizenID,
                authUid: data.authUid || doc.id,
                fullName: data.fullName || 'No Name Provided',
                email: data.email || 'N/A',
                phoneNumber: data.phoneNumber || 'No Phone Record',
                zone: data.zone || 'Unassigned Sector',
                status: data.status || (data.isDisabled ? 'Disabled' : 'Active'),
                isDisabled: data.isDisabled ?? false,
                isActive: isOnline,
                isArchived: data.isArchived || false,
                createdVia: data.createdVia || 'Admin Portal',
                createdBy: data.createdBy || 'System Admin',
                createdAt: data.createdAt && typeof data.createdAt.toDate === 'function' 
                    ? data.createdAt.toDate() 
                    : null
            };
        });

        res.setHeader('X-Total-Count', citizensList.length);
        res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');
        
        return res.json(citizensList);
    } catch (err) {
        console.error("Error fetching citizens:", err);
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

// 📡 CREATE NEW CITIZEN (Matching document ID to Auth UID)
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

        // Use Auth UID directly as the document ID for seamless client lookups
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
            createdBy: req.user.email || req.user.uid || 'Admin',
            createdAt: FieldValue.serverTimestamp()
        };

        await db.collection('citizens').doc(documentId).set(citizenData);

        try {
            const io = socketInit.getIO();
            io.to('admins').emit('citizen_created', { id: documentId, isActive: false, ...citizenData });
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
                console.error("Failed to rollback auth user during error handling:", cleanupErr);
            }
        }

        return res.status(400).json({ error: err.message });
    }
});

// 📡 TOGGLE ACCOUNT STATUS
router.patch('/citizens/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { isDisabled, status, actionTag } = req.body;
        const auth = getAuth();
        const db = getFirestore();

        const { docRef, doc } = await resolveCitizenDoc(db, id);

        if (!doc || !doc.exists) {
            return res.status(404).json({ error: `Citizen ${id} not found.` });
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
            updatedBy: req.user.email || req.user.uid || 'Admin'
        };

        await docRef.update(updatePayload);

        const isOnline = checkUserOnlineStatus(targetAuthUid, doc.id, citizenData.isActive);

        try {
            const io = socketInit.getIO();

            io.to('admins').emit('citizen_status_updated', { 
                id: doc.id, 
                citizenID,
                actionTag: logTag,
                isActive: isOnline,
                ...updatePayload 
            });

            if (targetIsDisabled && targetAuthUid) {
                const clientPayload = {
                    uid: targetAuthUid,
                    isDisabled: true,
                    status: targetStatus,
                    message: 'Your account was turned off by an admin.'
                };

                io.to(targetAuthUid).emit('account:disabled', clientPayload);
            }
        } catch (socketErr) {
            console.warn("Socket broadcast skipped:", socketErr.message);
        }

        return res.json({
            id: doc.id,
            citizenID,
            isDisabled: targetIsDisabled,
            status: targetStatus,
            actionTag: logTag,
            isActive: isOnline,
            success: true,
            message: `Account state set to ${targetStatus}`
        });
    } catch (err) {
        console.error("Status Patch Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📡 UPDATE CITIZEN
router.put('/citizens/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { email, password, fullName, phoneNumber, zone, status, isDisabled } = req.body;
        const auth = getAuth();
        const db = getFirestore();

        const { docRef, doc } = await resolveCitizenDoc(db, id);

        if (!doc || !doc.exists) {
            return res.status(404).json({ error: 'Citizen record not found' });
        }

        const citizenData = doc.data();
        const targetAuthUid = citizenData.authUid || doc.id;

        if (targetAuthUid) {
            const authUpdate = {};
            if (email) authUpdate.email = email;
            if (fullName) authUpdate.displayName = fullName;
            if (password && password.length >= 6) authUpdate.password = password;
            if (typeof isDisabled === 'boolean') authUpdate.disabled = isDisabled;

            if (Object.keys(authUpdate).length > 0) {
                await auth.updateUser(targetAuthUid, authUpdate);
                if (isDisabled === true) {
                    await auth.revokeRefreshTokens(targetAuthUid);
                }
            }
        }

        const firestoreUpdate = {
            fullName,
            email,
            phoneNumber,
            zone,
            status,
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: req.user.email || req.user.uid || 'Admin'
        };

        if (typeof isDisabled === 'boolean') {
            firestoreUpdate.isDisabled = isDisabled;
            if (!status) {
                firestoreUpdate.status = isDisabled ? 'Disabled' : 'Active';
            }
        }

        // Clean undefined properties cleanly
        const cleanUpdate = Object.fromEntries(
            Object.entries(firestoreUpdate).filter(([_, value]) => value !== undefined)
        );

        await docRef.update(cleanUpdate);

        const isOnline = checkUserOnlineStatus(targetAuthUid, doc.id, citizenData.isActive);

        try {
            const io = socketInit.getIO();
            
            io.to('admins').emit('citizen_updated', { id: doc.id, isActive: isOnline, ...cleanUpdate });

            if (isDisabled === true && targetAuthUid) {
                const clientPayload = {
                    uid: targetAuthUid,
                    isDisabled: true,
                    status: cleanUpdate.status || 'Disabled',
                    message: 'Your account was turned off by an admin.'
                };

                io.to(targetAuthUid).emit('account:disabled', clientPayload);
            }
        } catch (socketErr) {
            console.warn("Socket broadcast skipped:", socketErr.message);
        }

        return res.json({ id: doc.id, isActive: isOnline, ...cleanUpdate, success: true, message: 'Citizen updated successfully' });
    } catch (err) {
        console.error("Citizen Update Error:", err);
        return res.status(400).json({ error: err.message });
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
            return res.status(404).json({ message: 'Target record missing' });
        }

        const data = doc.data();
        await docRef.delete();

        const targetAuthUid = data.authUid || doc.id;
        if (targetAuthUid) {
            try {
                await auth.deleteUser(targetAuthUid);
            } catch (authErr) {
                console.warn(`Auth deletion bypassed for UID ${targetAuthUid}:`, authErr.message);
            }
        }

        try {
            const io = socketInit.getIO();
            io.to('admins').emit('citizen_deleted', { id: doc.id });
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
            return res.status(404).json({ error: 'Citizen record not found in active registry' });
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
            archivedBy: req.user.email || req.user.uid || 'Admin',
            originalCollection: 'citizens'
        });
        batch.delete(citizenRef);

        await batch.commit();

        try {
            const io = socketInit.getIO();
            
            io.to('admins').emit('citizen_archived', { id: doc.id, citizenID: data.citizenID || id });

            if (targetAuthUid) {
                const socketPayload = {
                    uid: targetAuthUid,
                    isArchived: true,
                    isDisabled: true,
                    status: 'Archived',
                    message: 'Your account has been archived. You have been signed out.'
                };

                io.to(targetAuthUid).emit('account:disabled', socketPayload);
            }
        } catch (socketErr) {
            console.warn("Socket broadcast skipped:", socketErr.message);
        }

        return res.json({ id: doc.id, success: true, message: 'Record archived in archived_citizens and Firebase Auth access locked out.' });
    } catch (err) {
        console.error("Archive Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;