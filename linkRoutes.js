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

    // Generate unique reference key & set 7-day expiration
    const linkKey = generateSecureLinkKey();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); 

    // Store mapping in Firestore `shared_links` collection
    await db.collection('shared_links').doc(linkKey).set({
      linkKey,
      incidentId,
      target,
      origin: 'AlertU-Console',
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromDate(expiresAt),
      active: true
    });

    const FRONTEND_URL = (process.env.APP_URL || 'https://alert-u-admin.vercel.app').replace(/\/+$/, '');
    
    // Use separate paths so each target opens its own page component.
    const targetPath = target === 'citizen'
      ? `/report/public/${linkKey}`
      : `/report/${linkKey}`;
    const secureLink = `${FRONTEND_URL}${targetPath}`;

    return res.status(200).json({
      success: true,
      secureLink,
      linkKey,
      target,
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
  // 1) reports by doc id
  const reportDoc = await db.collection('reports').doc(id).get();
  if (reportDoc.exists) {
    return { id: reportDoc.id, ...reportDoc.data() };
  }

  // 2) approved_reports by doc id
  const approvedReportDoc = await db.collection('approved_reports').doc(id).get();
  if (approvedReportDoc.exists) {
    return { id: approvedReportDoc.id, ...approvedReportDoc.data() };
  }

  // 3) AdminReports by doc id
  const adminReportDoc = await db.collection('AdminReports').doc(id).get();
  if (adminReportDoc.exists) {
    return { id: adminReportDoc.id, ...adminReportDoc.data() };
  }

  // 4) reports by embedded incidentId field
  const reportsByIncidentId = await db
    .collection('reports')
    .where('incidentId', '==', id)
    .limit(1)
    .get();

  if (!reportsByIncidentId.empty) {
    const found = reportsByIncidentId.docs[0];
    return { id: found.id, ...found.data() };
  }

  // 5) approved_reports by embedded incidentId field
  const approvedByIncidentId = await db
    .collection('approved_reports')
    .where('incidentId', '==', id)
    .limit(1)
    .get();

  if (!approvedByIncidentId.empty) {
    const found = approvedByIncidentId.docs[0];
    return { id: found.id, ...found.data() };
  }

  return null;
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

    return res.json({
      success: true,
      decoded: linkMetadata ? {
        incidentId: linkMetadata.incidentId,
        target: linkMetadata.target,
        origin: linkMetadata.origin
      } : { incidentId: targetIncidentId },
      report
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

    return res.json({
      success: true,
      decoded: linkMetadata ? {
        incidentId: linkMetadata.incidentId,
        target: linkMetadata.target,
        origin: linkMetadata.origin
      } : { incidentId: targetIncidentId },
      report
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
