const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { Resend } = require('resend');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

const db = getFirestore();

// 🚀 Initialize Resend API client using Environment Variable
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Helper: Generate & Dispatch Admin Password Reset 6-Digit OTP via Resend
 */
async function generateAndSendAdminResetOTP(uid, email) {
  // 1. Generate 6-digit PIN
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  // 2. Hash OTP using SHA-256 for secure DB storage
  const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');

  // 3. Set expiration time (10 minutes)
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));

  // 4. Record in Firestore 'admin_password_reset_otps' collection
  await db.collection('admin_password_reset_otps').doc(uid).set({
    hashedOtp,
    email: email.toLowerCase(),
    expiresAt,
    createdAt: FieldValue.serverTimestamp(),
    attempts: 0,
  });

  // 5. Send Branded Admin Email via Resend HTTP API
  const response = await resend.emails.send({
    from: 'AlertU System <onboarding@resend.dev>',
    to: email,
    subject: 'AlertU Admin Password Reset Code',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #0d47a1; text-align: center;">Admin Password Reset</h2>
        <p style="color: #333;">You requested to reset your Admin account password. Use the verification code below in the app/dashboard:</p>
        <div style="background-color: #f0f4f9; padding: 16px; border-radius: 8px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #0d47a1; margin: 20px 0;">
          ${otp}
        </div>
        <p style="color: #666; font-size: 13px;">This code will expire in <strong>10 minutes</strong>. If you did not request this, please secure your account immediately.</p>
      </div>
    `,
  });

  if (response.error) {
    throw new Error(`Resend API Error: ${response.error.message}`);
  }

  console.log(`✅ Admin password reset OTP email sent via Resend to ${email} (ID: ${response.data.id})`);
}

// =========================================================================
// 1. Send Admin Password Reset OTP Endpoint
// =========================================================================
const handleSendAdminResetOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email address is required.',
        error: 'Email address is required'
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Fetch Firebase User record by Email
    let user;
    try {
      user = await getAuth().getUserByEmail(cleanEmail);
    } catch (authError) {
      if (authError.code === 'auth/user-not-found') {
        return res.status(404).json({ 
          success: false, 
          message: 'No account found with this email address.',
          error: 'No account found with this email'
        });
      }
      throw authError;
    }

    // 💡 Verify target account belongs to an Admin in Firestore
    let isAdmin = false;
    const docSnap = await db.collection('admins').doc(user.uid).get();

    if (docSnap.exists) {
      isAdmin = true;
    } else {
      const querySnap = await db.collection('admins').where('uid', '==', user.uid).limit(1).get();
      if (!querySnap.empty) {
        isAdmin = true;
      }
    }

    if (!isAdmin) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied: Email address does not belong to an Admin account.',
        error: 'Access denied: Email address does not belong to an Admin account.' 
      });
    }

    // Cooldown throttle check (60 seconds)
    const existingDoc = await db.collection('admin_password_reset_otps').doc(user.uid).get();
    if (existingDoc.exists) {
      const data = existingDoc.data();
      if (data && data.createdAt && typeof data.createdAt.toDate === 'function') {
        const lastSent = data.createdAt.toDate().getTime();
        if (Date.now() - lastSent < 60000) {
          return res.status(429).json({
            success: false,
            message: 'Please wait 60 seconds before requesting another reset code.',
            error: 'Please wait 60 seconds before requesting another reset code.'
          });
        }
      }
    }

    await generateAndSendAdminResetOTP(user.uid, cleanEmail);

    return res.status(200).json({
      success: true,
      message: 'Verification code sent successfully.',
    });
  } catch (error) {
    console.error('❌ Error sending Admin reset OTP:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send verification email.',
      error: 'Failed to send verification email'
    });
  }
};

// =========================================================================
// 2. Verify OTP & Reset Admin Firebase Password Endpoint
// =========================================================================
const handleResetAdminPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        message: 'All fields are required.',
        error: 'All fields are required'
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Fetch Firebase User to locate UID
    let user;
    try {
      user = await getAuth().getUserByEmail(cleanEmail);
    } catch (authError) {
      return res.status(404).json({ 
        success: false, 
        message: 'No account found with this email address.',
        error: 'No active code request found for this email'
      });
    }

    const docRef = db.collection('admin_password_reset_otps').doc(user.uid);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(400).json({
        success: false,
        message: 'No active code request found for this email.',
        error: 'No active code request found for this email'
      });
    }

    const data = docSnap.data();

    // 1. Check expiration
    if (data.expiresAt && Date.now() > data.expiresAt.toDate().getTime()) {
      await docRef.delete();
      return res.status(400).json({
        success: false,
        message: 'Verification code has expired. Please request a new one.',
        error: 'Verification code has expired. Please request a new one.'
      });
    }

    // 2. Hash input OTP and compare
    const inputHash = crypto.createHash('sha256').update(otp.toString().trim()).digest('hex');

    if (inputHash !== data.hashedOtp) {
      await docRef.update({ attempts: FieldValue.increment(1) });
      return res.status(400).json({
        success: false,
        message: 'Invalid verification code.',
        error: 'Invalid verification code'
      });
    }

    // 3. Update Password in Firebase Authentication
    await getAuth().updateUser(user.uid, {
      password: newPassword,
    });

    // 4. Clean up OTP document from Firestore
    await docRef.delete();

    return res.status(200).json({
      success: true,
      message: 'Password updated successfully',
    });
  } catch (error) {
    console.error('❌ Error resetting Admin password:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update password.',
      error: 'Failed to update password'
    });
  }
};

// Route definitions
router.post('/send-admin-reset-otp', handleSendAdminResetOtp);
router.post('/reset-admin-password', handleResetAdminPassword);

module.exports = router;
