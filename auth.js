'use strict';
/**
 * auth.js — password hashing (scrypt, no dependencies) and session tokens.
 */
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, hash] = parts;
    const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch {
    return false;
  }
}

function newSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// ------------------------------------------------- self-signup (v2) ---
const GMAIL_RE = /^[A-Za-z0-9._%+-]+@gmail\.com$/i;

/**
 * Validate a self-signup form. Returns an error message string, or null
 * when everything is fine. Kept pure so it is easy to unit test.
 */
function validateSignup({ name, email, password, confirm }) {
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length > 40) {
    return 'Please enter your name (up to 40 characters).';
  }
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!GMAIL_RE.test(cleanEmail)) {
    return 'Please use a valid Gmail address (…@gmail.com).';
  }
  if (String(password || '').length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (password !== confirm) {
    return 'The two passwords do not match.';
  }
  return null;
}

/** Secure random email-verification token (hex). */
function newVerifyToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Verification links live for 24 hours. */
function verifyTokenExpiry() {
  return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
}

/**
 * Login gate: accounts created before email verification existed have no
 * email_verified field and keep working. Only an explicit `false` blocks.
 */
function loginAllowed(member) {
  if (!member) return false;
  return member.email_verified !== false;
}

module.exports = { hashPassword, verifyPassword, newSessionId, validateSignup, newVerifyToken, verifyTokenExpiry, loginAllowed };
