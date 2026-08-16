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

// Constants
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const BUCKET_NAME = "alertu-media-storage";
const ADMIN_MEDIA_PREFIX = "admin-reports";
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

// Backblaze B2 S3 Client Initialization
const s3 = new S3Client({
  region: "us-west-004",
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  credentials: {
    accessKeyId: process.env.B2_KEY_ID?.trim() || "",
    secretAccessKey: process.env.B2_APP_KEY?.trim() || "",
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

    // Sanitize filename to prevent S3 key encoding bugs
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

    // Dynamically resolve host and protocol
    const host = req.get('host');
    const protocol = req.protocol;
    const permanentStreamUrl = `${protocol}://${host}/api/dispatch-media/stream?storagePath=${encodeURIComponent(uniqueStoragePath)}`;

    return res.status(200).json({
      success: true,
      storagePath: uniqueStoragePath, // Store this in DB
      fileUrl: permanentStreamUrl     // Fully-qualified proxy stream URL saved to DB
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

    // Path traversal security check: Ensure key originates from allowed prefixes
    if (!storagePath.startsWith(`${ADMIN_MEDIA_PREFIX}/`) && !storagePath.startsWith('incidents/')) {
      return res.status(403).json({ success: false, error: 'Access denied to requested path' });
    }

    // Pass HTTP Range headers down to B2 for video seeking/scrubbing support
    const rangeHeader = req.headers.range;

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: storagePath,
      ...(rangeHeader && { Range: rangeHeader })
    });

    const s3Response = await s3.send(command);

    // Forward crucial HTTP headers for streaming and inline browser rendering
    if (s3Response.ContentType) res.setHeader('Content-Type', s3Response.ContentType);
    if (s3Response.ContentLength) res.setHeader('Content-Length', s3Response.ContentLength);
    if (s3Response.ContentRange) res.setHeader('Content-Range', s3Response.ContentRange);
    if (s3Response.AcceptRanges) res.setHeader('Accept-Ranges', s3Response.AcceptRanges);

    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); // Aggressive client-side caching

    // Return 206 Partial Content if seeking/range request, otherwise 200
    res.status(rangeHeader ? 206 : 200);

    // Pipe stream with error handling
    s3Response.Body.pipe(res);
    s3Response.Body.on('error', (streamErr) => {
      console.error('❌ Stream Pipe Error:', streamErr.message);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
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

    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: storagePath,
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

    const headCommand = new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: storagePath,
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

    const deleteCommand = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: storagePath,
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