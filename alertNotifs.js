// alertNotifs.js - FCM Push Notification Service for Broadcast Alerts
const admin = require('firebase-admin');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

/**
 * Default topics used for broadcasting emergency alerts to citizens
 */
const ALL_RESIDENTS_TOPIC = 'all_residents';
const APPROVED_REPORTS_TOPIC = 'approved_reports'; // Existing public topic subscribed to by mobile clients

/**
 * Normalizes a barangay name to a valid FCM topic string.
 * FCM topics must match: [a-zA-Z0-9-_.~%]+
 */
function normalizeBarangayTopic(barangayName = '') {
  const cleaned = String(barangayName)
    .trim()
    .toLowerCase()
    .replace(/^(brgy\.?|barangay)\s*/i, '')
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `barangay_${cleaned}`;
}

/**
 * Builds normalized FCM data payload for an alert.
 * Note: All FCM data payload values MUST be strings.
 */
function buildAlertData(alertData = {}, alertId) {
  const id = String(alertId || alertData.id || `alert_${Date.now()}`);
  const type = String(alertData.type || 'General');
  const title = String(alertData.title || 'Emergency Alert');
  const message = String(alertData.message || '');
  const recipientScope = String(alertData.recipientScope || 'All Residents');
  const targetLocation = String(alertData.targetLocation || 'All Barangays');
  const expiresIn = String(alertData.expiresIn || '1 Hour');

  return {
    alertId: id,
    id,
    type,
    title,
    message,
    body: message,
    recipientScope,
    targetLocation,
    expiresIn,
    isAdminAlert: 'true',
    click_action: 'FLUTTER_NOTIFICATION_CLICK',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Dispatches FCM notification to a specific topic.
 */
async function sendToTopic(topic, alertData, alertId) {
  const data = buildAlertData(alertData, alertId);

  const message = {
    topic,
    notification: {
      title: `🚨 ${data.title}`,
      body: data.message.length > 150 ? `${data.message.slice(0, 147)}...` : data.message,
    },
    data,
    android: {
      priority: 'high',
      notification: {
        channelId: 'emergency_alerts_channel',
        sound: 'default',
        priority: 'max',
        defaultVibrateTimings: true,
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          contentAvailable: true,
          badge: 1,
        },
      },
    },
  };

  return admin.messaging().send(message);
}

/**
 * Main dispatcher: sends an alert to all residents or specific barangay topics.
 */
async function sendAlertNotification(alertData = {}, alertId) {
  const data = buildAlertData(alertData, alertId);
  const scope = alertData.recipientScope || '';
  const barangays = Array.isArray(alertData.barangays) ? alertData.barangays : [];

  const results = [];

  if (scope.includes('Specific') && barangays.length > 0) {
    // Send to each specific barangay topic
    for (const brgy of barangays) {
      const topic = normalizeBarangayTopic(brgy);
      try {
        const messageId = await sendToTopic(topic, alertData, alertId);
        console.log(`📢 FCM alert pushed to [${topic}] messageId: ${messageId}`);
        results.push({ topic, success: true, messageId });
      } catch (err) {
        console.error(`❌ FCM alert failed for topic [${topic}]:`, err.message);
        results.push({ topic, success: false, error: err.message });
      }
    }
  } else {
    // Broadcast to ALL RESIDENTS
    // Send to both 'all_residents' and 'approved_reports' to guarantee delivery to all devices
    const primaryTopics = [ALL_RESIDENTS_TOPIC, APPROVED_REPORTS_TOPIC];
    for (const topic of primaryTopics) {
      try {
        const messageId = await sendToTopic(topic, alertData, alertId);
        console.log(`📢 FCM alert broadcasted to [${topic}] messageId: ${messageId}`);
        results.push({ topic, success: true, messageId });
      } catch (err) {
        console.error(`❌ FCM alert broadcast failed for [${topic}]:`, err.message);
        results.push({ topic, success: false, error: err.message });
      }
    }
  }

  return results;
}

/**
 * Safe non-blocking wrapper
 */
async function trySendAlertNotification(alertData = {}, alertId) {
  try {
    return await sendAlertNotification(alertData, alertId);
  } catch (error) {
    console.error('❌ FCM alert broadcast failure:', error.message);
    return null;
  }
}

/**
 * Starts a Firestore real-time listener on the 'alerts' collection.
 * Automatically pushes an FCM notification whenever an active alert is created or resent.
 */
let isListenerInitialized = false;

function initAlertsListener(dbInstance) {
  if (isListenerInitialized) return;
  isListenerInitialized = true;

  const db = dbInstance || getFirestore();
  const alertsCol = db.collection('alerts');

  // Track initial load to avoid re-notifying existing alerts on server restart
  let isInitialLoad = true;

  console.log('📡 Starting Firestore Real-Time Alerts Listener for FCM Push...');

  alertsCol.onSnapshot(
    (snapshot) => {
      if (isInitialLoad) {
        isInitialLoad = false;
        console.log(`✅ Real-Time Alerts Listener initialized with ${snapshot.size} existing alerts.`);
        return;
      }

      snapshot.docChanges().forEach(async (change) => {
        const data = change.doc.data();
        const docId = change.doc.id;

        // Trigger notification only if status is 'active' and not archived
        if (data.status === 'active' && !data.isArchived) {
          // Check if this version was already pushed
          const nowMs = Date.now();
          const lastPushedAt = data.fcmLastPushedAt ? new Date(data.fcmLastPushedAt).getTime() : 0;

          // If pushed within the last 10 seconds, skip duplicate
          if (nowMs - lastPushedAt < 10000) {
            return;
          }

          if (change.type === 'added' || change.type === 'modified') {
            console.log(`🚨 Triggering FCM Push for Active Alert: "${data.title}" [${docId}]`);

            // 📡 Real-time Socket.IO Broadcast for open mobile apps
            try {
              const socketModule = require('./socket');
              const io = socketModule.getIO ? socketModule.getIO() : null;
              if (io) {
                io.emit('NEW_BROADCAST_ALERT', {
                  alertId: docId,
                  ...data,
                });
                console.log(`📡 Broadcasted active alert via Socket.IO from Firestore listener: "${data.title}"`);
              }
            } catch (sockErr) {
              // Socket not yet initialized or non-critical error
            }

            // Mark as pushed in Firestore to prevent duplicate triggers
            try {
              await alertsCol.doc(docId).set(
                {
                  fcmLastPushedAt: new Date().toISOString(),
                },
                { merge: true }
              );
            } catch (updateErr) {
              console.warn('Could not update fcmLastPushedAt:', updateErr.message);
            }

            await trySendAlertNotification(data, docId);
          }
        }
      });
    },
    (error) => {
      console.error('❌ Error in Alerts Firestore listener:', error.message);
    }
  );
}

module.exports = {
  ALL_RESIDENTS_TOPIC,
  APPROVED_REPORTS_TOPIC,
  normalizeBarangayTopic,
  sendAlertNotification,
  trySendAlertNotification,
  initAlertsListener,
};
