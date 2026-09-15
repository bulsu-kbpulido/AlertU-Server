const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const admin = require('firebase-admin'); // Firebase Admin SDK
const router = express.Router();

router.get('/agora-token', async (req, res) => {
  const { channelName, citizenId, callerName } = req.query;

  // 1. Validate required parameter
  if (!channelName || channelName.trim() === '') {
    return res.status(400).json({ error: 'channelName parameter is required' });
  }

  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate) {
    console.error('❌ AGORA_APP_ID or AGORA_APP_CERTIFICATE missing in process.env');
    return res.status(500).json({ error: 'Agora credentials missing in environment variables' });
  }

  const role = RtcRole.PUBLISHER;
  const expirationTimeInSeconds = 3600 * 2; // Valid for 2 hours
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  let token;
  try {
    // 2. Generate Agora Token (UID 0 allows Agora to allocate dynamic numeric UIDs)
    token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName.trim(),
      0,
      role,
      privilegeExpiredTs
    );
  } catch (agoraErr) {
    console.error('❌ Failed to build Agora Token:', agoraErr);
    return res.status(500).json({ error: 'Token construction failed' });
  }

  const resolvedCitizenId = (citizenId && citizenId.trim() !== '') ? citizenId.trim() : 'UNKNOWN';
  const resolvedCallerName = (callerName && callerName.trim() !== '') ? callerName.trim() : 'Emergency Citizen';

  // 3. Non-blocking Firestore session logging
  try {
    if (admin.apps.length > 0) {
      await admin.firestore().collection('active_calls').doc(channelName).set({
        channelName,
        citizenId: resolvedCitizenId,
        submitterName: resolvedCallerName,
        callerName: resolvedCallerName,
        status: 'ringing',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      console.warn('⚠️ Firebase Admin SDK is not initialized. Skipping active_calls document write.');
    }
  } catch (fsErr) {
    console.error('⚠️ Firestore active_calls write error (non-fatal):', fsErr);
  }

  // 4. Non-blocking Socket Notification
  try {
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('admin:incoming_call', {
        channelName,
        citizenId: resolvedCitizenId,
        submitterName: resolvedCallerName,
        callerName: resolvedCallerName,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (socketErr) {
    console.error('⚠️ Socket emit error (non-fatal):', socketErr);
  }

  // 5. Return Token & App ID
  return res.json({ token, appId });
});

// ==========================================
// POST /calls/claim — Atomic call claim
// Prevents two admins from both answering the same emergency call.
// Frontend (App.jsx handleAnswerCall) posts here when "Answer Call" is clicked.
// ==========================================
router.post('/calls/claim', async (req, res) => {
  const { channelName, adminId, adminName } = req.body || {};

  if (!channelName || String(channelName).trim() === '') {
    return res.status(400).json({ success: false, message: 'channelName is required.' });
  }
  if (!adminId) {
    return res.status(400).json({ success: false, message: 'adminId is required.' });
  }

  if (admin.apps.length === 0) {
    console.error('❌ Firebase Admin SDK is not initialized. Cannot claim call.');
    return res.status(500).json({ success: false, message: 'Server storage is unavailable.' });
  }

  const callRef = admin.firestore().collection('active_calls').doc(String(channelName).trim());

  try {
    const claimResult = await admin.firestore().runTransaction(async (transaction) => {
      const snap = await transaction.get(callRef);

      if (!snap.exists) {
        return { conflict: false, notFound: true };
      }

      const data = snap.data();

      // Already claimed by a different admin and still active
      if (
        data.status === 'in_call' &&
        data.assignedAdminId &&
        data.assignedAdminId !== adminId
      ) {
        return {
          conflict: true,
          claimedBy: data.assignedAdminName || 'another dispatcher',
          assignedAdminId: data.assignedAdminId,
        };
      }

      // Claim it (or re-confirm claim by the same admin)
      transaction.set(
        callRef,
        {
          status: 'in_call',
          assignedAdminId: adminId,
          assignedAdminName: adminName || 'Dispatcher',
          claimedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return { conflict: false, notFound: false };
    });

    if (claimResult.notFound) {
      return res.status(404).json({ success: false, message: 'Call may have ended.' });
    }

    if (claimResult.conflict) {
      return res.status(409).json({
        success: false,
        claimedBy: claimResult.claimedBy,
        assignedAdminId: claimResult.assignedAdminId,
        message: `This call has already been answered by ${claimResult.claimedBy}.`,
      });
    }

    // Notify all admins so their local queues reflect the claim
    try {
      const io = req.app.get('io');
      if (io) {
        io.to('admins').emit('call_claimed', {
          channelName,
          assignedAdminId: adminId,
          assignedAdminName: adminName || 'Dispatcher',
        });
      }
    } catch (socketErr) {
      console.error('⚠️ Socket emit error on call claim (non-fatal):', socketErr);
    }

    return res.status(200).json({ success: true, channelName, assignedAdminId: adminId });
  } catch (err) {
    console.error('❌ Error claiming call:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to claim call.' });
  }
});

module.exports = router;
