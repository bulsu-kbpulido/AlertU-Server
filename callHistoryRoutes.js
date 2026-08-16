const express = require('express');
const router = express.Router();
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const db = getFirestore();
const CALL_HISTORY_COLLECTION = 'callHistory';
const ACTIVE_CALLS_COLLECTION = 'active_calls';

/**
 * @route   POST /api/call-history
 * @desc    Save a new video call record to Firestore & clear active_calls doc
 */
router.post('/call-history', async (req, res) => {
  try {
    const {
      channelName,
      citizenName,
      citizenId,
      adminId,
      adminName,
      duration,       // Duration in seconds or formatted string
      endedBy,        // 'admin', 'citizen', or 'timeout'
      status          // 'completed', 'missed', 'rejected', 'failed'
    } = req.body;

    if (!channelName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: channelName is required.'
      });
    }

    const resolvedCitizenId = (citizenId && citizenId.trim() !== '') ? citizenId.trim() : null;

    const newCallRecord = {
      channelName,
      citizenName: citizenName || 'Unknown Citizen',
      citizenId: resolvedCitizenId,
      adminId: adminId || null,
      adminName: adminName || 'Admin',
      duration: duration || 0,
      endedBy: endedBy || 'system',
      status: status || 'completed',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    // 1. Save record in callHistory
    const docRef = await db.collection(CALL_HISTORY_COLLECTION).add(newCallRecord);

    // 2. Clean up or resolve document in active_calls collection
    try {
      await db.collection(ACTIVE_CALLS_COLLECTION).doc(channelName).delete();
    } catch (cleanupErr) {
      console.warn(`⚠️ Could not remove active call document for ${channelName}:`, cleanupErr.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Call history recorded successfully',
      callId: docRef.id,
      data: newCallRecord
    });
  } catch (error) {
    console.error('❌ Error saving call history:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to record call history',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/call-history
 * @desc    Retrieve all call history records (sorted newest first)
 */
router.get('/call-history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const snapshot = await db
      .collection(CALL_HISTORY_COLLECTION)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const history = [];
    snapshot.forEach((doc) => {
      history.push({
        id: doc.id,
        ...doc.data()
      });
    });

    return res.json({
      success: true,
      count: history.length,
      data: history
    });
  } catch (error) {
    console.error('❌ Error fetching call history:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch call history',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/call-history/citizen/:citizenId
 * @desc    Get call logs for a specific citizen ID
 */
router.get('/call-history/citizen/:citizenId', async (req, res) => {
  try {
    const { citizenId } = req.params;

    const snapshot = await db
      .collection(CALL_HISTORY_COLLECTION)
      .where('citizenId', '==', citizenId)
      .get();

    const logs = [];
    snapshot.forEach((doc) => {
      logs.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // In-memory sort by createdAt descending to handle missing composite indexes safely
    logs.sort((a, b) => {
      const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return timeB - timeA;
    });

    return res.json({
      success: true,
      count: logs.length,
      data: logs
    });
  } catch (error) {
    console.error('❌ Error fetching call history for citizen:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch citizen call history',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/call-history/room/:channelName
 * @desc    Get call logs for a specific channel/room
 */
router.get('/call-history/room/:channelName', async (req, res) => {
  try {
    const { channelName } = req.params;

    const snapshot = await db
      .collection(CALL_HISTORY_COLLECTION)
      .where('channelName', '==', channelName)
      .get();

    const logs = [];
    snapshot.forEach((doc) => {
      logs.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // In-memory sort by createdAt descending
    logs.sort((a, b) => {
      const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return timeB - timeA;
    });

    return res.json({
      success: true,
      count: logs.length,
      data: logs
    });
  } catch (error) {
    console.error('❌ Error fetching call history for room:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch room call history',
      error: error.message
    });
  }
});

module.exports = router;