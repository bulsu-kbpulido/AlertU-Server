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

module.exports = router;