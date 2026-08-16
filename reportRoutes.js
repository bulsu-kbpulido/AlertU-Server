const express = require('express');
const router = express.Router();
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getIO } = require('./socket');
const crypto = require('crypto'); // Native Node.js CommonJS-safe ID generator
const { trySendApprovedReportNotification } = require('./sendreportnotifs');

const db = getFirestore();

/**
 * CommonJS-compatible NanoID replacement using Node's crypto module
 */
function generateNanoId(length = 10) {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

/**
 * Helper function: Formats report counter integer into padded string "RID00000001"
 */
function formatReportId(counterNumber) {
  return `RID${String(counterNumber).padStart(8, '0')}`;
}

/**
 * Helper function: Formats verified counter integer into padded string "VRID00000001"
 */
function formatVerifiedReportId(counterNumber) {
  return `VRID${String(counterNumber).padStart(8, '0')}`;
}

/**
 * Helper function: Converts Firestore Timestamps, JS Dates, serialized objects,
 * epoch numbers, or strings into a clean ISO 8601 date string.
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
    console.warn('⚠️ Timestamp parsing warning:', err.message);
  }

  return new Date().toISOString();
}

/**
 * Recursively removes 'undefined' properties from objects without mutating
 * native Firestore types (Timestamps, GeoPoints, DocumentReferences, FieldValues, etc.).
 */
function cleanUndefinedValues(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (
    obj instanceof Date ||
    (obj.constructor && obj.constructor.name === 'Timestamp') ||
    (obj.constructor && obj.constructor.name === 'GeoPoint') ||
    (obj.constructor && obj.constructor.name === 'DocumentReference') ||
    (obj.constructor && obj.constructor.name === 'FieldValue') ||
    typeof obj._methodName === 'string'
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
 * Calculates straight-line distance in meters between two lat/lng coordinates using Haversine formula.
 */
function calculateHaversineDistanceMeters(lat1, lon1, lat2, lon2) {
  if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) return Infinity;
  if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) return Infinity;

  const R = 6371e3;
  const radLat1 = (lat1 * Math.PI) / 180;
  const radLat2 = (lat2 * Math.PI) / 180;
  const deltaLat = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Helper to extract coordinates safely from different report object layouts
 */
function extractCoords(report) {
  if (!report) return { latitude: NaN, longitude: NaN };

  let lat = report.latitude ?? report.lat;
  let lng = report.longitude ?? report.lng;

  if (report.location && typeof report.location === 'object') {
    lat = lat ?? report.location.latitude ?? report.location.lat ?? report.location._latitude;
    lng = lng ?? report.location.longitude ?? report.location.lng ?? report.location._longitude;
  }

  return {
    latitude: typeof lat === 'number' ? lat : parseFloat(lat),
    longitude: typeof lng === 'number' ? lng : parseFloat(lng)
  };
}

/**
 * Checks for duplicate reports across pending AND approved collections based on location proximity and incident type.
 */
async function checkIsDuplicate(upcomingReport, maxDistanceMeters = 500) {
  try {
    const upcomingCoords = extractCoords(upcomingReport);
    if (isNaN(upcomingCoords.latitude) || isNaN(upcomingCoords.longitude)) {
      console.warn('⚠️ Invalid or missing coordinates on incoming report. Skipping duplicate check.');
      return { isDuplicate: false, parentReportId: null };
    }

    const upcomingType = String(
      upcomingReport.incidentType ||
      upcomingReport.hazard ||
      ''
    ).toLowerCase().trim();

    const [pendingSnap, approvedSnap] = await Promise.all([
      db.collection('reports').get(),
      db.collection('approved_reports').get()
    ]);

    const allDocs = [...pendingSnap.docs, ...approvedSnap.docs];
    let matches = [];

    for (const doc of allDocs) {
      const activeReport = doc.data();
      const activeType = String(
        activeReport.incidentType ||
        activeReport.hazard ||
        ''
      ).toLowerCase().trim();

      if (upcomingType && activeType && upcomingType !== activeType) {
        continue;
      }

      const activeCoords = extractCoords(activeReport);
      const distanceMeters = calculateHaversineDistanceMeters(
        upcomingCoords.latitude,
        upcomingCoords.longitude,
        activeCoords.latitude,
        activeCoords.longitude
      );

      if (distanceMeters <= maxDistanceMeters) {
        matches.push(activeReport);
      }
    }

    if (matches.length > 0) {
      matches.sort((a, b) => {
        const idA = String(a.reportID || a.reportId || a.id || '');
        const idB = String(b.reportID || b.reportId || b.id || '');
        return idB.localeCompare(idA, undefined, { numeric: true, sensitivity: 'base' });
      });

      const latestDuplicate = matches[0];
      
      return {
        isDuplicate: true,
        parentReportId: latestDuplicate.reportID || latestDuplicate.reportId || latestDuplicate.id || null
      };
    }

    return { isDuplicate: false, parentReportId: null };
  } catch (err) {
    console.warn('⚠️ Duplicate check warning:', err.message);
    return { isDuplicate: false, parentReportId: null };
  }
}

/**
 * In-memory user cache with size capping (max 1000 items)
 */
const userCache = new Map();
const MAX_CACHE_SIZE = 1000;

async function enrichWithSubmitterData(data) {
  if (!data) return data;

  const userId = 
    data.userId || 
    data.user_id || 
    data.citizenId || 
    data.citizen_id || 
    data.citizenID || 
    data.uid || 
    data.authUid || 
    data.reporterId;

  let submitterName = 
    data.submitterName || 
    data.submitter_name || 
    data.reporterName || 
    data.fullName || 
    data.displayName || 
    data.name || 
    null;

  let submitterEmail = 
    data.submitterEmail || 
    data.submitter_email || 
    data.reporterEmail || 
    data.email || 
    null;

  let submitterPhone = 
    data.submitterPhone || 
    data.submitter_phone || 
    data.reporterPhone || 
    data.phone || 
    data.phoneNumber || 
    data.contactNumber || 
    null;

  if (userId && (!submitterName || submitterName === 'Anonymous Submitter')) {
    const cacheKey = String(userId);
    
    if (userCache.has(cacheKey)) {
      const cached = userCache.get(cacheKey);
      submitterName = cached.submitterName || submitterName;
      submitterEmail = cached.submitterEmail || submitterEmail;
      submitterPhone = cached.submitterPhone || submitterPhone;
    } else {
      try {
        const collections = ['citizens', 'users', 'admin_citizens'];
        let foundUserData = null;

        for (const colName of collections) {
          const docSnap = await db.collection(colName).doc(cacheKey).get();
          if (docSnap.exists) {
            foundUserData = docSnap.data();
            break;
          }

          const qUid = await db.collection(colName).where('uid', '==', userId).limit(1).get();
          if (!qUid.empty) {
            foundUserData = qUid.docs[0].data();
            break;
          }

          const qCitizenId = await db.collection(colName).where('citizenID', '==', userId).limit(1).get();
          if (!qCitizenId.empty) {
            foundUserData = qCitizenId.docs[0].data();
            break;
          }
        }

        if (foundUserData) {
          submitterName = 
            foundUserData.fullName || 
            foundUserData.displayName || 
            foundUserData.name || 
            foundUserData.full_name || 
            (foundUserData.firstName ? `${foundUserData.firstName} ${foundUserData.lastName || ''}`.trim() : null) || 
            submitterName;

          submitterEmail = 
            foundUserData.email || 
            foundUserData.emailAddress || 
            foundUserData.email_address || 
            submitterEmail;

          submitterPhone = 
            foundUserData.phoneNumber || 
            foundUserData.phone || 
            foundUserData.contactNumber || 
            foundUserData.phone_number || 
            foundUserData.mobile || 
            submitterPhone;

          if (userCache.size >= MAX_CACHE_SIZE) {
            const firstKey = userCache.keys().next().value;
            userCache.delete(firstKey);
          }
          userCache.set(cacheKey, { submitterName, submitterEmail, submitterPhone });
        }
      } catch (err) {
        console.warn(`⚠️ Could not resolve submitter details for userId (${userId}):`, err.message);
      }
    }
  }

  return {
    ...data,
    submitterName: submitterName || 'Anonymous Submitter',
    submitterEmail: submitterEmail || 'No email provided',
    submitterPhone: submitterPhone || 'No phone provided',
  };
}

// 1. GET ALL REPORTS
router.get('/reports', async (req, res) => {
  try {
    const { view } = req.query;

    if (view === 'approved') {
      const [approvedSnapshot, adminSnapshot] = await Promise.all([
        db.collection('approved_reports').get(),
        db.collection('ApprovedAdminReports').get()
      ]);

      const approvedReports = await Promise.all(
        approvedSnapshot.docs.map(async (doc) => {
          const rawData = doc.data();
          const data = await enrichWithSubmitterData(rawData);
          const vrid = data.verifiedReportId || data.verifiedreportID || null;

          return {
            id: data.id || doc.id,
            reportId: data.reportId || data.reportID || doc.id,
            reportID: data.reportID || data.reportId || doc.id,
            verifiedreportID: vrid,
            verifiedReportId: vrid,
            source: 'approved',
            isDuplicate: typeof data.isDuplicate === 'boolean' ? data.isDuplicate : false,
            ...data,
            timestamp: parseTimestamp(data.timestamp, data.createdAt),

            mediaUrl: data.mediaUrl || null,
            mediaFileName: data.mediaFileName || null,
            mediaType: data.mediaType || null,
            selectedAgencies: data.selectedAgencies || data.assignedAgencies || [],
            assignedAgencies: data.assignedAgencies || data.selectedAgencies || []
          };
        })
      );

      const adminReports = await Promise.all(
        adminSnapshot.docs.map(async (doc) => {
          const rawData = doc.data();
          const data = await enrichWithSubmitterData(rawData);
          const rawTimestamp = data.reportTimestamp || data.createdAt || data.timestamp;
          const vrid = data.verifiedReportId || data.verifiedreportID || null;

          return {
            id: data.id || doc.id,
            reportId: data.reportId || data.reportID || doc.id,
            reportID: data.reportID || data.reportId || doc.id,
            verifiedreportID: vrid,
            verifiedReportId: vrid,
            source: 'admin',

            reportTitle: data.reportTitle || data.hazard || 'Admin Incident Report',
            incidentType: data.incidentType,
            hazard: data.hazard,
            severity: data.verifiedSeverity || data.severity,
            status: data.status || 'verified',

            notes: data.notes,
            adminNotes: data.adminNotes,
            location: data.location,

            radius: data.radius || null,
            polyline: data.polyline || [],
            routeCoords: data.routeCoords || [],

            submitterName: data.submitterName,
            submitterEmail: data.submitterEmail,
            submitterPhone: data.submitterPhone,

            mediaUrl: data.media?.url || data.mediaUrl || null,
            mediaFileName: data.media?.fileName || data.mediaFileName || null,
            mediaType: data.media?.type || data.mediaType || null,

            isSensitive: typeof data.isSensitive === 'boolean' ? data.isSensitive : false,
            isDuplicate: typeof data.isDuplicate === 'boolean' ? data.isDuplicate : false,
            timestamp: parseTimestamp(rawTimestamp),
            verifiedAt: data.verifiedAt ? parseTimestamp(data.verifiedAt) : null,

            isAuthenticated: data.isAuthenticated ?? true,
            isVerified: data.isVerified ?? true,
            verifiedBy: data.verifiedBy || 'Admin',
            selectedAgencies: data.selectedAgencies || data.assignedAgencies || [],
            assignedAgencies: data.assignedAgencies || data.selectedAgencies || []
          };
        })
      );

      const mergedReports = [...approvedReports, ...adminReports];
      mergedReports.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return res.status(200).json({
        success: true,
        data: mergedReports
      });
    }

    if (view === 'duplicates') {
      const duplicatesSnapshot = await db.collection('duplicate_reports').orderBy('timestamp', 'desc').get();
      const duplicatesList = await Promise.all(
        duplicatesSnapshot.docs.map(async (doc) => {
          const rawData = doc.data();
          const data = await enrichWithSubmitterData(rawData);

          return {
            id: data.id || doc.id,
            reportId: data.reportId || data.reportID || doc.id,
            reportID: data.reportID || data.reportId || doc.id,
            isDuplicate: true,
            parentReportId: data.parentReportId || null,
            ...data,
            timestamp: parseTimestamp(data.timestamp, data.createdAt)
          };
        })
      );

      return res.status(200).json({ success: true, data: duplicatesList });
    }

    // Default query for pending reports
    const reportsSnapshot = await db.collection('reports').orderBy('timestamp', 'desc').get();
    
    // Filter out historical duplicates from pending view
    const reportsList = (
      await Promise.all(
        reportsSnapshot.docs.map(async (doc) => {
          const rawData = doc.data();
          const data = await enrichWithSubmitterData(rawData);

          const isDocDuplicate =
            data.isDuplicate === true ||
            String(data.isDuplicate).toLowerCase() === 'true' ||
            String(data.status).toLowerCase() === 'duplicate';

          if (isDocDuplicate) return null;

          return {
            id: data.id || doc.id,
            reportId: data.reportId || data.reportID || doc.id,
            reportID: data.reportID || data.reportId || doc.id,
            isDuplicate: false,
            ...data,
            timestamp: parseTimestamp(data.timestamp, data.createdAt)
          };
        })
      )
    ).filter((item) => item !== null);

    return res.status(200).json({ success: true, data: reportsList });
  } catch (error) {
    console.error("Error fetching reports:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 2. ON-DEMAND CLEANUP ROUTE: Transfers duplicates out of 'reports'
router.post('/reports/cleanup-duplicates', async (req, res) => {
  try {
    const reportsSnap = await db.collection('reports').get();
    const batch = db.batch();
    let migratedCount = 0;

    for (const doc of reportsSnap.docs) {
      const data = doc.data();
      const isDocDuplicate =
        data.isDuplicate === true ||
        String(data.isDuplicate).toLowerCase() === 'true' ||
        String(data.status).toLowerCase() === 'duplicate';

      if (isDocDuplicate) {
        const docId = doc.id;
        const destRef = db.collection('duplicate_reports').doc(docId);

        const transferPayload = cleanUndefinedValues({
          ...data,
          id: data.id || docId,
          reportId: data.reportId || data.reportID || docId,
          reportID: data.reportID || data.reportId || docId,
          status: 'Duplicate',
          isDuplicate: true,
          migratedAt: new Date().toISOString()
        });

        batch.set(destRef, transferPayload, { merge: true });
        batch.delete(doc.ref);
        migratedCount++;
      }
    }

    if (migratedCount > 0) {
      await batch.commit();
    }

    return res.status(200).json({
      success: true,
      message: `Successfully transferred ${migratedCount} duplicate report(s) from 'reports' to 'duplicate_reports' and deleted the originals.`
    });
  } catch (error) {
    console.error('Error cleaning up duplicates:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 3. GET SINGLE REPORT BY ID
router.get('/reports/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const collections = ['reports', 'approved_reports', 'ApprovedAdminReports', 'duplicate_reports'];

    for (const colName of collections) {
      let docSnap = await db.collection(colName).doc(id).get();

      if (!docSnap.exists) {
        let q = await db.collection(colName).where('id', '==', id).limit(1).get();
        if (q.empty) q = await db.collection(colName).where('reportId', '==', id).limit(1).get();
        if (q.empty) q = await db.collection(colName).where('reportID', '==', id).limit(1).get();
        if (!q.empty) {
          docSnap = q.docs[0];
        }
      }

      if (docSnap && docSnap.exists) {
        const rawData = docSnap.data();
        const enrichedData = await enrichWithSubmitterData(rawData);
        const vrid = enrichedData.verifiedReportId || enrichedData.verifiedreportID || null;

        return res.status(200).json({
          success: true,
          id: enrichedData.id || docSnap.id,
          reportId: enrichedData.reportId || enrichedData.reportID || docSnap.id,
          reportID: enrichedData.reportID || enrichedData.reportId || docSnap.id,
          verifiedreportID: vrid,
          verifiedReportId: vrid,
          isDuplicate: typeof enrichedData.isDuplicate === 'boolean' ? enrichedData.isDuplicate : false,
          ...enrichedData,
          timestamp: parseTimestamp(enrichedData.timestamp, enrichedData.createdAt)
        });
      }
    }

    return res.status(404).json({ success: false, message: "Report not found." });
  } catch (error) {
    console.error("Error fetching single report:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 4. PATCH: MANUALLY MARK EXISTING PENDING REPORT AS DUPLICATE
router.patch('/reports/:id/mark-duplicate', async (req, res) => {
  const { id } = req.params;
  const { parentReportId } = req.body;

  try {
    let ref = db.collection('reports').doc(id);
    let snap = await ref.get();

    if (!snap.exists) {
      let q = await db.collection('reports').where('id', '==', id).limit(1).get();
      if (q.empty) q = await db.collection('reports').where('reportId', '==', id).limit(1).get();
      if (q.empty) q = await db.collection('reports').where('reportID', '==', id).limit(1).get();

      if (!q.empty) {
        snap = q.docs[0];
        ref = snap.ref;
      }
    }

    if (!snap || !snap.exists) {
      return res.status(404).json({
        success: false,
        message: 'Pending report not found in reports collection.'
      });
    }

    const reportData = snap.data();
    const docId = snap.id;

    const duplicateData = cleanUndefinedValues({
      ...reportData,
      id: reportData.id || docId,
      reportId: reportData.reportId || reportData.reportID || docId,
      reportID: reportData.reportID || reportData.reportId || docId,
      status: 'Duplicate',
      isDuplicate: true,
      parentReportId: parentReportId || reportData.parentReportId || null,
      flaggedAt: new Date().toISOString()
    });

    const batch = db.batch();
    const duplicateRef = db.collection('duplicate_reports').doc(docId);

    batch.set(duplicateRef, duplicateData);
    batch.delete(ref);
    await batch.commit();

    const io = getIO();
    if (io) {
      io.emit('report_marked_duplicate', {
        id: docId,
        reportId: duplicateData.reportId,
        ...duplicateData
      });
    }

    return res.status(200).json({
      success: true,
      message: `Report #${docId} marked as duplicate, transferred to 'duplicate_reports', and deleted from 'reports'.`,
      data: duplicateData
    });
  } catch (error) {
    console.error('Error marking report as duplicate:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 5. PATCH / POST: VERIFY AND MIGRATE TO APPROVED (ATOMIC VRID TRANSACTION)
const handleVerification = async (req, res) => {
  const id = req.params.id || req.body.id || req.body.reportID || req.body.reportId;

  const {
    status,
    incidentType,
    verifiedSeverity,
    adminNotes,
    reportTitle, 
    selectedAgencies,
    correctedLatitude,
    correctedLongitude,
    correctedAddress,
    selectedMarkerIcon,
    radius,
    polyline,
    routeCoords,
    isSensitive,
    location,
    verifiedBy
  } = req.body;

  if (!id) {
    return res.status(400).json({ success: false, message: "Missing required report ID." });
  }

  try {
    const verifiedCounterRef = db.collection('counters').doc('verified_reports_counter');

    const result = await db.runTransaction(async (transaction) => {
      // Step A: Find the target report across collections
      const collectionsToSearch = ['reports', 'ApprovedAdminReports', 'approved_reports', 'duplicate_reports'];
      let sourceReportRef = null;
      let docSnapshot = null;
      let foundCollection = null;

      for (const col of collectionsToSearch) {
        let ref = db.collection(col).doc(id);
        let snap = await transaction.get(ref);

        if (!snap.exists) {
          let q = await db.collection(col).where('id', '==', id).limit(1).get();
          if (q.empty) q = await db.collection(col).where('reportId', '==', id).limit(1).get();
          if (q.empty) q = await db.collection(col).where('reportID', '==', id).limit(1).get();

          if (!q.empty) {
            snap = await transaction.get(q.docs[0].ref);
          }
        }

        if (snap && snap.exists) {
          docSnapshot = snap;
          sourceReportRef = snap.ref;
          foundCollection = col;
          break;
        }
      }

      if (!docSnapshot || !docSnapshot.exists) {
        throw new Error("Pending or target report not found.");
      }

      // Step B: Atomic VRID Generation via Transaction Counter
      const rawSourceData = docSnapshot.data();
      let generatedVRID = rawSourceData.verifiedReportId || rawSourceData.verifiedreportID;

      if (!generatedVRID) {
        const counterDoc = await transaction.get(verifiedCounterRef);
        let currentCounter = 0;
        if (counterDoc.exists) {
          currentCounter = counterDoc.data().current || counterDoc.data().currentValue || 0;
        }
        const nextCounter = currentCounter + 1;
        generatedVRID = formatVerifiedReportId(nextCounter);
        
        transaction.set(verifiedCounterRef, { current: nextCounter, currentValue: nextCounter }, { merge: true });
      }

      // Step C: Prepare destination payload
      const docId = docSnapshot.id;
      const destinationApprovedRef = db.collection('approved_reports').doc(docId);
      
      const sourceData = await enrichWithSubmitterData(rawSourceData);
      const existingLocationObj = (typeof sourceData.location === 'object' && sourceData.location !== null)
        ? sourceData.location
        : {};

      const approvedData = cleanUndefinedValues({
        ...sourceData,
        id: sourceData.id || docId,
        reportId: sourceData.reportId || sourceData.reportID || docId,
        reportID: sourceData.reportID || sourceData.reportId || docId,
        verifiedReportId: generatedVRID,
        verifiedreportID: generatedVRID,
        incidentId: docId,
        incidentType: incidentType || sourceData.incidentType || 'others',
        severity: verifiedSeverity || sourceData.severity || 'Medium',
        status: status || 'verified',
        verifiedAt: new Date().toISOString(),
        verifiedBy: verifiedBy || sourceData.verifiedBy || 'Admin',
        adminNotes: adminNotes || sourceData.adminNotes || 'Verified.',
        
        reportTitle: reportTitle || sourceData.reportTitle || '',
        
        submitterName: sourceData.submitterName,
        submitterEmail: sourceData.submitterEmail,
        submitterPhone: sourceData.submitterPhone,

        selectedAgencies: selectedAgencies || sourceData.selectedAgencies || [],
        
        location: {
          ...existingLocationObj,
          latitude: correctedLatitude ?? location?.latitude ?? sourceData.latitude ?? existingLocationObj.latitude ?? 0,
          longitude: correctedLongitude ?? location?.longitude ?? sourceData.longitude ?? existingLocationObj.longitude ?? 0,
          address: correctedAddress || location?.address || sourceData.address || existingLocationObj.address || (typeof sourceData.location === 'string' ? sourceData.location : '')
        },
        
        selectedMarkerIcon: selectedMarkerIcon || sourceData.selectedMarkerIcon || '',
        ...(radius ? { radius } : {}),
        ...(polyline ? { polyline } : {}),
        routeCoords: routeCoords || sourceData.routeCoords || [],
        isSensitive: typeof isSensitive === 'boolean' ? isSensitive : (sourceData.isSensitive ?? false),
        isDuplicate: false,
        timestamp: parseTimestamp(sourceData.timestamp, sourceData.createdAt)
      });

      // Step D: Write payload to destination and delete source if moving
      transaction.set(destinationApprovedRef, approvedData);

      if (foundCollection !== 'approved_reports') {
        transaction.delete(sourceReportRef);
      }

      return approvedData;
    });

    const io = getIO();
    if (io) {
      io.emit('report_verified', {
        id: result.id,
        reportId: result.reportId,
        verifiedReportId: result.verifiedReportId,
        verifiedreportID: result.verifiedreportID,
        source: 'approved',
        ...result
      });
    }

    // 🚀 Trigger FCM Push Notification only when migrated to approved_reports
    await trySendApprovedReportNotification(result, result.verifiedReportId);

    return res.status(200).json({
      success: true,
      message: `Report successfully verified and migrated to approved_reports.`,
      verifiedReportId: result.verifiedReportId,
      verifiedreportID: result.verifiedreportID,
      data: result
    });
  } catch (error) {
    console.error("Migration error:", error);
    const statusCode = error.message.includes("not found") ? 404 : 500;
    return res.status(statusCode).json({ success: false, message: error.message });
  }
};

router.patch('/reports/:id/verify', handleVerification);
router.post('/admin-reports/approve', handleVerification);

// 6. POST NEW REPORT
router.post('/reports', async (req, res) => {
  try {
    const rawReportData = req.body;

    if (!rawReportData || Object.keys(rawReportData).length === 0) {
      return res.status(400).json({ success: false, message: "Report body cannot be empty." });
    }

    const reportData = await enrichWithSubmitterData(rawReportData);
    const generatedNanoId = generateNanoId(10);

    const serverCheck = await checkIsDuplicate(reportData, 500);

    const isClientFlaggedDuplicate = 
      reportData.isDuplicate === true || 
      String(reportData.isDuplicate).toLowerCase() === 'true' ||
      String(reportData.status).toLowerCase() === 'duplicate';

    const isDuplicate = isClientFlaggedDuplicate || serverCheck.isDuplicate === true;
    const parentReportId = reportData.parentReportId || serverCheck.parentReportId || null;

    if (isDuplicate) {
      const duplicateDocRef = db.collection('duplicate_reports').doc(generatedNanoId);

      const duplicatePayload = cleanUndefinedValues({
        ...reportData,
        id: generatedNanoId,
        reportId: generatedNanoId,
        reportID: generatedNanoId,
        parentReportId: parentReportId || null,
        status: 'Duplicate',
        isDuplicate: true,
        timestamp: reportData.timestamp ? reportData.timestamp : FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        flaggedAt: FieldValue.serverTimestamp()
      });

      await duplicateDocRef.set(duplicatePayload);

      const responsePayload = cleanUndefinedValues({
        ...reportData,
        id: generatedNanoId,
        reportId: generatedNanoId,
        reportID: generatedNanoId,
        parentReportId: parentReportId || null,
        status: 'Duplicate',
        isDuplicate: true,
        timestamp: parseTimestamp(reportData.timestamp)
      });

      const io = getIO();
      if (io) {
        io.emit('new_duplicate_report', responsePayload);
      }

      return res.status(201).json({
        success: true,
        isDuplicate: true,
        parentReportId: parentReportId || null,
        id: generatedNanoId,
        reportId: generatedNanoId,
        reportID: generatedNanoId,
        data: responsePayload,
        message: 'Report flagged as Duplicate and routed to duplicate_reports collection.'
      });
      
    } else {
      const counterRef = db.collection('counters').doc('reports_counter');

      const { formattedReportId } = await db.runTransaction(async (transaction) => {
        const counterDoc = await transaction.get(counterRef);

        let currentCounter = 0;
        if (counterDoc.exists) {
          currentCounter = counterDoc.data().current || 0;
        }

        const nextCounter = currentCounter + 1;
        const formattedId = formatReportId(nextCounter);

        transaction.set(counterRef, { current: nextCounter }, { merge: true });

        const newReportRef = db.collection('reports').doc(formattedId);
        
        const newReportPayload = cleanUndefinedValues({
          ...reportData,
          id: generatedNanoId,
          reportId: formattedId,
          reportID: formattedId,
          status: reportData.status || 'pending',
          isDuplicate: false,
          timestamp: reportData.timestamp ? reportData.timestamp : FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp()
        });

        transaction.set(newReportRef, newReportPayload);

        return { formattedReportId: formattedId };
      });

      const newReportPayload = cleanUndefinedValues({
        ...reportData,
        id: generatedNanoId,
        reportId: formattedReportId,
        reportID: formattedReportId,
        status: reportData.status || 'pending',
        isDuplicate: false,
        timestamp: parseTimestamp(reportData.timestamp)
      });

      const io = getIO();
      if (io) {
        io.emit('new_citizen_report', newReportPayload);
      }

      return res.status(201).json({ 
        success: true, 
        isDuplicate: false,
        id: generatedNanoId,
        reportId: formattedReportId,
        reportID: formattedReportId,
        data: newReportPayload,
        message: 'New valid report created successfully and routed to reports collection.'
      });
    }

  } catch (error) {
    console.error("Error creating report:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 7. POST REJECT REPORT (ARCHIVE)
router.post('/reports/:id/reject', async (req, res) => {
  const { id } = req.params;

  try {
    const collectionsToSearch = ['reports', 'duplicate_reports'];
    let docSnap = null;

    for (const col of collectionsToSearch) {
      let ref = db.collection(col).doc(id);
      let snap = await ref.get();

      if (!snap.exists) {
        let q = await db.collection(col).where('id', '==', id).limit(1).get();
        if (q.empty) q = await db.collection(col).where('reportId', '==', id).limit(1).get();
        if (q.empty) q = await db.collection(col).where('reportID', '==', id).limit(1).get();

        if (!q.empty) {
          snap = q.docs[0];
        }
      }

      if (snap && snap.exists) {
        docSnap = snap;
        break;
      }
    }

    if (!docSnap || !docSnap.exists) {
      return res.status(404).json({
        success: false,
        message: 'Active or duplicate report not found.'
      });
    }

    const reportData = docSnap.data();
    const docId = docSnap.id;

    const archivedData = cleanUndefinedValues({
      ...reportData,
      status: 'rejected',
      timestamp: parseTimestamp(reportData.timestamp, reportData.createdAt),
      archivedAt: new Date().toISOString(),
      rejectedAt: new Date().toISOString()
    });

    const batch = db.batch();
    const archiveRef = db.collection('archivedreports').doc(docId);

    batch.set(archiveRef, archivedData);
    batch.delete(docSnap.ref);

    await batch.commit();

    return res.status(200).json({
      success: true,
      message: `Report #${docId} successfully rejected and moved to archives.`
    });

  } catch (error) {
    console.error('Error rejecting report:', error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 8. GET ALL DUPLICATE REPORTS
router.get('/duplicate-reports', async (req, res) => {
  try {
    const snapshot = await db.collection('duplicate_reports').get();

    const duplicateReports = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.status(200).json({
      success: true,
      count: duplicateReports.length,
      data: duplicateReports,
    });
  } catch (error) {
    console.error('⚠️ Error fetching from duplicate_reports collection:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch items from duplicate_reports collection.',
      error: error.message,
    });
  }
});

// 9. GET SINGLE DUPLICATE REPORT BY ID
router.get('/duplicate-reports/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection('duplicate_reports').doc(id);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({
        success: false,
        message: `Duplicate report #${id} was not found in duplicate_reports collection.`,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: docSnap.id,
        ...docSnap.data(),
      },
    });
  } catch (error) {
    console.error(`⚠️ Error fetching duplicate report #${req.params.id}:`, error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve duplicate report record.',
      error: error.message,
    });
  }
});

module.exports = router;