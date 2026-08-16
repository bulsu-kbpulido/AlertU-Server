const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');
const { verifyToken } = require('./authMiddleware'); // Express middleware for protected endpoints
const { getIO } = require('./socket'); // 👈 Import Socket accessor

const db = getFirestore();

// Helper function to safely serialize Firestore Timestamps to ISO strings
const formatTimestamps = (data) => {
  const formatted = { ...data };
  
  ['verifiedAt', 'createdAt', 'timestamp', 'updatedAt', 'resolvedAt'].forEach((field) => {
    if (formatted[field]?.toDate && typeof formatted[field].toDate === 'function') {
      formatted[field] = formatted[field].toDate().toISOString();
    }
  });

  return formatted;
};

// 1. GET ALL APPROVED / AUTHENTICATED ADMIN REPORTS
router.get('/approved-admin-reports', async (req, res) => {
  try {
    const { incidentType, severity, limit = 50 } = req.query;
    let collectionRef = db.collection('ApprovedAdminReports');

    // Build the query
    let query = collectionRef;

    if (incidentType) {
      query = query.where('incidentType', '==', incidentType);
    }

    // Try-catch block specifically for index errors on ordered queries
    let snapshot;
    try {
      snapshot = await query.orderBy('verifiedAt', 'desc').limit(Number(limit)).get();
    } catch (indexError) {
      console.warn('Composite index missing or query order failed. Falling back to unordered fetch:', indexError.message);
      // Fallback query without orderBy to prevent 500 error if Firebase index is missing
      snapshot = await query.limit(Number(limit)).get();
    }

    let approvedReports = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...formatTimestamps(data),
        severity: data.verifiedSeverity || data.severity || 'medium'
      };
    });

    // In-memory severity filtering to catch both `severity` and `verifiedSeverity` fields
    if (severity) {
      const targetSeverity = String(severity).toLowerCase();
      approvedReports = approvedReports.filter(r => 
        (r.severity && r.severity.toLowerCase() === targetSeverity) ||
        (r.verifiedSeverity && r.verifiedSeverity.toLowerCase() === targetSeverity)
      );
    }

    return res.status(200).json({
      success: true,
      count: approvedReports.length,
      data: approvedReports,
    });
  } catch (error) {
    console.error('Error fetching approved admin reports:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to retrieve approved admin reports.',
      error: error.message 
    });
  }
});

// 2. GET SINGLE APPROVED REPORT BY ID
router.get('/approved-admin-reports/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const docSnapshot = await db.collection('ApprovedAdminReports').doc(id).get();

    if (!docSnapshot.exists) {
      return res.status(404).json({
        success: false,
        message: 'Approved admin report not found.',
      });
    }

    const data = docSnapshot.data();
    return res.status(200).json({
      success: true,
      data: {
        id: docSnapshot.id,
        ...formatTimestamps(data),
        severity: data.verifiedSeverity || data.severity || 'medium'
      },
    });
  } catch (error) {
    console.error('Error fetching approved admin report by ID:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to retrieve report details.',
      error: error.message 
    });
  }
});

module.exports = router;