'use strict';
/**
 * firebase-auth.js — Firebase Phone Auth for member login, with NO
 * firebase-admin dependency. The server verifies the Firebase ID token
 * itself: it fetches Google's public signing certs, caches them
 * (respecting Cache-Control max-age), verifies the RS256 signature with
 * built-in crypto, and checks aud / iss / exp / iat.
 *
 * All Firebase config comes from env vars (never hardcoded):
 *   FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID
 *
 * The client config (apiKey/authDomain/projectId) is public by design —
 * Firebase web keys are meant to be embedded in pages. The SECRET side
 * (token verification) happens here on the server.
 */

const crypto = require('crypto');

const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/** True when the server has everything it needs for phone login. */
function firebaseConfigured() {
  return !!(process.env.FIREBASE_API_KEY && process.env.FIREBASE_AUTH_DOMAIN && process.env.FIREBASE_PROJECT_ID);
}

/** Public client config, embedded into the login page. Safe to expose. */
function firebaseClientConfig() {
  return {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
  };
}

// ---------------------------------------------------------------- certs ---
let certCache = { certs: null, expiresAt: 0 };

/** Test hook: clear the in-memory cert cache. */
function _resetCertCache() {
  certCache = { certs: null, expiresAt: 0 };
}

async function fetchCerts(fetchImpl) {
  if (certCache.certs && Date.now() < certCache.expiresAt) return certCache.certs;
  const f = fetchImpl || fetch;
  const res = await f(CERT_URL);
  if (!res.ok) throw new Error('cert-fetch-failed');
  const certs = await res.json();
  let maxAge = 3600;
  const cc = (res.headers && res.headers.get && res.headers.get('cache-control')) || '';
  const m = /max-age=(\d+)/.exec(cc);
  if (m) maxAge = parseInt(m[1], 10);
  certCache = { certs, expiresAt: Date.now() + maxAge * 1000 };
  return certs;
}

function b64urlDecode(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Buffer.from(t, 'base64');
}

/**
 * Verify a Firebase ID token. Returns { uid, phone } where phone is the
 * E.164 phone number from the token claims (null when absent).
 * Throws an Error describing the failure. Options (for tests):
 *   { fetchImpl } — replacement fetch for the cert download (no network)
 *   { nowMs }     — override "now"
 */
async function verifyIdToken(idToken, opts = {}) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('firebase-not-configured');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('bad-token-format');
  const [hB64, pB64, sigB64] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(hB64).toString('utf8'));
    payload = JSON.parse(b64urlDecode(pB64).toString('utf8'));
  } catch {
    throw new Error('bad-token-format');
  }
  if (!header || header.alg !== 'RS256' || !header.kid) throw new Error('bad-token-header');
  const certs = await fetchCerts(opts.fetchImpl);
  const certPem = certs[header.kid];
  if (!certPem) throw new Error('unknown-kid');
  let sigOk = false;
  try {
    sigOk = crypto.verify('RSA-SHA256', Buffer.from(hB64 + '.' + pB64, 'utf8'), certPem, b64urlDecode(sigB64));
  } catch {
    sigOk = false;
  }
  if (!sigOk) throw new Error('bad-signature');
  const now = Math.floor((opts.nowMs || Date.now()) / 1000);
  if (payload.aud !== projectId) throw new Error('bad-audience');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('bad-issuer');
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('token-expired');
  if (typeof payload.iat !== 'number' || payload.iat > now + 300) throw new Error('bad-issued-at');
  if (!payload.sub) throw new Error('bad-subject');
  return {
    uid: String(payload.sub),
    phone: payload.phone_number ? String(payload.phone_number) : null,
  };
}

/**
 * Normalize a phone number typed by a member. US default: 10 digits get
 * +1, 11 digits starting with 1 get +. Anything else must already be E.164.
 * Returns the normalized string, or null when it doesn't look like a phone.
 */
function normalizePhone(raw) {
  const t = String(raw || '').trim();
  if (/^\+\d{7,15}$/.test(t)) return t;
  const digits = t.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

/**
 * Core phone-login flow (pure logic; the route in server.js is a thin
 * wrapper that creates the session cookie). Kept injectable for tests.
 *
 * verify — async (idToken) => { uid, phone }
 * Returns:
 *   { ok: true, user, isNew }            — log them in (create session)
 *   { ok: false, code: 'needs-name' }    — first login: ask for a display name
 *   { ok: false, code: 'invalid-token' }  — token didn't verify
 *   { ok: false, code: 'no-phone' }       — token has no phone_number claim
 */
async function phoneLoginFlow({ store, idToken, name, verify }) {
  const doVerify = verify || verifyIdToken;
  let claims;
  try {
    claims = await doVerify(idToken);
  } catch (e) {
    return { ok: false, code: 'invalid-token', detail: e.message };
  }
  if (!claims.phone) return { ok: false, code: 'no-phone' };
  let user = await store.findUserByPhone(claims.phone);
  let isNew = false;
  if (!user) {
    const cleanName = String(name || '').trim().slice(0, 40);
    if (!cleanName) return { ok: false, code: 'needs-name' };
    try {
      await store.createUser({
        username: claims.phone,
        phone: claims.phone,
        phoneVerified: true,
        name: cleanName,
        role: 'member',
      });
    } catch (e) {
      // Lost a race with another first-login for the same number — use it.
      if (e.message !== 'username-taken' && e.message !== 'email-taken' && e.message !== 'phone-taken') throw e;
    }
    user = await store.findUserByPhone(claims.phone);
    if (!user) return { ok: false, code: 'invalid-token', detail: 'user-create-failed' };
    isNew = true;
  }
  return { ok: true, user, isNew };
}

module.exports = {
  firebaseConfigured,
  firebaseClientConfig,
  verifyIdToken,
  normalizePhone,
  phoneLoginFlow,
  _resetCertCache,
};
