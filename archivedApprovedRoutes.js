const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');

// Optional Authentication Middleware (uncomment if you wish to enforce JWT protection)
// const { verifyToken } = require('./authMiddleware');

// Optional Cache Invalidation Hook (uncomment if you use ARlimitcache for archived approved)
// const { invalidateArchivedCache } = require('./ARlimitcache');

const db = getFirestore();

/**
 * Helper function: Sanitizes ID params (strips trailing artifacts like ':1' or whitespace)
 */
function sanitizeId(rawId) {
  if (!rawId) return '';
  return String(rawId).split(':')[0].trim();
}

/**
 * Helper function: Finds a document across Firestore by doc ID or custom report ID fields
 */
async function findDocInCollection(collectionName, id) {
  const cleanId = sanitizeId(id);
  const colRef = db.collection(collectionName);

  // 1. Check direct Firestore Document Key
  let docSnap = await colRef.doc(cleanId).get();

  // 2. Fall back to custom identifier field queries
  if (!docSnap.exists) {
    let q = await colRef.where('id', '==', cleanId).limit(1).get();
    if (q.empty) q = await colRef.where('reportId', '==', cleanId).limit(1).get();
    if (q.empty) q = await colRef.where('reportID', '==', cleanId).limit(1).get();
    if (q.empty) q = await colRef.where('verifiedReportId', '==', cleanId).limit(1).get();
    if (q.empty) q = await colRef.where('verifiedreportID', '==', cleanId).limit(1).get();

    if (!q.empty) {
      docSnap = q.docs[0];
    }
  }

  return docSnap;
}

/**
 * Recursively removes 'undefined' properties from objects without mutating
 * native Firestore types (Timestamps, GeoPoints, DocumentReferences, etc.).
 */
function cleanUndefinedValues(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Preserve native Firestore/Date objects intact
  if (
    obj instanceof Date ||
    (obj.constructor && obj.constructor.name === 'Timestamp') ||
    (obj.constructor && obj.constructor.name === 'GeoPoint') ||
    (obj.constructor && obj.constructor.name === 'DocumentReference')
  ) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(cleanUndefinedValues);
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      cleaned[key] = cleanUndefinedValues(value);
    }
  }
  return cleaned;
}

/**
 * @route   GET /api/archived-approved
 * @desc    Fetch all archived approved reports from ArchivedApproved collection
 * @access  Public
 */
router.get('/archived-approved', async (req, res) => {
  try {
    const snapshot = await db.collection('ArchivedApproved')
      .orderBy('timestamp', 'desc')
      .get();

    const reports = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        timestamp: data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : data.timestamp,
        resolvedAt: data.resolvedAt || data.archivedAt || null
      };
    });

    return res.status(200).json({
      success: true,
      count: reports.length,
      data: reports
    });
  } catch (error) {
    console.error("Error fetching archived approved reports:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to retrieve archived approved reports.",
      error: error.message
    });
  }
});

/**
 * @route   POST /api/archive-approved/:id
 * @desc    Archive an approved report out of active collections into 'ArchivedApproved'
 * @access  Public (or add verifyToken)
 */
router.post('/archive-approved/:id', async (req, res) => {
  try {
    const id = sanitizeId(req.params.id);
    const { sourceCollection } = req.body;

    const candidateCollections = [];
    if (sourceCollection) candidateCollections.push(sourceCollection);
    candidateCollections.push('AdminReports', 'approved_reports', 'reports');

    let identifiedSource = null;
    let documentSnapshot = null;

    for (const collectionName of candidateCollections) {
      const snap = await findDocInCollection(collectionName, id);
      if (snap && snap.exists) {
        identifiedSource = collectionName;
        documentSnapshot = snap;
        break;
      }
    }

    if (!identifiedSource || !documentSnapshot) {
      console.error(`❌ Global lookup failure. Document ID ${id} missing in candidate matrices.`);
      return res.status(404).json({
        success: false,
        message: `Target document ${id} could not be located in any active registry collections.`
      });
    }

    const sourceDocRef = documentSnapshot.ref;
    const targetDocId = documentSnapshot.id;
    const archiveDocRef = db.collection('ArchivedApproved').doc(targetDocId);

    await db.runTransaction(async (transaction) => {
      const freshSnap = await transaction.get(sourceDocRef);
      if (!freshSnap.exists) {
        throw new Error('Target document was modified or removed mid-transaction lifecycle.');
      }

      const rawData = freshSnap.data();
      const baseTimestamp = rawData.timestamp || rawData.reportTimestamp || rawData.createdAt || new Date().toISOString();

      const archivalPayload = cleanUndefinedValues({
        ...rawData,
        status: 'archived',
        archivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timestamp: baseTimestamp,
        migrationSource: identifiedSource
      });

      transaction.set(archiveDocRef, archivalPayload);
      transaction.delete(sourceDocRef);
    });

    console.log(`📦 System transaction successful. Migrated report ${targetDocId} out of '${identifiedSource}' into 'ArchivedApproved'`);

    return res.status(200).json({
      success: true,
      message: `Report successfully migrated from ${identifiedSource} to ArchivedApproved storage.`
    });

  } catch (error) {
    console.error('Archival transaction fault execution failure:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to complete archival transaction.',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/archived-approved/:id/restore
 * @desc    Restore an archived approved report back to its active source collection (AdminReports or approved_reports)
 * @access  Public (or add verifyToken)
 */
router.post('/archived-approved/:id/restore', async (req, res) => {
  const id = sanitizeId(req.params.id);
  console.log(`🚀 Restore command received for Archived Approved ID: ${id}`);

  try {
    const docSnapshot = await findDocInCollection('ArchivedApproved', id);

    if (!docSnapshot || !docSnapshot.exists) {
      console.error(`❌ Document #${id} does not exist in 'ArchivedApproved' collection!`);
      return res.status(404).json({
        success: false,
        message: 'The requested archived approved record could not be found.'
      });
    }

    const archivedData = docSnapshot.data() || {};
    const targetDocId = docSnapshot.id;

    const destinationCollection = archivedData.migrationSource || 
      (archivedData.source === 'admin' ? 'AdminReports' : 'approved_reports');

    console.log(`📥 Restoring document #${targetDocId} back to '${destinationCollection}'...`);

    const restoredData = cleanUndefinedValues({
      ...archivedData,
      status: 'approved',
      restoredAt: new Date().toISOString()
    });

    delete restoredData.archivedAt;
    delete restoredData.migrationSource;

    const batch = db.batch();
    const destinationRef = db.collection(destinationCollection).doc(targetDocId);

    batch.set(destinationRef, restoredData);
    batch.delete(docSnapshot.ref);

    await batch.commit();

    console.log(`📤 Successfully restored document #${targetDocId} back to active '${destinationCollection}' pipeline.`);

    return res.status(200).json({
      success: true,
      message: `Incident record successfully restored to active ${destinationCollection} pipeline.`,
      data: restoredData
    });

  } catch (error) {
    console.error('💥 CRITICAL FAILURE during restore transaction:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to complete restore pipeline transaction.',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/archived-approved/:id
 * @desc    Fetch a single archived approved report by ID
 * @access  Public
 */
router.get('/archived-approved/:id', async (req, res) => {
  try {
    const id = sanitizeId(req.params.id);
    const docSnapshot = await findDocInCollection('ArchivedApproved', id);

    if (!docSnapshot || !docSnapshot.exists) {
      return res.status(404).json({ success: false, message: "Archived report not found." });
    }

    const data = docSnapshot.data();
    return res.status(200).json({
      success: true,
      data: {
        id: docSnapshot.id,
        ...data,
        timestamp: data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : data.timestamp
      }
    });
  } catch (error) {
    console.error("Error fetching single archived report:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route   DELETE /api/archived-approved/:id
 * @desc    Permanently delete a record directly from 'ArchivedApproved'
 * @access  Public (or add verifyToken)
 */
router.delete('/archived-approved/:id', async (req, res) => {
  const id = sanitizeId(req.params.id);
  console.log(`🧹 Permanent delete requested for Archived Approved ID: ${id}`);

  try {
    const docSnapshot = await findDocInCollection('ArchivedApproved', id);

    if (!docSnapshot || !docSnapshot.exists) {
      return res.status(404).json({
        success: false,
        message: 'The requested archived record could not be found.'
      });
    }

    await docSnapshot.ref.delete();

    console.log(`🗑️ Document ID #${docSnapshot.id} permanently erased from ArchivedApproved collection.`);

    return res.status(200).json({
      success: true,
      message: 'Incident record permanently purged from approved archive storage.'
    });

  } catch (error) {
    console.error('Failure inside Permanent Archive Purge routine:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to complete physical document destruction.',
      error: error.message
    });
  }
});

module.exports = router;