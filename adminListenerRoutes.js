const express = require('express');
const router = express.Router();
const socketInit = require('./socket');
const { getMessaging } = require('firebase-admin/messaging');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

/**
 * Resolve the authenticated admin profile and its human-readable adminId.
 * This preserves values such as ADMIN-004 in the socket/FCM payload.
 */
async function getAdminProfileFromRequest(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;

  try {
    const decodedToken = await getAuth().verifyIdToken(authHeader.substring(7));
    const uid = decodedToken.uid;
    const adminDoc = await getFirestore().collection('admins').doc(uid).get();

    if (!adminDoc.exists) {
      return { uid, adminId: null, name: decodedToken.name || 'System Admin', department: null };
    }

    const data = adminDoc.data();
    return {
      uid,
      adminId: data.adminId || null,
      name: data.name || data.displayName || decodedToken.name || 'System Admin',
      department: data.department || null,
    };
  } catch (error) {
    console.warn('⚠️ Could not resolve authenticated admin profile:', error.message);
    return null;
  }
}

/**
 * Helper to fetch Citizen identifiers (CID / authUid) linked to a Report ID
 */
async function getCitizenByReportId(reportId) {
  if (!reportId) return null;
  const db = getFirestore();

  try {
    // 1️⃣ Look up in `citizenreporttracking` collection by document ID
    let trackingDoc = await db.collection('citizenreporttracking').doc(reportId).get();

    if (trackingDoc.exists) {
      const data = trackingDoc.data();
      return {
        citizenID: data.CID || data.citizenID || data.citizenId || null,
        authUid: data.authUid || data.uid || null,
      };
    }

    // Fallback searches in tracking records using common report-ID field names.
    for (const fieldName of ['ReportId', 'reportId', 'reportID', 'reportDocId']) {
      const trackingQuery = await db.collection('citizenreporttracking')
        .where(fieldName, '==', reportId)
        .limit(1)
        .get();

      if (!trackingQuery.empty) {
        const data = trackingQuery.docs[0].data();
        return {
          citizenID: data.CID || data.citizenID || data.citizenId || null,
          authUid: data.authUid || data.authUID || data.uid || data.userId || data.userUID || null,
        };
      }
    }

    // The report may already have moved to approved_reports after dispatch.
    // Search both collections by document ID and common report-ID fields.
    for (const collectionName of ['reports', 'approved_reports']) {
      const reportDoc = await db.collection(collectionName).doc(reportId).get();
      if (reportDoc.exists) {
        const data = reportDoc.data();
        return {
          citizenID: data.citizenID || data.CID || data.citizenId || data.submitterCitizenID || null,
          authUid: data.authUid || data.authUID || data.uid || data.userId || data.userUID || null,
        };
      }

      for (const fieldName of [
        'reportID',
        'reportId',
        'ReportId',
        'documentId',
        'verifiedReportId',
        'verifiedreportID',
      ]) {
        const reportQuery = await db.collection(collectionName)
          .where(fieldName, '==', reportId)
          .limit(1)
          .get();

        if (!reportQuery.empty) {
          const data = reportQuery.docs[0].data();
          return {
            citizenID: data.citizenID || data.CID || data.citizenId || data.submitterCitizenID || null,
            authUid: data.authUid || data.authUID || data.uid || data.userId || data.userUID || null,
          };
        }
      }
    }
  } catch (err) {
    console.error(`⚠️ Error resolving citizen for report ${reportId}:`, err.message);
  }

  return null;
}

/**
 * Helper to extract Report ID from string targets (e.g. "Report_#RID00000001" -> "RID00000001")
 */
function extractReportId(target, metadata) {
  if (metadata?.reportId) return metadata.reportId;
  if (metadata?.reportID) return metadata.reportID;
  if (!target) return null;

  const rawTarget = String(target).trim();

  // Match formatted report IDs such as RID00000001 inside a display target.
  const match = rawTarget.match(/RID\d+/i);
  if (match) return match[0].toUpperCase();

  // Preserve arbitrary Firestore document IDs as valid lookup keys.
  return rawTarget
    .replace(/^Report[_\s-]*#?/i, '')
    .replace(/^#/, '')
    .trim() || null;
}

/**
 * 📡 POST /api/admin-actions/log
 * Captures UI actions from Web Admin (e.g., Opening Verify Modal for RID00000001),
 * relays targeted updates via Socket.io to the submitter, and dispatches targeted FCM.
 */
router.post('/admin-actions/log', async (req, res, next) => {
  try {
    const {
      action,
      target,
      adminName: bodyAdminName,
      adminId: bodyAdminId,
      metadata,
      targetRoom,
    } = req.body;

    // 1. Validation
    if (!action || !target) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: "action" and "target" are required.',
      });
    }

    // Resolve the real admin identity before creating the event payload.
    const adminProfile = await getAdminProfileFromRequest(req);
    const adminId =
      adminProfile?.adminId ||
      (bodyAdminId && bodyAdminId !== 'admin_123' ? bodyAdminId : null) ||
      'ADMIN-004';
    const resolvedAdminName =
      adminProfile?.name || bodyAdminName || 'System Admin';

    // Extract cleanest report ID possible
    const reportId = extractReportId(target, metadata);

    // 2. Resolve Target Citizen details from Firestore
    let targetedCitizen = null;
    if (reportId) {
      targetedCitizen = await getCitizenByReportId(reportId);
    }

    // Flutter registers its socket using the Firebase Auth UID. If the
    // tracking record contains only a citizen ID, resolve the UID as well.
    if (targetedCitizen?.citizenID && !targetedCitizen?.authUid) {
      try {
        const db = getFirestore();
        const citizenQuery = await db
          .collection('citizens')
          .where('citizenID', '==', targetedCitizen.citizenID)
          .limit(1)
          .get();

        if (!citizenQuery.empty) {
          const citizenData = citizenQuery.docs[0].data();
          targetedCitizen = {
            ...targetedCitizen,
            authUid: citizenData.authUid ||
              citizenData.authUID ||
              citizenData.uid ||
              citizenData.userId ||
              citizenData.userUID ||
              null,
          };
        }
      } catch (lookupErr) {
        console.warn(
          `⚠️ Could not enrich citizen Auth UID for ${targetedCitizen.citizenID}:`,
          lookupErr.message,
        );
      }
    }

    // 3. Format Standardized Event Payload
    const actionPayload = {
      eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      action,
      target,
      reportId: reportId || null,
      citizenID: targetedCitizen?.citizenID || null,
      authUid: targetedCitizen?.authUid || null,
      adminName: resolvedAdminName,
      adminId,
      adminUid: adminProfile?.uid || null,
      department: adminProfile?.department || null,
      metadata: metadata || {},
      timestamp: new Date().toISOString(),
    };

    console.log(`⚡ [Admin Action Captured] [ID: ${actionPayload.adminId}] ${actionPayload.adminName} → ${actionPayload.action} (${actionPayload.target})`);

    // 4. 🚀 Targeted Relay via WebSockets
    try {
      const io = socketInit.getIO();

      if (targetRoom && targetRoom !== 'super_admins') {
        // Preserve explicit-room delivery for admin/dashboard consumers.
        io.to(targetRoom).emit('ADMIN_ACTION_EVENT', actionPayload);
        console.log(`📡 Broadcasted to specified room: ${targetRoom}`);
      }

      if (targetedCitizen?.authUid || targetedCitizen?.citizenID) {
        // TARGET ONLY THE CITIZEN WHO REPORTED THIS INCIDENT
        if (targetedCitizen.authUid) {
          io.to(targetedCitizen.authUid).emit('ADMIN_ACTION_EVENT', actionPayload);
          io.to(targetedCitizen.authUid).emit('CITIZEN_REPORT_UPDATED', actionPayload);
        }
        if (targetedCitizen.citizenID) {
          io.to(targetedCitizen.citizenID).emit('ADMIN_ACTION_EVENT', actionPayload);
          io.to(targetedCitizen.citizenID).emit('CITIZEN_REPORT_UPDATED', actionPayload);
        }

        // Also emit to super_admins so other Web Admin panels stay updated
        io.to('super_admins').emit('ADMIN_ACTION_EVENT', actionPayload);

        console.log(`📡 Targeted notification emitted strictly to citizen rooms (${targetedCitizen.citizenID} / ${targetedCitizen.authUid}) and super_admins`);
      } else {
        // System admin monitoring rooms only (DO NOT broadcast globally to all citizens)
        io.to('super_admins').emit('ADMIN_ACTION_EVENT', actionPayload);
        console.log(`📡 Broadcasted strictly to admin monitoring room (super_admins)`);
      }
    } catch (wsErr) {
      console.warn('⚠️ WebSockets failed or not initialized:', wsErr.message);
    }

    // The super-admin movement detector is mounted immediately after this
    // listener and owns the final response, audit-log persistence, adminId
    // formatting, and one-time FCM dispatch. Continue the same request so
    // both systems execute instead of one route shadowing the other.
    req.mobileNotificationPayload = actionPayload;
    return next();
  } catch (error) {
    next(error);
  }
});

/**
 * Helper function to send targeted FCM notifications to specific citizen topic
 */
async function dispatchTargetedFcmNotification(payload, targetedCitizen) {
  const messaging = getMessaging();
  const db = getFirestore();

  // Respect the citizen’s persisted notification preference.
  // Existing citizens without this field remain enabled by default.
  let citizenSnapshot = null;
  const citizens = db.collection('citizens');
  const targetUid = targetedCitizen?.authUid || targetedCitizen?.uid;

  if (targetUid) {
    citizenSnapshot = await citizens.doc(targetUid).get();

    if (!citizenSnapshot.exists) {
      const authUidQuery = await citizens
        .where('authUid', '==', targetUid)
        .limit(1)
        .get();
      citizenSnapshot = authUidQuery.empty ? null : authUidQuery.docs[0];
    }

    if (!citizenSnapshot?.exists) {
      const uidQuery = await citizens
        .where('uid', '==', targetUid)
        .limit(1)
        .get();
      citizenSnapshot = uidQuery.empty ? null : uidQuery.docs[0];
    }
  }

  if (!citizenSnapshot?.exists && targetedCitizen?.citizenID) {
    const query = await citizens
      .where('citizenID', '==', targetedCitizen.citizenID)
      .limit(1)
      .get();
    citizenSnapshot = query.empty ? null : query.docs[0];
  }

  if (citizenSnapshot?.exists && citizenSnapshot.data()?.notificationsEnabled === false) {
    console.log(`🔕 FCM suppressed for citizen ${targetedCitizen.citizenID || targetUid}: notifications disabled.`);
    return;
  }

  // Target specific citizen topic (e.g., `citizen_CID00000001` or `user_AUTHUID`)
  const targetTopic = targetedCitizen?.citizenID 
    ? `citizen_${targetedCitizen.citizenID}` 
    : (targetedCitizen?.authUid ? `user_${targetedCitizen.authUid}` : null);

  if (!targetTopic) return;

  // 🎯 Format human-readable title & message based on action status
  let notificationTitle = `Report Update: ${payload.action}`;
  let notificationBody = `Your report ${payload.reportId || payload.target} was updated by ${payload.adminName}.`;

  const upperAction = String(payload.action).toUpperCase();

  if (
    upperAction === 'REPORT_VERIFIED' ||
    upperAction === 'VERIFIED_REPORT_DISPATCH' ||
    upperAction === 'DISPATCH_FINALIZED'
  ) {
    notificationTitle = '🎉 Report Approved & Dispatched';
    notificationBody = `Your emergency report (${payload.reportId || payload.target}) has been verified and dispatched to responders.`;
  } else if (
    upperAction === 'OPEN_VERIFY_MODAL' ||
    upperAction === 'START_VERIFY_WORKFLOW'
  ) {
    notificationTitle = '🔍 Report Under Review';
    notificationBody = `Your emergency report (${payload.reportId || payload.target}) is currently being reviewed by system operators.`;
  }

  const message = {
    notification: {
      title: notificationTitle,
      body: notificationBody,
    },
    // FCM data fields MUST strictly be strings
    data: {
      eventId: String(payload.eventId),
      action: String(payload.action),
      target: String(payload.target),
      reportId: String(payload.reportId || ''),
      citizenID: String(payload.citizenID || ''),
      timestamp: String(payload.timestamp),
      metadata: JSON.stringify(payload.metadata || {}),
    },
    topic: targetTopic,
  };

  const response = await messaging.send(message);
  console.log(`📲 [Targeted FCM Dispatched] Topic: ${targetTopic} | Message ID: ${response}`);
}

module.exports = router;