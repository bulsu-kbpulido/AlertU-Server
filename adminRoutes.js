// adminRoutes.js - Production Ready
const express = require('express');
const router = express.Router();
const multer = require('multer');

// Direct Firebase Admin SDK imports
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// AWS S3 SDK v3 for Backblaze B2 Integration
const { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand 
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Initialize local Firestore and Auth instances directly from default Firebase App
const auth = getAuth();
const firestore = getFirestore();

// Safely extract verifyToken middleware & ID generator
const { verifyToken } = require('./authMiddleware');
const { getNextAdminId } = require('./adminIdGenerator');

// ==========================================
// MULTER IN-MEMORY FILE UPLOAD CONFIG
// ==========================================
const storage = multer.memoryStorage();
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB Limit
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PNG, JPEG, WEBP, and GIF are allowed.'));
    }
  }
});

// ==========================================
// BACKBLAZE B2 S3 CLIENT CONFIGURATION
// ==========================================
const BUCKET_NAME = process.env.B2_BUCKET_NAME || "alertu-media-storage";
const AVATARS_PREFIX = "avatars";

const s3 = new S3Client({
  region: process.env.B2_REGION || "us-west-004", 
  endpoint: process.env.B2_ENDPOINT || "https://s3.us-west-004.backblazeb2.com", 
  credentials: {
    accessKeyId: process.env.B2_KEY_ID ? process.env.B2_KEY_ID.trim() : "",          
    secretAccessKey: process.env.B2_APP_KEY ? process.env.B2_APP_KEY.trim() : "",     
  },
});

// ==========================================
// 1. DASHBOARD & TEAM MEMBER ENDPOINTS
// ==========================================

// Resolves to: GET /api/admin/dashboard
router.get('/dashboard', verifyToken, (req, res) => {
  res.json({
    success: true,
    message: 'Welcome to the Admin Dashboard',
    timestamp: new Date().toISOString()
  });
});

// Resolves to: POST /api/admin/create-user
router.post('/create-user', verifyToken, (req, res) => {
  const { username, role } = req.body;

  if (!username || !role) {
    return res.status(400).json({ success: false, message: 'Missing username or role' });
  }

  res.json({
    success: true,
    message: `User '${username}' created with role '${role}'`
  });
});

// ==========================================
// 2. AVATAR / PROFILE PICTURE ENDPOINTS
// ==========================================

const avatarUploadHandler = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded.' });
    }

    const { file } = req;
    const uid = req.body.uid || (req.user ? req.user.uid : Date.now());
    
    const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const uniqueStoragePath = `${AVATARS_PREFIX}/${uid}_${Date.now()}_${sanitizedFilename}`;

    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: uniqueStoragePath,
      Body: file.buffer,
      ContentType: file.mimetype,
    });

    await s3.send(putCommand);

    const host = req.get('host');
    const protocol = req.protocol;
    const permanentStreamUrl = `${protocol}://${host}/api/admin/avatar/stream?storagePath=${encodeURIComponent(uniqueStoragePath)}`;

    return res.status(200).json({
      success: true,
      storagePath: uniqueStoragePath,
      fileUrl: permanentStreamUrl
    });
  } catch (error) {
    console.error("❌ Direct Proxy Avatar Upload Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
};

const uploadSingleFile = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'avatar', maxCount: 1 }
]);

const extractFileMiddleware = (req, res, next) => {
  uploadSingleFile(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (req.files) {
      if (req.files['file'] && req.files['file'][0]) {
        req.file = req.files['file'][0];
      } else if (req.files['avatar'] && req.files['avatar'][0]) {
        req.file = req.files['avatar'][0];
      }
    }
    next();
  });
};

// Direct upload aliases: POST /api/admin/upload AND POST /api/admin/upload-avatar
router.post('/upload', verifyToken, extractFileMiddleware, avatarUploadHandler);
router.post('/upload-avatar', verifyToken, extractFileMiddleware, avatarUploadHandler);

/**
 * PERMANENT PROXY AVATAR STREAM ROUTE
 * Resolves to: GET /api/admin/avatar/stream
 */
router.get('/avatar/stream', async (req, res) => {
  try {
    const { storagePath } = req.query;

    if (!storagePath) {
      return res.status(400).json({ success: false, error: 'storagePath query parameter is required' });
    }

    if (!storagePath.startsWith(`${AVATARS_PREFIX}/`)) {
      return res.status(403).json({ success: false, error: 'Access denied to requested path' });
    }

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: storagePath
    });

    const s3Response = await s3.send(command);

    if (s3Response.ContentType) res.setHeader('Content-Type', s3Response.ContentType);
    if (s3Response.ContentLength) res.setHeader('Content-Length', s3Response.ContentLength);

    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    res.status(200);

    s3Response.Body.pipe(res);
    s3Response.Body.on('error', (streamErr) => {
      console.error('❌ Avatar Stream Pipe Error:', streamErr.message);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
  } catch (error) {
    console.error('❌ Admin Avatar Stream Error:', error.message);
    return res.status(404).json({ success: false, error: 'Avatar image not found or inaccessible' });
  }
});

/**
 * PRESIGNED AVATAR UPLOAD URL
 * Resolves to: POST /api/admin/get-avatar-upload-url
 */
router.post('/get-avatar-upload-url', verifyToken, async (req, res) => {
  try {
    const { fileType, fileName, uid } = req.body; 

    if (!fileType) {
      return res.status(400).json({ success: false, error: "Missing fileType parameter." });
    }

    let extension = 'jpg';
    if (fileType.includes('png')) extension = 'png';
    else if (fileType.includes('webp')) extension = 'webp';
    else if (fileType.includes('gif')) extension = 'gif';

    let rawName = fileName || `${Date.now()}.${extension}`;
    const sanitizedFilename = rawName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    
    const userIdentifier = uid || (req.user ? req.user.uid : Date.now());
    const uniqueStoragePath = `${AVATARS_PREFIX}/${userIdentifier}_${Date.now()}_${sanitizedFilename}`;

    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME, 
      Key: uniqueStoragePath,
      ContentType: fileType,
    });

    const uploadUrl = await getSignedUrl(s3, putCommand, { expiresIn: 300 });

    const host = req.get('host');
    const protocol = req.protocol;
    const permanentStreamUrl = `${protocol}://${host}/api/admin/avatar/stream?storagePath=${encodeURIComponent(uniqueStoragePath)}`;

    return res.status(200).json({
      success: true,
      uploadUrl: uploadUrl,
      storagePath: uniqueStoragePath, 
      fileUrl: permanentStreamUrl     
    });
  } catch (error) {
    console.error("❌ Avatar Presigned URL Generation Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 3. CREATE ADMIN ENDPOINT
// Resolves to: POST /api/admin/create-admin
// ==========================================
router.post('/create-admin', verifyToken, async (req, res) => {
  const { email, password, name, department, barangay, phone, address, avatar } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields (email, password, name).' 
    });
  }

  try {
    const adminId = await getNextAdminId();

    const userRecord = await auth.createUser({
      email: email,
      password: password,
      displayName: name,
    });

    await firestore.collection('admins').doc(userRecord.uid).set({
      uid: userRecord.uid,
      adminId: adminId,
      name: name,
      email: email,
      department: department || 'barangay',
      barangay: barangay || null,
      phone: phone || '',
      address: address || '',
      avatar: avatar || '',
      avatarBg: 'bg-blue-500',
      createdAt: FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ 
      success: true, 
      message: 'Admin account provisioned successfully.',
      uid: userRecord.uid, 
      adminId: adminId 
    });

  } catch (error) {
    console.error('Firebase Admin Creation Error:', error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

// ==========================================
// 4. UPDATE ADMIN ENDPOINT
// Resolves to: POST /api/admin/update-admin-auth
// ==========================================
router.post('/update-admin-auth', verifyToken, async (req, res) => {
  const { uid, email, phone, name, department, barangay, address, avatar } = req.body;

  if (!uid) {
    return res.status(400).json({ success: false, error: 'UID is required for updates.' });
  }

  try {
    let formattedPhone = undefined;
    if (phone) {
      let cleaned = phone.replace(/\s+/g, '').replace(/[-()]/g, '');
      if (cleaned.startsWith('+63')) formattedPhone = cleaned;
      else if (cleaned.startsWith('63')) formattedPhone = `+${cleaned}`;
      else if (cleaned.startsWith('0')) formattedPhone = `+63${cleaned.substring(1)}`;
      else formattedPhone = `+63${cleaned}`;

      if (formattedPhone.length > 15) {
        return res.status(400).json({ success: false, error: 'Phone number format is too long.' });
      }
    }

    await auth.updateUser(uid, {
      email: email,
      displayName: name,
      phoneNumber: formattedPhone || undefined
    });

    const updateData = {};
    if (email !== undefined) updateData.email = email;
    if (name !== undefined) updateData.name = name;
    if (department !== undefined) updateData.department = department;
    if (barangay !== undefined) updateData.barangay = barangay;
    if (address !== undefined) updateData.address = address;
    if (avatar !== undefined) updateData.avatar = avatar;
    if (formattedPhone !== undefined) updateData.phone = formattedPhone;

    await firestore.collection('admins').doc(uid).update(updateData);

    return res.status(200).json({ 
      success: true, 
      message: 'User structural profile synchronized successfully.' 
    });

  } catch (error) {
    console.error('Firebase Admin Auth Update Error:', error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

// ==========================================
// 5. DELETE ADMIN ENDPOINT
// Resolves to: POST /api/admin/delete-admin-auth
// ==========================================
router.post('/delete-admin-auth', verifyToken, async (req, res) => {
  const { uid } = req.body;

  if (!uid) {
    return res.status(400).json({ success: false, error: 'UID is required.' });
  }

  try {
    await auth.deleteUser(uid);
    await firestore.collection('admins').doc(uid).delete();

    return res.status(200).json({ 
      success: true, 
      message: 'User wiped out from Auth and Database successfully.' 
    });

  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      await firestore.collection('admins').doc(uid).delete();
      return res.status(200).json({ 
        success: true, 
        warning: 'User was already removed from Authentication. Firestore document cleaned up.' 
      });
    }

    console.error('Firebase Admin Auth Delete Error:', error);
    return res.status(400).json({ success: false, error: error.message });
  }
});

// ==========================================
// 6. SECURE VERIFICATION ENDPOINT
// Resolves to: POST /api/admin/verify-admin-session
// ==========================================
router.post('/verify-admin-session', verifyToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const adminDoc = await firestore.collection('admins').doc(uid).get();

    if (!adminDoc.exists) {
      return res.status(403).json({ success: false, error: 'User is authenticated but not registered as an Admin.' });
    }

    return res.status(200).json({ 
      success: true, 
      adminName: adminDoc.data().name 
    });

  } catch (error) {
    console.error('Security Verification Error:', error);
    return res.status(401).json({ success: false, error: 'Invalid or expired session token.' });
  }
});

module.exports = router;