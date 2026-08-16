const express = require('express');
const router = express.Router();
const { getFirestore } = require('firebase-admin/firestore');
const { handleSendMessage } = require('./chatHandler');
const { getIO } = require('./socket');

/**
 * Helper to safely convert Firestore Timestamps to ISO Strings
 * for standard REST JSON consumption across client applications.
 */
const sanitizeDocData = (data) => {
  const sanitized = { ...data };
  
  if (sanitized.createdAt && typeof sanitized.createdAt.toDate === 'function') {
    sanitized.createdAt = sanitized.createdAt.toDate().toISOString();
  }
  if (sanitized.updatedAt && typeof sanitized.updatedAt.toDate === 'function') {
    sanitized.updatedAt = sanitized.updatedAt.toDate().toISOString();
  }
  if (sanitized.lastMessageTimestamp && typeof sanitized.lastMessageTimestamp.toDate === 'function') {
    sanitized.lastMessageTimestamp = sanitized.lastMessageTimestamp.toDate().toISOString();
  }
  
  return sanitized;
};

// ==============================================================================
// 1. Send Message via REST Endpoint (Fallback when WebSockets are disconnected)
// ==============================================================================
router.post('/send', async (req, res) => {
  try {
    const { chatId, senderId, senderRole, text } = req.body;

    // Direct REST Payload Validation
    if (!chatId || !senderId || !senderRole || !text) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameters: chatId, senderId, senderRole, and text are required.',
      });
    }

    const io = getIO();
    let responseSent = false;

    // Mock socket response object to intercept errors emitted inside handleSendMessage
    const mockSocket = {
      emit: (event, payload) => {
        if (!responseSent) {
          responseSent = true;
          return res.status(400).json({
            success: false,
            event,
            message: payload?.message || 'Error executing chat event handler.',
            error: payload?.error || null,
          });
        }
      },
    };

    // Forward req.body (includes chatId, senderId, senderRole, text, recipientUid, citizenId, citizenName)
    await handleSendMessage(mockSocket, io, req.body);

    if (!responseSent) {
      return res.status(200).json({
        success: true,
        message: 'Message sent successfully',
      });
    }
  } catch (err) {
    console.error('❌ REST Chat send error:', err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error processing message send.',
      error: err.message,
    });
  }
});

// ==============================================================================
// 2. Get Message History for a Specific Chat Room
// ==============================================================================
router.get('/:chatId/messages', async (req, res) => {
  try {
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit, 10) || 50;

    if (!chatId) {
      return res.status(400).json({
        success: false,
        message: 'Parameter chatId is required.',
      });
    }

    const db = getFirestore();
    const snapshot = await db
      .collection('chats')
      .doc(chatId)
      .collection('messages')
      .orderBy('timestamp', 'asc') // Sorts sequentially by ISO timestamp
      .limit(limit)
      .get();

    const messages = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...sanitizeDocData(data),
      };
    });

    return res.status(200).json({
      success: true,
      count: messages.length,
      data: messages,
    });
  } catch (err) {
    console.error('❌ Error fetching chat history:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve message history.',
      error: err.message,
    });
  }
});

// ==============================================================================
// 3. Get All Active Conversations (For React Admin / Dispatcher Dashboard)
// ==============================================================================
router.get('/conversations', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const db = getFirestore();

    const snapshot = await db
      .collection('chats')
      .orderBy('updatedAt', 'desc')
      .limit(limit)
      .get();

    const conversations = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...sanitizeDocData(data),
      };
    });

    return res.status(200).json({
      success: true,
      count: conversations.length,
      data: conversations,
    });
  } catch (err) {
    console.error('❌ Error fetching chat conversations:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve active conversations.',
      error: err.message,
    });
  }
});

module.exports = router;