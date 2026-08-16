const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

// 🔑 Import modular getAuth and getFirestore from firebase-admin
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const db = getFirestore();
const otpStore = new Map();

// 📧 Use explicit host, port 465, and secure: true
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, 
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Verify SMTP connection on server startup
transporter.verify((error) => {
  if (error) {
    console.error('❌ Super Admin Password Reset SMTP Verification Error:', error.message);
  } else {
    console.log('✅ Super Admin Password Reset SMTP Transporter ready');
  }
});

// 1. Send Super Admin Password Reset 6-Digit OTP
router.post('/send-superadmin-reset-otp', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, error: 'Email address is required' });
  }

  try {
    // 💡 Get Firebase Auth user
    const user = await getAuth().getUserByEmail(email);

    // 💡 Verify target account exists in 'superadmin' Firestore collection
    let isSuperAdmin = false;
    const docSnap = await db.collection('superadmin').doc(user.uid).get();

    if (docSnap.exists) {
      isSuperAdmin = true;
    } else {
      const querySnap = await db.collection('superadmin').where('uid', '==', user.uid).limit(1).get();
      if (!querySnap.empty) {
        isSuperAdmin = true;
      }
    }

    if (!isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'Access denied: Email address does not belong to a Super Admin account.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10-minute validity

    otpStore.set(email.toLowerCase(), { otp, expiresAt, uid: user.uid });

    const mailOptions = {
      from: `"AlertU System" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'AlertU Super Admin Password Reset Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 12px; background-color: #ffffff;">
          <h2 style="color: #0d47a1; text-align: center; margin-bottom: 8px;">Super Admin Password Reset</h2>
          <p style="color: #4a5568; font-size: 14px; text-align: center;">You requested to reset your Super Admin account password. Use the verification code below to proceed:</p>
          <div style="background-color: #f0f4f9; padding: 18px; border-radius: 10px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #0d47a1; margin: 24px 0;">
            ${otp}
          </div>
          <p style="color: #718096; font-size: 12px; text-align: center; margin: 0;">This code expires in 10 minutes. If you did not request this, please secure your account immediately.</p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    return res.status(200).json({ success: true, message: 'Verification code sent successfully' });

  } catch (error) {
    console.error('Error sending Super Admin reset OTP:', error);
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({ success: false, error: 'No account found with this email' });
    }
    return res.status(500).json({ success: false, error: 'Failed to send verification email' });
  }
});

// 2. Verify OTP & Update Firebase Password
router.post('/reset-superadmin-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ success: false, error: 'All fields are required' });
  }

  const record = otpStore.get(email.toLowerCase());

  if (!record) {
    return res.status(400).json({ success: false, error: 'No active code request found for this email' });
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(email.toLowerCase());
    return res.status(400).json({ success: false, error: 'Verification code has expired. Please request a new one.' });
  }

  if (record.otp !== otp.trim()) {
    return res.status(400).json({ success: false, error: 'Invalid verification code' });
  }

  try {
    // 💡 Update user password in Firebase Auth
    await getAuth().updateUser(record.uid, {
      password: newPassword,
    });

    otpStore.delete(email.toLowerCase());

    return res.status(200).json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Super Admin password reset update error:', error);
    return res.status(500).json({ success: false, error: 'Failed to update password' });
  }
});

module.exports = router;