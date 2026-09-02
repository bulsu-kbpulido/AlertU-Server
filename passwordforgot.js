const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const db = getFirestore();
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const OTP_TTL_MS = 10 * 60 * 1000;
const RESET_COOLDOWN_MS = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const hashOtp = (otp) =>
  crypto.createHash('sha256').update(String(otp)).digest('hex');

const providerErrorMessage = (error) => {
  const data = error?.response?.data;
  if (typeof data?.message === 'string') return data.message;
  if (typeof data?.code === 'string') return data.code;
  if (typeof error?.message === 'string') return error.message;
  return 'Unknown Brevo API error';
};

/**
 * Generates a password-reset OTP, sends it through Brevo over HTTPS,
 * and stores only the hashed OTP in Firestore.
 */
async function generateAndSendResetOTP(uid, recipientEmail) {
  const brevoApiKey = String(process.env.BREVO_API_KEY || '').trim();
  const senderEmail = normalizeEmail(process.env.BREVO_SENDER_EMAIL);
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
  const otpRef = db.collection('password_reset_otps').doc(uid);

  try {
    const response = await axios.post(
      BREVO_API_URL,
      {
        sender: {
          name: senderName,
          email: senderEmail,
        },
        to: [{ email: recipientEmail }],
        subject: 'Your AlertU Password Reset Code',
        htmlContent: `
          <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;border:1px solid #e0e0e0;border-radius:10px;">
            <h2 style="color:#0d47a1;text-align:center;">AlertU Password Reset</h2>
            <p style="color:#333;">You requested to reset your AlertU password. Enter the verification code below in the app:</p>
            <div style="background-color:#f0f4f9;padding:16px;border-radius:8px;text-align:center;font-size:32px;font-weight:bold;letter-spacing:8px;color:#0d47a1;margin:20px 0;">${otp}</div>
            <p style="color:#666;font-size:13px;">This code will expire in <strong>10 minutes</strong>. If you did not request this, you can ignore this email.</p>
          </div>
        `,
        textContent: `Your AlertU password reset code is ${otp}. It expires in 10 minutes. If you did not request this, ignore this email.`,
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

    console.log(`✅ Password-reset email accepted by Brevo for ${recipientEmail}. Message ID: ${messageId}`);
    return messageId;
  } catch (error) {
    console.error('❌ Brevo password-reset email error:', {
      status: error?.response?.status,
      data: error?.response?.data,
      message: error?.message,
    });

    try {
      await otpRef.delete();
    } catch (cleanupError) {
      console.error('⚠️ Failed to clean up password-reset OTP:', cleanupError.message);
    }

    throw new Error(`Brevo API Error: ${providerErrorMessage(error)}`);
  }
}

// =========================================================================
// 1. Send Password Reset OTP
// =========================================================================
const handleSendResetOtp = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'A valid email address is required.',
        error: 'A valid email address is required.',
      });
    }

    let user;
    try {
      user = await getAuth().getUserByEmail(email);
    } catch (authError) {
      if (authError.code === 'auth/user-not-found') {
        return res.status(404).json({
          success: false,
          message: 'No account found with this email address.',
          error: 'No account found with this email address.',
        });
      }
      throw authError;
    }

    const otpRef = db.collection('password_reset_otps').doc(user.uid);
    const existingDoc = await otpRef.get();

    if (existingDoc.exists) {
      const data = existingDoc.data() || {};
      if (data.createdAt && typeof data.createdAt.toDate === 'function') {
        const elapsed = Date.now() - data.createdAt.toDate().getTime();
        if (elapsed < RESET_COOLDOWN_MS) {
          return res.status(429).json({
            success: false,
            message: 'Please wait 60 seconds before requesting another reset code.',
            error: 'Please wait 60 seconds before requesting another reset code.',
          });
        }
      }
    }

    const messageId = await generateAndSendResetOTP(user.uid, email);

    return res.status(200).json({
      success: true,
      message: 'Password-reset code sent successfully.',
      messageId,
    });
  } catch (error) {
    console.error('❌ Error sending password-reset OTP:', error);
    const message = error?.message || 'Failed to send password-reset email.';
    return res.status(502).json({
      success: false,
      message,
      error: message,
    });
  }
};

// =========================================================================
// 2. Verify OTP and Reset Firebase Password
// =========================================================================
const handleResetPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (!email || !isValidEmail(email) || !/^\d{6}$/.test(otp) || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'A valid email, 6-digit code, and password of at least 6 characters are required.',
        error: 'Invalid password-reset fields.',
      });
    }

    let user;
    try {
      user = await getAuth().getUserByEmail(email);
    } catch (authError) {
      return res.status(404).json({
        success: false,
        message: 'No account found with this email address.',
        error: 'No account found with this email address.',
      });
    }

    const otpRef = db.collection('password_reset_otps').doc(user.uid);
    const otpSnap = await otpRef.get();

    if (!otpSnap.exists) {
      return res.status(400).json({
        success: false,
        message: 'No active reset-code request found for this email.',
        error: 'No active reset-code request found for this email.',
      });
    }

    const data = otpSnap.data() || {};
    const attempts = Number(data.attempts || 0);

    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await otpRef.delete();
      return res.status(429).json({
        success: false,
        message: 'Too many incorrect attempts. Please request a new code.',
        error: 'Too many incorrect attempts.',
      });
    }

    if (data.expiresAt && typeof data.expiresAt.toDate === 'function' && Date.now() > data.expiresAt.toDate().getTime()) {
      await otpRef.delete();
      return res.status(400).json({
        success: false,
        message: 'Password-reset code has expired. Please request a new one.',
        error: 'Password-reset code has expired.',
      });
    }

    const expectedHash = Buffer.from(String(data.hashedOtp || ''), 'utf8');
    const actualHash = Buffer.from(hashOtp(otp), 'utf8');
    const hashesMatch = expectedHash.length === actualHash.length && crypto.timingSafeEqual(expectedHash, actualHash);

    if (!hashesMatch) {
      await otpRef.update({ attempts: FieldValue.increment(1) });
      return res.status(400).json({
        success: false,
        message: 'Invalid password-reset code.',
        error: 'Invalid password-reset code.',
      });
    }

    await getAuth().updateUser(user.uid, {
      password: newPassword,
    });

    await otpRef.delete();

    return res.status(200).json({
      success: true,
      message: 'Password updated successfully.',
    });
  } catch (error) {
    console.error('❌ Error resetting password:', error);
    const message = error?.message || 'Failed to update password.';
    return res.status(500).json({
      success: false,
      message,
      error: message,
    });
  }
};

router.post('/send-reset-otp', handleSendResetOtp);
router.post('/reset-password', handleResetPassword);

module.exports = router;
