const express = require('express');
const router = express.Router();

// Direct Firebase Admin SDK imports matching guide architecture
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// Initialize local Firestore and Auth instances directly from default Firebase App
const auth = getAuth();
const db = getFirestore();

// Import shared verification middleware
const { verifyToken } = require('./authMiddleware');

/**
 * GET /api/superadmin/profile/:uid
 * Fetch Super Admin profile details from Firestore.
 */
router.get('/profile/:uid', verifyToken, async (req, res) => {
  try {
    const { uid } = req.params;

    // Direct check by document ID (matching auth UID)
    let docRef = db.collection('superadmin').doc(uid);
    let docSnap = await docRef.get();

    // Fallback search by uid field if document ID is custom
    if (!docSnap.exists) {
      const querySnap = await db.collection('superadmin').where('uid', '==', uid).limit(1).get();
      if (!querySnap.empty) {
        docSnap = querySnap.docs[0];
      }
    }

    if (!docSnap.exists) {
      return res.status(404).json({ success: false, error: 'Super Admin profile not found.' });
    }

    return res.status(200).json({
      success: true,
      id: docSnap.id,
      ...docSnap.data()
    });
  } catch (error) {
    console.error('Error fetching Super Admin profile:', error);
    return res.status(500).json({ success: false, error: 'Failed to retrieve profile data.' });
  }
});

/**
 * PUT /api/superadmin/profile/:uid
 * Update profile details (Name, Username, Phone, Avatar).
 */
router.put('/profile/:uid', verifyToken, async (req, res) => {
  try {
    const { uid } = req.params;
    const { name, username, phone, avatar } = req.body;

    let docRef = db.collection('superadmin').doc(uid);
    let docSnap = await docRef.get();

    // Locate document reference if custom ID was used
    if (!docSnap.exists) {
      const querySnap = await db.collection('superadmin').where('uid', '==', uid).limit(1).get();
      if (!querySnap.empty) {
        docRef = querySnap.docs[0].ref;
      } else {
        return res.status(404).json({ success: false, error: 'Super Admin record not found.' });
      }
    }

    const updateData = {
      updatedAt: FieldValue.serverTimestamp()
    };

    if (name !== undefined) updateData.name = name;
    if (username !== undefined) updateData.username = username;
    if (phone !== undefined) updateData.phone = phone;
    if (avatar !== undefined) updateData.avatar = avatar;

    await docRef.set(updateData, { merge: true });

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully.',
      updatedFields: updateData
    });
  } catch (error) {
    console.error('Error updating Super Admin profile:', error);
    return res.status(500).json({ success: false, error: 'Failed to update profile.' });
  }
});

/**
 * GET /api/superadmin/dashboard-stats
 * Fetch aggregate counts and statistics for the Dashboard screen.
 */
router.get('/dashboard-stats', verifyToken, async (req, res) => {
  try {
    const adminsSnap = await db.collection('admins').get();
    const logsSnap = await db.collection('audit_logs').orderBy('timestamp', 'desc').limit(8).get();

    const admins = adminsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const auditLogs = logsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const totalAdmins = admins.length;
    const activeAdmins = admins.filter(a => a.status === 'active').length;

    return res.status(200).json({
      success: true,
      totalAdmins,
      activeAdmins,
      auditLogs,
      admins
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    return res.status(500).json({ success: false, error: 'Failed to load dashboard metrics.' });
  }
});

module.exports = router;