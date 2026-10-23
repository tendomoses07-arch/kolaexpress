#!/usr/bin/env node
/**
 * Kola Express — Secure Administrator Password Rotation Utility
 *
 * Rotates passwords for:
 * - admin@kolaexpress.ug (Super Admin, ID 1)
 * - ops@kolaexpress.ug (Operations Admin, ID 12)
 * - finance@kolaexpress.ug (Finance Admin, ID 13)
 *
 * Rules:
 * - Cryptographically secure random generation (32 characters, crypto.randomInt)
 * - bcryptjs hash with established salt rounds (10)
 * - Atomic transaction with verification and rollback
 * - Zero plaintext exposure in terminal logs, version control, or git
 * - Invalidates pre-existing sessions via password_changed_at timestamp
 * - Credentials written to local protected vault: server/.admin_credentials.vault
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Load environment
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { db, initDatabase } = require('../db');

// Ensure database schema is initialized
initDatabase();

const TARGET_ADMINS = [
  {
    email: 'admin@kolaexpress.ug',
    role: 'admin',
    admin_role: 'super_admin',
    defaultPassword: 'admin123'
  },
  {
    email: 'ops@kolaexpress.ug',
    role: 'admin',
    admin_role: 'operations_admin',
    defaultPassword: 'ops123'
  },
  {
    email: 'finance@kolaexpress.ug',
    role: 'admin',
    admin_role: 'finance_admin',
    defaultPassword: 'finance123'
  }
];

// Generates a cryptographically strong 32-character password
function generateSecurePassword(length = 32) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*(-_=+)';
  const allChars = upper + lower + digits + symbols;

  let pwd = '';
  // Ensure at least one from each pool
  pwd += upper[crypto.randomInt(0, upper.length)];
  pwd += lower[crypto.randomInt(0, lower.length)];
  pwd += digits[crypto.randomInt(0, digits.length)];
  pwd += symbols[crypto.randomInt(0, symbols.length)];

  for (let i = pwd.length; i < length; i++) {
    pwd += allChars[crypto.randomInt(0, allChars.length)];
  }

  // Shuffle securely
  const arr = pwd.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr.join('');
}

function rotateAdminPasswords(customCredentials = null) {
  console.log('=================================================================');
  console.log('🛡️ KOLA EXPRESS — SECURE ADMINISTRATOR PASSWORD ROTATION');
  console.log('=================================================================\n');

  // 1. Verify existence of all three target administrator accounts
  console.log('Step 1: Inspecting existing administrator accounts...');
  const adminRecords = [];
  for (const target of TARGET_ADMINS) {
    const existing = db.prepare('SELECT id, full_name, email, phone, role, admin_role, is_active FROM users WHERE LOWER(email) = LOWER(?)').get(target.email);
    if (!existing) {
      throw new Error(`Target administrator account not found: ${target.email}`);
    }
    if (existing.role !== 'admin') {
      throw new Error(`Account ${target.email} does not have role 'admin' (found: ${existing.role})`);
    }
    adminRecords.push({ ...target, ...existing });
    console.log(`  ✓ Account Found: ID ${existing.id} | ${existing.email} | Role: ${existing.admin_role || 'admin'} | Active: ${existing.is_active}`);
  }

  // 2. Generate cryptographically secure passwords
  console.log('\nStep 2: Generating independent, high-entropy credentials (> 24 chars)...');
  const credentialMap = new Map();

  for (const admin of adminRecords) {
    let plainPassword;
    if (customCredentials && customCredentials[admin.email]) {
      plainPassword = customCredentials[admin.email];
      if (plainPassword.length < 24) {
        throw new Error(`Password for ${admin.email} must be at least 24 characters.`);
      }
    } else {
      plainPassword = generateSecurePassword(32);
    }

    const hash = bcrypt.hashSync(plainPassword, 10);
    credentialMap.set(admin.email, {
      id: admin.id,
      email: admin.email,
      admin_role: admin.admin_role,
      plainPassword,
      hash
    });
    console.log(`  ✓ Secure credential generated for: ${admin.email} (32 characters, cryptographic entropy)`);
  }

  // 3. Execute atomic transaction to update password hashes
  console.log('\nStep 3: Updating database hashes within atomic transaction...');

  const rotateTxn = db.transaction(() => {
    for (const admin of adminRecords) {
      const cred = credentialMap.get(admin.email);

      // Parameterized update to password_hash and password_changed_at
      const result = db.prepare(`
        UPDATE users
        SET password_hash = ?,
            password_changed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND role = 'admin'
      `).run(cred.hash, cred.id);

      if (result.changes !== 1) {
        throw new Error(`Failed to update password hash for ${admin.email}: expected 1 change, got ${result.changes}`);
      }

      // Verify in-transaction that new hash authenticates
      const updatedUser = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(cred.id);
      const isNewValid = bcrypt.compareSync(cred.plainPassword, updatedUser.password_hash);
      if (!isNewValid) {
        throw new Error(`Hash verification check failed for ${admin.email}`);
      }

      // Verify in-transaction that previous development-default password is REJECTED
      const isOldValid = bcrypt.compareSync(admin.defaultPassword, updatedUser.password_hash);
      if (isOldValid) {
        throw new Error(`Old default password still validated for ${admin.email}! Rollback triggered.`);
      }
    }
  });

  rotateTxn();
  console.log('  ✓ Transaction committed successfully: 3 accounts updated and verified.');

  // 4. Save credentials safely to local protected vault (excluded from git)
  console.log('\nStep 4: Securing credential delivery...');
  const vaultPath = path.resolve(__dirname, '../.admin_credentials.vault');
  const nowIso = new Date().toISOString();

  let vaultContent = `# KOLA EXPRESS — SECURE PRODUCTION ADMINISTRATOR CREDENTIALS VAULT\n`;
  vaultContent += `# Generated: ${nowIso}\n`;
  vaultContent += `# CONFIDENTIAL: This file is excluded from Git (.gitignore). Store these credentials in an access-controlled company password manager and shred this file.\n\n`;

  for (const admin of adminRecords) {
    const cred = credentialMap.get(admin.email);
    vaultContent += `Account: ${cred.email}\n`;
    vaultContent += `Role: ${cred.admin_role}\n`;
    vaultContent += `User ID: ${cred.id}\n`;
    vaultContent += `Password: ${cred.plainPassword}\n\n`;
  }

  fs.writeFileSync(vaultPath, vaultContent, { mode: 0o600 });

  const vaultHash = crypto.createHash('sha256').update(fs.readFileSync(vaultPath)).digest('hex');

  console.log(`  ✓ Credentials saved to local access-controlled vault file:`);
  console.log(`    File Location: ${vaultPath}`);
  console.log(`    File Permissions: 0600 (Owner Read/Write Only)`);
  console.log(`    SHA-256 Vault Checksum: ${vaultHash}`);
  console.log(`  ✓ ZERO plaintext passwords printed to console or logs.`);

  return {
    success: true,
    vaultPath,
    vaultHash,
    accountsUpdated: adminRecords.map(a => ({
      id: a.id,
      email: a.email,
      role: a.role,
      admin_role: a.admin_role,
      is_active: a.is_active
    }))
  };
}

if (require.main === module) {
  try {
    const result = rotateAdminPasswords();
    console.log('\n=================================================================');
    console.log('🎉 ADMINISTRATOR PASSWORD ROTATION COMPLETE');
    console.log('=================================================================\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Password rotation failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  rotateAdminPasswords,
  generateSecurePassword,
  TARGET_ADMINS
};
