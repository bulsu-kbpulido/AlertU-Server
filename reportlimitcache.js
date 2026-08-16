const express = require('express');
const router = express.Router();
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getIO } = require('./socket');
const crypto = require('crypto'); // Native Node.js CommonJS-safe ID generator

const db = getFirestore();

/**
 * =========================================================================
 * IN-MEMORY DATA CACHE ENGINES
 * =========================================================================
 */
const reportCache = {
  active: { data: null, timestamp: 0 },
  duplicate: { data: null, timestamp: 0 },
  approved: { data: null, timestamp: 0 },
};

// Cache Time-To-Live in milliseconds (30 seconds)
const CACHE_TTL_MS = 30 * 1000;

// User cache engine with size capping (max 1000 entries) to protect memory footprint
const userCache = new Map();
const MAX_USER_CACHE_SIZE = 1000;

/**
 * Helper function to invalidate cache layers on mutations (Create/Verify/Reject/Restore/Delete)
 */
function invalidateReportCache(keys = ['active', 'duplicate', 'approved']) {
  keys.forEach((key) => {
    if (reportCache[key]) {
      reportCache[key].data = null;
      reportCache[key].timestamp = 0;
    }
  });
}

/**
 * CommonJS-compatible NanoID replacement using Node's crypto module
 */
function generateNanoId(length = 10) {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

/**
 * Helper functions: Formats database counter integers into zero-padded IDs
 */
function formatReportId(counterNumber) {
  return `RID${String(counterNumber).padStart(8, '0')}`;
}

function formatVerifiedReportId(counterNumber) {
  return `VRID${String(counterNumber).padStart(8, '0')}`;
}

/**
 * Helper function: Sanitizes ID params (strips trailing artifacts like ':1' or whitespace)
 */
function sanitizeId(rawId) {
  if (!rawId) return '';
  return String(rawId).split(':')[0].trim();
}

/**
 * Helper function: Finds a document across multiple Firestore collections by doc ID or custom ID fields.
 * Supports running within an active database transaction window.
 */
async function findDocInCollections(collections, rawId, transaction = null) {
  const cleanId = sanitizeId(rawId);
  if (!cleanId) return null;

  for (const colName of collections) {
    const colRef = db.collection(colName);
    const docRef = colRef.doc(cleanId);
    
    // 1. Direct Doc ID check
    let snap = transaction ? await transaction.get(docRef) : await docRef.get();
    if (snap.exists) {
      return { snap, collection: colName };
    }

    // 2. Query fallback for dynamic legacy custom ID keys
    const fieldQueries = ['reportId', 'reportID', 'verifiedReportId', 'verifiedreportID', 'verifiedReportID', 'verifiedreportid', 'vrid', 'id'];
    for (const field of fieldQueries) {
      let q = colRef.where(field, '==', cleanId).limit(1);
      let querySnap = transaction ? await transaction.get(q) : await q.get();
      if (!querySnap.empty) {
        let docSnap = querySnap.docs[0];
        if (transaction) {
          docSnap = await transaction.get(docSnap.ref);
        }
        return { snap: docSnap, collection: colName };
      }
    }
  }

  return null;
}

/**
 * Helper function: Converts Firestore Timestamps, JS Dates, serialized epoch markers, or strings into ISO string.
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
 * Recursively removes 'undefined' properties from payload structures without breaking native Firestore drivers.
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
 * Helper to extract coordinates safely from different nested report geometry models
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
 * Scans active and incoming tables to detect matching incident hazards within a given meter threshold.
 */
async function checkIsDuplicate(upcomingReport, maxDistanceMeters = 500) {
  try {
    const upcomingCoords = extractCoords(upcomingReport);
    if (isNaN(upcomingCoords.latitude) || isNaN(upcomingCoords.longitude)) {
      console.warn('⚠️ Invalid or missing coordinates on incoming report. Skipping duplicate check.');
      return { isDuplicate: false, parentReportId: null };
    }

    const upcomingType = String(
      upcomingReport.incidentType || upcomingReport.hazard || ''
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
        activeReport.incidentType || activeReport.hazard || ''
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
 * Enriches individual reports with complete citizen profile metrics via capped Map Cache.
 */
async function enrichWithSubmitterData(data) {
  if (!data) return data;

  const userId =
    data.userId || data.user_id || data.citizenId || data.citizen_id || data.citizenID || data.uid || data.authUid || data.reporterId;

  let submitterName =
    data.submitterName || data.submitter_name || data.reporterName || data.fullName || data.displayName || data.name || null;

  let submitterEmail =
    data.submitterEmail || data.submitter_email || data.reporterEmail || data.email || null;

  let submitterPhone =
    data.submitterPhone || data.submitter_phone || data.reporterPhone || data.phone || data.phoneNumber || data.contactNumber || null;

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

          submitterEmail = foundUserData.email || foundUserData.emailAddress || foundUserData.email_address || submitterEmail;
          submitterPhone = foundUserData.phoneNumber || foundUserData.phone || foundUserData.contactNumber || foundUserData.phone_number || foundUserData.mobile || submitterPhone;

          if (userCache.size >= MAX_USER_CACHE_SIZE) {
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

// =========================================================================
// CORE ROUTE HANDLERS
// =========================================================================

// 1. GET ALL REPORTS (WITH OPTIMAL CACHING ENGINE AND CONFIGURABLE LIMITS)
router.get('/reports', async (req, res) => {
  try {
    const { view, tab, queryLimit } = req.query;
    const now = Date.now();
    const parsedLimit = parseInt(queryLimit, 10) || 50;

    // --- VIEW: APPROVED INCIDENTS ---
    if (view === 'approved') {
      if (reportCache.approved.data && (now - reportCache.approved.timestamp < CACHE_TTL_MS)) {
        return res.status(200).json({ success: true, data: reportCache.approved.data, cached: true });
      }

      const [approvedSnapshot, adminSnapshot] = await Promise.all([
        db.collection('approved_reports').limit(parsedLimit).get(),
        db.collection('ApprovedAdminReports').limit(parsedLimit).get()
      ]);

      const approvedReports = await Promise.all(
        approvedSnapshot.docs.map(async (doc) => {
          const rawData = doc.data();
          const data = await enrichWithSubmitterData(rawData);
          const vrid = data.verifiedReportId || data.verifiedreportID || data.verifiedReportID || data.verifiedreportid || null;
          const displayId = vrid || data.reportId || data.reportID || doc.id;

          return {
            ...data,
            id: doc.id,
            reportId: displayId,
            reportID: displayId,
            verifiedreportID: vrid,
            verifiedReportId: vrid,
            verifiedReportID: vrid, 
            verifiedreportid: vrid,
            source: 'approved',
            isDuplicate: typeof data.isDuplicate === 'boolean' ? data.isDuplicate : false,
            timestamp: parseTimestamp(data.timestamp, data.createdAt),
            mediaUrl: data.mediaUrl || null,
            mediaFileName: data.mediaFileName || null,
            mediaType: data.mediaType || null,
            selectedAgencies: data.selectedAgencies || []
          };
        })
      );

      const adminReports = await Promise.all(
        adminSnapshot.docs.map(async (doc) => {
          const rawData = doc.data();
          const data = await enrichWithSubmitterData(rawData);
          const rawTimestamp = data.reportTimestamp || data.createdAt || data.timestamp;
          
          const vrid = data.verifiedReportId || data.verifiedReportID || data.verifiedreportID || data.verifiedreportid || null;
          const displayId = vrid || data.reportId || data.reportID || doc.id;

          return {
            ...data, 
            id: doc.id,
            reportId: displayId,
            reportID: displayId,
            vrid: vrid,
            displayId: displayId,
            verifiedreportID: vrid,
            verifiedReportId: vrid,
            verifiedReportID: vrid,
            verifiedreportid: vrid,
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
            selectedAgencies: data.selectedAgencies || []
          };
        })
      );

      const mergedReports = [...approvedReports, ...adminReports];
      mergedReports.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      reportCache.approved = { data: mergedReports, timestamp: now };
      return res.status(200).json({ success: true, data: mergedReports });
    }

    // --- VIEW / TAB: DUPLICATE TICKETS ---
    if (view === 'duplicates' || tab === 'duplicate') {
      if (reportCache.duplicate.data && (now - reportCache.duplicate.timestamp < CACHE_TTL_MS)) {
        return res.status(200).json({ success: true, data: reportCache.duplicate.data, cached: true });
      }

      const [duplicateCollectionSnap, duplicateFlaggedSnap] = await Promise.all([
        db.collection('duplicate_reports').limit(parsedLimit).get(),
        db.collection('reports').where('isDuplicate', '==', true).limit(parsedLimit).get()
      ]);

      const duplicateList = await Promise.all([
        ...duplicateCollectionSnap.docs,
        ...duplicateFlaggedSnap.docs
      ].map(async (doc) => {
        const rawData = doc.data();
        const data = await enrichWithSubmitterData(rawData);
        return {
          ...data,
          id: doc.id,
          reportId: data.reportId || data.reportID || doc.id,
          reportID: data.reportID || data.reportId || doc.id,
          isDuplicate: true,
          parentReportId: data.parentReportId || null,
          timestamp: parseTimestamp(data.timestamp, data.createdAt)
        };
      }));

      const uniqueDuplicates = Array.from(
        new Map(duplicateList.map((item) => [item.id, item])).values()
      );
      uniqueDuplicates.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      reportCache.duplicate = { data: uniqueDuplicates, timestamp: now };
      return res.status(200).json({ success: true, data: uniqueDuplicates });
    }

    // --- DEFAULT: PENDING OPEN ACTIVE QUEUE ---
    if (reportCache.active.data && (now - reportCache.active.timestamp < CACHE_TTL_MS)) {
      return res.status(200).json({ success: true, data: reportCache.active.data, cached: true });
    }

    const reportsSnapshot = await db
      .collection('reports')
      .where('isDuplicate', '==', false)
      .limit(parsedLimit)
      .get();

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
            ...data,
            id: doc.id,
            reportId: data.reportId || data.reportID || doc.id,
            reportID: data.reportID || data.reportId || doc.id,
            isDuplicate: false,
            timestamp: parseTimestamp(data.timestamp, data.createdAt)
          };
        })
      )
    ).filter((item) => item !== null);

    reportsList.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    reportCache.active = { data: reportsList, timestamp: now };
    return res.status(200).json({ success: true, data: reportsList });
  } catch (error) {
    console.error("Error fetching reports:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 2. ON-DEMAND CLEANUP ROUTE: Transfers duplicates out of 'reports' to separate collections
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
          id: docId,
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
      invalidateReportCache(['active', 'duplicate']);
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

// 3. GET SINGLE REPORT BY ANY VALID GLOBAL ID INTERCEPTOR
router.get('/reports/:id', async (req, res) => {
  const cleanId = sanitizeId(req.params.id);

  try {
    const collections = ['reports', 'approved_reports', 'ApprovedAdminReports', 'duplicate_reports'];
    const result = await findDocInCollections(collections, cleanId);

    if (result && result.snap) {
      const docSnap = result.snap;
      const rawData = docSnap.data();
      const enrichedData = await enrichWithSubmitterData(rawData);
      
      const vrid = enrichedData.verifiedReportId || enrichedData.verifiedreportID || enrichedData.verifiedReportID || enrichedData.verifiedreportid || null;
      const displayId = vrid || enrichedData.reportId || enrichedData.reportID || docSnap.id;

      return res.status(200).json({
        success: true,
        ...enrichedData,
        id: docSnap.id,
        reportId: displayId,
        reportID: displayId,
        verifiedreportID: vrid,
        verifiedReportId: vrid,
        verifiedReportID: vrid,
        verifiedreportid: vrid,
        isDuplicate: typeof enrichedData.isDuplicate === 'boolean' ? enrichedData.isDuplicate : (result.collection === 'duplicate_reports'),
        timestamp: parseTimestamp(enrichedData.timestamp, enrichedData.createdAt)
      });
    }

    return res.status(404).json({ success: false, message: "Report not found." });
  } catch (error) {
    console.error("Error fetching single report:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 4. PATCH: MANUALLY MARK PENDING TICKET AS DUPLICATE
router.patch('/reports/:id/mark-duplicate', async (req, res) => {
  const cleanId = sanitizeId(req.params.id);
  const { parentReportId } = req.body;

  try {
    const result = await findDocInCollections(['reports'], cleanId);

    if (!result || !result.snap) {
      return res.status(404).json({
        success: false,
        message: 'Pending report not found in reports collection.'
      });
    }

    const snap = result.snap;
    const ref = snap.ref;
    const reportData = snap.data();
    const docId = snap.id;

    const duplicateData = cleanUndefinedValues({
      ...reportData,
      id: docId,
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

    invalidateReportCache(['active', 'duplicate']);

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

// 5. PATCH / POST: ATOMIC MIGRATION TRANSACTION TO APPROVED STATUS WITH VRID GENERATION
const handleVerification = async (req, res) => {
  const rawId = req.params.id || req.body.id || req.body.reportID || req.body.reportId;
  const cleanId = sanitizeId(rawId);

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

  if (!cleanId) {
    return res.status(400).json({ success: false, message: "Missing required report ID." });
  }

  try {
    const verifiedCounterRef = db.collection('counters').doc('verified_reports_counter');

    const result = await db.runTransaction(async (transaction) => {
      const collectionsToSearch = ['reports', 'ApprovedAdminReports', 'approved_reports', 'duplicate_reports'];
      const searchResult = await findDocInCollections(collectionsToSearch, cleanId, transaction);

      if (!searchResult || !searchResult.snap) {
        throw new Error("Pending or target report not found across indexed system scopes.");
      }

      const docSnapshot = searchResult.snap;
      const sourceReportRef = docSnapshot.ref;
      const foundCollection = searchResult.collection;

      const rawSourceData = docSnapshot.data();
      let generatedVRID = rawSourceData.verifiedReportId || rawSourceData.verifiedreportID || rawSourceData.verifiedReportID || rawSourceData.verifiedreportid;

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

      const docId = docSnapshot.id;
      const destinationApprovedRef = db.collection('approved_reports').doc(docId);
      
      const sourceData = await enrichWithSubmitterData(rawSourceData);
      const existingLocationObj = (typeof sourceData.location === 'object' && sourceData.location !== null)
        ? sourceData.location
        : {};

      const approvedData = cleanUndefinedValues({
        ...sourceData,
        id: docId,
        reportId: generatedVRID,
        reportID: generatedVRID,
        verifiedReportId: generatedVRID,
        verifiedreportID: generatedVRID,
        verifiedReportID: generatedVRID,
        verifiedreportid: generatedVRID,
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

      transaction.set(destinationApprovedRef, approvedData);

      if (foundCollection !== 'approved_reports') {
        transaction.delete(sourceReportRef);
      }

      return approvedData;
    });

    invalidateReportCache(['active', 'duplicate', 'approved']);

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

// 6. POST: SUBMIT NEW INCIDENT (WITH TRANSACTION ISOLATION AND DUPLICATE MATCHING AUTOMATION)
router.post('/reports', async (req, res) => {
  try {
    const rawReportData = req.body;

    if (!rawReportData || Object.keys(rawReportData).length === 0) {
      return res.status(400).json({ success: false, message: "Report body cannot be empty." });
    }

    const reportData = await enrichWithSubmitterData(rawReportData);
    const generatedNanoId = generateNanoId(10);

    // Dynamic Server Proximity Check
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
      invalidateReportCache(['duplicate']);

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

      invalidateReportCache(['active']);

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

// 7. POST: REJECT AND ARCHIVE ACTIVE OR DUPLICATE REPORT
router.post('/reports/:id/reject', async (req, res) => {
  const cleanId = sanitizeId(req.params.id);

  try {
    const collectionsToSearch = ['reports', 'duplicate_reports', 'approved_reports', 'ApprovedAdminReports'];
    const result = await findDocInCollections(collectionsToSearch, cleanId);

    if (!result || !result.snap) {
      return res.status(404).json({
        success: false,
        message: 'Report not found across active, duplicate or approved collections.'
      });
    }

    const docSnap = result.snap;
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

    invalidateReportCache(['active', 'duplicate', 'approved']);

    return res.status(200).json({
      success: true,
      message: `Report #${docId} successfully rejected and moved to archives.`
    });
  } catch (error) {
    console.error('Error rejecting report:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// =========================================================================
// DUPLICATE QUEUE RESTORATION & PURGE ENGINE
// =========================================================================

// 8. POST: RESTORE SINGLE DUPLICATE REPORT ENTRY TO ACTIVE QUEUE
router.post('/duplicate-reports/:id/restore', async (req, res) => {
  const cleanId = sanitizeId(req.params.id);

  try {
    const result = await findDocInCollections(['duplicate_reports', 'reports'], cleanId);

    if (!result || !result.snap) {
      return res.status(404).json({
        success: false,
        message: `Duplicate report record #${cleanId} not found.`
      });
    }

    const duplicateSnap = result.snap;
    const reportData = duplicateSnap.data();
    const targetReportId = reportData.reportId || reportData.reportID || duplicateSnap.id;

    const restoredPayload = cleanUndefinedValues({
      ...reportData,
      id: duplicateSnap.id,
      reportId: targetReportId,
      reportID: targetReportId,
      status: 'pending',
      isDuplicate: false,
      parentReportId: FieldValue.delete(),
      restoredAt: new Date().toISOString()
    });

    const batch = db.batch();
    const primaryRef = db.collection('reports').doc(targetReportId);

    batch.set(primaryRef, restoredPayload, { merge: true });

    if (duplicateSnap.ref.parent.id === 'duplicate_reports') {
      batch.delete(duplicateSnap.ref);
    }

    await batch.commit();
    invalidateReportCache(['active', 'duplicate']);

    const io = getIO();
    if (io) {
      io.emit('report_restored', {
        id: targetReportId,
        reportId: targetReportId,
        ...restoredPayload
      });
    }

    return res.status(200).json({
      success: true,
      message: `Report #${targetReportId} successfully restored to active verification queue.`,
      data: restoredPayload
    });
  } catch (error) {
    console.error(`Error restoring duplicate report #${req.params.id}:`, error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 9. DELETE: PERMANENTLY PURGE DUPLICATE RECORD FROM STACKS
router.delete('/duplicate-reports/:id', async (req, res) => {
  const cleanId = sanitizeId(req.params.id);

  try {
    const result = await findDocInCollections(['duplicate_reports', 'reports'], cleanId);

    if (!result || !result.snap) {
      return res.status(404).json({
        success: false,
        message: `Duplicate record #${cleanId} not found.`
      });
    }

    await result.snap.ref.delete();
    invalidateReportCache(['duplicate', 'active']);

    const io = getIO();
    if (io) {
      io.emit('duplicate_report_deleted', { id: result.snap.id });
    }

    return res.status(200).json({
      success: true,
      message: `Duplicate record #${result.snap.id} permanently purged.`
    });
  } catch (error) {
    console.error(`Error purging duplicate report #${req.params.id}:`, error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 10. POST: BATCH RESTORE DUPLICATE RECORDS
router.post('/duplicate-reports/batch-restore', async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, message: 'Array of report IDs is required.' });
  }

  try {
    const batch = db.batch();
    const restoredItems = [];

    for (const rawId of ids) {
      const result = await findDocInCollections(['duplicate_reports', 'reports'], rawId);

      if (result && result.snap) {
        const dupSnap = result.snap;
        const data = dupSnap.data();
        const targetId = data.reportId || data.reportID || dupSnap.id;
        const targetRef = db.collection('reports').doc(targetId);

        const restoredData = cleanUndefinedValues({
          ...data,
          id: dupSnap.id,
          reportId: targetId,
          reportID: targetId,
          status: 'pending',
          isDuplicate: false,
          parentReportId: FieldValue.delete(),
          restoredAt: new Date().toISOString()
        });

        batch.set(targetRef, restoredData, { merge: true });

        if (dupSnap.ref.parent.id === 'duplicate_reports') {
          batch.delete(dupSnap.ref);
        }

        restoredItems.push(restoredData);
      }
    }

    if (restoredItems.length > 0) {
      await batch.commit();
      invalidateReportCache(['active', 'duplicate']);

      const io = getIO();
      if (io) {
        io.emit('batch_reports_restored', { items: restoredItems });
      }
    }

    return res.status(200).json({
      success: true,
      count: restoredItems.length,
      message: `Successfully restored ${restoredItems.length} duplicate report(s).`
    });
  } catch (error) {
    console.error('Batch restore error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 11. POST: BATCH PURGE DUPLICATE RECORDS
router.post('/duplicate-reports/batch-delete', async (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, message: 'Array of report IDs is required.' });
  }

  try {
    const batch = db.batch();
    let deleteCount = 0;

    for (const rawId of ids) {
      const result = await findDocInCollections(['duplicate_reports', 'reports'], rawId);
      if (result && result.snap) {
        batch.delete(result.snap.ref);
        deleteCount++;
      }
    }

    if (deleteCount > 0) {
      await batch.commit();
      invalidateReportCache(['duplicate', 'active']);

      const io = getIO();
      if (io) {
        io.emit('batch_reports_deleted', { ids });
      }
    }

    return res.status(200).json({
      success: true,
      count: deleteCount,
      message: `Successfully purged ${deleteCount} duplicate report(s).`
    });
  } catch (error) {
    console.error('Batch delete error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;