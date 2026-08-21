// mediaRoutes.js - Production-Ready Presigned Upload & Proxy Streaming
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
const BASE_URL = process.env.BASE_URL || "https://alertu-server-production.up.railway.app";

const s3 = new S3Client({
  region: process.env.B2_REGION || "us-west-004", 
  endpoint: process.env.B2_ENDPOINT || "https://s3.us-west-004.backblazeb2.com", 
  credentials: {
    accessKeyId: (process.env.B2_KEY_ID || process.env.B2_APPLICATION_KEY_ID || "").trim(),          
    secretAccessKey: (process.env.B2_APP_KEY || process.env.B2_APPLICATION_KEY || "").trim(),     
  },
});

// -----------------------------------------------------------------------------
// 1. GENERATE PRESIGNED UPLOAD URL & ABSOLUTE PRODUCTION STREAM LINK
// -----------------------------------------------------------------------------
router.post('/get-upload-url', async (req, res) => {
  try {
    let { fileType, fileName } = req.body; 
    
    if (!fileType || fileType === 'blob') {
      fileType = 'application/octet-stream';
    }

    let extension = 'jpg';
    if (fileType.includes('video')) extension = 'mp4';
    if (fileType.includes('audio')) extension = 'aac';

    let rawName = fileName || `${Date.now()}.${extension}`;
    const sanitizedFilename = rawName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    
    const uniqueStoragePath = `${INCIDENTS_PREFIX}/${Date.now()}_${sanitizedFilename}`;

    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME, 
      Key: uniqueStoragePath,
      ContentType: fileType,
    });

    const uploadUrl = await getSignedUrl(s3, putCommand, { expiresIn: 300 });

    const permanentStreamUrl = `${BASE_URL}/api/media/stream?storagePath=${encodeURIComponent(uniqueStoragePath)}`;

    return res.status(200).json({
      success: true,
      uploadUrl: uploadUrl,
      storagePath: uniqueStoragePath,
      fileUrl: permanentStreamUrl,
      requiredContentType: fileType
    });
  } catch (error) {
    console.error("❌ Presigned URL Generation Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------------------------------------------------------------
// 2. PERMANENT PROXY STREAM ROUTE
// -----------------------------------------------------------------------------
router.get('/stream', async (req, res) => {
  try {
    let { storagePath } = req.query;

    if (!storagePath) {
      return res.status(400).json({ success: false, error: 'storagePath query parameter is required' });
    }

    // Decode and normalize storage path safely
    const cleanStoragePath = decodeURIComponent(storagePath).replace(/^\/+/, '');

    const rangeHeader = req.headers.range;

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: cleanStoragePath,
      ...(rangeHeader && { Range: rangeHeader })
    });

    const s3Response = await s3.send(command);

    // Standard headers for CORS and Media Playback
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

    if (s3Response.ContentType) res.setHeader('Content-Type', s3Response.ContentType);
    if (s3Response.ContentLength) res.setHeader('Content-Length', s3Response.ContentLength);
    if (s3Response.ContentRange) res.setHeader('Content-Range', s3Response.ContentRange);
    if (s3Response.AcceptRanges) res.setHeader('Accept-Ranges', s3Response.AcceptRanges);

    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    res.status(rangeHeader ? 206 : 200);

    // Stream directly to response
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
    console.error('❌ Incident Media Stream Error:', error.message);
    return res.status(404).json({ success: false, error: 'Media file not found or inaccessible' });
  }
});

module.exports = router;
