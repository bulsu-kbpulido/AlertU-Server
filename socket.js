const { Server } = require('socket.io');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { handleSendMessage } = require('./chatHandler');

let io;

// Track pending disconnect timeouts by user ID to avoid race conditions when phone wakes up
const pendingDisconnects = new Map();

/**
 * Helper to update citizen presence safely using targetRef.update()
 */
async function updateCitizenPresence(db, uid, citizenIDInput, isActive) {
  if (!uid && !citizenIDInput) return null;

  try {
    let targetRef = null;
    let citizenID = citizenIDInput || null;
    let docId = uid;

    if (uid) {
      const directDocRef = db.collection('citizens').doc(uid);
      const directDoc = await directDocRef.get();

      if (directDoc.exists) {
        targetRef = directDocRef;
        citizenID = directDoc.data()?.citizenID || directDoc.data()?.cid || citizenID;
      }
    }

    if (!targetRef) {
      let querySnapshot = await db
        .collection('citizens')
        .where('authUid', '==', uid)
        .limit(1)
        .get();

      if (querySnapshot.empty && citizenIDInput) {
        querySnapshot = await db
          .collection('citizens')
          .where('citizenID', '==', citizenIDInput)
          .limit(1)
          .get();
      }

      if (!querySnapshot.empty) {
        const matchedDoc = querySnapshot.docs[0];
        targetRef = matchedDoc.ref;
        docId = matchedDoc.id;
        citizenID = matchedDoc.data()?.citizenID || matchedDoc.data()?.cid || citizenIDInput;
      }
    }

    if (targetRef) {
      await targetRef.update({
        isActive: Boolean(isActive),
        isOnline: Boolean(isActive),
        lastActiveAt: FieldValue.serverTimestamp(),
      });
    }

    return { docId, citizenID };
  } catch (err) {
    console.error(`❌ Firestore presence sync failed for ID ${uid || citizenIDInput}:`, err.message);
    return null;
  }
}

/**
 * Utility to resolve room and document keys deterministically.
 */
const resolveDocKey = (rawId) => {
  if (!rawId) return null;
  const cleanId = String(rawId).trim();
  return cleanId.startsWith('sos_') ? cleanId : `sos_${cleanId}`;
};

module.exports = {
  init: (httpServer, corsOptions) => {
    const db = getFirestore();

    io = new Server(httpServer, {
      cors: corsOptions || {
        origin: ['http://localhost:5173', '*'],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        credentials: true,
      },
      pingTimeout: 10000,
      pingInterval: 5000,
    });

    console.log('⚡ Socket.IO engine initialized successfully');

    io.on('connection', (socket) => {
      console.log(`🔌 Client connected: ${socket.id}`);
      socket.userData = null;

      socket.join(socket.id);

      // --- Room Joins & Leaves ---
      socket.on('join_room', (roomName) => {
        if (roomName) {
          socket.join(roomName);
          console.log(`📡 Socket ${socket.id} joined room: ${roomName}`);
        }
      });

      socket.on('joinSocketRoom', (roomName) => {
        if (roomName) {
          socket.join(roomName);
          console.log(`📡 Socket ${socket.id} joined socket room: ${roomName}`);
        }
      });

      socket.on('leave_room', (roomName) => {
        if (roomName) {
          socket.leave(roomName);
          console.log(`🚪 Socket ${socket.id} left room: ${roomName}`);
        }
      });

      // --- User / Admin / SuperAdmin Registration ---
      socket.on('register_user', (data) => {
        const uid = data?.uid || data?.authUid;
        const citizenID = data?.citizenID || data?.cid;
        const role = data?.role;

        if (uid || citizenID || role) {
          socket.userData = { uid, citizenID, role };
          if (uid) socket.join(uid);
          if (citizenID) socket.join(citizenID);

          if (role === 'admin' || role === 'dispatcher') {
            socket.join('admins');
            console.log(`🛡️ Socket ${socket.id} joined 'admins' channel.`);
          }

          // 👑 SUPERADMIN ROOM INTEGRATION
          if (role === 'superadmin' || role === 'super_admin') {
            socket.join('admins');
            socket.join('super_admins');
            console.log(`👑 Socket ${socket.id} joined 'super_admins' & 'admins' channel.`);
          }

          console.log(`👤 Socket ${socket.id} registered user UID: ${uid || citizenID}`);
        }
      });

      // --- SuperAdmin Real-Time Audit Log & Movement Handler ---
      socket.on('log_admin_movement', async (payload) => {
        const logData = {
          eventId: payload?.eventId || `audit_${Date.now()}`,
          action: payload?.action || 'ADMIN_MOVEMENT',
          target: payload?.target || 'SYSTEM',
          reportId: payload?.reportId || null,
          adminId: payload?.adminId || socket.userData?.uid || 'UNKNOWN',
          adminName: payload?.adminName || 'System Admin',
          details: payload?.details || {},
          timestamp: payload?.timestamp || new Date().toISOString(),
          createdAt: FieldValue.serverTimestamp(),
        };

        try {
          await db.collection('audit_logs').doc(logData.eventId).set(logData);
          console.log(`💾 Persisted audit log ${logData.eventId} to Firestore.`);
        } catch (err) {
          console.error(`❌ Failed to persist audit log:`, err.message);
        }

        // Broadcast to super_admins monitoring room
        io.to('super_admins').emit('AUDIT_LOG_EVENT', logData);
        io.to('super_admins').emit('admin_movement_log', logData);
      });

      // --- Online Presence ---
      const handlePresence = async (data) => {
        const uid = data?.uid || data?.authUid || socket.userData?.uid;
        const citizenIDInput = data?.citizenID || data?.cid || socket.userData?.citizenID;
        const lookupKey = uid || citizenIDInput;

        if (!lookupKey) return;

        if (pendingDisconnects.has(lookupKey)) {
          clearTimeout(pendingDisconnects.get(lookupKey));
          pendingDisconnects.delete(lookupKey);
        }

        const isActive = data.isActive ?? true;
        socket.userData = { ...socket.userData, uid, citizenID: citizenIDInput };

        if (uid) socket.join(uid);
        if (citizenIDInput) socket.join(citizenIDInput);

        const citizenInfo = await updateCitizenPresence(db, uid, citizenIDInput, isActive);

        const payload = {
          uid: uid || lookupKey,
          authUid: uid || lookupKey,
          id: citizenInfo?.docId || uid || lookupKey,
          citizenID: citizenInfo?.citizenID || citizenIDInput || lookupKey,
          cid: citizenInfo?.citizenID || citizenIDInput || lookupKey,
          isActive: Boolean(isActive),
          isOnline: Boolean(isActive),
        };

        io.to('admins').emit('citizen_presence_changed', payload);
        io.emit('citizen_status_change', payload);
      };

      socket.on('set_presence', handlePresence);
      socket.on('user_online', (data) => handlePresence({ ...data, isActive: true }));

      // --- Offline Presence ---
      const handleOffline = async (data) => {
        const uid = data?.uid || socket.userData?.uid;
        const citizenIDInput = data?.citizenID || data?.cid || socket.userData?.citizenID;
        const lookupKey = uid || citizenIDInput;

        if (!lookupKey) return;

        const connectedSockets = Array.from(io.sockets.sockets.values());
        const remainingSockets = connectedSockets.filter(
          (s) =>
            s.id !== socket.id &&
            ((uid && s.userData?.uid === uid) ||
              (citizenIDInput && s.userData?.citizenID === citizenIDInput))
        );

        if (remainingSockets.length > 0) {
          return;
        }

        const citizenInfo = await updateCitizenPresence(db, uid, citizenIDInput, false);

        const payload = {
          uid: uid || lookupKey,
          authUid: uid || lookupKey,
          id: citizenInfo?.docId || uid || lookupKey,
          citizenID: citizenInfo?.citizenID || citizenIDInput || lookupKey,
          cid: citizenInfo?.citizenID || citizenIDInput || lookupKey,
          isActive: false,
          isOnline: false,
        };

        io.to('admins').emit('citizen_presence_changed', payload);
        io.emit('citizen_status_change', payload);
      };

      socket.on('user_offline', handleOffline);

      // =========================================================================
      // --- 🚨 EMERGENCY SOS & GIS HANDLER ENGINE (SINGLE-DOCUMENT INTEGRATED) ---
      // =========================================================================

      // 1. Join Specific SOS Incident Room
      socket.on('sos:join_room', (data) => {
        const rawId = typeof data === 'string' ? data : data?.sosId || data?.id || data?.citizenID;
        const roomName = resolveDocKey(rawId);
        if (roomName) {
          socket.join(roomName);
          console.log(`🚨 Socket ${socket.id} subscribed to SOS Incident Room: ${roomName}`);
        }
      });

      // 2. Leave Specific SOS Incident Room
      socket.on('sos:leave_room', (data) => {
        const rawId = typeof data === 'string' ? data : data?.sosId || data?.id || data?.citizenID;
        const roomName = resolveDocKey(rawId);
        if (roomName) {
          socket.leave(roomName);
          console.log(`🚪 Socket ${socket.id} unsubscribed from SOS Incident Room: ${roomName}`);
        }
      });

      // 3. Client-Driven SOS Trigger Relay
      socket.on('sos:trigger_alert', async (payload) => {
        const rawId = payload?.citizenID || payload?.citizenUid || payload?.sosId || socket.userData?.citizenID || socket.userData?.uid;
        if (!rawId) return;

        const docKey = resolveDocKey(rawId);
        console.log(`🚨 Emergency SOS client signal received for: ${docKey}`);

        const name = payload?.submitterName || payload?.citizenName || 'Emergency Citizen';
        const phone = payload?.submitterPhone || payload?.citizenPhone || payload?.phone || 'N/A';
        const email = payload?.submitterEmail || payload?.citizenEmail || payload?.email || 'N/A';

        const normalizedPayload = {
          ...payload,
          sosId: docKey,
          id: docKey,
          targetRoom: docKey,
          citizenUid: payload?.citizenUid || socket.userData?.uid || '',
          citizenID: payload?.citizenID || socket.userData?.citizenID || '',
          submitterName: name,
          citizenName: name,
          submitterPhone: phone,
          citizenPhone: phone,
          submitterEmail: email,
          citizenEmail: email,
          emergencyContacts: Array.isArray(payload?.emergencyContacts) ? payload.emergencyContacts : [],
          gisLocation: payload?.gisLocation || payload?.location || {},
          sosDetails: payload?.sosDetails || payload?.note || 'Emergency SOS Triggered via Mobile App',
          
          status: 'ACTIVE',
          isActive: true,
          closedAt: null,
          resolvedAt: null,
          isNewSession: true,
          updatedAt: new Date().toISOString(),
          triggeredAt: new Date().toISOString(),
        };

        try {
          await db.collection('sos_alerts').doc(docKey).set(normalizedPayload, { merge: true });
          console.log(`💾 Merged and re-activated SOS record for ${docKey} in sos_alerts.`);
        } catch (err) {
          console.error(`❌ Failed to persist SOS alert ${docKey} to Firestore:`, err.message);
        }

        io.to('admins').emit('sos:alert_triggered', normalizedPayload);
        io.emit('sos:alert_triggered', normalizedPayload);
        io.to(docKey).emit('sos:location_updated', normalizedPayload);
      });

      // 4. Real-Time Socket Relay for Live GIS Location Updates
      socket.on('sos:update_location', async (payload) => {
        const rawId = payload?.sosId || payload?.citizenId || payload?.citizenID || socket.userData?.citizenID || socket.userData?.uid;
        if (!rawId) return;

        const docKey = resolveDocKey(rawId);
        const lat = payload?.gisLocation?.latitude ?? payload?.latitude ?? payload?.lat;
        const lng = payload?.gisLocation?.longitude ?? payload?.longitude ?? payload?.lng;

        if (lat !== undefined && lng !== undefined) {
          const gisLocation = {
            latitude: Number(lat),
            longitude: Number(lng),
            altitude: payload?.altitude ? Number(payload.altitude) : null,
            accuracy: payload?.accuracy ? Number(payload.accuracy) : null,
            updatedAt: new Date().toISOString(),
          };

          const locationPayload = {
            sosId: docKey,
            id: docKey,
            citizenUid: payload?.citizenUid || socket.userData?.uid,
            gisLocation,
            latitude: Number(lat),
            longitude: Number(lng),
            updatedAt: new Date().toISOString(),
          };

          try {
            await db.collection('sos_alerts').doc(docKey).set(locationPayload, { merge: true });
          } catch (e) {
            console.error(`❌ Failed to update location for ${docKey}:`, e.message);
          }

          io.to('admins').emit('sos:location_updated', locationPayload);
          io.to(docKey).emit('sos:location_updated', locationPayload);
        } else {
          console.warn('⚠️ Received malformed sos:update_location payload:', payload);
        }
      });

      // 5. Real-Time Socket Relay for SOS Status Updates
      socket.on('sos:update_status', async (payload) => {
        const rawId = payload?.sosId || payload?.citizenId || payload?.citizenID;
        const status = payload?.status;

        if (rawId && status) {
          const docKey = resolveDocKey(rawId);
          const targetStatus = String(status).toUpperCase();
          const isClosed = targetStatus === 'RESOLVED' || targetStatus === 'CANCELLED' || targetStatus === 'CLOSED';

          const statusPayload = {
            sosId: docKey,
            id: docKey,
            status: targetStatus,
            isActive: !isClosed,
            closedAt: isClosed ? new Date().toISOString() : null,
            responderNotes: payload?.responderNotes || '',
            updatedBy: payload?.updatedBy || socket.userData?.uid || 'Admin',
            updatedAt: new Date().toISOString(),
          };

          try {
            await db.collection('sos_alerts').doc(docKey).set(statusPayload, { merge: true });
          } catch (err) {
            console.error(`❌ Failed to update SOS status in Firestore:`, err.message);
          }

          io.to('admins').emit('sos:status_updated', statusPayload);
          io.to(docKey).emit('sos:status_updated', statusPayload);
          if (payload?.citizenUid) {
            io.to(payload.citizenUid).emit('sos:status_updated', statusPayload);
          }
        }
      });

      // =========================================================================
      // --- 💬 REAL-TIME CHAT ENGINE ---
      // =========================================================================

      socket.on('join_chat', (data) => {
        const chatId = typeof data === 'string' ? data : data?.chatId;
        if (chatId) {
          socket.join(chatId);
          console.log(`💬 Socket ${socket.id} subscribed to Chat Room: ${chatId}`);
        }
      });

      socket.on('leave_chat', (data) => {
        const chatId = typeof data === 'string' ? data : data?.chatId;
        if (chatId) {
          socket.leave(chatId);
          console.log(`💬 Socket ${socket.id} unsubscribed from Chat Room: ${chatId}`);
        }
      });

      socket.on('send_message', async (data) => {
        console.log(`📩 Outgoing message in room [${data?.chatId}] from ${data?.senderRole}`);
        await handleSendMessage(socket, io, data);
      });

      socket.on('typing_indicator', (data) => {
        const { chatId, isTyping, senderRole, senderId } = data || {};
        if (chatId) {
          socket.to(chatId).emit('typing_status', {
            chatId,
            isTyping: Boolean(isTyping),
            senderRole,
            senderId,
          });
        }
      });

      socket.on('mark_read', async (data) => {
        const { chatId, userRole } = data || {};
        if (!chatId || !userRole) return;

        try {
          const chatRef = db.collection('chats').doc(chatId);
          const updateField = userRole === 'admin' 
            ? { unreadCountAdmin: 0 } 
            : { unreadCountCitizen: 0 };

          await chatRef.update(updateField);

          io.to(chatId).emit('messages_marked_read', {
            chatId,
            readByRole: userRole,
            timestamp: new Date().toISOString()
          });
        } catch (err) {
          console.error(`❌ Error resetting unread count for ${chatId}:`, err.message);
        }
      });

      // =========================================================================
      // --- 📞 AGORA RTC EMERGENCY CALL SIGNALING ENGINE ---
      // =========================================================================

      socket.on('call_invite', (data) => {
        const channelName = data?.channelName || data?.targetRoom;
        const target = data?.targetRoom || 'admins';

        io.to(target).emit('call_invite', {
          channelName: channelName,
          callerName: data?.callerName || "Emergency Caller",
          callerId: data?.callerId || socket.id,
          targetRoom: channelName,
          senderSocketId: socket.id,
          timestamp: new Date().toISOString()
        });
      });

      socket.on('call_accept', (data) => {
        const channelName = data?.channelName || data?.targetRoom;
        const target = data?.targetRoom || data?.targetSocketId || data?.callerId;

        if (target) {
          io.to(target).emit('call_accept', {
            channelName,
            acceptedBy: socket.id,
            targetRoom: channelName,
            senderSocketId: socket.id
          });
        }
      });

      socket.on('call_reject', (data) => {
        const channelName = data?.channelName || data?.targetRoom;
        const target = data?.targetRoom || data?.targetSocketId || data?.callerId;

        if (target) {
          io.to(target).emit('call_reject', {
            channelName,
            rejectedBy: socket.id,
            reason: data?.reason || 'User rejected the call',
            targetRoom: channelName,
            senderSocketId: socket.id
          });
        }
      });

      socket.on('call_ended', (data) => {
        const channelName = typeof data === 'string' ? data : data?.channelName;
        const targetRoom = typeof data === 'object' ? data?.targetRoom : null;

        const payload = {
          channelName: channelName || targetRoom,
          endedBy: socket.id,
          senderSocketId: socket.id
        };

        if (channelName) io.to(channelName).emit('call_ended', payload);
        if (targetRoom && targetRoom !== channelName) io.to(targetRoom).emit('call_ended', payload);
        io.to('admins').emit('call_ended', payload);
      });

      // =========================================================================
      // --- 🌐 WEBRTC FALLBACK RELAYS ---
      // =========================================================================

      socket.on('webrtc_offer', (data) => {
        const target = data?.targetRoom || data?.targetSocketId || 'admins';
        const offer = data?.offer;

        if (offer) {
          io.to(target).emit('webrtc_offer', {
            ...data,
            offer: offer,
            senderSocketId: socket.id,
            callerName: data?.callerName || "Emergency Citizen Caller"
          });
        }
      });

      socket.on('webrtc_answer', (data) => {
        const target = data?.targetRoom || data?.targetSocketId || data?.senderSocketId;
        const answer = data?.answer;

        if (target && answer) {
          io.to(target).emit('webrtc_answer', {
            ...data,
            answer: answer,
            senderSocketId: socket.id
          });
        }
      });

      socket.on('webrtc_ice_candidate', (data) => {
        const target = data?.targetRoom || data?.targetSocketId || data?.senderSocketId;
        const candidate = data?.candidate;

        if (target && candidate) {
          io.to(target).emit('webrtc_ice_candidate', {
            ...data,
            candidate: candidate,
            senderSocketId: socket.id
          });
        }
      });

      socket.on('end_call', (data) => {
        const target = typeof data === 'string' 
          ? data 
          : (data?.targetRoom || data?.targetSocketId || 'admins');
          
        if (target) {
          io.to(target).emit('end_call', { senderSocketId: socket.id });
          io.to(target).emit('call_ended', { senderSocketId: socket.id });
        }
      });

      // --- Disconnect Listener ---
      socket.on('disconnect', (reason) => {
        console.log(`🔌 Client disconnected: ${socket.id} (Reason: ${reason})`);

        const uid = socket.userData?.uid;
        const citizenID = socket.userData?.citizenID;
        const lookupKey = uid || citizenID;

        if (!lookupKey) return;

        if (pendingDisconnects.has(lookupKey)) {
          clearTimeout(pendingDisconnects.get(lookupKey));
        }

        const timer = setTimeout(async () => {
          await handleOffline({ uid, citizenID });
          pendingDisconnects.delete(lookupKey);
        }, 3000);

        pendingDisconnects.set(lookupKey);
      });
    });

    return io;
  },

  getIO: () => {
    if (!io) {
      throw new Error('Socket.io has not been initialized!');
    }
    return io;
  },
};