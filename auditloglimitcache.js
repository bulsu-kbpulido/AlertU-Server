const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();

/**
 * =========================================================================
 * IN-MEMORY DATA CACHE ENGINES FOR AUDIT LOGS
 * =========================================================================
 */
const auditLogCache = {
  data: null,
  timestamp: 0,
  queryLimit: 0, // Stores the query limit used during the last cache hydration
};

// Cache Time-To-Live in milliseconds (30 seconds)
const CACHE_TTL_MS = 30 * 1000;

/**
 * Helper function to invalidate cache on new audit log writes or mutations
 */
function invalidateAuditLogCache() {
  auditLogCache.data = null;
  auditLogCache.timestamp = 0;
  auditLogCache.queryLimit = 0;
}

/**
 * Helper function: Converts Firestore Timestamps, JS Dates, or strings into ISO strings.
 */
function parseTimestamp(timestamp, fallbackTimestamp = null) {
  const val = timestamp || fallbackTimestamp;
  if (!val) return new Date().toISOString();

  try {
    if (typeof val.toDate === 'function') {
      return val.toDate().toISOString();
    }

    if (val instanceof Date) {
      return val.toISOString();
    }

    if (typeof val === 'object' && val !== null) {
      const seconds = val.seconds ?? val._seconds;
      if (seconds !== undefined && seconds !== null) {
        return new Date(seconds * 1000).toISOString();
      }
    }

    if (typeof val === 'number') {
      const ms = val < 10000000000 ? val * 1000 : val;
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d.toISOString();
    }

    const parsedDate = new Date(val);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate.toISOString();
    }
  } catch (err) {
    console.warn('⚠️ Audit log timestamp parsing warning:', err.message);
  }

  return new Date().toISOString();
}

/**
 * Helper to construct the exact backend console string if missing
 */
function getConsoleLogString(log) {
  if (log.consoleLogMessage) {
    return log.consoleLogMessage;
  }
  const adminId = log.adminId || 'ADMIN';
  const adminName = log.adminName || log.performedBy || 'System Admin';
  const action = log.action || 'SYSTEM_ACTION';
  const target = log.target || log.targetUser || 'N/A';

  return `⚡ [Admin Movement Captured] [ID: ${adminId}] ${adminName} → ${action} (${target})`;
}

// =========================================================================
// CORE ROUTE HANDLERS
// =========================================================================

/**
 * 1. GET ALL AUDIT LOGS (WITH MEMORY CACHE ENGINE & CONFIGURABLE LIMITS)
 * GET /api/audit-logs?queryLimit=100
 */
router.get('/audit-logs', async (req, res) => {
  try {
    const now = Date.now();
    const parsedLimit = parseInt(req.query.queryLimit, 10) || 100;

    // Check if valid cache exists for the requested or higher limit window
    const isCacheValid =
      auditLogCache.data &&
      now - auditLogCache.timestamp < CACHE_TTL_MS &&
      auditLogCache.queryLimit >= parsedLimit;

    if (isCacheValid) {
      // Serve sliced data based on requested limit from valid cache
      const slicedCache = auditLogCache.data.slice(0, parsedLimit);
      return res.status(200).json({
        success: true,
        count: slicedCache.length,
        cached: true,
        data: slicedCache,
      });
    }

    // Fetch fresh logs from Firestore
    const snapshot = await db
      .collection('audit_logs')
      .orderBy('createdAt', 'desc')
      .limit(parsedLimit)
      .get();

    const logs = snapshot.docs.map((doc) => {
      const data = doc.data();
      const consoleLogMessage = getConsoleLogString(data);

      return {
        id: doc.id,
        eventId: data.eventId || doc.id,
        action: data.action || null,
        target: data.target || null,
        entityType: data.entityType || 'UNKNOWN',
        reportId: data.reportId || null,
        citizenID: data.citizenID || null,
        authUid: data.authUid || null,
        adminId: data.adminId || 'ADMIN',
        adminUid: data.adminUid || null,
        adminName: data.adminName || data.performedBy || 'System Admin',
        department: data.department || null,
        consoleLogMessage,
        metadata: data.metadata || {},
        systemLogTrace: data.systemLogTrace || [],
        timestamp: parseTimestamp(data.createdAt, data.timestamp),
        createdAt: parseTimestamp(data.createdAt, data.timestamp),
      };
    });

    // Populate memory cache engine
    auditLogCache.data = logs;
    auditLogCache.timestamp = now;
    auditLogCache.queryLimit = parsedLimit;

    return res.status(200).json({
      success: true,
      count: logs.length,
      cached: false,
      data: logs,
    });
  } catch (error) {
    console.error('Error fetching cached audit logs:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 2. GET SINGLE AUDIT LOG ENTRY BY EVENT ID
 * GET /api/audit-logs/:eventId
 */
router.get('/audit-logs/:eventId', async (req, res) => {
  try {
    const eventId = String(req.params.eventId).trim();

    // Check if present in memory cache first
    if (auditLogCache.data) {
      const cachedEntry = auditLogCache.data.find(
        (log) => log.id === eventId || log.eventId === eventId
      );
      if (cachedEntry) {
        return res.status(200).json({ success: true, cached: true, data: cachedEntry });
      }
    }

    // Direct Firestore lookup fallback
    const docRef = db.collection('audit_logs').doc(eventId);
    let docSnap = await docRef.get();

    if (!docSnap.exists) {
      const querySnap = await db
        .collection('audit_logs')
        .where('eventId', '==', eventId)
        .limit(1)
        .get();

      if (!querySnap.empty) {
        docSnap = querySnap.docs[0];
      } else {
        return res.status(404).json({ success: false, message: 'Audit log entry not found.' });
      }
    }

    const data = docSnap.data();
    const formattedLog = {
      id: docSnap.id,
      eventId: data.eventId || docSnap.id,
      action: data.action || null,
      target: data.target || null,
      entityType: data.entityType || 'UNKNOWN',
      reportId: data.reportId || null,
      citizenID: data.citizenID || null,
      authUid: data.authUid || null,
      adminId: data.adminId || 'ADMIN',
      adminUid: data.adminUid || null,
      adminName: data.adminName || data.performedBy || 'System Admin',
      department: data.department || null,
      consoleLogMessage: getConsoleLogString(data),
      metadata: data.metadata || {},
      systemLogTrace: data.systemLogTrace || [],
      timestamp: parseTimestamp(data.createdAt, data.timestamp),
      createdAt: parseTimestamp(data.createdAt, data.timestamp),
    };

    return res.status(200).json({ success: true, cached: false, data: formattedLog });
  } catch (error) {
    console.error(`Error fetching audit log ${req.params.eventId}:`, error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 3. POST: EXPLICIT CACHE INVALIDATION
 * POST /api/audit-logs/clear-cache
 */
router.post('/audit-logs/clear-cache', (req, res) => {
  invalidateAuditLogCache();
  return res.status(200).json({
    success: true,
    message: 'Audit log in-memory cache successfully invalidated.',
  });
});

module.exports = {
  router,
  invalidateAuditLogCache,
};