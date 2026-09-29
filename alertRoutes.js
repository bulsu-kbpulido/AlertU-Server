// alertRoutes.js - Express Router for Alert Notifications & Broadcasting
const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');
const { broadcastAlert } = require('./alertNotifs');

const db = getFirestore();

/**
 * POST /api/alerts/broadcast
 * Allows Web Admin or API clients to directly trigger an FCM broadcast for an alert.
 */
router.post('/alerts/broadcast', async (req, res) => {
  try {
    const { alertId, alertData } = req.body;

    if (!alertData && !alertId) {
      return res.status(400).json({
        success: false,
        message: 'Missing alertId or alertData in request body.',
      });
    }

    // The dashboard saves the alert to Firestore before calling this, so the
    // stored document is the source of truth (a Resend's client copy is stale).
    let stored = null;
    if (alertId) {
      const docSnap = await db.collection('alerts').doc(alertId).get();
      if (docSnap.exists) stored = docSnap.data();
    }

    if (!stored && !alertData) {
      return res.status(404).json({
        success: false,
        message: `Alert with ID "${alertId}" not found in Firestore.`,
      });
    }

    const payload = { ...(alertData || {}), ...(stored || {}) };

    const { skipped, results } = await broadcastAlert(payload, alertId || payload.id);

    // A send that reached nobody must not look like success to the dashboard.
    if (!skipped && results.length > 0 && results.every((r) => !r.success)) {
      return res.status(502).json({
        success: false,
        message: 'FCM push failed for every target.',
        results,
      });
    }

    return res.status(200).json({
      success: true,
      message: skipped
        ? 'Alert was already broadcast moments ago.'
        : 'Alert push notification dispatched successfully.',
      results,
    });
  } catch (error) {
    console.error('❌ Error broadcasting alert via API:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to broadcast alert notification.',
      error: error.message,
    });
  }
});

module.exports = router;
