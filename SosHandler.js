const express = require('express');
const router = express.Router();
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const socketInit = require('./socket');

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

const sanitizeContacts = (contacts) => {
  if (!Array.isArray(contacts)) return [];
  return contacts.map((c) => ({
    name: c.name || c.fullName || 'Unnamed Contact',
    phoneNumber: c.phoneNumber || c.phone || c.contactNumber || 'No Phone Record',
    relationship: c.relationship || c.relation || 'Emergency Contact',
    email: c.email || c.emailAddress || 'N/A'
  }));
};

// ==========================================
// 📡 ROUTE HANDLERS
// ==========================================

/**
 * 1. 🚨 TRIGGER / RE-TRIGGER SOS ALERT (Strictly target sos_alerts)
 */
router.post('/trigger', async (req, res) => {
  try {
    const db = getFirestore();
    const { latitude, longitude, altitude, accuracy, alertType, note } = req.body;
    const citizenUid = req.user.uid;

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'Latitude and Longitude (GIS coordinates) are required.' });
    }

    // Fetch latest Citizen Details and Emergency Contacts
    const citizenDoc = await db.collection('citizens').doc(citizenUid).get();
    let citizenData = {};
    let emergencyContacts = [];

    if (citizenDoc.exists) {
      citizenData = citizenDoc.data() || {};
      emergencyContacts = sanitizeContacts(citizenData.emergencyContacts || []);
    }

    const resolvedName = citizenData.fullName || citizenData.name || citizenData.displayName || req.user.name || 'Unknown Citizen';
    const resolvedPhone = citizenData.phoneNumber || citizenData.phone || req.user.phone_number || 'N/A';
    const resolvedEmail = citizenData.email || req.user.email || 'No email provided';
    const resolvedCitizenID = citizenData.citizenID || citizenData.citizenId || citizenUid;

    // 🔑 CANONICAL KEY: Always use Firebase Auth UID (e.g. "sos_7SHhX2853dRCZpwfL8Or1qLhQF22")
    const docKey = citizenUid.startsWith('sos_') ? citizenUid : `sos_${citizenUid}`;

    const gisLocation = {
      latitude: Number(latitude),
      longitude: Number(longitude),
      altitude: altitude ? Number(altitude) : null,
      accuracy: accuracy ? Number(accuracy) : null,
      updatedAt: new Date().toISOString(),
    };

    const sosPayload = {
      sosId: docKey,
      id: docKey,
      targetRoom: docKey,
      citizenUid,
      citizenID: resolvedCitizenID,
      citizenName: resolvedName,
      submitterName: resolvedName,
      citizenPhone: resolvedPhone,
      submitterPhone: resolvedPhone,
      phone: resolvedPhone,
      citizenEmail: resolvedEmail,
      submitterEmail: resolvedEmail,
      email: resolvedEmail,
      alertType: alertType || 'GENERAL_EMERGENCY',
      
      // 🔄 CRITICAL FIX FOR 2ND SWIPE: Force reset flags so React Dashboard picks it up as new/active
      status: 'ACTIVE',
      isActive: true,
      closedAt: null,
      
      isNewSession: true,
      note: note || '',
      sosDetails: note || '',
      gisLocation,
      latitude: Number(latitude),
      longitude: Number(longitude),
      emergencyContacts,
      updatedAt: FieldValue.serverTimestamp(),
      triggeredAt: FieldValue.serverTimestamp(), // Re-stamp trigger time on 2nd+ swipes
    };

    const locationRef = db.collection('sos_alerts').doc(docKey);

    // Single write strictly into sos_alerts
    await locationRef.set(sosPayload, { merge: true });

    // Stream real-time socket event to admins
    try {
      const io = socketInit.getIO();
      const socketData = {
        ...sosPayload,
        updatedAt: new Date().toISOString(),
        triggeredAt: new Date().toISOString(),
      };

      io.to('admins').emit('sos:alert_triggered', socketData);
      io.to(docKey).emit('sos:location_updated', socketData);
    } catch (socketErr) {
      console.warn('⚠️ Socket emission skipped:', socketErr.message);
    }

    return res.status(200).json({
      success: true,
      sosId: docKey,
      message: 'Citizen emergency document updated successfully in sos_alerts.',
      sosData: sosPayload,
    });
  } catch (err) {
    console.error('❌ SOS Trigger Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 2. 📍 UPDATE GIS LOCATION FOR CITIZEN (Targeting sos_alerts)
 */
router.patch('/:citizenId/location', async (req, res) => {
  try {
    const rawId = req.params.citizenId;
    const docKey = String(rawId).startsWith('sos_') ? rawId : `sos_${rawId}`;
    
    const { latitude, longitude, altitude, accuracy } = req.body;
    const db = getFirestore();

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'Latitude and Longitude are required.' });
    }

    const gisLocation = {
      latitude: Number(latitude),
      longitude: Number(longitude),
      altitude: altitude ? Number(altitude) : null,
      accuracy: accuracy ? Number(accuracy) : null,
      updatedAt: new Date().toISOString(),
    };

    const locationUpdatePayload = {
      sosId: docKey,
      gisLocation,
      latitude: Number(latitude),
      longitude: Number(longitude),
      updatedAt: FieldValue.serverTimestamp(),
    };

    // Update single document in sos_alerts ONLY
    await db.collection('sos_alerts').doc(docKey).set(locationUpdatePayload, { merge: true });

    try {
      const io = socketInit.getIO();
      io.to('admins').emit('sos:location_updated', {
        sosId: docKey,
        gisLocation,
        latitude: Number(latitude),
        longitude: Number(longitude),
      });

      io.to(docKey).emit('sos:location_updated', { sosId: docKey, gisLocation });
    } catch (socketErr) {
      console.warn('⚠️ Socket emission skipped:', socketErr.message);
    }

    return res.json({ success: true, sosId: docKey, gisLocation });
  } catch (err) {
    console.error('❌ GIS Location Update Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 3. 🏷️ UPDATE SOS STATUS FOR CITIZEN (Targeting sos_alerts)
 */
router.patch('/:citizenId/status', async (req, res) => {
  try {
    const rawId = req.params.citizenId;
    const docKey = String(rawId).startsWith('sos_') ? rawId : `sos_${rawId}`;

    const { status, responderNotes } = req.body;
    const db = getFirestore();

    const validStatuses = ['ACTIVE', 'ACKNOWLEDGED', 'DISPATCHED', 'RESOLVED', 'CANCELLED'];
    if (!status || !validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const targetStatus = status.toUpperCase();

    const updatePayload = {
      sosId: docKey,
      status: targetStatus,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: req.user?.email || req.user?.uid || 'Admin',
    };

    if (responderNotes) {
      updatePayload.responderNotes = responderNotes;
    }

    if (targetStatus === 'RESOLVED' || targetStatus === 'CANCELLED') {
      updatePayload.closedAt = FieldValue.serverTimestamp();
      updatePayload.isActive = false;
    }

    // Update single document in sos_alerts ONLY
    await db.collection('sos_alerts').doc(docKey).set(updatePayload, { merge: true });

    try {
      const io = socketInit.getIO();

      const socketPayload = {
        sosId: docKey,
        status: targetStatus,
        responderNotes: responderNotes || '',
        updatedBy: updatePayload.updatedBy,
      };

      io.to('admins').emit('sos:status_updated', socketPayload);
      io.to(docKey).emit('sos:status_updated', socketPayload);
    } catch (socketErr) {
      console.warn('⚠️ Socket emission skipped:', socketErr.message);
    }

    return res.json({
      success: true,
      sosId: docKey,
      status: targetStatus,
      message: `Citizen SOS status updated to ${targetStatus} in sos_alerts`,
    });
  } catch (err) {
    console.error('❌ SOS Status Patch Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;