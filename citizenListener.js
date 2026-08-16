const express = require('express');
const router = express.Router();
const socketInit = require('./socket');
const { getMessaging } = require('firebase-admin/messaging');

/**
 * 📡 POST /api/reports/notify-new
 * Called by Flutter (ReportSubmissionPage) when a report is submitted.
 * Relays the report live to Web Admin via Socket.IO and dispatches FCM Push Notifications.
 */
router.post('/reports/notify-new', async (req, res, next) => {
  try {
    const { event, targetRoom, reportId, reportData, timestamp } = req.body;

    // 1. Validation
    if (!reportId || !reportData) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: "reportId" and "reportData" are required.',
      });
    }

    // 2. Build Standardized Payload for Web Admin Dashboard
    const broadcastPayload = {
      eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      event: event || 'NEW_REPORT_SUBMITTED',
      reportID: reportId,
      reportId: reportId,
      incidentType: reportData.incidentType || 'Others',
      severity: reportData.severity || 'Low',
      hazard: reportData.hazard || 'None',
      address: reportData.address || 'Unknown Location',
      latitude: reportData.latitude,
      longitude: reportData.longitude,
      timestamp: timestamp || new Date().toISOString(),
    };

    console.log(`🚨 [New Report Notification] ${broadcastPayload.reportID} (${broadcastPayload.incidentType}) at ${broadcastPayload.address}`);

    // 3. 🚀 Relay to Web Admin Dashboard via Socket.IO
    try {
      const io = socketInit.getIO();
      const room = targetRoom || 'super_admins';

      // Emit to room (e.g., 'super_admins') and globally as a fallback
      io.to(room).emit('NEW_REPORT_SUBMITTED', broadcastPayload);
      io.to(room).emit('INCIDENT_REPORT_RECEIVED', broadcastPayload);
      io.emit('NEW_REPORT_SUBMITTED', broadcastPayload);

      console.log(`📡 Broadcasted live report alert to socket room: ${room}`);
    } catch (wsErr) {
      console.warn('⚠️ Socket.IO broadcast warning:', wsErr.message);
    }

    // 4. 📲 Send FCM Push Notification to Admin devices (Async background execution)
    dispatchFcmNotification(broadcastPayload).catch((fcmErr) => {
      console.error('❌ FCM Push Notification Error:', fcmErr.message);
    });

    // 5. Immediate success response back to Flutter
    return res.status(200).json({
      success: true,
      message: 'Report notification received and broadcasted to dispatch team.',
      reportId: broadcastPayload.reportID,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Sends FCM Push Notifications to administrative topics
 */
async function dispatchFcmNotification(payload) {
  try {
    const messaging = getMessaging();

    const message = {
      notification: {
        title: `🚨 Emergency Report: ${payload.incidentType}`,
        body: `Severity: ${payload.severity} • Location: ${payload.address}`,
      },
      data: {
        reportId: String(payload.reportID),
        incidentType: String(payload.incidentType),
        severity: String(payload.severity),
        address: String(payload.address),
        latitude: String(payload.latitude || ''),
        longitude: String(payload.longitude || ''),
        timestamp: String(payload.timestamp),
      },
      topic: 'super_admin_alerts',
    };

    const response = await messaging.send(message);
    console.log(`📲 [FCM Dispatched] Message ID: ${response}`);
  } catch (err) {
    console.error('⚠️ FCM dispatch failed:', err.message);
  }
}

module.exports = router;