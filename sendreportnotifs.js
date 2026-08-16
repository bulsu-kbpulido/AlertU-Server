// sendreportnotifs.js - FCM Push Notification Service for Reports
const admin = require('firebase-admin');

/**
 * Topic used by admin clients to receive report notifications.
 * Admin devices subscribe to this topic via FCM.
 */
const ADMIN_REPORTS_TOPIC = 'admin_reports';

/**
 * Topic used by general citizen/public clients for approved alerts.
 */
const APPROVED_REPORTS_TOPIC = 'approved_reports';

/**
 * Safely fetches the first non-empty value from an array of possible key names.
 */
function firstValue(data, keys, fallback = '') {
  for (const key of keys) {
    const value = data?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return fallback;
}

/**
 * Casts input value to string safely.
 */
function toSafeString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

/**
 * Normalizes report payload data into standard FCM notification attributes.
 */
function buildReportData(reportData = {}, reportId, type) {
  const id = toSafeString(
    reportId || firstValue(reportData, ['verifiedReportId', 'verifiedreportID', 'reportID', 'reportId', 'id']),
    'unknown'
  );

  const category = toSafeString(
    firstValue(reportData, ['category', 'incidentType', 'hazard', 'type']),
    'Incident'
  );

  const title = toSafeString(
    firstValue(reportData, ['reportTitle', 'title', 'hazard', 'incidentType']),
    'Emergency Alert'
  );

  const severity = toSafeString(
    firstValue(reportData, ['severity', 'verifiedSeverity']),
    'Medium'
  );

  const status = toSafeString(firstValue(reportData, ['status']), 'pending');

  return {
    reportId: id,
    reportID: id,
    type: toSafeString(type, 'REPORT_ALERT'),
    category,
    title,
    severity,
    status,
  };
}

/**
 * Sends a push notification to admin devices when a raw citizen report is created.
 */
async function sendNewReportNotification(reportData = {}, reportId) {
  const data = buildReportData(reportData, reportId, 'NEW_REPORT');

  const message = {
    topic: ADMIN_REPORTS_TOPIC,
    notification: {
      title: ' New Incident Report Pending Verification',
      body: `Category: ${data.category} | Severity: ${data.severity}`,
    },
    data,
    android: {
      priority: 'high',
      notification: {
        channelId: 'emergency_alerts',
        sound: 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          contentAvailable: true,
        },
      },
    },
  };

  return admin.messaging().send(message);
}

/**
 * Sends a push notification when a report lands in or migrates to approved_reports.
 */
async function sendApprovedReportNotification(reportData = {}, reportId, targetTopic = ADMIN_REPORTS_TOPIC) {
  const data = buildReportData(reportData, reportId, 'APPROVED_REPORT');
  data.status = 'verified';

  const message = {
    topic: targetTopic,
    notification: {
      title: ' Official Emergency Alert Approved',
      body: `${data.title} (${data.category}) has been verified and dispatched.`,
    },
    data,
    android: {
      priority: 'high',
      notification: {
        channelId: 'emergency_alerts',
        sound: 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          contentAvailable: true,
        },
      },
    },
  };

  return admin.messaging().send(message);
}

/**
 * Non-blocking wrappers to guarantee API route requests do not break 
 * if Firebase Messaging throws an error.
 */
async function trySendNewReportNotification(reportData = {}, reportId) {
  try {
    const messageId = await sendNewReportNotification(reportData, reportId);
    console.log(`📡 FCM new-report notification sent [${messageId}]`);
    return messageId;
  } catch (error) {
    console.error('❌ FCM new-report notification failed:', error.message);
    return null;
  }
}

async function trySendApprovedReportNotification(reportData = {}, reportId, targetTopic = ADMIN_REPORTS_TOPIC) {
  try {
    const messageId = await sendApprovedReportNotification(reportData, reportId, targetTopic);
    console.log(`📡 FCM approved-report notification sent to topic '${targetTopic}' [${messageId}]`);
    return messageId;
  } catch (error) {
    console.error('❌ FCM approved-report notification failed:', error.message);
    return null;
  }
}

module.exports = {
  ADMIN_REPORTS_TOPIC,
  APPROVED_REPORTS_TOPIC,
  sendNewReportNotification,
  sendApprovedReportNotification,
  trySendNewReportNotification,
  trySendApprovedReportNotification,
};