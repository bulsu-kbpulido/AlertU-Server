// alertRoutes.js - Express Router for Alert Notifications & Broadcasting
const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');
const { trySendAlertNotification } = require('./alertNotifs');

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

    let payload = alertData;

    // If only alertId was provided, fetch document from Firestore
    if (!payload && alertId) {
      const docSnap = await db.collection('alerts').doc(alertId).get();
      if (!docSnap.exists) {
        return res.status(404).json({
          success: false,
          message: `Alert with ID "${alertId}" not found in Firestore.`,
        });
      }
      payload = docSnap.data();
    }

    const results = await trySendAlertNotification(payload, alertId || payload.id);

    return res.status(200).json({
      success: true,
      message: 'Alert push notification dispatched successfully.',
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
