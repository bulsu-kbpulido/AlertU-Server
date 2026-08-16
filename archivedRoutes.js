const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');

// 🔒 Custom auth middleware
const { verifyToken } = require('./authMiddleware'); // 👈 Adjust path as needed

// ⚡ Import caching & query capping engine
const { getArchivedReportsWithCache, invalidateArchivedCache } = require('./ARlimitcache');

const db = getFirestore();

/**
 * Helper function: Finds a document across Firestore by doc ID or custom report ID fields
 */
async function findDocInCollection(collectionName, id) {
  const colRef = db.collection(collectionName);
  let docSnap = await colRef.doc(id).get();

  if (!docSnap.exists) {
    let q = await colRef.where('id', '==', id).limit(1).get();
    if (q.empty) q = await colRef.where('reportId', '==', id).limit(1).get();
    if (q.empty) q = await colRef.where('reportID', '==', id).limit(1).get();

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
 * @route   GET /api/archived-reports
 * @desc    Fetch archived incident records with query capping and in-memory TTL caching via ARlimitcache
 * @access  Public (No auth token required)
 */
router.get('/archived-reports', async (req, res) => {
  try {
    const queryLimit = parseInt(req.query.queryLimit, 10) || 50;

    // Retrieve cached / query-capped archived reports from ARlimitcache module
    const { data, cached } = await getArchivedReportsWithCache(queryLimit);

    return res.status(200).json({
      success: true,
      count: data.length,
      cached,
      data
    });

  } catch (error) {
    console.error('Failure inside Archived Node Extraction Pipeline:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve archived nodes from cloud partition.',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/archived-reports/:id/restore
 * @desc    Move a record out of 'archivedreports' back into 'reports' preserving all original attributes & invalidate cache
 * @access  Protected (Requires valid Bearer token)
 */
router.post('/archived-reports/:id/restore', verifyToken, async (req, res) => {
  const { id } = req.params;
  console.log(`🚀 Restore command received for ID: ${id} by User: ${req.user?.uid || 'Authenticated User'}`);

  try {
    // 1. Locate the document in archivedreports
    const docSnapshot = await findDocInCollection('archivedreports', id);

    if (!docSnapshot || !docSnapshot.exists) {
      console.error(`❌ Document #${id} does not exist in 'archivedreports' collection!`);
      return res.status(404).json({
        success: false,
        message: 'The requested archived record could not be found.'
      });
    }

    const archivedData = docSnapshot.data() || {};
    const targetDocId = docSnapshot.id;
    console.log(`📥 Successfully retrieved document data for restoration (Target Doc ID: ${targetDocId}).`);

    // 2. Prepare restored payload while preserving exact raw Firestore types
    const restoredData = cleanUndefinedValues({
      ...archivedData,
      status: 'pending', // Revert to active status
      restoredAt: new Date().toISOString()
    });

    // Clean up archive-specific flags only
    delete restoredData.archivedAt;
    delete restoredData.rejectedAt;

    // 3. Execute atomic batch operation: write to 'reports' & delete from 'archivedreports'
    const batch = db.batch();
    const activeReportRef = db.collection('reports').doc(targetDocId);

    batch.set(activeReportRef, restoredData);
    batch.delete(docSnapshot.ref);

    await batch.commit();

    // 🛑 Invalidate memory cache so next GET retrieves updated data
    invalidateArchivedCache();

    console.log(`📤 Successfully restored document #${targetDocId} to active 'reports' pipeline.`);

    return res.status(200).json({
      success: true,
      message: 'Incident record successfully re-deployed to the active reports pipeline.',
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
 * @route   DELETE /api/archived-reports/:id
 * @desc    Permanently purge a document directly from the archive & invalidate cache
 * @access  Protected (Requires valid Bearer token)
 */
router.delete('/archived-reports/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  console.log(`🧹 Permanent delete requested for Archived Document ID: ${id} by User: ${req.user?.uid || 'Authenticated User'}`);

  try {
    const docSnapshot = await findDocInCollection('archivedreports', id);

    if (!docSnapshot || !docSnapshot.exists) {
      return res.status(404).json({
        success: false,
        message: 'The requested archived record could not be found.'
      });
    }

    // Completely wipe out from firestore
    await docSnapshot.ref.delete();

    // 🛑 Invalidate memory cache on deletion
    invalidateArchivedCache();

    console.log(`🗑️ Document ID #${docSnapshot.id} has been permanently erased from the archive storage array.`);

    return res.status(200).json({
      success: true,
      message: 'Incident record permanently purged from archive storage.'
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