const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

async function handleSendMessage(socket, io, data) {
  const db = getFirestore();
  const messaging = getMessaging();

  let { chatId, senderId, senderRole, text, recipientUid, citizenId, citizenName } = data;

  // Basic payload validation
  if (!chatId || !text || !senderId || !senderRole) {
    socket.emit('chat_error', { message: 'Missing required chat payload parameters.' });
    return;
  }

  const isoTimestamp = new Date().toISOString();
  const isCitizen = senderRole === 'citizen';

  try {
    // Optional Fallback: Fetch missing Citizen Details from DB if sender is citizen
    if (isCitizen && (!citizenId || !citizenName)) {
      const citizenDoc = await db.collection('citizens').doc(senderId).get();
      if (citizenDoc.exists) {
        const cData = citizenDoc.data();
        citizenId = citizenId || cData.citizenID || cData.citizenId || cData.cid || 'UNKNOWN';
        citizenName = citizenName || cData.fullName || cData.name || cData.submitterName || 'Citizen';
      }
    }

    const batch = db.batch();

    // 1. Prepare Message Document Reference
    const chatRef = db.collection('chats').doc(chatId);
    const messageRef = chatRef.collection('messages').doc();

    const messageData = {
      id: messageRef.id,
      chatId,
      senderId,
      senderRole, // 'citizen' or 'admin' / 'dispatcher'
      text,
      timestamp: isoTimestamp,
      createdAt: FieldValue.serverTimestamp(),
      ...(citizenId && { citizenId }),
      ...(citizenName && { citizenName }),
    };

    batch.set(messageRef, messageData);

    // 2. Prepare Parent Chat Document Metadata Update
    const parentChatData = {
      chatId,
      lastMessage: text,
      lastSenderId: senderId,
      lastSenderRole: senderRole,
      lastMessageTimestamp: isoTimestamp,
      updatedAt: FieldValue.serverTimestamp(),
      ...(citizenId && { citizenId }),
      ...(citizenName && { citizenName }),
      ...(isCitizen 
        ? { unreadCountAdmin: FieldValue.increment(1) }
        : { unreadCountCitizen: FieldValue.increment(1) })
    };

    batch.set(chatRef, parentChatData, { merge: true });

    // 3. Commit both writes atomically
    await batch.commit();

    // 4. Real-time Socket.IO Broadcasts
    io.to(chatId).emit('receive_message', messageData);
    
    if (recipientUid) {
      io.to(recipientUid).emit('receive_message', messageData);
    }

    // 5. FCM Push Notification for Offline Citizens
    if (!isCitizen && recipientUid) {
      const userDoc = await db.collection('citizens').doc(recipientUid).get();
      const fcmToken = userDoc.data()?.fcmToken;

      if (fcmToken) {
        messaging.send({
          token: fcmToken,
          notification: {
            title: 'New Emergency Message',
            body: text.length > 100 ? `${text.substring(0, 97)}...` : text,
          },
          data: {
            type: 'CHAT_MESSAGE',
            chatId: String(chatId),
            senderId: String(senderId),
            click_action: 'FLUTTER_NOTIFICATION_CLICK'
          },
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channelId: 'emergency_chat_channel'
            }
          },
          apns: {
            payload: {
              aps: { sound: 'default' }
            }
          }
        }).catch(fcmErr => console.error('⚠️ Push Notification failed:', fcmErr.message));
      }
    }
  } catch (err) {
    console.error('❌ Error saving chat message:', err);
    socket.emit('chat_error', { message: 'Failed to send message', error: err.message });
  }
}

module.exports = { handleSendMessage };