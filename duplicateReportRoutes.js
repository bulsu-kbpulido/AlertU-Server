const express = require('express');
const router = express.Router();
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getIO } = require('./socket');
const crypto = require('crypto');

const db = getFirestore();

// ==========================================
// 🛠️ HELPER FUNCTIONS
// ==========================================

/**
 * Generates a random Nano ID string of specified length.
 */
function generateNanoId(length = 10) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

/**
 * Formats a raw counter integer into RID00000001 format.
 */
function formatReportId(counterNumber) {
  return `RID${String(counterNumber).padStart(8, '0')}`;
}

/**
 * Removes keys with undefined values from payload before Firestore write.
 */
function cleanUndefinedValues(obj) {
  return JSON.parse(JSON.stringify(obj, (key, value) => (value === undefined ? null : value)));
}

/**
 * Resolves submitter profile metadata from citizens collection if needed.
 */
async function enrichWithSubmitterData(rawReport) {
  if (!rawReport.citizenID && !rawReport.authUid) {
    return rawReport;
  }

  try {
    const identifier = rawReport.citizenID || rawReport.authUid;
    let doc = await db.collection('citizens').doc(identifier).get();

    if (!doc.exists) {
      const snap = await db.collection('citizens').where('citizenID', '==', identifier).limit(1).get();
      if (!snap.empty) doc = snap.docs[0];
    }

    if (doc.exists) {
      const profile = doc.data();
      return {
        ...rawReport,
        citizenID: profile.citizenID || profile.citizenId || rawReport.citizenID,
        submitterName: rawReport.submitterName || profile.fullName || 'Citizen Submitter',
        submitterPhone: rawReport.submitterPhone || profile.phoneNumber || 'N/A',
        submitterEmail: rawReport.submitterEmail || profile.email || 'N/A',
      };
    }
  } catch (err) {
    console.warn('Profile enrichment non-blocking warning:', err.message);
  }

  return rawReport;
}

/**
 * Calculates straight-line distance in kilometers between two lat/lng pairs.
 */
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in KM
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Checks existing reports across collections to see if a matching incident exists.
 * Returns the primary report object if a duplicate is found, or null otherwise.
 */
async function checkForDuplicateIncident({ incidentType, latitude, longitude, radiusKm = 0.5, timeWindowMinutes = 120 }) {
  if (!latitude || !longitude || !incidentType) return null;

  const now = new Date();
  const startTime = new Date(now.getTime() - timeWindowMinutes * 60 * 1000);

  // Search both pending reports and approved reports for existing active incidents
  const collectionsToSearch = ['reports', 'approved_reports'];

  for (const collectionName of collectionsToSearch) {
    const snapshot = await db
      .collection(collectionName)
      .where('incidentType', '==', incidentType)
      .get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const reportLat = data.latitude ?? data.location?.latitude;
      const reportLng = data.longitude ?? data.location?.longitude;

      if (reportLat && reportLng) {
        const distance = calculateDistanceKm(latitude, longitude, reportLat, reportLng);

        // Parse doc timestamp safely
        let reportDate = new Date();
        if (data.timestamp?.toDate) {
          reportDate = data.timestamp.toDate();
        } else if (data.timestamp) {
          reportDate = new Date(data.timestamp);
        }

        // Match criteria: Within radius & within time window
        if (distance <= radiusKm && reportDate >= startTime) {
          return {
            primaryReportId: data.reportId || data.reportID || doc.id,
            distanceKm: parseFloat(distance.toFixed(3)),
            collection: collectionName,
            data,
          };
        }
      }
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// POST /reports - Automatic Duplicate Categorization and Routing
// -----------------------------------------------------------------------------
router.post('/reports', async (req, res) => {
  try {
    const rawReportData = req.body;

    if (!rawReportData || Object.keys(rawReportData).length === 0) {
      return res.status(400).json({ success: false, message: 'Report body cannot be empty.' });
    }

    const reportData = await enrichWithSubmitterData(rawReportData);
    const counterRef = db.collection('counters').doc('reports_counter');
    const generatedNanoId = generateNanoId(10);

    const lat = reportData.latitude ?? reportData.location?.latitude;
    const lng = reportData.longitude ?? reportData.location?.longitude;
    const incidentType = reportData.incidentType || 'Others';

    // 1. Run Duplicate Check Algorithm
    const duplicateMatch = await checkForDuplicateIncident({
      incidentType,
      latitude: lat,
      longitude: lng,
      radiusKm: 0.5,          // 500 meters radius
      timeWindowMinutes: 120, // 2-hour timeframe window
    });

    const isDuplicate = !!duplicateMatch;
    const targetCollectionName = isDuplicate ? 'duplicate_reports' : 'reports';

    // 2. Generate Report ID & Save Document
    const { formattedReportId } = await db.runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);

      let currentCounter = 0;
      if (counterDoc.exists) {
        currentCounter = counterDoc.data().current || counterDoc.data().currentCount || 0;
      }

      const nextCounter = currentCounter + 1;
      const formattedId = formatReportId(nextCounter);

      transaction.set(counterRef, { current: nextCounter, currentCount: nextCounter }, { merge: true });

      const targetDocRef = db.collection(targetCollectionName).doc(formattedId);
      const trackingDocRef = db.collection('citizenreporttracking').doc(formattedId);

      const finalDocumentPayload = cleanUndefinedValues({
        ...reportData,
        id: generatedNanoId,
        reportId: formattedId,
        reportID: formattedId,
        status: isDuplicate ? 'duplicate' : 'pending',
        isDuplicate: isDuplicate,
        flaggedAsDuplicate: isDuplicate,
        ...(isDuplicate && {
          primaryReportId: duplicateMatch.primaryReportId,
          duplicateDistanceKm: duplicateMatch.distanceKm,
          duplicateReason: `Automatically matched duplicate report #${duplicateMatch.primaryReportId}`,
        }),
        timestamp: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });

      const trackingPayload = cleanUndefinedValues({
        ReportId: formattedId,
        reportID: formattedId,
        CID: reportData.citizenID || reportData.authUid,
        citizenID: reportData.citizenID || reportData.authUid,
        authUid: reportData.authUid,
        submitterName: reportData.submitterName,
        incidentType: incidentType,
        status: isDuplicate ? 'duplicate' : 'pending',
        createdAt: FieldValue.serverTimestamp(),
      });

      transaction.set(targetDocRef, finalDocumentPayload);
      transaction.set(trackingDocRef, trackingPayload);

      return { formattedReportId: formattedId };
    });

    const newReportPayload = cleanUndefinedValues({
      id: generatedNanoId,
      reportId: formattedReportId,
      reportID: formattedReportId,
      ...reportData,
      isDuplicate,
      status: isDuplicate ? 'duplicate' : 'pending',
      timestamp: new Date().toISOString(),
    });

    // 3. Socket Notification
    const io = getIO();
    if (io) {
      const eventName = isDuplicate ? 'new_duplicate_report' : 'new_citizen_report';
      io.emit(eventName, newReportPayload);
    }

    return res.status(201).json({
      success: true,
      isDuplicate,
      targetCollection: targetCollectionName,
      id: generatedNanoId,
      reportId: formattedReportId,
      reportID: formattedReportId,
      ...(isDuplicate && { primaryReportId: duplicateMatch.primaryReportId }),
    });
  } catch (error) {
    console.error('Error creating report:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});



module.exports = router;