// alertNotifs.js - FCM Push Notification Service for Broadcast Alerts
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

/**
 * Topics every citizen device subscribes to on launch (see the mobile app's
 * NotificationService.subscribeToPublicTopics).
 */
const ALL_RESIDENTS_TOPIC = 'all_residents';
const APPROVED_REPORTS_TOPIC = 'approved_reports'; // legacy public topic, still subscribed by the app

// Same channel id the mobile app creates in NotificationService._emergencyChannel
const ANDROID_CHANNEL_ID = 'emergency_alerts_channel';

// A phone that has been offline longer than this shouldn't get a stale alert.
const ALERT_TTL_MS = 60 * 60 * 1000;

// The route and the Firestore listener can both fire for one press of
// Send/Resend. Anything for the same alert inside this window is one send.
const DUPLICATE_WINDOW_MS = 8000;

/**
 * Normalizes a barangay name to the FCM topic the mobile app subscribes to.
 * MUST mirror NotificationService.normalizeBarangayTopic in the Flutter app,
 * otherwise a barangay's residents never receive its alerts
 * (e.g. "Santo Niño" -> barangay_santo_nino).
 */
function normalizeBarangayTopic(barangayName = '') {
  const cleaned = String(barangayName)
    .trim()
    .toLowerCase()
    .replace(/^(brgy\.?|barangay)\s*/i, '')
    .replace(/\bsto\.?\s*/gi, 'santo_')
    .replace(/\bsta\.?\s*/gi, 'santa_')
    .replace(/[ñÑ]/g, 'n')
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `barangay_${cleaned}`;
}

/**
 * Builds normalized FCM data payload for an alert.
 * Note: All FCM data payload values MUST be strings.
 */
function buildAlertData(alertData = {}, alertId, sendId) {
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
    sendId: String(sendId),
    timestamp: new Date().toISOString(),
  };
}

/** First usable https photo attached by the admin, for the notification image. */
function firstImageUrl(alertData = {}) {
  const urls = Array.isArray(alertData.imageUrls) ? alertData.imageUrls : [];
  return urls.find((u) => typeof u === 'string' && /^https:\/\//i.test(u));
}

/**
 * Dispatches one FCM message to a target: { topic } or { condition }.
 */
async function sendToTarget(target, alertData, alertId, sendId) {
  const data = buildAlertData(alertData, alertId, sendId);
  const imageUrl = firstImageUrl(alertData);

  const message = {
    ...target,
    notification: {
      title: `🚨 ${data.title}`,
      body: data.message.length > 150 ? `${data.message.slice(0, 147)}...` : data.message,
      ...(imageUrl ? { imageUrl } : {}),
    },
    data,
    android: {
      priority: 'high',
      ttl: ALERT_TTL_MS,
      notification: {
        channelId: ANDROID_CHANNEL_ID,
        sound: 'default',
        priority: 'max',
        defaultVibrateTimings: true,
        // Unique per send, so a Resend appears as a NEW notification rather
        // than being merged into (and silently replacing) the previous one.
        tag: `${data.alertId}-${sendId}`,
      },
    },
    apns: {
      headers: { 'apns-priority': '10' },
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
 * Sends an alert to all residents or specific barangay topics.
 * Returns one result entry per FCM message.
 */
async function sendAlertNotification(alertData = {}, alertId, sendId = Date.now()) {
  const scope = alertData.recipientScope || '';
  const barangays = Array.isArray(alertData.barangays) ? alertData.barangays : [];

  const targets = [];
  if (scope.includes('Specific') && barangays.length > 0) {
    for (const brgy of barangays) {
      const topic = normalizeBarangayTopic(brgy);
      targets.push({ label: topic, target: { topic } });
    }
  } else {
    // Every device is subscribed to BOTH all_residents and approved_reports.
    // Sending to each topic separately delivered every alert twice; one
    // condition message reaches each device exactly once.
    targets.push({
      label: `${ALL_RESIDENTS_TOPIC}|${APPROVED_REPORTS_TOPIC}`,
      target: {
        condition: `'${ALL_RESIDENTS_TOPIC}' in topics || '${APPROVED_REPORTS_TOPIC}' in topics`,
      },
    });
  }

  const results = [];
  for (const { label, target } of targets) {
    try {
      const messageId = await sendToTarget(target, alertData, alertId, sendId);
      console.log(`📢 FCM alert pushed to [${label}] messageId: ${messageId}`);
      results.push({ topic: label, success: true, messageId });
    } catch (err) {
      console.error(`❌ FCM alert failed for [${label}]:`, err.message);
      results.push({ topic: label, success: false, error: err.message });
    }
  }
  return results;
}

// alertId -> timestamp of the last send, shared by the route and the listener.
const recentSends = new Map();

/**
 * The single entry point for delivering an alert: socket event for open apps
 * plus the FCM push for closed apps. Safe to call from several places for the
 * same press of Send/Resend -- duplicates inside DUPLICATE_WINDOW_MS are
 * collapsed, but a later Resend always goes out again.
 *
 * Resolves to { skipped, results }. Never throws.
 */
async function broadcastAlert(alertData = {}, alertId) {
  const id = String(alertId || alertData.id || '');
  const now = Date.now();

  if (id) {
    const last = recentSends.get(id);
    if (last && now - last < DUPLICATE_WINDOW_MS) {
      console.log(`⏭️  Alert ${id} was just broadcast; skipping duplicate trigger.`);
      return { skipped: true, results: [] };
    }
    recentSends.set(id, now);
    // keep the map small
    for (const [key, ts] of recentSends) {
      if (now - ts > 10 * 60 * 1000) recentSends.delete(key);
    }
  }

  // 📡 Socket.IO for apps that are open right now
  try {
    const socketModule = require('./socket');
    const io = socketModule.getIO ? socketModule.getIO() : null;
    if (io) {
      io.emit('NEW_BROADCAST_ALERT', { alertId: id || undefined, ...alertData });
      console.log(`📡 Socket.IO [NEW_BROADCAST_ALERT]: "${alertData.title || id}"`);
    }
  } catch (sockErr) {
    console.warn('⚠️ Socket alert broadcast warning:', sockErr.message);
  }

  let results = [];
  try {
    results = await sendAlertNotification(alertData, id, now);
  } catch (error) {
    console.error('❌ FCM alert broadcast failure:', error.message);
    results = [{ topic: 'n/a', success: false, error: error.message }];
  }

  // If nothing went out, let the next trigger try again instead of skipping it.
  if (id && results.length > 0 && results.every((r) => !r.success)) {
    recentSends.delete(id);
  }

  return { skipped: false, results };
}

/** Kept for backwards compatibility with older imports. */
async function trySendAlertNotification(alertData = {}, alertId) {
  const { results } = await broadcastAlert(alertData, alertId);
  return results;
}

// Latest explicit send of an alert: the dashboard stamps `sentAt` on
// "Send Now" and `resentAt` on "Resend".
function sendVersionOf(data = {}) {
  let best = 0;
  for (const key of ['sentAt', 'resentAt']) {
    const v = data[key];
    const ms = v && typeof v.toMillis === 'function' ? v.toMillis() : 0;
    if (ms > best) best = ms;
  }
  return best;
}

/**
 * Real-time listener on the 'alerts' collection. The dashboard also calls
 * POST /api/alerts/broadcast, and both routes into broadcastAlert(), which
 * de-duplicates. The listener is the safety net for alerts that become active
 * without that call (e.g. scheduled alerts activated elsewhere).
 *
 * It only reacts to real "send" events -- a new active alert, a status change
 * to active, or a Send Now / Resend -- not to every edit of an active alert.
 */
let isListenerInitialized = false;

function initAlertsListener(dbInstance) {
  if (isListenerInitialized) return;
  isListenerInitialized = true;

  const db = dbInstance || getFirestore();
  const alertsCol = db.collection('alerts');

  const lastSeen = new Map(); // docId -> { status, version }
  let isInitialLoad = true;

  console.log('📡 Starting Firestore Real-Time Alerts Listener for FCM Push...');

  alertsCol.onSnapshot(
    (snapshot) => {
      if (isInitialLoad) {
        isInitialLoad = false;
        snapshot.forEach((doc) => {
          const d = doc.data();
          lastSeen.set(doc.id, { status: d.status, version: sendVersionOf(d) });
        });
        console.log(`✅ Real-Time Alerts Listener initialized with ${snapshot.size} existing alerts.`);
        return;
      }

      snapshot.docChanges().forEach((change) => {
        const docId = change.doc.id;

        if (change.type === 'removed') {
          lastSeen.delete(docId);
          return;
        }

        const data = change.doc.data();
        const prev = lastSeen.get(docId);
        const version = sendVersionOf(data);
        lastSeen.set(docId, { status: data.status, version });

        if (data.status !== 'active' || data.isArchived) return;

        const becameActive = !prev || prev.status !== 'active';
        const sentAgain = !!prev && version > prev.version;
        if (!becameActive && !sentAgain) return;

        console.log(`🚨 Listener triggering push for active alert: "${data.title}" [${docId}]`);
        broadcastAlert(data, docId);
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
  broadcastAlert,
  trySendAlertNotification,
  initAlertsListener,
};
