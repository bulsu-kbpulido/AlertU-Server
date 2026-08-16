// adminReportRoutes.js - Secure Admin Report Collection with Media & Real-Time Socket Integration
const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');
const { verifyToken } = require('./authMiddleware');
const { getIO } = require('./socket'); // 👈 Import Socket accessor
const { trySendApprovedReportNotification } = require('./sendreportnotifs');

const db = getFirestore();

const ALLOWED_MIME_TYPES = ['video/mp4', 'image/png', 'image/jpeg'];
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

/**
 * Helper to generate an atomic auto-incrementing verifiedReportId (e.g. VRID00000001)
 */
async function generateVerifiedReportId(transaction) {
  // 🎯 Points to the exact same counter tracking document as reportRoutes.js
  const counterRef = db.collection('counters').doc('verified_reports_counter');
  const counterSnapshot = await transaction.get(counterRef);

  let currentCount = 0;
  if (counterSnapshot.exists) {
    // 🎯 Reads the exact same fields 'current' and 'currentValue'
    currentCount = counterSnapshot.data().current || counterSnapshot.data().currentValue || 0;
  }

  const nextCounter = currentCount + 1;

  // 🎯 Updates the document with the identical structure used in reportRoutes.js
  transaction.set(
    counterRef, 
    { current: nextCounter, currentValue: nextCounter }, 
    { merge: true }
  );

  // Format with leading zeros to 8 digits
  return `VRID${String(nextCounter).padStart(8, '0')}`;
}

// 1. GET ALL ADMIN REPORTS (Checks approved_reports primary collection)
router.get('/admin-reports', async (req, res) => {
  try {
    const { status, sortBy } = req.query;
    let query = db.collection('approved_reports');

    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    const reportsSnapshot = await query.orderBy(sortBy || 'createdAt', 'desc').get();
    let reportsList = reportsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt,
        verifiedAt: data.verifiedAt?.toDate ? data.verifiedAt.toDate().toISOString() : data.verifiedAt,
      };
    });

    // Fallback search in legacy AdminReports if approved_reports is empty
    if (reportsList.length === 0) {
      let legacyQuery = db.collection('AdminReports');
      if (status && status !== 'all') legacyQuery = legacyQuery.where('status', '==', status);
      const legacySnap = await legacyQuery.get();
      reportsList = legacySnap.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    }

    return res.status(200).json({ success: true, data: reportsList, count: reportsList.length });
  } catch (error) {
    console.error('Error fetching admin reports:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 2. GET SINGLE ADMIN REPORT
router.get('/admin-reports/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let docSnapshot = await db.collection('approved_reports').doc(id).get();

    if (!docSnapshot.exists) {
      docSnapshot = await db.collection('AdminReports').doc(id).get();
    }

    if (!docSnapshot.exists) {
      return res.status(404).json({ success: false, message: 'Report not found.' });
    }

    const data = docSnapshot.data();
    return res.status(200).json({
      success: true,
      data: {
        id: docSnapshot.id,
        ...data,
        createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt,
        verifiedAt: data.verifiedAt?.toDate ? data.verifiedAt.toDate().toISOString() : data.verifiedAt,
      }
    });
  } catch (error) {
    console.error('Error fetching admin report:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 3. CREATE DIRECTLY IN APPROVED ADMIN REPORTS WITH ATOMIC VRID
router.post('/admin-reports', verifyToken, async (req, res) => {
  try {
    const {
      incidentType,
      hazard,
      severity,
      status,
      address,
      latitude,
      longitude,
      notes,
      adminNotes,
      reportTitle,
      mediaUrl,
      mediaType,
      mediaFileName,
      timestamp,
      isSensitive,
      selectedAgencies = [],
      radius,
      polyline,
      routeCoords
    } = req.body;

    // Validate required fields
    if (!incidentType || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: incidentType, latitude, longitude'
      });
    }

    if (!reportTitle || reportTitle.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Report title is required'
      });
    }

    if (!Array.isArray(selectedAgencies) || selectedAgencies.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please assign at least one responder agency."
      });
    }

    const adminUid = req.user?.uid || 'system_admin';
    const adminEmail = req.user?.email || 'admin@gov.com';
    let generatedVRID = '';
    let docId = '';
    let reportData = {};

    // Execute Firestore Transaction to atomically increment VRID counter
    await db.runTransaction(async (transaction) => {
      generatedVRID = await generateVerifiedReportId(transaction);
      
      const currentIsoTime = new Date().toISOString();

      reportData = {
        verifiedReportId: generatedVRID,
        verifiedReportID: generatedVRID,
        verifiedreportID: generatedVRID,

        reportTitle: reportTitle.trim(),
        incidentType,
        hazard: hazard || 'None',
        severity: severity || 'Medium',
        verifiedSeverity: severity || 'Medium',
        status: status || 'verified',
        isVerified: true,
        isAuthenticated: true,
        
        notes: notes || adminNotes || 'Admin Dispatched Incident',
        adminNotes: adminNotes || notes || 'Verified via Dispatch Telemetry Modal',

        verifiedBy: adminUid,
        verifiedByEmail: adminEmail,
        verifiedByName: 'System Admin',
        verifiedAt: currentIsoTime,
        createdAt: currentIsoTime,
        updatedAt: currentIsoTime,
        reportTimestamp: timestamp || currentIsoTime,

        isSensitive: isSensitive === true,
        selectedAgencies,

        location: {
          address: address || 'Unknown',
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
        },
        address: address || 'Unknown',
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),

        media: {
          url: mediaUrl || '',
          type: mediaType || 'image/jpeg',
          fileName: mediaFileName || 'none',
          uploadedAt: currentIsoTime,
        },
        mediaUrl: mediaUrl || '',
        mediaType: mediaType || 'image/jpeg',
        mediaFileName: mediaFileName || 'none',

        // Spatial telemetry payloads
        radius: radius || null,
        polyline: polyline || null,
        routeCoords: Array.isArray(routeCoords) ? routeCoords : []
      };

      // Direct insertion into approved_reports collection
      const docRef = db.collection('approved_reports').doc();
      docId = docRef.id;
      transaction.set(docRef, reportData);
    });

    const createdReport = { id: docId, ...reportData };
    console.log(`✅ Approved Admin report created directly in approved_reports: ${docId} with ${generatedVRID}`);

    // 📡 Socket notification for real-time live map feed
    try {
      getIO().emit('new_approved_admin_report', createdReport);
    } catch (socketErr) {
      console.error('Socket broadcast error (new_approved_admin_report):', socketErr.message);
    }

    // 🚀 Trigger FCM Push Notification
    await trySendApprovedReportNotification(createdReport, generatedVRID);

    return res.status(201).json({
      success: true,
      message: 'Approved Admin report created successfully',
      id: docId,
      verifiedReportId: generatedVRID,
      data: createdReport
    });
  } catch (error) {
    console.error('Error creating approved admin report:', error);
    return res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to create approved admin report' 
    });
  }
});

// 4. UPDATE ADMIN REPORT STATUS & SPATIAL PARAMETERS
router.patch('/admin-reports/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      status, 
      verifiedSeverity, 
      verifiedBy, 
      adminNotes,
      radius,
      polyline,
      routeCoords
    } = req.body;

    let docRef = db.collection('approved_reports').doc(id);
    let docSnapshot = await docRef.get();

    if (!docSnapshot.exists) {
      docRef = db.collection('AdminReports').doc(id);
      docSnapshot = await docRef.get();
    }

    if (!docSnapshot.exists) {
      return res.status(404).json({ success: false, message: 'Report not found.' });
    }

    const updates = {
      updatedAt: new Date().toISOString(),
    };

    if (status) updates.status = status;
    if (radius !== undefined) updates.radius = radius;
    if (polyline !== undefined) updates.polyline = polyline;
    if (routeCoords !== undefined) updates.routeCoords = Array.isArray(routeCoords) ? routeCoords : [];
    if (verifiedSeverity) updates.verifiedSeverity = verifiedSeverity;
    if (adminNotes) updates.adminNotes = adminNotes;

    await docRef.update(updates);

    const updatedDoc = await docRef.get();
    const updatedData = { id: updatedDoc.id, ...updatedDoc.data() };

    // 📡 Emit Socket Event for Spatial Telemetry / Status Updates
    try {
      getIO().emit('admin_report_updated', updatedData);
    } catch (socketErr) {
      console.error('Socket broadcast error (admin_report_updated):', socketErr.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Report verified and updated with spatial parameters successfully',
      data: updatedData
    });
  } catch (error) {
    console.error('Error updating admin report telemetry:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 5. DELETE ADMIN REPORT
router.delete('/admin-reports/:id', async (req, res) => {
  try {
    const { id } = req.params;

    let docRef = db.collection('approved_reports').doc(id);
    let docSnapshot = await docRef.get();

    if (!docSnapshot.exists) {
      docRef = db.collection('AdminReports').doc(id);
      docSnapshot = await docRef.get();
    }

    if (!docSnapshot.exists) {
      return res.status(404).json({ success: false, message: 'Report not found.' });
    }

    const reportData = docSnapshot.data();
    console.log(`🗑️ Deleting admin report: ${id} with media: ${reportData.media?.fileName}`);

    await docRef.delete();

    // 📡 Emit Socket Event for Removal
    try {
      getIO().emit('admin_report_deleted', { id });
    } catch (socketErr) {
      console.error('Socket broadcast error (admin_report_deleted):', socketErr.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Report deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting admin report:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 6. SEARCH ADMIN REPORTS BY LOCATION
router.get('/admin-reports/search/location', async (req, res) => {
  try {
    const { latitude, longitude, radiusKm } = req.query;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'latitude and longitude are required'
      });
    }

    const radius = parseFloat(radiusKm) || 5;
    const reportsSnapshot = await db.collection('approved_reports').get();
    
    const centerLat = parseFloat(latitude);
    const centerLng = parseFloat(longitude);

    const nearbyReports = reportsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(report => {
        const lat = report.location?.latitude || report.latitude;
        const lng = report.location?.longitude || report.longitude;
        
        if (!lat || !lng) return false;

        const R = 6371;
        const dLat = (lat - centerLat) * Math.PI / 180;
        const dLng = (lng - centerLng) * Math.PI / 180;
        const a = 
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(centerLat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        return distance <= radius;
      });

    return res.status(200).json({
      success: true,
      data: nearbyReports,
      count: nearbyReports.length,
      searchRadius: radius
    });
  } catch (error) {
    console.error('Error searching by location:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ===================================================
// ADMIN PASSWORD AUTHENTICATION & ATOMIC APPROVED TRANSFER WITH VRID
// ===================================================
router.post(
  "/admin-reports/:id/authenticate",
  verifyToken,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { experienceRating, feedbackNotes } = req.body;
      const adminUid = req.user?.uid;

      if (!adminUid) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized: Missing administrative session UID."
        });
      }

      let generatedVRID = '';
      let fullApprovedReport = {};

      // Perform transaction to ensure atomic increment of VRID counter & document transfer
      await db.runTransaction(async (transaction) => {
        const docRef = db.collection("AdminReports").doc(id);
        const snapshot = await transaction.get(docRef);

        if (!snapshot.exists) {
          throw new Error("Report not found.");
        }

        // Fetch administrator profile details
        const adminProfileRef = db.collection('admins').doc(adminUid);
        const adminProfileSnapshot = await transaction.get(adminProfileRef);

        let adminDetails = {
          verifiedByName: "System Admin",
          verifiedByEmail: req.user?.email || "admin@gov.com",
          verifiedByPhone: "N/A"
        };

        if (adminProfileSnapshot.exists) {
          const adminData = adminProfileSnapshot.data();
          adminDetails = {
            verifiedByName: adminData.name || "System Admin",
            verifiedByEmail: adminData.email || req.user?.email || "admin@gov.com",
            verifiedByPhone: adminData.phone || "N/A"
          };
        }

        // Generate auto-incremented VRID (e.g., VRID00000001)
        generatedVRID = await generateVerifiedReportId(transaction);

        const existingData = snapshot.data();
        const currentIsoTime = new Date().toISOString();

        // Consolidated authentication updates with verifiedReportId
        const updatedFields = {
          verifiedReportId: generatedVRID,
          verifiedReportID: generatedVRID,
          verifiedreportID: generatedVRID,
          status: "verified",
          isVerified: true,
          isAuthenticated: true,
          verifiedBy: adminUid,
          verifiedByName: adminDetails.verifiedByName,
          verifiedByEmail: adminDetails.verifiedByEmail,
          verifiedByPhone: adminDetails.verifiedByPhone,
          experienceRating: Number(experienceRating) || 0,
          feedbackNotes: feedbackNotes || "",
          verifiedAt: currentIsoTime,
          updatedAt: currentIsoTime,
        };

        fullApprovedReport = {
          ...existingData,
          ...updatedFields,
          originalReportId: id,
        };

        // 1. Insert into approved_reports collection
        const approvedDocRef = db.collection("approved_reports").doc(id);
        transaction.set(approvedDocRef, fullApprovedReport, { merge: true });

        // 2. Delete original source document from AdminReports collection
        transaction.delete(docRef);
      });

      console.log(`✅ Report ${id} assigned ${generatedVRID}, moved to approved_reports, and purged from AdminReports.`);

      // 📡 Broadcast Socket Events
      try {
        const io = getIO();
        // Notify clients viewing pending admin reports to drop this ID
        io.emit('admin_report_approved', { id, newCollection: 'approved_reports', verifiedReportId: generatedVRID });
        // Notify clients watching approved live feeds/maps to append this new report
        io.emit('new_approved_admin_report', { id, ...fullApprovedReport });
      } catch (socketErr) {
        console.error('Socket broadcast error during authentication transfer:', socketErr.message);
      }

      // 🚀 Trigger FCM Push Notification
      await trySendApprovedReportNotification(fullApprovedReport, generatedVRID);

      return res.status(200).json({
        success: true,
        message: "Report authenticated successfully and moved to approved_reports.",
        verifiedReportId: generatedVRID,
        verifiedBy: fullApprovedReport.verifiedByName
      });

    } catch (err) {
      console.error("Authentication Error:", err);
      return res.status(500).json({
        success: false,
        message: err.message || "Failed to process report authentication."
      });
    }
  }
);

// General Citizen/Standard Report Verification Endpoint (/reports/:id/verify)
// Atomically migrates the source document from reports to approved_reports.
router.patch('/reports/:id/verify', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      incidentType,
      verifiedSeverity,
      adminNotes,
      reportTitle,
      selectedAgencies,
      correctedLatitude,
      correctedLongitude,
      correctedAddress,
      radius,
      polyline,
      selectedMarkerIcon,
      routeCoords,
      isSensitive
    } = req.body;

    let generatedVRID = '';
    let approvedReport = null;

    await db.runTransaction(async (transaction) => {
      const reportRef = db.collection('reports').doc(id);
      const reportSnapshot = await transaction.get(reportRef);

      if (!reportSnapshot.exists) {
        throw new Error('Report not found');
      }

      const existingData = reportSnapshot.data();
      generatedVRID = await generateVerifiedReportId(transaction);

      const currentIsoTime = new Date().toISOString();
      const existingLocation =
        existingData.location && typeof existingData.location === 'object'
          ? existingData.location
          : {};

      const latitude = correctedLatitude !== undefined
        ? parseFloat(correctedLatitude)
        : (existingData.latitude ?? existingLocation.latitude ?? null);
      const longitude = correctedLongitude !== undefined
        ? parseFloat(correctedLongitude)
        : (existingData.longitude ?? existingLocation.longitude ?? null);
      const address = correctedAddress || existingData.address || existingLocation.address || 'Unknown';

      approvedReport = {
        ...existingData,
        id,
        reportId: existingData.reportId || existingData.reportID || id,
        reportID: existingData.reportID || existingData.reportId || id,
        incidentId: existingData.incidentId || id,
        verifiedreportID: generatedVRID,
        verifiedReportID: generatedVRID,
        verifiedReportId: generatedVRID,
        status: 'verified',
        isVerified: true,
        verifiedAt: currentIsoTime,
        updatedAt: currentIsoTime,
        verifiedBy: req.user?.uid || req.user?.email || 'Admin',
        reportTitle: reportTitle?.trim() || existingData.reportTitle || existingData.title || '',
        incidentType: incidentType || existingData.incidentType || existingData.hazard || 'others',
        verifiedSeverity: verifiedSeverity || existingData.verifiedSeverity || existingData.severity || 'Medium',
        severity: verifiedSeverity || existingData.severity || 'Medium',
        adminNotes: adminNotes || existingData.adminNotes || '',
        selectedAgencies: Array.isArray(selectedAgencies)
          ? selectedAgencies
          : (existingData.selectedAgencies || existingData.assignedAgencies || []),
        selectedMarkerIcon: selectedMarkerIcon || existingData.selectedMarkerIcon || '',
        isSensitive: typeof isSensitive === 'boolean'
          ? isSensitive
          : (existingData.isSensitive || false),
        radius: radius ?? existingData.radius ?? null,
        polyline: polyline ?? existingData.polyline ?? null,
        routeCoords: Array.isArray(routeCoords)
          ? routeCoords
          : (Array.isArray(existingData.routeCoords) ? existingData.routeCoords : []),
        address,
        latitude,
        longitude,
        location: {
          ...existingLocation,
          address,
          latitude,
          longitude,
        },
      };

      const approvedRef = db.collection('approved_reports').doc(id);
      transaction.set(approvedRef, approvedReport);
      transaction.delete(reportRef);
    });

    try {
      getIO()?.emit('report_verified', {
        id,
        reportId: approvedReport.reportId,
        verifiedReportId: generatedVRID,
        verifiedreportID: generatedVRID,
        source: 'approved',
        ...approvedReport,
      });
    } catch (socketError) {
      console.warn('Verification succeeded, but socket notification failed:', socketError.message);
    }

    // 🚀 Trigger FCM Push Notification
    await trySendApprovedReportNotification(approvedReport, generatedVRID);

    console.log(`✅ Report ${id} migrated from reports to approved_reports as ${generatedVRID}`);

    return res.status(200).json({
      success: true,
      message: 'Report successfully verified and migrated to approved_reports.',
      id,
      verifiedreportID: generatedVRID,
      verifiedReportID: generatedVRID,
      verifiedReportId: generatedVRID,
      data: approvedReport,
    });
  } catch (error) {
    console.error('Error verifying and migrating report:', error);
    return res.status(error.message === 'Report not found' ? 404 : 500).json({
      success: false,
      message: error.message || 'Failed to verify report.',
    });
  }
});

module.exports = router;