const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// Firebase Auth middleware for protected link generation
const { verifyToken } = require('./authMiddleware');

const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const db = getFirestore();

const linkGenerationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 45,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many link broadcast allocations from this endpoint. Please try again later.'
  }
});

/**
 * Generates a cryptographically secure, random 24-character hexadecimal key
 */
const generateSecureLinkKey = () => crypto.randomBytes(12).toString('hex');

// ==========================================
// POST /api/links/generate
// Body: { incidentId, target, incidentType? }
// ==========================================
router.post(['/links/generate', '/links/generate/'], verifyToken, linkGenerationLimiter, async (req, res) => {
  try {
    const { incidentId, target } = req.body;

    if (!incidentId || !target) {
      return res.status(400).json({
        success: false,
        message: 'Missing core routing attributes (incidentId or target configuration).'
      });
    }

    // Normalize the audience before using it in Firestore or URL generation.
    const normalizedTarget = String(target || '').toLowerCase() === 'citizen'
      ? 'citizen'
      : 'department';

    // Generate unique reference key & set 7-day expiration.
    const linkKey = generateSecureLinkKey();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Store mapping in Firestore `shared_links` collection.
    await db.collection('shared_links').doc(linkKey).set({
      linkKey,
      incidentId,
      target: normalizedTarget,
      origin: 'AlertU-Console',
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromDate(expiresAt),
      active: true
    });

    const FRONTEND_URL = (process.env.APP_URL || 'https://alert-u-admin.vercel.app').replace(/\/+$/, '');

    // Use separate paths so each target opens its own page component.
    const targetPath = normalizedTarget === 'citizen'
      ? `/report/public/${encodeURIComponent(linkKey)}`
      : `/report/${encodeURIComponent(linkKey)}`;
    const secureLink = `${FRONTEND_URL}${targetPath}`;

    return res.status(200).json({
      success: true,
      secureLink,
      linkKey,
      target: normalizedTarget,
      incidentId,
      expiresAt
    });
  } catch (error) {
    console.error('Link Reference Generation Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Internal secure link generation breakdown.'
    });
  }
});

/**
 * Resolves a report document across all relevant collections
 */
async function resolveReportByIncidentId(id) {
  const lookupId = String(id || '').trim();
  if (!lookupId) return null;

  const collections = [
    'reports',
    'approved_reports',
    'AdminReports',
    'ApprovedAdminReports'
  ];

  const identifierFields = [
    'incidentId',
    'reportID',
    'reportId',
    'verifiedReportId',
    'verifiedreportID',
    'id'
  ];

  // First check document IDs. This is the most reliable lookup.
  for (const collectionName of collections) {
    const document = await db.collection(collectionName).doc(lookupId).get();
    if (document.exists) {
      return { id: document.id, ...document.data() };
    }
  }

  // Then check every identifier field used by the different report modules.
  for (const collectionName of collections) {
    for (const fieldName of identifierFields) {
      const snapshot = await db
        .collection(collectionName)
        .where(fieldName, '==', lookupId)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const document = snapshot.docs[0];
        return { id: document.id, ...document.data() };
      }
    }
  }

  return null;
}


/**
 * Removes private fields before a citizen-facing link receives the report.
 * Department links retain the complete report payload.
 */
function sanitizeReportForTarget(report, target) {
  if (!report || target !== 'citizen') return report;

  const citizenReport = { ...report };
  const privateFields = [
    'audioUrl', 'voicenoteUrl', 'voiceNoteUrl', 'audio',
    'audioLogs', 'voiceLogs', 'voiceNotes',
    'submitterName', 'submitterEmail', 'submitterPhone',
    'submitter_name', 'submitter_email', 'submitter_phone',
    'reporterName', 'reporterEmail', 'reporterPhone', 'reporterId',
    'user', 'userId', 'user_id', 'citizenId', 'citizen_id',
    'citizenID', 'authUid', 'uid',
    'notes', 'citizenNotes', 'citizenComment', 'citizenRemarks'
  ];

  for (const field of privateFields) {
    delete citizenReport[field];
  }

  if (citizenReport.media && typeof citizenReport.media === 'object') {
    const { url, type, fileName } = citizenReport.media;
    citizenReport.media = { url, type, fileName };
  }

  return citizenReport;
}

// ==========================================
// GET /api/links/verify/:id
// Handles lookup using either reference linkKey or direct incidentId
// ==========================================
router.get(['/links/verify/:id', '/links/verify/:id/'], async (req, res) => {
  try {
    const { id } = req.params;
    let targetIncidentId = id;
    let linkMetadata = null;

    // Check if `id` is a reference key stored in `shared_links`
    const linkDoc = await db.collection('shared_links').doc(id).get();

    if (linkDoc.exists) {
      linkMetadata = linkDoc.data();

      // Check active status
      if (!linkMetadata.active) {
        return res.status(401).json({
          success: false,
          message: 'This broadcast link has been deactivated.'
        });
      }

      // Check expiration
      if (linkMetadata.expiresAt && linkMetadata.expiresAt.toDate() < new Date()) {
        return res.status(401).json({
          success: false,
          message: 'This broadcast link has expired.'
        });
      }

      targetIncidentId = linkMetadata.incidentId;
    }

    // Resolve report payload using the determined incidentId
    const report = await resolveReportByIncidentId(targetIncidentId);

    if (!report) {
      return res.status(404).json({
        success: false,
        message: 'Report details not found in the spatial registry.'
      });
    }

    const responseTarget = linkMetadata?.target || 'department';
    const responseReport = sanitizeReportForTarget(report, responseTarget);

    return res.json({
      success: true,
      decoded: linkMetadata ? {
        incidentId: linkMetadata.incidentId,
        target: responseTarget,
        origin: linkMetadata.origin
      } : { incidentId: targetIncidentId },
      report: responseReport
    });
  } catch (err) {
    console.error('Link verification error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal link verification error.'
    });
  }
});

// ==========================================
// POST /api/links/verify/:id
// Body optional payload support
// ==========================================
router.post(['/links/verify/:id', '/links/verify/:id/'], async (req, res) => {
  try {
    const { id } = req.params;
    let targetIncidentId = id;
    let linkMetadata = null;

    const linkDoc = await db.collection('shared_links').doc(id).get();

    if (linkDoc.exists) {
      linkMetadata = linkDoc.data();

      if (!linkMetadata.active) {
        return res.status(401).json({
          success: false,
          message: 'This broadcast link has been deactivated.'
        });
      }

      if (linkMetadata.expiresAt && linkMetadata.expiresAt.toDate() < new Date()) {
        return res.status(401).json({
          success: false,
          message: 'This broadcast link has expired.'
        });
      }

      targetIncidentId = linkMetadata.incidentId;
    }

    const report = await resolveReportByIncidentId(targetIncidentId);

    if (!report) {
      return res.status(404).json({
        success: false,
        message: 'Report details not found in the spatial registry.'
      });
    }

    const responseTarget = linkMetadata?.target || 'department';
    const responseReport = sanitizeReportForTarget(report, responseTarget);

    return res.json({
      success: true,
      decoded: linkMetadata ? {
        incidentId: linkMetadata.incidentId,
        target: responseTarget,
        origin: linkMetadata.origin
      } : { incidentId: targetIncidentId },
      report: responseReport
    });
  } catch (err) {
    console.error('Link verification error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Internal link verification error.'
    });
  }
});

module.exports = router;
