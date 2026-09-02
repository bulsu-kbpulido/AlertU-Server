const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const db = getFirestore();
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

const cleanEmail = (value) => String(value || '').trim().toLowerCase();

const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const hashOtp = (otp) =>
  crypto.createHash('sha256').update(String(otp)).digest('hex');

const safeProviderMessage = (error) => {
  const providerData = error?.response?.data;
  if (typeof providerData?.message === 'string') return providerData.message;
  if (typeof providerData?.code === 'string') return providerData.code;
  if (typeof error?.message === 'string') return error.message;
  return 'Unknown Brevo API error';
};

/**
 * Require a valid Firebase ID token and prevent a client from using another UID.
 */
const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: missing Firebase ID token.',
    });
  }

  const idToken = authHeader.substring('Bearer '.length).trim();
  if (!idToken) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: empty Firebase ID token.',
    });
  }

  try {
    req.user = await getAuth().verifyIdToken(idToken);
    next();
  } catch (error) {
    console.error('❌ Email verification token failure:', error.message);
    return res.status(403).json({
      success: false,
      message: 'Unauthorized: invalid or expired Firebase session.',
    });
  }
};

/**
 * Generate an OTP, send it through Brevo's HTTPS API, and persist only its hash.
 */
async function generateAndSendOTP(uid, recipientEmail) {
  const brevoApiKey = String(process.env.BREVO_API_KEY || '').trim();
  const senderEmail = cleanEmail(process.env.BREVO_SENDER_EMAIL);
  const senderName = String(process.env.BREVO_SENDER_NAME || 'AlertU System').trim();

  if (!brevoApiKey) {
    throw new Error('BREVO_API_KEY is missing on the backend.');
  }

  if (!senderEmail || !isValidEmail(senderEmail)) {
    throw new Error('BREVO_SENDER_EMAIL is missing or invalid on the backend.');
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  const hashedOtp = hashOtp(otp);
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + OTP_TTL_MS));
  const otpRef = db.collection('otp_verifications').doc(uid);

  try {
    const response = await axios.post(
      BREVO_API_URL,
      {
        sender: {
          name: senderName,
          email: senderEmail,
        },
        to: [{ email: recipientEmail }],
        subject: 'Your AlertU Verification Code',
        htmlContent: `
          <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;border:1px solid #e0e0e0;border-radius:10px;">
            <h2 style="color:#0d47a1;text-align:center;">AlertU Identity Verification</h2>
            <p style="color:#333;">Your 6-digit security code is below. Enter it in the AlertU app to confirm your email address:</p>
            <div style="background-color:#f0f4f9;padding:16px;border-radius:8px;text-align:center;font-size:32px;font-weight:bold;letter-spacing:8px;color:#0d47a1;margin:20px 0;">${otp}</div>
            <p style="color:#666;font-size:13px;">This code will expire in <strong>10 minutes</strong>. Do not share this code with anyone.</p>
          </div>
        `,
        textContent: `Your AlertU verification code is ${otp}. It expires in 10 minutes. Do not share this code with anyone.`,
      },
      {
        timeout: 20000,
        headers: {
          accept: 'application/json',
          'api-key': brevoApiKey,
          'content-type': 'application/json',
        },
      }
    );

    const messageId = response.data?.messageId;
    if (!messageId) {
      throw new Error('Brevo returned no messageId.');
    }

    await otpRef.set({
      hashedOtp,
      email: recipientEmail,
      expiresAt,
      createdAt: FieldValue.serverTimestamp(),
      attempts: 0,
      provider: 'brevo',
      providerMessageId: messageId,
    });

    console.log(`✅ Verification email accepted by Brevo for ${recipientEmail}. Message ID: ${messageId}`);
    return messageId;
  } catch (error) {
    console.error('❌ Brevo verification-email error:', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });

    // Do not leave an old or unusable OTP after a failed delivery attempt.
    try {
      await otpRef.delete();
    } catch (cleanupError) {
      console.error('⚠️ Failed to clean up OTP after Brevo failure:', cleanupError.message);
    }

    throw new Error(`Brevo API Error: ${safeProviderMessage(error)}`);
  }
}

const handleSendOtp = async (req, res) => {
  try {
    const uid = String(req.body?.uid || '').trim();
    const email = cleanEmail(req.body?.email);

    if (!uid || !email) {
      return res.status(400).json({
        success: false,
        message: 'Both uid and email are required.',
      });
    }

    if (req.user.uid !== uid) {
      return res.status(403).json({
        success: false,
        message: 'The Firebase user does not match the requested account.',
      });
    }

    if (req.user.email && cleanEmail(req.user.email) !== email) {
      return res.status(400).json({
        success: false,
        message: 'The email does not match the authenticated Firebase account.',
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'A valid email address is required.',
      });
    }

    const otpRef = db.collection('otp_verifications').doc(uid);
    const existingDoc = await otpRef.get();

    if (existingDoc.exists) {
      const data = existingDoc.data() || {};
      if (data.createdAt && typeof data.createdAt.toDate === 'function') {
        const elapsed = Date.now() - data.createdAt.toDate().getTime();
        if (elapsed < RESEND_COOLDOWN_MS) {
          return res.status(429).json({
            success: false,
            message: 'Please wait 60 seconds before requesting another code.',
          });
        }
      }
    }

    const messageId = await generateAndSendOTP(uid, email);

    return res.status(200).json({
      success: true,
      message: 'Verification code sent successfully.',
      messageId,
    });
  } catch (error) {
    console.error('❌ Error sending verification OTP:', error);
    const message = error?.message || 'Failed to send verification code.';
    return res.status(502).json({
      success: false,
      message,
      error: message,
    });
  }
};

const handleVerifyOtp = async (req, res) => {
  try {
    const uid = String(req.body?.uid || '').trim();
    const email = cleanEmail(req.body?.email);
    const otp = String(req.body?.otp || '').trim();

    if (!uid || !email || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: 'uid, email, and a 6-digit otp are required.',
      });
    }

    if (req.user.uid !== uid || (req.user.email && cleanEmail(req.user.email) !== email)) {
      return res.status(403).json({
        success: false,
        message: 'The verification request does not match the authenticated account.',
      });
    }

    const otpRef = db.collection('otp_verifications').doc(uid);
    const otpSnap = await otpRef.get();

    if (!otpSnap.exists) {
      return res.status(404).json({
        success: false,
        message: 'No pending verification request found. Please request a new code.',
      });
    }

    const data = otpSnap.data() || {};
    const attempts = Number(data.attempts || 0);

    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await otpRef.delete();
      return res.status(429).json({
        success: false,
        message: 'Too many incorrect attempts. Please request a new code.',
      });
    }

    if (data.expiresAt && typeof data.expiresAt.toDate === 'function' && Date.now() > data.expiresAt.toDate().getTime()) {
      await otpRef.delete();
      return res.status(400).json({
        success: false,
        message: 'Verification code has expired. Please request a new one.',
      });
    }

    const expectedHash = Buffer.from(String(data.hashedOtp || ''), 'utf8');
    const actualHash = Buffer.from(hashOtp(otp), 'utf8');
    const hashesMatch = expectedHash.length === actualHash.length && crypto.timingSafeEqual(expectedHash, actualHash);

    if (!hashesMatch) {
      await otpRef.update({ attempts: FieldValue.increment(1) });
      return res.status(400).json({
        success: false,
        message: 'Incorrect verification code. Please check and try again.',
      });
    }

    await db.collection('citizens').doc(uid).set(
      {
        emailVerified: true,
        isEmailVerified: true,
        emailVerifiedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await otpRef.delete();

    return res.status(200).json({
      success: true,
      message: 'Email address verified successfully.',
    });
  } catch (error) {
    console.error('❌ Error verifying email OTP:', error);
    const message = error?.message || 'Failed to process verification code.';
    return res.status(500).json({
      success: false,
      message,
      error: message,
    });
  }
};

router.post('/send-otp', verifyFirebaseToken, handleSendOtp);
router.post('/verify-otp', verifyFirebaseToken, handleVerifyOtp);

module.exports = router;
