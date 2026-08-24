const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const socketInit = require('./socket'); // Socket engine reference

// --- Standardized Config (Matches server.js & mediaRoutes.js) ---
const BUCKET_NAME = process.env.B2_BUCKET_NAME || "alertu-media-storage";
const REGION = process.env.B2_REGION || "us-west-004";
const ENDPOINT = process.env.B2_ENDPOINT || `https://s3.${REGION}.backblazeb2.com`;

// Initialize Backblaze B2 S3 Client
async function resolveCitizenRef(db, uid) {
  const directRef = db.collection('citizens').doc(uid);
  const directDoc = await directRef.get();
  if (directDoc.exists) return directRef;

  const snapshot = await db.collection('citizens')
    .where('authUid', '==', uid)
    .limit(1)
    .get();
  return snapshot.empty ? directRef : snapshot.docs[0].ref;
}

const s3Client = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: (process.env.B2_KEY_ID || process.env.B2_APPLICATION_KEY_ID || "").trim(),
    secretAccessKey: (process.env.B2_APP_KEY || process.env.B2_APPLICATION_KEY || "").trim(),
  },
});

// --- Multer Configuration ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = /jpeg|jpg|png|webp|heic|heif|gif/;
    const extName = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
    const mimeType = file.mimetype.startsWith('image/') || file.mimetype === 'application/octet-stream';

    if (extName || mimeType) {
      cb(null, true);
    } else {
      const err = new Error('Only image files are allowed!');
      err.code = 'INVALID_FILE_TYPE';
      cb(err, false);
    }
  },
});

/**
 * Express wrapper for Multer to catch upload validation errors gracefully
 */
const handleUpload = (req, res, next) => {
  upload.single('avatar')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'File size exceeds 10MB limit.' });
      }
      return res.status(400).json({ success: false, error: err.message || 'Invalid upload file.' });
    }
    next();
  });
};

/**
 * @route   POST /api/citizens/upload-avatar
 * @desc    Direct multipart file upload for Mobile App user profile avatar
 * @access  Private (Bearer ID Token required)
 */
router.post('/upload-avatar', handleUpload, async (req, res) => {
  try {
    // 1. Verify Authentication Token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized. Token missing.' });
    }

    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(token);
    const uid = decodedToken.uid;

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file provided.' });
    }

    // 2. Prepare Storage Path and Metadata
    let fileExtension = path.extname(req.file.originalname).replace('.', '').toLowerCase();
    if (!fileExtension || fileExtension === 'blob') {
      fileExtension = 'jpg';
    }

    let contentType = req.file.mimetype;
    if (!contentType || contentType === 'application/octet-stream') {
      contentType = `image/${fileExtension === 'jpg' ? 'jpeg' : fileExtension}`;
    }

    const storagePath = `avatars/${uid}_${Date.now()}.${fileExtension}`;

    // 3. Upload Stream directly to Backblaze B2
    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: storagePath,
      Body: req.file.buffer,
      ContentType: contentType,
    };

    await s3Client.send(new PutObjectCommand(uploadParams));

    // 4. Robust Absolute URL Builder for Mobile App Access
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const serverBaseUrl = process.env.PUBLIC_BASE_URL || `${protocol}://${host}`;
    
    const relativeStreamPath = `/api/media/stream?storagePath=${encodeURIComponent(storagePath)}`;
    
    const photoUrl = process.env.B2_PUBLIC_URL 
      ? `${process.env.B2_PUBLIC_URL}/${storagePath}`
      : `${serverBaseUrl}${relativeStreamPath}`;

    // 5. Update Firebase Auth Profile
    await getAuth().updateUser(uid, {
      photoURL: photoUrl,
    });

    // 6. Update Firestore Document (citizens collection)
    const db = getFirestore();
    const citizenRef = await resolveCitizenRef(db, uid);

    await citizenRef.set(
      {
        avatar: photoUrl,
        photoUrl: photoUrl,
        photoURL: photoUrl,
        storagePath: storagePath,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 7. Safe Socket.IO Event Dispatch
    try {
      const io = socketInit.getIO();
      if (io) {
        io.to(uid).emit('profile_updated', {
          uid,
          avatar: photoUrl,
          photoUrl: photoUrl,
          message: 'Avatar updated successfully',
        });
      }
    } catch (socketErr) {
      console.warn('⚠️ Socket broadcast skipped in mobileAvatarUpload:', socketErr.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Avatar uploaded and profile updated successfully.',
      avatar: photoUrl,
      photoUrl: photoUrl,
      storagePath: storagePath
    });
  } catch (error) {
    console.error('❌ Error uploading mobile avatar:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload avatar.',
    });
  }
});

/**
 * @route   DELETE /api/citizens/avatar/delete OR /api/citizens/delete-avatar
 * @desc    Removes user's avatar image from Backblaze B2, Firebase Auth, and Firestore
 * @access  Private (Bearer ID Token required)
 */
router.delete(['/avatar/delete', '/delete-avatar'], async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized. Token missing.' });
    }

    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(token);
    const uid = decodedToken.uid;

    const db = getFirestore();
    const citizenRef = await resolveCitizenRef(db, uid);
    const citizenDoc = await citizenRef.get();

    // Default UI avatar fallback URL
    const citizenData = citizenDoc.exists ? citizenDoc.data() : {};
    const fallbackAvatar = `https://ui-avatars.com/api/?background=0D8ABC&color=fff&name=${encodeURIComponent(citizenData.fullName || 'Citizen')}`;

    // 1. Delete actual file from Backblaze B2 bucket if storagePath exists
    if (citizenDoc.exists && citizenDoc.data()?.storagePath) {
      const storagePath = citizenDoc.data().storagePath;
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: BUCKET_NAME,
          Key: storagePath,
        }));
      } catch (s3Err) {
        console.warn('⚠️ Backblaze storage file deletion skipped:', s3Err.message);
      }
    }

    // 2. Reset Firebase Auth Photo URL to fallback
    await getAuth().updateUser(uid, {
      photoURL: fallbackAvatar,
    });

    // 3. Clear avatar file fields in Firestore
    await citizenRef.set(
      {
        avatar: FieldValue.delete(),
        photoUrl: FieldValue.delete(),
        photoURL: FieldValue.delete(),
        storagePath: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // 4. Emit real-time socket event
    try {
      const io = socketInit.getIO();
      if (io) {
        io.to(uid).emit('profile_updated', {
          uid,
          avatar: fallbackAvatar,
          photoUrl: fallbackAvatar,
          message: 'Avatar removed successfully',
        });
      }
    } catch (socketErr) {
      console.warn('⚠️ Socket broadcast skipped on avatar deletion:', socketErr.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Avatar removed successfully.',
      avatar: fallbackAvatar
    });
  } catch (error) {
    console.error('❌ Error deleting mobile avatar:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to remove avatar.',
    });
  }
});

module.exports = router;
