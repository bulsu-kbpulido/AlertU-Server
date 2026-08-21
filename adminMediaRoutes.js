// adminMediaRoutes.js - Production Ready
const express = require('express');
const router = express.Router();
const { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand, 
  DeleteObjectCommand, 
  HeadObjectCommand 
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { verifyToken } = require('./authMiddleware');
const multer = require('multer');

// -----------------------------------------------------------------------------
// ENVIRONMENT & CONFIGURATION
// -----------------------------------------------------------------------------
const BUCKET_NAME = process.env.B2_BUCKET_NAME || "alertu-media-storage";
const ADMIN_MEDIA_PREFIX = "admin-reports";
const BASE_URL = process.env.BASE_URL || "https://alertu-server-production.up.railway.app";
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const ALLOWED_MIME_TYPES = ['video/mp4', 'image/png', 'image/jpeg', 'image/webp'];

// Multer Setup (In-Memory Buffer Storage)
const upload = multer({
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP4, PNG, JPEG, and WEBP are allowed.'));
    }
  }
});

// Backblaze B2 S3 Client Initialization (Aligned with mediaRoutes.js fallback environment keys)
const s3 = new S3Client({
  region: process.env.B2_REGION || "us-west-004",
  endpoint: process.env.B2_ENDPOINT || "https://s3.us-west-004.backblazeb2.com",
  credentials: {
    accessKeyId: (process.env.B2_KEY_ID || process.env.B2_APPLICATION_KEY_ID || "").trim(),
    secretAccessKey: (process.env.B2_APP_KEY || process.env.B2_APPLICATION_KEY || "").trim(),
  },
});

// -----------------------------------------------------------------------------
// 1. UPLOAD MEDIA (Endpoint: POST /api/dispatch-media/upload)
// -----------------------------------------------------------------------------
router.post('/upload', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided' });
    }

    const { reportId } = req.body;
    const { file } = req;

    // Sanitize filename to prevent S3 key encoding issues
    const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const folder = reportId || `temp-${Date.now()}`;
    const uniqueStoragePath = `${ADMIN_MEDIA_PREFIX}/${folder}/${Date.now()}_${sanitizedFilename}`;

    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: uniqueStoragePath,
      Body: file.buffer,
      ContentType: file.mimetype,
    });

    await s3.send(putCommand);

    // Standardized to absolute production URL (BASE_URL) consistent with mediaRoutes.js
    const permanentStreamUrl = `${BASE_URL}/api/dispatch-media/stream?storagePath=${encodeURIComponent(uniqueStoragePath)}`;

    return res.status(200).json({
      success: true,
      storagePath: uniqueStoragePath,
      fileUrl: permanentStreamUrl
    });
  } catch (error) {
    console.error('❌ Upload Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 2. PERMANENT PROXY STREAM ROUTE (Endpoint: GET /api/dispatch-media/stream)
// -----------------------------------------------------------------------------
router.get('/stream', async (req, res) => {
  try {
    const { storagePath } = req.query;

    if (!storagePath) {
      return res.status(400).json({ success: false, error: 'storagePath query parameter is required' });
    }

    // Decode and normalize storage path safely
    const cleanStoragePath = decodeURIComponent(storagePath).replace(/^\/+/, '');

    // Path traversal security check: Ensure key originates from allowed prefixes
    if (!cleanStoragePath.startsWith(`${ADMIN_MEDIA_PREFIX}/`) && !cleanStoragePath.startsWith('incidents/')) {
      return res.status(403).json({ success: false, error: 'Access denied to requested path' });
    }

    // Pass HTTP Range headers down to B2 for video seeking/scrubbing support
    const rangeHeader = req.headers.range;

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: cleanStoragePath,
      ...(rangeHeader && { Range: rangeHeader })
    });

    const s3Response = await s3.send(command);

    // Standard CORS headers for cross-origin browser media playback
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

    // Forward crucial HTTP headers for streaming and inline browser rendering
    if (s3Response.ContentType) res.setHeader('Content-Type', s3Response.ContentType);
    if (s3Response.ContentLength) res.setHeader('Content-Length', s3Response.ContentLength);
    if (s3Response.ContentRange) res.setHeader('Content-Range', s3Response.ContentRange);
    if (s3Response.AcceptRanges) res.setHeader('Accept-Ranges', s3Response.AcceptRanges);

    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    // Return 206 Partial Content if seeking/range request, otherwise 200
    res.status(rangeHeader ? 206 : 200);

    // Robust stream handling (handles Node stream pipe and AWS SDK v3 event streams)
    if (s3Response.Body && typeof s3Response.Body.pipe === 'function') {
      s3Response.Body.pipe(res);
      s3Response.Body.on('error', (err) => {
        console.error('❌ Stream Pipe Error:', err.message);
        if (!res.headersSent) res.status(500).end();
      });
    } else if (s3Response.Body) {
      const stream = s3Response.Body;
      stream.on('data', (chunk) => res.write(chunk));
      stream.on('end', () => res.end());
      stream.on('error', (err) => {
        console.error('❌ Stream Error:', err.message);
        if (!res.headersSent) res.status(500).end();
      });
    }
  } catch (error) {
    console.error('❌ Media Stream Error:', error.message);
    return res.status(404).json({ success: false, error: 'Media file not found or inaccessible' });
  }
});

// -----------------------------------------------------------------------------
// 3. ON-DEMAND SHORT-LIVED PRESIGNED URL (Endpoint: GET /api/dispatch-media/url)
// -----------------------------------------------------------------------------
router.get('/url', verifyToken, async (req, res) => {
  try {
    const { storagePath, mimeType } = req.query;

    if (!storagePath) {
      return res.status(400).json({ success: false, error: 'storagePath query parameter is required' });
    }

    const cleanStoragePath = decodeURIComponent(storagePath).replace(/^\/+/, '');

    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: cleanStoragePath,
      ResponseContentDisposition: 'inline',
      ...(mimeType && { ResponseContentType: mimeType })
    });

    const freshUrl = await getSignedUrl(s3, getCommand, { expiresIn: 3600 });

    return res.status(200).json({
      success: true,
      url: freshUrl
    });
  } catch (error) {
    console.error('❌ Presigned URL Generation Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 4. VERIFY UPLOAD ROUTE (Endpoint: GET /api/dispatch-media/verify)
// -----------------------------------------------------------------------------
router.get('/verify', verifyToken, async (req, res) => {
  try {
    const { storagePath } = req.query;

    if (!storagePath) {
      return res.status(400).json({ success: false, error: 'storagePath query parameter is required' });
    }

    const cleanStoragePath = decodeURIComponent(storagePath).replace(/^\/+/, '');

    const headCommand = new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: cleanStoragePath,
    });

    const metadata = await s3.send(headCommand);

    return res.status(200).json({
      success: true,
      exists: true,
      size: metadata.ContentLength,
      contentType: metadata.ContentType,
      lastModified: metadata.LastModified
    });
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ success: false, exists: false, error: 'File not found' });
    }
    console.error('❌ Verify Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 5. DELETE MEDIA ROUTE (Endpoint: DELETE /api/dispatch-media/delete)
// -----------------------------------------------------------------------------
router.delete('/delete', verifyToken, async (req, res) => {
  try {
    const { storagePath } = req.body;

    if (!storagePath) {
      return res.status(400).json({ success: false, error: 'storagePath body parameter is required' });
    }

    const cleanStoragePath = decodeURIComponent(storagePath).replace(/^\/+/, '');

    const deleteCommand = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: cleanStoragePath,
    });

    await s3.send(deleteCommand);

    return res.status(200).json({
      success: true,
      message: 'File deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
