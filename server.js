require('dotenv').config();

// 🚀 Enforce IPv4 DNS resolution globally to resolve Render IPv6 ENETUNREACH issues
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const http = require('http'); // Native HTTP module
const cors = require('cors');
const axios = require('axios'); 
const { Bonjour } = require('bonjour-service');
const helmet = require('helmet');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { S3Client } = require('@aws-sdk/client-s3');

const serviceAccount = require('./serviceAccountKey.json');
const socketInit = require('./socket'); // Socket module

// 🚀 Firebase Admin Structural Initialization
initializeApp({ 
  credential: cert(serviceAccount) 
});

const db = getFirestore();

// ☁️ Initialize S3 Client for Backblaze B2 Storage Integration
const b2Region = process.env.B2_REGION || 'us-west-004';
const b2BucketName = process.env.B2_BUCKET_NAME || 'alertu-media-storage';

const s3Client = new S3Client({
  endpoint: process.env.B2_ENDPOINT || `https://s3.${b2Region}.backblazeb2.com`,
  region: b2Region,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID || process.env.B2_APPLICATION_KEY_ID,
    secretAccessKey: process.env.B2_APP_KEY || process.env.B2_APPLICATION_KEY,
  },
});

const app = express();
const server = http.createServer(app); // Wrap express app in HTTP server

// 🌐 Global CORS Configuration for Express HTTP API
const corsOptions = {
  origin: (origin, callback) => callback(null, true), 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type', 'X-Total-Count'],
  credentials: true
};

// Apply CORS Middleware globally (Handles options preflight automatically)
app.use(cors(corsOptions));

// ⚡ Initialize Socket.IO Server Engine with explicit CORS options
socketInit.init(server, corsOptions); 

// ⚙️ Routing Behavioral Rules
app.set('strict routing', false); 
app.set('case sensitive routing', false);

// 🛡️ Security Headers Configuration
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false
}));

// 🎛️ Global Body Parsers
app.use(express.json());

// 🔍 Global Request Logging Middleware
app.use((req, res, next) => {
  console.log(`📡 [${new Date().toISOString()}] ${req.method} → ${req.originalUrl}`);
  next();
});

// Axios Debugging Interceptor
axios.interceptors.request.use(request => {
  console.log('Starting Request to:', request.url);
  return request;
});

// 🔒 Firebase Authentication Verification Middleware
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Missing or malformed token header.' });
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await getAuth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Firebase Token Verification Failed:', error.message);
    return res.status(403).json({ success: false, error: 'Unauthorized: Invalid or expired token session.' });
  }
};

// ==========================================
// Inline Proxy Routes
// ==========================================

// SECURE PROXY ROUTE FOR OPENROUTESERVICE
app.get('/api/ors/directions', async (req, res) => {
  try {
    const { start, end } = req.query;
    
    if (!start || !end) {
      return res.status(400).json({ success: false, message: "Missing start or end coordinates." });
    }

    const url = `https://api.openrouteservice.org/v2/directions/driving-car?start=${start}&end=${end}`;
    
    const response = await axios.get(url, {
      headers: {
        'Accept': 'application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8',
        'Authorization': process.env.ORS_API_KEY, 
        'Content-Type': 'application/json'
      }
    });

    return res.json(response.data);
  } catch (error) {
    console.error("ORS Proxy Error:", error.message);
    return res.status(error.response?.status || 500).json({ 
      success: false, 
      message: error.response?.data || "Internal Routing Proxy Error" 
    });
  }
});

// ==========================================
// 1. Import Modular Routing Engines
// ==========================================
console.log('📦 Loading route modules...');
const superadminRoutes = require('./superadminRoutes'); 
const superadpassForgotRoutes = require('./superadpassForgot'); 
const adminForgotPasswordRoutes = require('./adminForgotPassword'); // 🔑 Admin Reset Module
const adminRoutes = require('./adminRoutes');
const mediaRoutes = require('./mediaRoutes');
const reportLimitCacheRoutes = require('./reportlimitcache'); 
const archivedReportLimitCacheRoutes = require('./ARlimitcache'); 
const { router: auditLogLimitCacheRoutes } = require('./auditloglimitcache'); // 🛡️ Audit Log Cache Engine
const reportRoutes = require('./reportRoutes');     
const approvedRoutes = require('./approvedRoutes'); 
const archivedRoutes = require('./archivedRoutes');
const archivedCitizenRoutes = require('./archivedcitizenRoutes'); 
const citizenRoutes = require('./citizenRoutes');
const mobileAvatarUploadRoutes = require('./mobileAvatarUpload'); // 🖼️ Mobile Profile Avatar Upload Engine
const citizenOwnReportsRoutes = require('./citizenOwnReports'); 
const adminCitizenRoutes = require('./AdminCitizenRoutes'); 
const adminMediaRoutes = require('./adminMediaRoutes'); 
const adminReportRoutes = require('./adminReportRoutes'); 
const approvedAdminRoutes = require('./ApprovedAdminRoutes');
const linkRoutes = require('./linkRoutes');
const resolvedRoutes = require('./resolvedRoutes');
const archivedApprovedRoutes = require('./archivedApprovedRoutes');
const adminListenerRoutes = require('./adminListenerRoutes');
const citizenListener = require('./citizenListener'); 
const emailVerificationRoutes = require('./EmailVerificationRoute');
const passwordForgotRoutes = require('./passwordforgot'); 
const agoraRoutes = require('./agoraRoutes');
const callHistoryRoutes = require('./callHistoryRoutes');
const chatRoutes = require('./chatRoutes'); 
const sosHandlerRoutes = require('./SosHandler'); 
const movementDetectorRoutes = require('./movementDetector'); // 🕵️‍♂️ Admin Movement Log Engine

// 🔄 Duplicate Detection & Resolution Route Engines
const duplicateReportRoutes = require('./duplicateReportRoutes');
const duplicateTOreport = require('./duplicateTOreport');

console.log('✅ All route modules loaded successfully');

// ==========================================
// 2. Mount Endpoints under /api Prefix
// ==========================================
console.log('🔌 Mounting routes...');

// 👑 SUPERADMIN ROUTES
app.use('/api/superadmin', superadminRoutes); 

// 🔒 ADMIN SPECIFIC ROUTES & DISPATCH MEDIA ENGINE
app.use('/api/dispatch-media', adminMediaRoutes); 
app.use('/api', adminReportRoutes); // Supports /admin-reports inside adminReportRoutes.js
app.use('/api/approved-admin-reports', approvedAdminRoutes);
app.use('/api/admin/citizens', adminCitizenRoutes);
app.use('/api/admin', adminRoutes);

// 🕵️‍♂️ ADMIN ACTION & MOVEMENT LOGGING
// IMPORTANT: adminListenerRoutes owns the mobile /admin-actions/log endpoint.
// It must be mounted before movementDetectorRoutes because Express uses the
// first matching route and both modules define the same endpoint.
app.use('/api', adminListenerRoutes);
app.use('/api', movementDetectorRoutes);

// 🟢 PUBLIC / UNPROTECTED ROUTES
app.use('/api/auth', passwordForgotRoutes); 
app.use('/api/auth', superadpassForgotRoutes); 
app.use('/api/auth', adminForgotPasswordRoutes); // Mounts /api/auth/send-admin-reset-otp & /api/auth/reset-admin-password

// 📧 EMAIL VERIFICATION ENGINES
app.use('/api/email-verification', emailVerificationRoutes);
app.use('/api', emailVerificationRoutes);

app.use('/api', citizenListener);
app.use('/api', linkRoutes);          
app.use('/api', agoraRoutes);         
app.use('/api', callHistoryRoutes);   

// 💬 REAL-TIME EMERGENCY CHAT ROUTE ENGINE
app.use('/api/chats', chatRoutes);    

// 🚨 SOS EMERGENCY & GIS REAL-TIME LOCATION ENGINE
app.use('/api/sos', sosHandlerRoutes); 

// ⚡ READ-OPTIMIZED CACHED REPORT & AUDIT ENGINES
app.use('/api', reportLimitCacheRoutes);         
app.use('/api', archivedReportLimitCacheRoutes); 
app.use('/api', auditLogLimitCacheRoutes); // Mounts /api/audit-logs, /api/audit-logs/:eventId, & /api/audit-logs/clear-cache

// 🔒 OTHER PROTECTED & GENERAL API ROUTES
app.use('/api/media', mediaRoutes);
app.use('/api', reportRoutes);   
app.use('/api', approvedRoutes); 
app.use('/api', archivedRoutes); 

// 🚨 IMPORTANT ORDER: Explicit /citizens sub-routes (avatars & archives) MUST be mounted before generic wildcard routes
app.use('/api/citizens', mobileAvatarUploadRoutes); // 🖼️ Mounts /upload-avatar & /avatar/delete under /api/citizens FIRST
app.use('/api/citizens', archivedCitizenRoutes); 
app.use('/api/citizens', citizenRoutes); // 👤 Citizen engine mounted directly under /api/citizens
app.use('/api/citizen-reports', citizenOwnReportsRoutes); 

app.use('/api', resolvedRoutes);
app.use('/api', archivedApprovedRoutes);

// 🔍 DUPLICATE MANAGEMENT ENDPOINTS
app.use('/api/duplicates', duplicateReportRoutes);
app.use('/api/duplicate-to-report', duplicateTOreport);

console.log('✅ All routes mounted successfully');

// ==========================================
// 3. Core Operational Fallbacks
// ==========================================

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'AlertU Backend is running',
    timestamp: new Date().toISOString()
  });
});

// Explicit default to PORT 3000
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🚨 ALERTU BACKEND SERVER INITIALIZATION                   ║
╚════════════════════════════════════════════════════════════╝
  
  📍 Server running on port: ${PORT}
  🌐 Listening on: 0.0.0.0:${PORT}
  ⚡ WebSockets (Socket.IO): Enabled
  ⏰ Started at: ${new Date().toLocaleString()}
  
  ✅ Loaded Routes:
     • OpenRouteService Proxy Engine (/api/ors/directions)
     • SuperAdmin Engine (/api/superadmin/...)
     • Admin Routes Engine (/api/admin/...)
     • Dispatch Media Engine (/api/dispatch-media/...)
     • Forgot Password Engine (/api/auth/send-reset-otp, /api/auth/reset-password)
     • SuperAdmin Forgot Password Engine (/api/auth/send-superadmin-reset-otp, /api/auth/reset-superadmin-password)
     • Admin Forgot Password Engine (/api/auth/send-admin-reset-otp, /api/auth/reset-admin-password)
     • Email Verification (/api/email-verification/send-otp, /api/email-verification/verify-otp)
     • Admin Action Logger (/api/admin-actions/log)
     • Audit Log Cache & Limit Engine (/api/audit-logs)
     • Mobile Avatar Upload & Delete Engine (/api/citizens/upload-avatar, /api/citizens/avatar/delete)
     • Archived Citizen Engine (/api/citizens/archived)
     • Citizen Engine (/api/citizens/...)
     • Citizen Own Reports Engine (/api/citizen-reports/...)
     • Admin Citizen Engine (/api/admin/citizens/...)
     • Media Routes (/api/media/...)
     • Report Cache & Limit Engine (/api/reports)
     • Archived Report Cache & Limit Engine (/api/archived-reports)
     • Report Routes (/api/reports/...)
     • Citizen Submission Listener (/api/reports/notify-new)
     • Approved Routes (/api/approved/...)
     • Archived Routes (/api/archived/...)
     • Admin Report Routes (/api/admin-reports)
     • Approved Admin Report Routes (/api/approved-admin-reports/...)
     • Link Management Engine (/api/links/...)
     • TURN Credentials Engine (/api/turn-credentials)
     • Call History Engine (/api/call-history)
     • Emergency Chat REST Engine (/api/chats/...)
     • Emergency SOS & GIS Handler Engine (/api/sos/...) via SosHandler.js
     • Duplicate Checking Engine (/api/duplicates/...)
     • Duplicate Action Pipeline (/api/duplicate-to-report/...)
  
  🔑 Environment Variables Check:
     B2_KEY_ID: ${process.env.B2_KEY_ID || process.env.B2_APPLICATION_KEY_ID ? '✅ SET' : '❌ MISSING'}
     B2_APP_KEY: ${process.env.B2_APP_KEY || process.env.B2_APPLICATION_KEY ? '✅ SET' : '❌ MISSING'}
     B2_BUCKET_NAME: ${process.env.B2_BUCKET_NAME ? '✅ SET' : '⚠️ UNSET (Defaulting to "alertu-media-storage")'}
     B2_REGION: ${process.env.B2_REGION ? '✅ SET' : '⚠️ UNSET (Defaulting to "us-west-004")'}
     RESEND_API_KEY: ${process.env.RESEND_API_KEY ? '✅ SET' : '❌ MISSING (Required for Email Verification)'}
     JWT_SECRET: ${process.env.JWT_SECRET ? '✅ SET' : '⚠️ UNSET (Using Fallback Hash)'}
  `);

  // Skip Bonjour broadcasting in cloud/production environments like Render
  if (process.env.NODE_ENV !== 'production' && !process.env.RENDER) {
    try {
      const bonjour = new Bonjour();
      bonjour.publish({ 
        name: 'AlertU-Backend', 
        type: 'http', 
        port: parseInt(PORT) 
      });
      console.log(`📡 Broadcast service 'AlertU-Backend' is live on local network.\n`);
    } catch (err) {
      console.error("Failed to start Bonjour broadcasting:", err);
    }
  } else {
    console.log(`ℹ️ Cloud environment detected. Local network Bonjour broadcasting skipped.\n`);
  }
});

// ==========================================
// 4. Global Error Handling Middleware
// ==========================================
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error catch:', err);
  
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Credentials", "true");
  
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// 5. Ultimate 404 Route Catch-All
// ==========================================
app.use((req, res) => {
  console.warn(`⚠️ 404 Route Deficit: ${req.method} ${req.path}`);
  
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Credentials", "true");
  
  res.status(404).json({
    success: false,
    message: 'Route not found in system manifest',
    path: req.path,
    method: req.method
  });
});

// ==========================================
// Graceful Shutdown Signal Handlers (Render Lifecycle)
// ==========================================
const handleShutdown = (signal) => {
  console.log(`\n⚠️ Received ${signal}. Initiating graceful shutdown...`);
  server.close(() => {
    console.log('🛑 HTTP and WebSocket server closed cleanly.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
