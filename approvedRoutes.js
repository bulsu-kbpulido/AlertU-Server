// approvedRoutes.js
const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();

// 1. GET ALL APPROVED REPORTS -> Hits: /api/approved-reports
router.get('/approved-reports', async (req, res) => {
  try {
    const snapshot = await db.collection('approved_reports').orderBy('verifiedAt', 'desc').get();
    const approvedList = [];
    
    snapshot.forEach(doc => {
      approvedList.push({ id: doc.id, ...doc.data() });
    });
    
    return res.status(200).json({ success: true, data: approvedList });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;