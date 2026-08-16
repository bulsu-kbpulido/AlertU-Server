const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();

/**
 * resolvedRoutes.js
 * Lifecycle manager handling the transition, reading, and restoration of 
 * long-term historic incidents migrated into and out of the "ResolvedReports" collection.
 */

// -----------------------------------------------------------------------------
// 1. GET ALL RESOLVED REPORTS
// Accessible via: GET http://localhost:3000/api/resolved-incidents
// -----------------------------------------------------------------------------
router.get('/resolved-incidents', async (req, res) => {
  try {
    // Read historical logs ordered by timeline exit points
    const snapshot = await db.collection('ResolvedReports')
      .orderBy('resolvedAt', 'desc')
      .get();

    const resolvedList = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        // Convert Firestore Timestamp safely if object exists, otherwise pass raw fallback
        timestamp: data.timestamp?.toDate ? data.timestamp.toDate().toISOString() : data.timestamp,
        resolvedAt: data.resolvedAt?.toDate ? data.resolvedAt.toDate().toISOString() : data.resolvedAt
      };
    });

    return res.status(200).json({
      success: true,
      count: resolvedList.length,
      data: resolvedList
    });
  } catch (error) {
    console.error("Error fetching records from ResolvedReports manifest:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// -----------------------------------------------------------------------------
// 2. POST /resolve/:id (MARK AS RESOLVED)
// Accessible via: POST http://localhost:3000/api/resolve/:id
// Dynamically locates active document, normalizes fields, and moves it to ResolvedReports
// -----------------------------------------------------------------------------
router.post('/resolve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { sourceCollection } = req.body;

    // Scan tracking matrices if client-side indicator dropped offline
    const candidateCollections = [];
    if (sourceCollection) candidateCollections.push(sourceCollection);
    candidateCollections.push('approved_reports', 'AdminReports', 'reports');

    let identifiedSource = null;
    let documentSnapshot = null;

    for (const collectionName of candidateCollections) {
      const checkRef = db.collection(collectionName).doc(id);
      const snap = await checkRef.get();
      if (snap.exists) {
        identifiedSource = collectionName;
        documentSnapshot = snap;
        break; 
      }
    }

    if (!identifiedSource || !documentSnapshot) {
      console.error(`❌ Resolution look-up error: Document ID ${id} not found.`);
      return res.status(404).json({
        success: false,
        message: `Target incident report ${id} could not be resolved within current data manifests.`
      });
    }

    const sourceDocRef = db.collection(identifiedSource).doc(id);
    const resolvedDocRef = db.collection('ResolvedReports').doc(id);

    // Run isolated database batch context transaction
    await db.runTransaction(async (transaction) => {
      const freshSnap = await transaction.get(sourceDocRef);
      if (!freshSnap.exists) {
        throw new Error('Target document was modified or removed prior to commit phase completion.');
      }

      const rawData = freshSnap.data();
      let normalizedPayload = {};

      // 🎯 Sync structure dynamically depending on which collection it lives in
      if (identifiedSource === 'AdminReports') {
        normalizedPayload = {
          reportTitle: rawData.reportTitle || '',
          incidentType: rawData.incidentType || 'others',
          hazard: rawData.hazard || '',
          severity: rawData.verifiedSeverity || rawData.severity || 'Medium',
          status: 'resolved',
          notes: rawData.notes || '',
          adminNotes: rawData.adminNotes || '',
          location: rawData.location || {},
          radius: rawData.radius || null,
          polyline: rawData.polyline || [],
          routeCoords: rawData.routeCoords || [],
          
          // Flatten media sub-properties to match approved_reports conventions
          mediaUrl: rawData.media?.url || null,
          mediaFileName: rawData.media?.fileName || null,
          mediaType: rawData.media?.type || null,

          isSensitive: typeof rawData.isSensitive === 'boolean' ? rawData.isSensitive : false,
          isAuthenticated: typeof rawData.isAuthenticated === 'boolean' ? rawData.isAuthenticated : true,
          isVerified: typeof rawData.isVerified === 'boolean' ? rawData.isVerified : true,
          verifiedBy: rawData.verifiedBy || null,
          verifiedAt: rawData.verifiedAt || null,
          
          source: 'admin'
        };
      } else {
        // Standard approved_reports or raw citizen report template baseline tracking
        normalizedPayload = {
          ...rawData,
          status: 'resolved',
          source: rawData.source || 'approved'
        };
      }

      // Safe date format normalization stage
      const rawTimestamp = rawData.reportTimestamp || rawData.createdAt || rawData.timestamp;
      const baseTimestamp = rawTimestamp?.toDate ? rawTimestamp.toDate().toISOString() : (rawTimestamp || new Date().toISOString());

      // Append standard operational tracking keys
      normalizedPayload.timestamp = baseTimestamp;
      normalizedPayload.resolvedAt = new Date().toISOString();
      normalizedPayload.updatedAt = new Date().toISOString();
      normalizedPayload.migrationSource = identifiedSource;

      // Commit changes inside transaction state flow
      transaction.set(resolvedDocRef, normalizedPayload);
      transaction.delete(sourceDocRef);
    });

    console.log(`✅ Success: Incident ${id} migrated from '${identifiedSource}' into 'ResolvedReports'.`);
    return res.status(200).json({
      success: true,
      message: `Incident successfully migrated out of the active ${identifiedSource} grid.`
    });

  } catch (error) {
    console.error('Resolution transaction failure:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// -----------------------------------------------------------------------------
// 3. POST /resolve/restore/:id (SINGLE RESTORE)
// Accessible via: POST http://localhost:3000/api/resolve/restore/:id
// Restores a single resolved report back to its active target collection
// -----------------------------------------------------------------------------
router.post('/resolve/restore/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resolvedDocRef = db.collection('ResolvedReports').doc(id);

    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(resolvedDocRef);

      if (!snap.exists) {
        throw new Error(`Incident report ${id} was not found in ResolvedReports.`);
      }

      const data = snap.data();
      // Determine target collection based on stored metadata or fallback to approved_reports
      const targetCollection = data.migrationSource || (data.source === 'admin' ? 'AdminReports' : 'approved_reports');
      const targetDocRef = db.collection(targetCollection).doc(id);

      // Clean up internal tracking properties prior to restoring
      const restoredPayload = { ...data };
      delete restoredPayload.migrationSource;
      delete restoredPayload.resolvedAt;

      // Reset status back to approved / active state
      restoredPayload.status = 'approved';
      restoredPayload.restoredAt = new Date().toISOString();
      restoredPayload.updatedAt = new Date().toISOString();

      transaction.set(targetDocRef, restoredPayload);
      transaction.delete(resolvedDocRef);
    });

    console.log(`🔄 Incident ${id} successfully restored back to active reporting.`);
    return res.status(200).json({
      success: true,
      message: `Incident ${id} successfully restored back to active grid.`
    });
  } catch (error) {
    console.error('Single restoration transaction failure:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// -----------------------------------------------------------------------------
// 4. POST /resolve/batch-restore (BATCH RESTORE)
// Accessible via: POST http://localhost:3000/api/resolve/batch-restore
// Restores multiple selected incidents back to their origin collections
// Body requirement: { ids: ["id1", "id2", ...] }
// -----------------------------------------------------------------------------
router.post('/resolve/batch-restore', async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request: "ids" array must be provided.'
      });
    }

    const batch = db.batch();
    const missingIds = [];

    // Process all documents in parallel to fetch state prior to batch write
    const fetchPromises = ids.map(id => db.collection('ResolvedReports').doc(id).get());
    const snapshots = await Promise.all(fetchPromises);

    for (const snap of snapshots) {
      if (!snap.exists) {
        missingIds.push(snap.id);
        continue;
      }

      const id = snap.id;
      const data = snap.data();
      const targetCollection = data.migrationSource || (data.source === 'admin' ? 'AdminReports' : 'approved_reports');

      const resolvedDocRef = db.collection('ResolvedReports').doc(id);
      const targetDocRef = db.collection(targetCollection).doc(id);

      const restoredPayload = { ...data };
      delete restoredPayload.migrationSource;
      delete restoredPayload.resolvedAt;

      restoredPayload.status = 'approved';
      restoredPayload.restoredAt = new Date().toISOString();
      restoredPayload.updatedAt = new Date().toISOString();

      batch.set(targetDocRef, restoredPayload);
      batch.delete(resolvedDocRef);
    }

    if (missingIds.length === ids.length) {
      return res.status(404).json({
        success: false,
        message: 'None of the provided IDs were found in ResolvedReports.'
      });
    }

    await batch.commit();

    console.log(`🔄 Batch restored ${ids.length - missingIds.length} incident(s) to active grids.`);
    return res.status(200).json({
      success: true,
      restoredCount: ids.length - missingIds.length,
      skippedCount: missingIds.length,
      message: `Successfully restored ${ids.length - missingIds.length} incident(s).`
    });

  } catch (error) {
    console.error('Batch restore failure:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// -----------------------------------------------------------------------------
// 5. DELETE /resolve/:id (PERMANENT DELETE)
// Accessible via: DELETE http://localhost:3000/api/resolve/:id
// -----------------------------------------------------------------------------
router.delete('/resolve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection('ResolvedReports').doc(id);
    const snap = await docRef.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, message: "Incident not found in resolved registers." });
    }

    await docRef.delete();
    console.log(`🗑️ Record ${id} permanently dropped from ResolvedReports.`);
    
    return res.status(200).json({
      success: true,
      message: "Incident permanently removed from storage logs."
    });
  } catch (error) {
    console.error("Resolution delete cycle dropped error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;