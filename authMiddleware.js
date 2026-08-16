// 🔄 Import getAuth directly from the modular subpath
const { getAuth } = require('firebase-admin/auth');

// List of public endpoints that do NOT require an auth token
const publicRoutes = [
  '/auth/send-reset-otp',
  '/auth/reset-password',
  '/auth/login',
  '/auth/register',
  '/archived-reports',
  '/api/admin/avatar/stream',
];

/**
 * Capstone-friendly Base64 JWT Payload Decoder
 * Extracts user claims from the token even if it is expired.
 */
const decodeTokenPayload = (token) => {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch (err) {
    return null;
  }
};

/**
 * Middleware to verify Firebase ID Tokens for incoming requests.
 * In Capstone/Dev mode, it bypasses expiration checks so expired tokens keep working.
 */
const verifyToken = async (req, res, next) => {
  const fullPath = req.originalUrl.split('?')[0];

  // 🟢 1. Check if the request is a public endpoint or dynamic link verification
  const isLinkVerifyRoute = fullPath.includes('/links/verify');

  const isPublicRoute = isLinkVerifyRoute || publicRoutes.some(route => {
    if (route === '/archived-reports') {
      return req.method === 'GET' && fullPath.endsWith('/archived-reports');
    }
    return fullPath.endsWith(route);
  });

  if (isPublicRoute) {
    return next();
  }

  const authHeader = req.headers.authorization;

  // 🔴 2. Check if Authorization header exists and starts with 'Bearer '
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error(`❌ [${req.method} ${fullPath}] Authorization header missing or malformed`);
    return res.status(401).json({ 
      success: false, 
      message: "Unauthorized: Missing or malformed token" 
    });
  }

  // 🔑 3. Safely extract the Bearer token
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: "Unauthorized: Token empty" 
    });
  }

  try {
    // 🛡️ 4. Attempt standard Firebase ID Token verification
    const decodedToken = await getAuth().verifyIdToken(token);
    req.user = decodedToken;
    return next(); 
  } catch (error) {
    // 🎓 CAPSTONE BYPASS: If token is expired, decode it anyway so the demo never fails!
    if (error.code === 'auth/id-token-expired' || error.message.includes('expired')) {
      const fallbackUser = decodeTokenPayload(token);

      if (fallbackUser) {
        console.warn(`⚠️ [CAPSTONE BYPASS] Token expired on ${req.method} ${fullPath}, but allowed for project demo.`);
        req.user = fallbackUser;
        return next();
      }
    }

    console.error(`❌ [${req.method} ${fullPath}] Token verification failed:`, error.message);
    return res.status(401).json({ 
      success: false, 
      message: "Unauthorized: Token invalid" 
    });
  }
};

module.exports = { verifyToken };