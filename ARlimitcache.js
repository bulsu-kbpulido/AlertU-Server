const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();

// In-Memory Cache variables
let archivedCache = null;
let lastCacheFetchTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 60 Seconds Cache TTL

/**
 * Invalidate the memory cache (Call when documents are restored or deleted)
 */
function invalidateArchivedCache() {
  archivedCache = null;
  lastCacheFetchTime = 0;
  console.log('🧹 [ARlimitcache] In-memory cache invalidated.');
}

/**
 * Fetch archived reports from Firestore with query capping and TTL caching
 * @param {number} limitNum Maximum number of documents to query
 * @returns {Promise<{data: Array, cached: boolean}>} Object with report data and cache status
 */
async function getArchivedReportsWithCache(limitNum = 50) {
  const now = Date.now();

  // 1. Return from in-memory cache if valid and within TTL window
  if (archivedCache && (now - lastCacheFetchTime < CACHE_TTL_MS)) {
    console.log('⚡ [ARlimitcache] Serving archived reports from memory cache');
    return {
      data: archivedCache.slice(0, limitNum),
      cached: true
    };
  }

  // 2. Query Firestore with read-capping limit
  console.log(`🔥 [ARlimitcache] Querying Firestore (Limit: ${limitNum})...`);
  const snapshot = await db.collection('archivedreports')
    .limit(limitNum)
    .get();

  const archivedReports = snapshot.docs.map(doc => {
    const data = doc.data();
    return {
      id: data.id || doc.id,
      reportId: data.reportId || data.reportID || doc.id,
      reportID: data.reportID || data.reportId || doc.id,
      ...data
    };
  });

  // Sort by timestamp descending (newest archives first)
  archivedReports.sort((a, b) => {
    const getTime = (val) => {
      if (!val) return 0;
      if (typeof val.toDate === 'function') return val.toDate().getTime();
      return new Date(val).getTime() || 0;
    };

    const dateA = getTime(a.archivedAt || a.rejectedAt || a.verifiedAt || a.submittedAt || a.timestamp);
    const dateB = getTime(b.archivedAt || b.rejectedAt || b.verifiedAt || b.submittedAt || b.timestamp);
    return dateB - dateA;
  });

  // Update memory cache
  archivedCache = archivedReports;
  lastCacheFetchTime = now;

  return {
    data: archivedReports,
    cached: false
  };
}

/**
 * @route   GET /api/archived-reports
 * @desc    Fetch archived incident records with query capping and in-memory TTL caching
 * @access  Public
 */
router.get('/archived-reports', async (req, res) => {
  try {
    const queryLimit = parseInt(req.query.queryLimit, 10) || 50;
    const { data, cached } = await getArchivedReportsWithCache(queryLimit);

    return res.status(200).json({
      success: true,
      count: data.length,
      cached,
      data
    });
  } catch (error) {
    console.error('Failure inside Cached Archived Node Extraction Pipeline:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve archived nodes from cached pipeline.',
      error: error.message
    });
  }
});

// Attach helper functions directly to the Express router instance for cross-module imports
router.getArchivedReportsWithCache = getArchivedReportsWithCache;
router.invalidateArchivedCache = invalidateArchivedCache;

// 🚨 MUST export the Express router function so app.use('/api', archivedReportLimitCacheRoutes) works!
module.exports = router;