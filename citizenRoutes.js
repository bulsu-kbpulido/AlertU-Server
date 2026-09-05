const express = require('express');
const router = express.Router();
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const socketInit = require('./socket'); // Socket engine reference

// 🖼️ DEFAULT AVATAR CONSTANT
const DEFAULT_AVATAR_URL = 'https://ui-avatars.com/api/?background=0D8ABC&color=fff&name=Citizen';

// 🧠 SERVER-SIDE MEMORY CACHE ENGINE
let citizensMemoryCache = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 Minute Cache TTL

const invalidateMemoryCache = () => {
    citizensMemoryCache = null;
    lastCacheTime = 0;
};

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

const checkUserOnlineStatus = (authUid, docId, firestoreIsActive = false, activeSocketUidsSet = null) => {
    try {
        const io = socketInit.getIO();

        if (activeSocketUidsSet) {
            if ((authUid && activeSocketUidsSet.has(authUid)) || (docId && activeSocketUidsSet.has(docId))) {
                return true;
            }
        } else {
            const connectedSockets = Array.from(io.sockets.sockets.values());
            const isConnectedViaSocket = connectedSockets.some((s) => {
                const sUid = s.userData?.uid;
                return (authUid && sUid === authUid) || (docId && sUid === docId);
            });
            if (isConnectedViaSocket) return true;
        }

        const rooms = io.sockets.adapter.rooms;
        const hasUidRoom = authUid ? (rooms.get(authUid)?.size || 0) > 0 : false;
        const hasDocRoom = docId ? (rooms.get(docId)?.size || 0) > 0 : false;

        if (hasUidRoom || hasDocRoom) return true;

        return Boolean(firestoreIsActive);
    } catch (err) {
        return Boolean(firestoreIsActive);
    }
};

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

// 1. SPECIFIC / STATIC SUB-ROUTES FIRST

// 📱 REGISTER FCM TOKEN
router.post('/register-fcm-token', async (req, res) => {
  try {
    const uid = req.user.uid;
    const { fcmToken, token: fallbackToken } = req.body;
    const targetToken = fcmToken || fallbackToken;

    if (!targetToken) {
      return res.status(400).json({ success: false, error: 'fcmToken is required' });
    }

    const db = getFirestore();
    await db.collection('citizens').doc(uid).set({
      fcmToken: targetToken,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    invalidateMemoryCache();
    return res.status(200).json({ success: true, message: 'FCM token registered successfully' });
  } catch (error) {
    console.error('❌ FCM Token Registration Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 🖼️ DELETE AVATAR VIA QUERY / AUTH TOKEN
router.delete('/delete-avatar', async (req, res) => {
    try {
        const db = getFirestore();
        const auth = getAuth();
        const uid = req.query.uid || req.body?.uid || req.user.uid;

        if (!uid) {
            return res.status(400).json({ error: 'User UID is required.' });
        }

        const { docRef, doc } = await resolveCitizenDoc(db, uid);

        if (!doc || !doc.exists) {
            return res.status(404).json({ error: 'Citizen record not found.' });
        }

        const citizenData = doc.data();
        const fallbackAvatar = `https://ui-avatars.com/api/?background=0D8ABC&color=fff&name=${encodeURIComponent(citizenData.fullName || 'Citizen')}`;

        await docRef.update({
            avatar: FieldValue.delete(),
            photoUrl: FieldValue.delete(),
            photoURL: FieldValue.delete(),
            storagePath: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: req.user?.email || req.user?.uid || 'User'
        });

        try {
            await auth.updateUser(uid, { photoURL: fallbackAvatar });
        } catch (authErr) {
            console.warn(`Auth photoURL update skipped for UID ${uid}:`, authErr.message);
        }

        invalidateMemoryCache();

        try {
            const io = socketInit.getIO();
            const payload = { id: doc.id, avatar: fallbackAvatar };
            io.to('admins').emit('citizen_updated', payload);
            io.to(uid).emit('profile_updated', payload);
        } catch (socketErr) {
            console.warn("Socket broadcast skipped:", socketErr.message);
        }

        return res.json({ 
            success: true, 
            message: 'Avatar deleted successfully.',
            avatar: fallbackAvatar
        });
    } catch (err) {
        console.error("Delete Avatar Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📡 READ ALL CITIZENS (With Smart Fallback Cache)
router.get('/', async (req, res) => {
    try {
        const db = getFirestore();
        const now = Date.now();
        const forceRefresh = req.query._t || req.query.forceHydrate === 'true';

        let rawDocs = [];

        if (!forceRefresh && citizensMemoryCache && (now - lastCacheTime) < CACHE_TTL_MS) {
            rawDocs = citizensMemoryCache;
        } else {
            const limitVal = parseInt(req.query.queryLimit, 10) || 100;
            const snapshot = await db.collection('citizens').limit(limitVal).get();
            rawDocs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            
            citizensMemoryCache = rawDocs;
            lastCacheTime = now;
        }

        let activeSocketUidsSet = new Set();
        try {
            const io = socketInit.getIO();
            activeSocketUidsSet = getActiveSocketUidsSet(io);
        } catch (e) {}
        
        const citizensList = rawDocs.map(data => {
            const docId = data.id;
            const targetUid = data.authUid || docId;
            const isOnline = checkUserOnlineStatus(targetUid, docId, data.isActive, activeSocketUidsSet);

            const formattedCitizenID = 
                data.citizenID || 
                data.citizenId || 
                (docId.startsWith('CID') ? docId : 'CID00000000');

            const userAvatar = data.avatar || data.photoURL || `https://ui-avatars.com/api/?background=0D8ABC&color=fff&name=${encodeURIComponent(data.fullName || 'Citizen')}`;

            return {
                id: docId, 
                citizenID: formattedCitizenID,
                authUid: data.authUid || docId,
                fullName: data.fullName || 'No Name Provided',
                email: data.email || 'N/A',
                avatar: userAvatar,
                phoneNumber: data.phoneNumber || 'No Phone Record',
                zone: data.zone || 'Unassigned Sector',
                status: data.status || (data.isDisabled ? 'Disabled' : 'Active'),
                isDisabled: data.isDisabled ?? false,
                isActive: isOnline,
                isArchived: data.isArchived || false,
                dpaAccepted: data.dpaAccepted || false,
                createdVia: data.createdVia || 'Admin Portal',
                createdBy: data.createdBy || 'System Admin',
                createdAt: data.createdAt && typeof data.createdAt.toDate === 'function' 
                    ? data.createdAt.toDate() 
                    : data.createdAt || null
            };
        });

        res.setHeader('X-Total-Count', citizensList.length);
        res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');
        
        return res.json(citizensList);
    } catch (err) {
        console.error("Error fetching citizens from Firestore:", err);

        // Fallback: Return cached records if query failed
        if (citizensMemoryCache) {
            return res.json(citizensMemoryCache);
        }

        return res.status(500).json({ error: err.message });
    }
});

// 📡 CREATE NEW CITIZEN
router.post('/', async (req, res) => {
    const auth = getAuth();
    const db = getFirestore();
    let userRecord = null;

    try {
        const { email, password, fullName, phoneNumber, zone, avatar, isDisabled = false } = req.body;

        if (!email || !password || !fullName) {
            return res.status(400).json({ error: 'Missing required fields: email, password, and fullName.' });
        }

        const defaultAvatar = avatar || `https://ui-avatars.com/api/?background=0D8ABC&color=fff&name=${encodeURIComponent(fullName)}`;

        userRecord = await auth.createUser({
            email,
            password,
            displayName: fullName,
            photoURL: defaultAvatar,
            disabled: Boolean(isDisabled)
        });

        const documentId = userRecord.uid;
        const citizenID = await getNextCitizenID(db);

        const citizenData = {
            citizenID,
            citizenId: citizenID,
            authUid: userRecord.uid,
            fullName,
            email,
            avatar: defaultAvatar,
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
        invalidateMemoryCache();

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
                console.error("Failed to cleanup auth user during rollback:", cleanupErr);
            }
        }

        return res.status(400).json({ error: err.message });
    }
});

// 2. PARAMETERIZED SUB-ROUTES

// ✉️ DISPATCH EMAIL VERIFICATION LINK
router.post('/:uid/send-verification-email', async (req, res) => {
    try {
        const { uid } = req.params;
        const { newEmail } = req.body;
        const auth = getAuth();
        const db = getFirestore();

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

        const actionCodeSettings = {
            url: process.env.FIREBASE_CONTINUE_URL || 'https://your-app-domain.com/login',
            handleCodeInApp: true,
        };

        const link = await auth.generateEmailVerificationLink(newEmail, actionCodeSettings);

        const { docRef } = await resolveCitizenDoc(db, uid);
        const targetRef = docRef || db.collection('citizens').doc(uid);

        await targetRef.set({
            pendingEmail: newEmail,
            emailVerificationSentAt: FieldValue.serverTimestamp(),
            updatedBy: req.user?.email || req.user?.uid || 'User'
        }, { merge: true });

        invalidateMemoryCache();

        return res.json({
            success: true,
            message: 'Verification email generated successfully.',
            link
        });
    } catch (err) {
        console.error("Verification Email Generation Error:", err);
        return res.status(400).json({ error: err.message || 'Failed to dispatch verification email.' });
    }
});

// 🖼️ DELETE AVATAR BY ID
router.delete('/:id/avatar', async (req, res) => {
    try {
        const { id } = req.params;
        const db = getFirestore();
        const auth = getAuth();

        const { docRef, doc } = await resolveCitizenDoc(db, id);

        if (!doc || !doc.exists) {
            return res.status(404).json({ error: 'Citizen record not found.' });
        }

        const citizenData = doc.data();
        const targetAuthUid = citizenData.authUid || doc.id;
        const fallbackAvatar = `https://ui-avatars.com/api/?background=0D8ABC&color=fff&name=${encodeURIComponent(citizenData.fullName || 'Citizen')}`;

        await docRef.update({
            avatar: FieldValue.delete(),
            photoUrl: FieldValue.delete(),
            photoURL: FieldValue.delete(),
            storagePath: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: req.user?.email || req.user?.uid || 'User'
        });

        if (targetAuthUid) {
            try {
                await auth.updateUser(targetAuthUid, { photoURL: fallbackAvatar });
            } catch (authErr) {
                console.warn(`Auth photoURL reset skipped for ${targetAuthUid}:`, authErr.message);
            }
        }

        invalidateMemoryCache();

        return res.json({ 
            success: true, 
            message: 'Avatar reset to default.', 
            avatar: fallbackAvatar 
        });
    } catch (err) {
        console.error("Delete Avatar Route Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📡 READ ONE CITIZEN
router.get('/:id', async (req, res) => {
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

        const userAvatar = data.avatar || data.photoURL || `https://ui-avatars.com/api/?background=0D8ABC&color=fff&name=${encodeURIComponent(data.fullName || 'Citizen')}`;

        return res.json({ 
            id: doc.id, 
            ...data, 
            citizenID: formattedCitizenID,
            avatar: userAvatar,
            isActive: isOnline
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 📡 UPDATE CITIZEN (PUT)
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { email, password, fullName, phoneNumber, zone, status, isDisabled, avatar } = req.body;
        const auth = getAuth();
        const db = getFirestore();

        const { docRef, doc } = await resolveCitizenDoc(db, id);

        if (!doc || !doc.exists) {
            return res.status(404).json({ error: 'Citizen record not found in Firestore.' });
        }

        const citizenData = doc.data();
        const targetAuthUid = citizenData.authUid || citizenData.uid || doc.id;
        const requesterUid = req.user?.uid;
        const isPrivileged = req.user?.admin === true || req.user?.role === 'admin' || req.user?.role === 'superadmin';

        if (requesterUid !== targetAuthUid && !isPrivileged) {
            return res.status(403).json({ error: 'You may only update your own profile.' });
        }

        if (targetAuthUid) {
            const authUpdate = {};
            // A self-service email change is initiated in Flutter with
            // verifyBeforeUpdateEmail; do not overwrite it here.
            if (isPrivileged && email) authUpdate.email = String(email).trim().toLowerCase();
            if (fullName !== undefined) authUpdate.displayName = String(fullName).trim();
            if (avatar) authUpdate.photoURL = avatar;
            if (isPrivileged && password && password.length >= 6) authUpdate.password = password;
            if (typeof isDisabled === 'boolean' && isPrivileged) authUpdate.disabled = isDisabled;

            if (Object.keys(authUpdate).length > 0) {
                await auth.updateUser(targetAuthUid, authUpdate);
            }
        }

        const firestoreUpdate = {
            updatedAt: FieldValue.serverTimestamp(),
            updatedBy: req.user?.email || req.user?.uid || 'Admin'
        };

        if (isPrivileged && email !== undefined) firestoreUpdate.email = String(email).trim().toLowerCase();
        if (req.body.pendingEmail !== undefined) firestoreUpdate.pendingEmail = String(req.body.pendingEmail).trim().toLowerCase();
        if (fullName !== undefined) firestoreUpdate.fullName = fullName;
        if (avatar !== undefined) firestoreUpdate.avatar = avatar;
        if (phoneNumber !== undefined) firestoreUpdate.phoneNumber = phoneNumber;
        if (zone !== undefined) {
            firestoreUpdate.zone = zone;
            firestoreUpdate.zoneAddress = zone;
        }
        if (status !== undefined) firestoreUpdate.status = status;
        if (typeof isDisabled === 'boolean') {
            firestoreUpdate.isDisabled = isDisabled;
            firestoreUpdate.status = status || (isDisabled ? 'Disabled' : 'Active');
        }

        await docRef.update(firestoreUpdate);
        invalidateMemoryCache();

        try {
            const io = socketInit.getIO();
            const payload = { id: doc.id, uid: targetAuthUid, ...firestoreUpdate };

            io.to('admins').emit('citizen_updated', payload);
            if (targetAuthUid) {
                io.to(targetAuthUid).emit('citizen_updated', payload);
                io.to(targetAuthUid).emit('profile_updated', payload);
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

// 📡 PATCH STATUS
router.patch('/:id/status', async (req, res) => {
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
        invalidateMemoryCache();

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
                const socketPayload = {
                    uid: targetAuthUid,
                    isDisabled: true,
                    status: targetStatus,
                    message: 'Your account has been disabled by an administrator.'
                };

                io.to(targetAuthUid).emit('account:disabled', socketPayload);
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
            message: `Citizen account ${targetIsDisabled ? 'disabled' : 'enabled'} successfully.`
        });
    } catch (err) {
        console.error("Status Patch Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📦 ARCHIVE CITIZEN
router.post('/:id/archive', async (req, res) => {
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
        invalidateMemoryCache();

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

        return res.json({ id: doc.id, success: true, message: 'Citizen archived and Firebase Auth access locked out successfully.' });
    } catch (err) {
        console.error("Archive Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

// 📡 DELETE CITIZEN
router.delete('/:id', async (req, res) => {
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

        const targetAuthUid = data.authUid || doc.id;
        if (targetAuthUid) {
            try {
                await auth.deleteUser(targetAuthUid);
            } catch (authErr) {
                console.warn(`Auth user delete skipped for UID ${targetAuthUid}:`, authErr.message);
            }
        }

        invalidateMemoryCache();

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



module.exports = router;
