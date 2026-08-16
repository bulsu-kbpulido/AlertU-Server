const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const db = getFirestore();

// 📧 Configure Explicit Nodemailer Transporter
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // Enforce direct SSL/TLS to prevent socket timeouts
  auth: {
    user: process.env.EMAIL_USER, 
    pass: process.env.EMAIL_PASS, // Requires 16-character Gmail App Password
  },
});

// Verify SMTP connection on server startup
transporter.verify((error) => {
  if (error) {
    console.error('❌ Nodemailer SMTP Verification Error:', error.message);
  } else {
    console.log('✅ Nodemailer SMTP Transporter ready to dispatch emails');
  }
});

/**
 * Helper: Generate & Dispatch 6-Digit OTP
 */
async function generateAndSendOTP(uid, email) {
  // 1. Generate 6-digit pin
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  // 2. Hash OTP using SHA-256 for secure DB storage
  const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');

  // 3. Set expiration time (10 minutes)
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));

  // 4. Record in Firestore 'otp_verifications' collection
  await db.collection('otp_verifications').doc(uid).set({
    hashedOtp,
    email,
    expiresAt,
    createdAt: FieldValue.serverTimestamp(),
    attempts: 0,
  });

  // 5. Send Branded Email
  const mailOptions = {
    from: `"AlertU System" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Your AlertU Verification Code',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #0d47a1; text-align: center;">AlertU Identity Verification</h2>
        <p style="color: #333;">Your 6-digit security code is below. Enter this in your app to confirm your email address:</p>
        <div style="background-color: #f0f4f9; padding: 16px; border-radius: 8px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #0d47a1; margin: 20px 0;">
          ${otp}
        </div>
        <p style="color: #666; font-size: 13px;">This code will expire in <strong>10 minutes</strong>. Do not share this code with anyone.</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
}

// =========================================================================
// 1. Dispatch/Resend OTP Endpoint
// =========================================================================
router.post('/email-verification/send-otp', async (req, res) => {
  try {
    const { uid, email } = req.body;

    if (!uid || !email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required parameters (uid or email).' 
      });
    }

    // Cooldown throttle check (60 seconds)
    const existingDoc = await db.collection('otp_verifications').doc(uid).get();
    if (existingDoc.exists) {
      const data = existingDoc.data();
      
      // Guard against pending/unwritten server timestamps
      if (data && data.createdAt && typeof data.createdAt.toDate === 'function') {
        const lastSent = data.createdAt.toDate().getTime();
        const now = Date.now();
        if (now - lastSent < 60000) {
          return res.status(429).json({
            success: false,
            message: 'Please wait 60 seconds before requesting another code.',
          });
        }
      }
    }

    await generateAndSendOTP(uid, email);

    return res.json({
      success: true,
      message: 'Verification code sent successfully.',
    });
  } catch (error) {
    console.error('❌ Error sending OTP:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send verification code.',
      error: error.message,
    });
  }
});

// =========================================================================
// 2. Verify OTP Endpoint
// =========================================================================
router.post('/email-verification/verify-otp', async (req, res) => {
  try {
    const { uid, otp } = req.body;

    if (!uid || !otp) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required parameters (uid or otp).' 
      });
    }

    const docRef = db.collection('otp_verifications').doc(uid);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({
        success: false,
        message: 'No pending verification request found. Please request a new code.',
      });
    }

    const data = docSnap.data();

    // 1. Check expiration
    if (data.expiresAt && Date.now() > data.expiresAt.toDate().getTime()) {
      await docRef.delete();
      return res.status(400).json({
        success: false,
        message: 'Verification code has expired. Please request a new one.',
      });
    }

    // 2. Hash incoming input and compare with DB record
    const inputHash = crypto.createHash('sha256').update(otp.toString().trim()).digest('hex');

    if (inputHash !== data.hashedOtp) {
      await docRef.update({ attempts: FieldValue.increment(1) });
      return res.status(400).json({
        success: false,
        message: 'Incorrect verification code. Please check and try again.',
      });
    }

    // 3. Verification Successful! Update Citizen Record & Clean up
    await db.collection('citizens').doc(uid).set(
      {
        isEmailVerified: true,
        emailVerifiedAt: FieldValue.serverTimestamp(),
      },
      { merge: true } // Creates or updates fields safely
    );

    // Clean up OTP document
    await docRef.delete();

    return res.json({
      success: true,
      message: 'Email address verified successfully!',
    });
  } catch (error) {
    console.error('❌ Error verifying OTP:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process verification code.',
      error: error.message,
    });
  }
});

module.exports = router;