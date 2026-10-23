const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../db');
const { sanitizeAndValidateUgandaPhone } = require('../paymentGateway');
const emailService = require('../services/emailService');

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'kola_express_secret_jwt_key_2026') {
  if (!global.__KOLA_EPHEMERAL_JWT_SECRET) {
    global.__KOLA_EPHEMERAL_JWT_SECRET = crypto.randomBytes(32).toString('hex');
  }
  JWT_SECRET = global.__KOLA_EPHEMERAL_JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    console.warn('[SECURITY NOTICE] Production environment: Using high-entropy dynamic JWT_SECRET. For persistent login sessions across restarts, configure JWT_SECRET in Hostinger settings.');
  }
}

const LEGACY_JWT_SECRET = 'kola_express_secret_jwt_key_2026';

// Helper to verify tokens with backward compatibility for sessions signed prior to key rotation
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    if (JWT_SECRET !== LEGACY_JWT_SECRET) {
      try {
        return jwt.verify(token, LEGACY_JWT_SECRET);
      } catch (_) {}
    }
    throw err;
  }
}

// Middleware for authenticating requests
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  let decodedUser;
  try {
    decodedUser = verifyToken(token);
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  if (!decodedUser) return res.status(401).json({ error: 'Malformed authentication token' });

    // Look up user in database by ID, or fallback to phone / email
    let dbUser = null;
    if (decodedUser.id) {
      dbUser = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active, password_changed_at FROM users WHERE id = ?').get(decodedUser.id);
    }

    if (!dbUser && (decodedUser.phone || decodedUser.email)) {
      if (decodedUser.phone) {
        dbUser = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active, password_changed_at FROM users WHERE phone = ?').get(decodedUser.phone);
      }
      if (!dbUser && decodedUser.email) {
        dbUser = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active, password_changed_at FROM users WHERE LOWER(email) = LOWER(?)').get(decodedUser.email);
      }
    }

    // MANDATORY: If token user is not found in database, reject immediately
    if (!dbUser) {
      return res.status(401).json({ error: 'User account associated with this token was not found' });
    }

    // MANDATORY: If account is deactivated, reject immediately
    if (dbUser.is_active === 0 || dbUser.is_active === false) {
      return res.status(403).json({ error: 'Account has been deactivated. Please contact support.' });
    }

    // Invalidate existing sessions if password was rotated after token issuance
    if (dbUser.password_changed_at && decodedUser.iat) {
      const rawDate = String(dbUser.password_changed_at).trim();
      const isoDate = rawDate.includes('T') ? (rawDate.endsWith('Z') ? rawDate : rawDate + 'Z') : rawDate.replace(' ', 'T') + 'Z';
      const passwordChangedEpoch = Math.floor(new Date(isoDate).getTime() / 1000);
      if (decodedUser.iat < passwordChangedEpoch) {
        return res.status(401).json({ error: 'Session invalidated due to password rotation. Please log in again.' });
      }
    }

    // Enrich request with AUTHORITATIVE database user properties
    req.user = {
      ...decodedUser,
      id: dbUser.id,
      full_name: dbUser.full_name,
      phone: dbUser.phone,
      email: dbUser.email,
      role: dbUser.role,
      admin_role: dbUser.admin_role,
      is_active: dbUser.is_active
    };

    next();
}

// Middleware for Admin only (any administrative role)
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin' || req.user.is_active === 0) {
    return res.status(403).json({ error: 'Administrative authorization required' });
  }
  next();
}

// Middleware for Super Admin only (full access)
function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin' || (req.user.admin_role && req.user.admin_role !== 'super_admin') || req.user.is_active === 0) {
    return res.status(403).json({ error: 'Access Denied: Super Admin permission required for this action' });
  }
  next();
}

// Middleware for Operations Admin or Super Admin
function requireOpsOrSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin' || req.user.is_active === 0) {
    return res.status(403).json({ error: 'Administrative authorization required' });
  }
  const allowed = ['super_admin', 'operations_admin'];
  if (req.user.admin_role && !allowed.includes(req.user.admin_role)) {
    return res.status(403).json({ error: 'Access Denied: Operations Admin or Super Admin permission required' });
  }
  next();
}

// Middleware for Finance Admin or Super Admin
function requireFinanceOrSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin' || req.user.is_active === 0) {
    return res.status(403).json({ error: 'Administrative authorization required' });
  }
  const allowed = ['super_admin', 'finance_admin'];
  if (req.user.admin_role && !allowed.includes(req.user.admin_role)) {
    return res.status(403).json({ error: 'Access Denied: Finance Admin or Super Admin permission required' });
  }
  next();
}

// Middleware for Courier only
function requireCourier(req, res, next) {
  if (!req.user || (req.user.role !== 'courier' && req.user.role !== 'admin') || req.user.is_active === 0) {
    return res.status(403).json({ error: 'Courier access required' });
  }
  next();
}

// Register Customer (Email or Phone Number required)
router.post('/register', async (req, res) => {
  try {
    const { full_name, phone, email, identifier, password } = req.body;

    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }

    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Password is required (minimum 4 characters)' });
    }

    let contactPhone = (phone || '').trim();
    let contactEmail = (email || '').trim();
    const contactIdentifier = (identifier || '').trim();

    // If identifier was provided instead of separate fields, determine whether it's an email or a phone
    if (!contactPhone && !contactEmail && contactIdentifier) {
      if (contactIdentifier.includes('@')) {
        contactEmail = contactIdentifier;
      } else {
        contactPhone = contactIdentifier;
      }
    }

    if (!contactPhone && !contactEmail) {
      return res.status(400).json({ error: 'Please provide either an email address or a phone number to register' });
    }

    let validatedPhone = null;
    if (contactPhone) {
      const phoneCheck = sanitizeAndValidateUgandaPhone(contactPhone);
      if (!phoneCheck.valid) {
        return res.status(400).json({ error: phoneCheck.message });
      }
      validatedPhone = phoneCheck.formattedPhone;

      const existingPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(validatedPhone);
      if (existingPhone) {
        return res.status(400).json({ error: 'An account with this phone number already exists. Please log in.' });
      }
    }

    let validatedEmail = null;
    if (contactEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(contactEmail)) {
        return res.status(400).json({ error: 'Please enter a valid email address (e.g. name@example.com)' });
      }
      validatedEmail = contactEmail.toLowerCase();

      const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(validatedEmail);
      if (existingEmail) {
        return res.status(400).json({ error: 'An account with this email address already exists. Please log in.' });
      }
    }

    const password_hash = bcrypt.hashSync(password, 10);
    const initialVerified = validatedEmail ? 0 : 1;
    const result = db.prepare(`
      INSERT INTO users (full_name, phone, email, password_hash, role, email_verified)
      VALUES (?, ?, ?, ?, 'customer', ?)
    `).run(full_name.trim(), validatedPhone, validatedEmail, password_hash, initialVerified);

    const user = {
      id: result.lastInsertRowid,
      full_name: full_name.trim(),
      phone: validatedPhone,
      email: validatedEmail,
      role: 'customer',
      email_verified: Boolean(initialVerified)
    };

    // Immediately link all past deliveries associated with this customer phone so order history is preserved
    if (validatedPhone) {
      db.prepare(`
        UPDATE deliveries
        SET customer_id = ?
        WHERE sender_phone = ? AND (customer_id IS NULL OR customer_id != ?)
      `).run(user.id, validatedPhone, user.id);
    }

    // If user registered with email, automatically generate & send a 6-digit email verification code
    let emailVerificationSent = false;
    let emailPreviewUrl = null;
    if (validatedEmail) {
      try {
        const verifCode = Math.floor(100000 + Math.random() * 900000).toString();
        const verifExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        db.prepare(`
          INSERT INTO email_verifications (user_id, email, code, expires_at)
          VALUES (?, ?, ?, ?)
        `).run(user.id, validatedEmail, verifCode, verifExpiresAt);

        const emailResult = await emailService.sendEmailVerificationCode({
          to: validatedEmail,
          name: user.full_name,
          code: verifCode
        });
        emailVerificationSent = true;
        emailPreviewUrl = emailResult.previewUrl || null;
      } catch (mailErr) {
        console.warn('Initial verification email dispatch warning:', mailErr.message);
      }
    }

    // Sync newly registered user to PostgreSQL / Supabase if pool is configured
    try {
      const { getPgPool } = require('../supabase');
      const pool = getPgPool();
      if (pool) {
        pool.query(`
          INSERT INTO users (full_name, phone, email, password_hash, role)
          VALUES ($1, $2, $3, $4, 'customer')
          ON CONFLICT DO NOTHING
        `, [user.full_name, user.phone, user.email, password_hash]).catch(pgErr => {
          console.warn('Postgres user sync background notice:', pgErr.message);
        });
      }
    } catch (_) {}

    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({
      user,
      token,
      email_verification_sent: emailVerificationSent,
      email_preview_url: emailPreviewUrl
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Failed to create account: ' + err.message });
  }
});

// Login (Customer, Courier, or Admin)
router.post('/login', (req, res) => {
  try {
    const { identifier, phone, email, password } = req.body;
    const loginTarget = (identifier || phone || email || '').trim();

    if (!loginTarget || !password) {
      return res.status(400).json({ error: 'Phone/Email and password are required' });
    }

    const strippedTarget = loginTarget.replace(/[\s\-.()]/g, '');

    // Try finding by phone or email
    let user = db.prepare('SELECT * FROM users WHERE phone = ? OR phone = ? OR LOWER(email) = LOWER(?)').get(loginTarget, strippedTarget, loginTarget);

    // Also support formatted Uganda phone if applicable
    if (!user) {
      const pCheck = sanitizeAndValidateUgandaPhone(loginTarget);
      if (pCheck.valid) {
        user = db.prepare('SELECT * FROM users WHERE phone = ?').get(pCheck.formattedPhone);
      }
    }

    // Also support admin username / role lookup (admin, super_admin, ops, finance, full names)
    if (!user) {
      const lower = loginTarget.toLowerCase();
      let roleTarget = null;
      if (['admin', 'superadmin', 'super_admin', 'super admin', 'administrator', 'kola administrator'].includes(lower)) {
        roleTarget = 'super_admin';
      } else if (['ops', 'operations', 'operations_admin', 'operations admin', 'operations director'].includes(lower)) {
        roleTarget = 'operations_admin';
      } else if (['finance', 'finance_admin', 'finance admin', 'finance officer'].includes(lower)) {
        roleTarget = 'finance_admin';
      }

      if (roleTarget) {
        user = db.prepare("SELECT * FROM users WHERE admin_role = ? AND role = 'admin' ORDER BY id ASC LIMIT 1").get(roleTarget);
      } else {
        user = db.prepare("SELECT * FROM users WHERE LOWER(full_name) = LOWER(?) AND role = 'admin' LIMIT 1").get(loginTarget);
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials. Please check your phone/email/username.' });
    }

    const cleanPassword = typeof password === 'string' ? password : String(password);
    const valid = bcrypt.compareSync(cleanPassword, user.password_hash) || 
                  bcrypt.compareSync(cleanPassword.trim(), user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials. Password does not match.' });
    }

    if (user.is_active === 0) {
      return res.status(403).json({ error: 'This account has been deactivated. Please contact support.' });
    }

    // If courier, fetch courier profile info
    let courierInfo = null;
    if (user.role === 'courier') {
      courierInfo = db.prepare('SELECT * FROM couriers WHERE user_id = ?').get(user.id);
    }

    const payload = {
      id: user.id,
      full_name: user.full_name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      admin_role: user.admin_role || (user.role === 'admin' ? 'super_admin' : null),
      courier_id: courierInfo ? courierInfo.id : null,
      email_verified: Boolean(user.email_verified)
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      user: payload,
      courier: courierInfo,
      token
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// Current User Me
router.get('/me', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active, email_verified, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    user.email_verified = Boolean(user.email_verified);

    let courier = null;
    if (user.role === 'courier') {
      courier = db.prepare('SELECT * FROM couriers WHERE user_id = ?').get(user.id);
    }

    res.json({ user, courier });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve profile' });
  }
});

// ===================================================================
// EMAIL VERIFICATION (6-DIGIT CODE)
// ===================================================================

// Send / Resend Email Verification Code
router.post('/send-verification-code', async (req, res) => {
  try {
    let email = (req.body.email || req.body.identifier || '').trim().toLowerCase();

    // If email not provided in body, check auth header if available
    if (!email && req.headers['authorization']) {
      try {
        const token = req.headers['authorization'].split(' ')[1];
        const decoded = verifyToken(token);
        if (decoded && decoded.email) email = decoded.email.toLowerCase();
      } catch (_) {}
    }

    if (!email) {
      return res.status(400).json({ error: 'Please enter a registered email address to verify.' });
    }

    const user = db.prepare('SELECT id, full_name, email, email_verified FROM users WHERE LOWER(email) = ?').get(email);
    if (!user) {
      return res.status(404).json({ error: 'No account found with this email address.' });
    }

    if (user.email_verified === 1) {
      return res.json({ success: true, message: 'This email address is already verified.', already_verified: true });
    }

    // Generate 6-digit code server-side
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Clean up old unverified codes for this user
    db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND verified_at IS NULL').run(user.id);

    // Save code
    db.prepare(`
      INSERT INTO email_verifications (user_id, email, code, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(user.id, user.email, code, expiresAt);

    // Dispatch real email via SMTP
    const emailResult = await emailService.sendEmailVerificationCode({
      to: user.email,
      name: user.full_name,
      code
    });

    res.json({
      success: true,
      message: 'Verification code sent to your email.',
      masked_email: emailService.maskEmail(user.email),
      preview_url: emailResult.previewUrl || undefined,
      dev_code: (process.env.NODE_ENV !== 'production' ? code : undefined)
    });
  } catch (err) {
    console.error('Send verification code error:', err);
    res.status(500).json({ error: 'Failed to send verification code: ' + err.message });
  }
});

// Verify Email using 6-Digit Code
router.post('/verify-email', (req, res) => {
  try {
    let email = (req.body.email || req.body.identifier || '').trim().toLowerCase();
    const code = (req.body.code || '').trim();

    if (!code) {
      return res.status(400).json({ error: 'Please enter the 6-digit verification code.' });
    }

    // If email not provided in body, check auth header
    if (!email && req.headers['authorization']) {
      try {
        const token = req.headers['authorization'].split(' ')[1];
        const decoded = verifyToken(token);
        if (decoded && decoded.email) email = decoded.email.toLowerCase();
      } catch (_) {}
    }

    const nowIso = new Date().toISOString();
    let record = null;

    if (email) {
      record = db.prepare(`
        SELECT * FROM email_verifications
        WHERE LOWER(email) = ? AND code = ? AND verified_at IS NULL AND expires_at > ?
        ORDER BY id DESC LIMIT 1
      `).get(email, code, nowIso);
    } else {
      record = db.prepare(`
        SELECT * FROM email_verifications
        WHERE code = ? AND verified_at IS NULL AND expires_at > ?
        ORDER BY id DESC LIMIT 1
      `).get(code, nowIso);
    }

    if (!record) {
      return res.status(400).json({ error: 'Invalid or expired verification code. Please request a new code.' });
    }

    // Mark as verified
    db.prepare('UPDATE email_verifications SET verified_at = CURRENT_TIMESTAMP WHERE id = ?').run(record.id);
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(record.user_id);

    const user = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active, email_verified FROM users WHERE id = ?').get(record.user_id);
    if (user) {
      user.email_verified = Boolean(user.email_verified);
    }

    res.json({
      success: true,
      message: 'Email address verified successfully!',
      user
    });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Failed to verify email: ' + err.message });
  }
});

// ===================================================================
// PASSWORD RECOVERY / RESET (EMAIL PREFERRED)
// ===================================================================

// 1. Request Password Recovery Code
router.post('/forgot-password', async (req, res) => {
  try {
    const target = (req.body.email || req.body.identifier || req.body.phone || '').trim();

    if (!target) {
      return res.status(400).json({ error: 'Please enter your registered email address.' });
    }

    // Lookup user:
    // 1. By email
    let user = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active FROM users WHERE LOWER(email) = LOWER(?)').get(target);

    // 2. By phone
    if (!user) {
      user = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active FROM users WHERE phone = ?').get(target);
      if (!user) {
        const pCheck = sanitizeAndValidateUgandaPhone(target);
        if (pCheck.valid) {
          user = db.prepare('SELECT id, full_name, phone, email, role, admin_role, is_active FROM users WHERE phone = ?').get(pCheck.formattedPhone);
        }
      }
    }

    // 3. By admin role alias (admin, ops, finance)
    if (!user) {
      const lower = target.toLowerCase();
      let roleTarget = null;
      if (['admin', 'superadmin', 'super_admin', 'super admin'].includes(lower)) roleTarget = 'super_admin';
      else if (['ops', 'operations', 'operations_admin', 'operations admin'].includes(lower)) roleTarget = 'operations_admin';
      else if (['finance', 'finance_admin', 'finance admin'].includes(lower)) roleTarget = 'finance_admin';

      if (roleTarget) {
        user = db.prepare("SELECT id, full_name, phone, email, role, admin_role, is_active FROM users WHERE admin_role = ? AND role = 'admin' LIMIT 1").get(roleTarget);
      }
    }

    if (!user) {
      return res.status(404).json({
        error: 'No account found matching this email or phone number. Please check your credentials or create a new account.'
      });
    }

    if (user.is_active === 0) {
      return res.status(403).json({ error: 'This account has been deactivated. Please contact Kola Express support.' });
    }

    if (!user.email) {
      return res.status(400).json({
        error: 'This account does not have a registered email address. Password recovery is exclusively via email. Please contact support.'
      });
    }

    // Generate 6-digit verification code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    // Generate secure 32-byte hex token
    const token = crypto.randomBytes(32).toString('hex');

    // 15 minutes expiry
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Invalidate prior unused reset tokens for this user
    db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(user.id);

    // Save into password_resets table
    db.prepare(`
      INSERT INTO password_resets (user_id, email, token, code, expires_at, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.id, user.email, token, code, expiresAt, ipAddress);

    // Formulate 1-click reset link
    const host = req.headers.host || 'localhost:3000';
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const origin = req.headers.origin || `${proto}://${host}`;
    const resetLink = `${origin.replace(/\/$/, '')}/#reset-token=${token}`;

    // Send recovery email
    const emailResult = await emailService.sendPasswordRecoveryEmail({
      to: user.email,
      name: user.full_name,
      code,
      resetLink,
      token
    });

    const masked = emailService.maskEmail(user.email);

    res.json({
      success: true,
      message: 'Recovery verification code sent to your email.',
      masked_email: masked,
      expires_in_minutes: 15
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to initiate password recovery: ' + err.message });
  }
});

// 2. Verify Recovery Code or Token
router.post('/verify-reset-code', (req, res) => {
  try {
    const { token, code, identifier } = req.body;
    const cleanCode = (code || '').trim();

    if (!cleanCode && !token) {
      return res.status(400).json({ error: 'Verification code or reset token is required.' });
    }

    let resetRecord = null;
    const nowIso = new Date().toISOString();

    if (cleanCode && token) {
      // Both token and code supplied - must match both
      resetRecord = db.prepare(`
        SELECT pr.*, u.full_name 
        FROM password_resets pr
        JOIN users u ON u.id = pr.user_id
        WHERE pr.token = ? AND pr.code = ? AND pr.used_at IS NULL AND pr.expires_at > ?
      `).get(token, cleanCode, nowIso);
    } else if (cleanCode && identifier) {
      // Code and identifier (email or phone) supplied
      const idTrim = identifier.trim().toLowerCase();
      resetRecord = db.prepare(`
        SELECT pr.*, u.full_name 
        FROM password_resets pr
        JOIN users u ON u.id = pr.user_id
        WHERE pr.code = ? AND (LOWER(pr.email) = ? OR u.phone = ?) AND pr.used_at IS NULL AND pr.expires_at > ?
        ORDER BY pr.id DESC LIMIT 1
      `).get(cleanCode, idTrim, idTrim, nowIso);
    } else if (cleanCode) {
      // Code alone supplied
      resetRecord = db.prepare(`
        SELECT pr.*, u.full_name 
        FROM password_resets pr
        JOIN users u ON u.id = pr.user_id
        WHERE pr.code = ? AND pr.used_at IS NULL AND pr.expires_at > ?
        ORDER BY pr.id DESC LIMIT 1
      `).get(cleanCode, nowIso);
    } else if (token) {
      // Token alone supplied (e.g., 1-click link)
      resetRecord = db.prepare(`
        SELECT pr.*, u.full_name 
        FROM password_resets pr
        JOIN users u ON u.id = pr.user_id
        WHERE pr.token = ? AND pr.used_at IS NULL AND pr.expires_at > ?
      `).get(token, nowIso);
    }

    if (!resetRecord) {
      return res.status(400).json({
        error: 'Invalid or expired recovery code. Please check the code or request a new one.'
      });
    }

    res.json({
      success: true,
      valid: true,
      token: resetRecord.token,
      masked_email: emailService.maskEmail(resetRecord.email)
    });
  } catch (err) {
    console.error('Verify code error:', err);
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

// 3. Complete Password Reset
router.post('/reset-password', async (req, res) => {
  try {
    const { token, code, new_password } = req.body;

    if (!new_password || typeof new_password !== 'string' || new_password.trim().length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters long.' });
    }

    if (!token && !code) {
      return res.status(400).json({ error: 'Reset token or verification code is required.' });
    }

    const nowIso = new Date().toISOString();
    let resetRecord = null;

    const targetIdentifier = (req.body.identifier || req.body.email || '').trim().toLowerCase();

    if (token) {
      resetRecord = db.prepare(`
        SELECT pr.*, u.full_name, u.role, u.admin_role
        FROM password_resets pr
        JOIN users u ON u.id = pr.user_id
        WHERE pr.token = ? AND pr.used_at IS NULL AND pr.expires_at > ?
      `).get(token, nowIso);
    } else if (code && targetIdentifier) {
      resetRecord = db.prepare(`
        SELECT pr.*, u.full_name, u.role, u.admin_role
        FROM password_resets pr
        JOIN users u ON u.id = pr.user_id
        WHERE pr.code = ? AND (LOWER(pr.email) = ? OR u.phone = ?) AND pr.used_at IS NULL AND pr.expires_at > ?
        ORDER BY pr.id DESC LIMIT 1
      `).get(code.trim(), targetIdentifier, targetIdentifier, nowIso);
    } else if (code) {
      resetRecord = db.prepare(`
        SELECT pr.*, u.full_name, u.role, u.admin_role
        FROM password_resets pr
        JOIN users u ON u.id = pr.user_id
        WHERE pr.code = ? AND pr.used_at IS NULL AND pr.expires_at > ?
        ORDER BY pr.id DESC LIMIT 1
      `).get(code.trim(), nowIso);
    }

    if (!resetRecord) {
      return res.status(400).json({
        error: 'This password reset session has expired or is invalid. Please request a new recovery code.'
      });
    }

    const cleanPassword = new_password.trim();
    const password_hash = bcrypt.hashSync(cleanPassword, 10);

    // Update password in database
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, resetRecord.user_id);

    // Sync to PostgreSQL/Supabase if pool is configured
    try {
      const { getPgPool } = require('../supabase');
      const pool = getPgPool();
      if (pool) {
        pool.query('UPDATE users SET password_hash = $1 WHERE email = $2 OR id = $3', [password_hash, resetRecord.email, resetRecord.user_id]).catch(pgErr => {
          console.warn('Postgres password sync background notice:', pgErr.message);
        });
      }
    } catch (_) {}

    // Mark current reset token as used
    db.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(resetRecord.id);

    // Invalidate any other active reset tokens for this user
    db.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').run(resetRecord.user_id);

    // If admin, log to admin_logs
    if (resetRecord.role === 'admin') {
      db.prepare(`
        INSERT INTO admin_logs (admin_id, admin_name, admin_role, action, resource, details)
        VALUES (?, ?, ?, 'PASSWORD_RECOVERED', 'USERS', ?)
      `).run(resetRecord.user_id, resetRecord.full_name, resetRecord.admin_role || 'admin', `Password recovered via email verification (${resetRecord.email})`);
    }

    // Send confirmation security notification
    await emailService.sendPasswordChangedConfirmationEmail({
      to: resetRecord.email,
      name: resetRecord.full_name
    });

    res.json({
      success: true,
      message: 'Your password has been successfully reset! You can now log in with your new password.'
    });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password: ' + err.message });
  }
});

module.exports = {
  router,
  authenticateToken,
  verifyToken,
  requireAdmin,
  requireSuperAdmin,
  requireOpsOrSuperAdmin,
  requireFinanceOrSuperAdmin,
  requireCourier,
  JWT_SECRET
};
