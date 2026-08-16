const express = require('express');
const router = express.Router();
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getIO } = require('./socket'); // Ensure path to socket module is correct

const db = getFirestore();

/**
 * Helper to search across multiple Firestore collections for a report by ID or reportId field.
 */
async function findReportDocInCollections(id, collections) {
  for (const colName of collections) {
    let docRef = db.collection(colName).doc(id);
    let snap = await docRef.get();

    if (!snap.exists) {
      let q = await db.collection(colName).where('id', '==', id).limit(1).get();
      if (q.empty) q = await db.collection(colName).where('reportId', '==', id).limit(1).get();
      if (q.empty) q = await db.collection(colName).where('reportID', '==', id).limit(1).get();

      if (!q.empty) {
        snap = q.docs[0];
        docRef = snap.ref;
      }
    }

    if (snap && snap.exists) {
      return { snap, docRef, colName, data: snap.data() };
    }
  }
  return null;
}

/**
 * @route   POST /api/duplicate-to-report/confirm
 * @desc    Confirm a flagged report IS a duplicate and link it to the main primary report
 * @access  Private / Admin
 */
router.post('/confirm', async (req, res) => {
  const { duplicateReportId, primaryReportId, adminNotes } = req.body;

  if (!duplicateReportId || !primaryReportId) {
    return res.status(400).json({
      success: false,
      message: 'Both duplicateReportId and primaryReportId are required.',
    });
  }

  try {
    // 1. Find duplicate report (could be in `duplicate_reports` or `reports`)
    const duplicateMatch = await findReportDocInCollections(duplicateReportId, [
      'duplicate_reports',
      'reports',
    ]);

    if (!duplicateMatch) {
      return res.status(404).json({
        success: false,
        message: `Duplicate report ${duplicateReportId} not found.`,
      });
    }

    // 2. Find primary report (could be in `reports` or `approved_reports`)
    const primaryMatch = await findReportDocInCollections(primaryReportId, [
      'reports',
      'approved_reports',
      'ApprovedAdminReports',
    ]);

    if (!primaryMatch) {
      return res.status(404).json({
        success: false,
        message: `Primary report ${primaryReportId} not found.`,
      });
    }

    const batch = db.batch();

    // 3. Update status on the duplicate report
    batch.update(duplicateMatch.docRef, {
      status: 'confirmed_duplicate',
      isDuplicate: true,
      flaggedAsDuplicate: true,
      primaryReportId: primaryReportId,
      resolvedAt: new Date().toISOString(),
      adminNotes: adminNotes || 'Confirmed as duplicate by admin.',
      updatedAt: new Date().toISOString(),
    });

    // 4. Link duplicate report ID inside the primary report's linked array
    batch.update(primaryMatch.docRef, {
      linkedDuplicateIds: FieldValue.arrayUnion(duplicateReportId),
      updatedAt: new Date().toISOString(),
    });

    await batch.commit();

    // Emit Socket notification if required
    const io = getIO();
    if (io) {
      io.emit('duplicate_report_confirmed', {
        duplicateReportId,
        primaryReportId,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Report ${duplicateReportId} successfully confirmed and linked as duplicate to ${primaryReportId}.`,
    });
  } catch (error) {
    console.error('Error confirming duplicate report:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to confirm duplicate report.',
      error: error.message,
    });
  }
});

/**
 * @route   POST /api/duplicate-to-report/reject
 * @desc    Reject duplicate flag — Move report from `duplicate_reports` to `reports` as standard pending incident
 * @access  Private / Admin
 */
router.post('/reject', async (req, res) => {
  const { reportId, adminNotes } = req.body;

  if (!reportId) {
    return res.status(400).json({
      success: false,
      message: 'reportId is required.',
    });
  }

  try {
    // 1. Search for the report in `duplicate_reports` or `reports`
    const match = await findReportDocInCollections(reportId, [
      'duplicate_reports',
      'reports',
    ]);

    if (!match) {
      return res.status(404).json({
        success: false,
        message: `Report ${reportId} not found in duplicate or active collections.`,
      });
    }

    const docId = match.snap.id;
    const existingData = match.data;

    // 2. Build updated data payload for standard processing pipeline
    const restoredPayload = {
      ...existingData,
      status: 'pending',
      isDuplicate: false,
      flaggedAsDuplicate: false,
      primaryReportId: null,
      duplicateDistanceKm: FieldValue.delete(),
      duplicateReason: FieldValue.delete(),
      adminNotes: adminNotes || 'Flagged duplicate rejected by admin; restored as independent report.',
      updatedAt: new Date().toISOString(),
    };

    const targetRef = db.collection('reports').doc(docId);
    const batch = db.batch();

    // Set document into standard `reports` collection
    batch.set(targetRef, restoredPayload, { merge: true });

    // If source was in `duplicate_reports`, remove it from there
    if (match.colName === 'duplicate_reports') {
      batch.delete(match.docRef);
    }

    await batch.commit();

    // 3. Emit real-time socket event so Admin Dashboard moves it into main Pending queue
    const io = getIO();
    if (io) {
      io.emit('new_citizen_report', {
        id: existingData.id || docId,
        reportId: existingData.reportId || existingData.reportID || docId,
        reportID: existingData.reportID || existingData.reportId || docId,
        ...restoredPayload,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Report ${docId} successfully marked as unique and moved to standard pending reports.`,
    });
  } catch (error) {
    console.error('Error rejecting duplicate status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update duplicate report status.',
      error: error.message,
    });
  }
});

module.exports = router;