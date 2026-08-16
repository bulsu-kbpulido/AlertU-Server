const express = require('express');
const router = express.Router();
const socketInit = require('./socket');
const { getMessaging } = require('firebase-admin/messaging');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { verifyToken } = require('./authMiddleware');
const { invalidateAuditLogCache } = require('./auditloglimitcache');

/**
 * Helper to look up an Admin's profile and custom adminId from Firestore
 */
async function getAdminProfile(uid) {
  if (!uid) return null;
  const db = getFirestore();

  try {
    const adminDoc = await db.collection('admins').doc(uid).get();
    if (adminDoc.exists) {
      const data = adminDoc.data();
      return {
        uid,
        adminId: data.adminId || null,
        name: data.name || data.displayName || 'System Admin',
        email: data.email || null,
        department: data.department || null,
      };
    }
  } catch (err) {
    console.error(`⚠️ Error fetching admin profile for UID ${uid}:`, err.message);
  }

  return null;
}

/**
 * Helper to extract Report ID, Citizen ID, or Shared Link details from targets or metadata
 */
function parseTargetEntity(target, metadata) {
  const targetStr = String(target || '').trim();

  // 1️⃣ Check for Citizen Target (e.g. "CID00000001", "CID00000020", "CID_11")
  const cidMatch = targetStr.match(/CID[_\d]+/i) || metadata?.citizenID?.match(/CID[_\d]+/i);
  if (cidMatch) {
    return {
      entityType: 'CITIZEN',
      entityId: cidMatch[0].toUpperCase(),
    };
  }

  // 2️⃣ Check for Report Target (e.g. "RID00000008", "Report_#RID00000008")
  const metadataReportId = metadata?.reportId || metadata?.reportID || metadata?.ReportId;
  const ridMatch =
    targetStr.match(/RID\d+/i) ||
    String(metadataReportId || '').match(/RID\d+/i);

  if (ridMatch) {
    return {
      entityType: 'REPORT',
      entityId: ridMatch[0].toUpperCase(),
    };
  }

  // React may send a Firestore document ID instead of a formatted RID.
  // When reportId metadata is present, preserve the complete identifier.
  if (metadataReportId) {
    return {
      entityType: 'REPORT',
      entityId: String(metadataReportId).trim(),
    };
  }

  // Also support the parent screen's "Report_#..." target format.
  if (/^report[_\s#-]/i.test(targetStr)) {
    return {
      entityType: 'REPORT',
      entityId: targetStr.replace(/^report[_\s#-]*/i, '').trim(),
    };
  }

  // 3️⃣ Check for Shared Link / Broadcast Target (e.g. 24-char hex key, link URLs, or linkKey in metadata)
  const isHexKey = /^[a-f0-9]{24}$/i.test(targetStr);
  if (isHexKey || metadata?.linkKey || targetStr.includes('/report/') || metadata?.targetDepartment) {
    return {
      entityType: 'LINK',
      entityId: metadata?.linkKey || targetStr,
    };
  }

  return {
    entityType: 'UNKNOWN',
    entityId: targetStr,
  };
}

/**
 * Helper to fetch Citizen identifiers (CID / authUid) linked to a Report or Citizen ID
 */
async function resolveCitizenTarget(entityType, entityId, metadata) {
  if (!entityId || entityType === 'LINK') return null;
  const db = getFirestore();

  try {
    // 1️⃣ Direct Citizen Lookup
    if (entityType === 'CITIZEN') {
      const citizenDoc = await db.collection('citizens').doc(entityId).get();
      if (citizenDoc.exists) {
        const data = citizenDoc.data();
        return {
          citizenID: entityId,
          authUid: data.authUid || data.uid || null,
        };
      }

      const citizenQuery = await db
        .collection('citizens')
        .where('citizenID', '==', entityId)
        .limit(1)
        .get();

      if (!citizenQuery.empty) {
        const data = citizenQuery.docs[0].data();
        return {
          citizenID: entityId,
          authUid: data.authUid || data.uid || null,
        };
      }
    }

    // 2️⃣ Report Lookup (Resolves associated Citizen)
    if (entityType === 'REPORT') {
      let trackingDoc = await db.collection('citizenreporttracking').doc(entityId).get();
      if (trackingDoc.exists) {
        const data = trackingDoc.data();
        return {
          citizenID: data.CID || data.citizenID || data.citizenId || null,
          authUid: data.authUid || data.uid || null,
        };
      }

      const trackingQuery = await db
        .collection('citizenreporttracking')
        .where('ReportId', '==', entityId)
        .limit(1)
        .get();

      if (!trackingQuery.empty) {
        const data = trackingQuery.docs[0].data();
        return {
          citizenID: data.CID || data.citizenID || data.citizenId || null,
          authUid: data.authUid || data.uid || null,
        };
      }

      let reportDoc = await db.collection('reports').doc(entityId).get();
      if (reportDoc.exists) {
        const data = reportDoc.data();
        return {
          citizenID: data.citizenID || data.CID || data.citizenId || null,
          authUid: data.authUid || data.uid || null,
        };
      }
    }
  } catch (err) {
    console.error(`⚠️ Error resolving citizen for ${entityType} ${entityId}:`, err.message);
  }

  return {
    citizenID: metadata?.citizenID || null,
    authUid: metadata?.authUid || null,
  };
}

/**
 * Helper function to send targeted FCM notifications for report updates AND citizen profile movements
 */
async function dispatchTargetedFcmNotification(payload, targetedCitizen) {
  const messaging = getMessaging();

  const targetTopic = targetedCitizen?.citizenID
    ? `citizen_${targetedCitizen.citizenID}`
    : targetedCitizen?.authUid
    ? `user_${targetedCitizen.authUid}`
    : null;

  if (!targetTopic) return;

  const upperAction = String(payload.action).toUpperCase();

  let notificationTitle = null;
  let notificationBody = null;

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
  } else if (upperAction === 'DISABLE_CITIZEN_ACCOUNT') {
    notificationTitle = '⚠️ Account Disabled';
    notificationBody = 'Your citizen account has been temporarily disabled by an administrator.';
  } else if (upperAction === 'ENABLE_CITIZEN_ACCOUNT') {
    notificationTitle = '✅ Account Re-activated';
    notificationBody = 'Your citizen account has been re-activated by an administrator.';
  } else if (upperAction === 'EDIT_CITIZEN') {
    notificationTitle = 'ℹ️ Profile Updated';
    notificationBody = 'An administrator updated your profile information.';
  }

  if (!notificationTitle) {
    return;
  }

  const message = {
    notification: {
      title: notificationTitle,
      body: notificationBody,
    },
    data: {
      eventId: String(payload.eventId),
      action: String(payload.action),
      target: String(payload.target),
      reportId: String(payload.reportId || ''),
      citizenID: String(payload.citizenID || ''),
      adminId: String(payload.adminId || ''),
      timestamp: String(payload.timestamp),
      metadata: JSON.stringify(payload.metadata || {}),
    },
    topic: targetTopic,
  };

  const response = await messaging.send(message);
  console.log(`📲 [Targeted FCM Dispatched] Topic: ${targetTopic} | Message ID: ${response}`);
}

/**
 * 📡 POST /api/admin-actions/log
 * Handles audit logs for Report Verification workflows, Citizen Management movements, and Link Sharing / Broadcasts.
 */
router.post('/admin-actions/log', verifyToken, async (req, res, next) => {
  try {
    const { action, target, metadata, targetRoom, adminId: bodyAdminId, adminName: bodyAdminName } = req.body;
    const db = getFirestore();

    // 1. Validation
    if (!action || !target) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: "action" and "target" are required.',
      });
    }

    // 2. Resolve Admin Profile & adminId
    const authUid = req.user?.uid;
    const adminProfile = await getAdminProfile(authUid);

    const adminId = adminProfile?.adminId || bodyAdminId || 'ADMIN-004';
    const adminName = adminProfile?.name || bodyAdminName || 'System Admin';

    // 3. Resolve Target Entity (REPORT, CITIZEN, LINK, or UNKNOWN)
    const { entityType, entityId } = parseTargetEntity(target, metadata);
    let targetedCitizen = await resolveCitizenTarget(entityType, entityId, metadata);

    // If report tracking contains only a CID, resolve the Auth UID as well so
    // Flutter clients that join by Firebase UID receive the event.
    if (targetedCitizen?.citizenID && !targetedCitizen?.authUid) {
      try {
        const citizenQuery = await db
          .collection('citizens')
          .where('citizenID', '==', targetedCitizen.citizenID)
          .limit(1)
          .get();

        if (!citizenQuery.empty) {
          const citizenData = citizenQuery.docs[0].data();
          targetedCitizen = {
            ...targetedCitizen,
            authUid: citizenData.authUid || citizenData.uid || null,
          };
        }
      } catch (lookupErr) {
        console.warn(`⚠️ Could not enrich citizen Auth UID for ${targetedCitizen.citizenID}:`, lookupErr.message);
      }
    }

    // 4. Generate Console Log String and Format Payload
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const consoleLogMessage = `⚡ [Admin Movement Captured] [ID: ${adminId}] ${adminName} → ${action} (${target})`;

    const actionPayload = {
      eventId,
      action,
      target,
      entityType,
      reportId: entityType === 'REPORT' ? entityId : metadata?.reportId || null,
      citizenID: targetedCitizen?.citizenID || (entityType === 'CITIZEN' ? entityId : null),
      authUid: targetedCitizen?.authUid || null,
      adminId,
      adminUid: authUid || null,
      adminName,
      department: adminProfile?.department || null,
      consoleLogMessage, // 📌 Saves the formatted node console log string
      metadata: {
        ...metadata,
      },
      timestamp: new Date().toISOString(),
    };

    // Print to Node.js backend console
    console.log(consoleLogMessage);

    // 5. 💾 Persist to `audit_logs` collection in Firestore & Invalidate Cache
    try {
      await db.collection('audit_logs').doc(eventId).set({
        ...actionPayload,
        createdAt: FieldValue.serverTimestamp(),
      });
      
      // 🧹 Invalidate in-memory audit log cache on new write
      invalidateAuditLogCache();

      const firestorePersistLog = `💾 Persisted admin movement audit log ${eventId} to Firestore.`;
      console.log(firestorePersistLog);

      // Append terminal output trace inside Firestore metadata doc
      await db.collection('audit_logs').doc(eventId).update({
        systemLogTrace: FieldValue.arrayUnion(consoleLogMessage, firestorePersistLog)
      });
    } catch (dbErr) {
      console.error(`❌ Failed to persist audit log to Firestore:`, dbErr.message);
    }

    // 6. 🚀 Relay via WebSockets
    try {
      const io = socketInit.getIO();

      io.to('super_admins').emit('AUDIT_LOG_EVENT', actionPayload);
      io.to('super_admins').emit('admin_movement_log', actionPayload);

      // Keep the existing explicitly requested-room behavior for admin/dashboard consumers.
      if (targetRoom && targetRoom !== 'super_admins') {
        io.to(targetRoom).emit('ADMIN_ACTION_EVENT', actionPayload);
        io.to(targetRoom).emit('CITIZEN_REPORT_UPDATED', actionPayload);
        io.to(targetRoom).emit('CITIZEN_ACCOUNT_UPDATED', actionPayload);
      }

      // Also always notify the resolved citizen rooms. This must not be an
      // else-if because React may provide targetRoom while the citizen is
      // identified separately by authUid and/or citizenID.
      const citizenRooms = new Set([
        targetedCitizen?.authUid,
        targetedCitizen?.citizenID,
        actionPayload.authUid,
        actionPayload.citizenID,
      ].filter(Boolean).map(String));

      for (const citizenRoom of citizenRooms) {
        io.to(citizenRoom).emit('ADMIN_ACTION_EVENT', actionPayload);
        io.to(citizenRoom).emit('CITIZEN_REPORT_UPDATED', actionPayload);
        io.to(citizenRoom).emit('CITIZEN_ACCOUNT_UPDATED', actionPayload);
      }

      if (citizenRooms.size > 0) {
        console.log(
          `📡 Verification events emitted to citizen rooms: ${Array.from(citizenRooms).join(', ')}`,
        );
      }
    } catch (wsErr) {
      console.warn('⚠️ WebSockets failed or not initialized:', wsErr.message);
    }

    // 7. 📲 Targeted FCM Push Notification (if applicable)
    if (targetedCitizen) {
      dispatchTargetedFcmNotification(actionPayload, targetedCitizen).catch((fcmErr) => {
        console.error('❌ Failed to dispatch Targeted FCM Push Notification:', fcmErr.message);
      });
    }

    // 8. Response
    return res.status(200).json({
      success: true,
      message: `Admin action (${action}) logged successfully.`,
      eventId: actionPayload.eventId,
      adminId: actionPayload.adminId,
      consoleLogMessage: actionPayload.consoleLogMessage,
      entityType,
      targetedCitizen,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;