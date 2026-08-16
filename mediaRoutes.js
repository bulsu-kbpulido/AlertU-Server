// mediaRoutes.js - Fixed Content-Type matching & presigned URL generation
const express = require('express');
const router = express.Router();
const { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand 
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET_NAME = process.env.B2_BUCKET_NAME || "alertu-media-storage";
const INCIDENTS_PREFIX = "incidents";

// Initialize Backblaze B2 S3 Client
const s3 = new S3Client({
  region: process.env.B2_REGION || "us-west-004", 
  endpoint: process.env.B2_ENDPOINT || "https://s3.us-west-004.backblazeb2.com", 
  credentials: {
    accessKeyId: (process.env.B2_KEY_ID || process.env.B2_APPLICATION_KEY_ID || "").trim(),          
    secretAccessKey: (process.env.B2_APP_KEY || process.env.B2_APPLICATION_KEY || "").trim(),     
  },
});

// -----------------------------------------------------------------------------
// 1. GENERATE PRESIGNED UPLOAD URL & PERMANENT STREAM LINK
// -----------------------------------------------------------------------------
router.post('/get-upload-url', async (req, res) => {
  try {
    let { fileType, fileName } = req.body; 
    
    // Default fallback if MIME type isn't specified
    if (!fileType || fileType === 'blob') {
      fileType = 'application/octet-stream';
    }

    // Determine extension or fallback
    let extension = 'jpg';
    if (fileType.includes('video')) extension = 'mp4';
    if (fileType.includes('audio')) extension = 'aac';

    // Sanitize user filename or fall back to timestamp
    let rawName = fileName || `${Date.now()}.${extension}`;
    const sanitizedFilename = rawName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    
    const uniqueStoragePath = `${INCIDENTS_PREFIX}/${Date.now()}_${sanitizedFilename}`;

    // Presigned PutObject Command
    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME, 
      Key: uniqueStoragePath,
      ContentType: fileType, // Client MUST send this exact Content-Type on PUT request
    });

    // Generate 5-minute presigned upload link
    const uploadUrl = await getSignedUrl(s3, putCommand, { expiresIn: 300 });

    // Permanent proxy streaming URL
    const permanentStreamUrl = `/api/media/stream?storagePath=${encodeURIComponent(uniqueStoragePath)}`;

    return res.status(200).json({
      success: true,
      uploadUrl: uploadUrl,
      storagePath: uniqueStoragePath,
      fileUrl: permanentStreamUrl,
      requiredContentType: fileType // Send back to client to guarantee header match
    });
  } catch (error) {
    console.error("❌ Presigned URL Generation Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 2. PERMANENT PROXY STREAM ROUTE
// Mounted at /api/media in server.js -> Listening on GET /api/media/stream
// -----------------------------------------------------------------------------
router.get('/stream', async (req, res) => {
  try {
    const { storagePath } = req.query;

    if (!storagePath) {
      return res.status(400).json({ success: false, error: 'storagePath query parameter is required' });
    }

    const rangeHeader = req.headers.range;

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: storagePath,
      ...(rangeHeader && { Range: rangeHeader })
    });

    const s3Response = await s3.send(command);

    // Forward streaming headers
    if (s3Response.ContentType) res.setHeader('Content-Type', s3Response.ContentType);
    if (s3Response.ContentLength) res.setHeader('Content-Length', s3Response.ContentLength);
    if (s3Response.ContentRange) res.setHeader('Content-Range', s3Response.ContentRange);
    if (s3Response.AcceptRanges) res.setHeader('Accept-Ranges', s3Response.AcceptRanges);

    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    res.status(rangeHeader ? 206 : 200);

    s3Response.Body.pipe(res);
  } catch (error) {
    console.error('❌ Incident Media Stream Error:', error.message);
    return res.status(404).json({ success: false, error: 'Media file not found or inaccessible' });
  }
});

module.exports = router;