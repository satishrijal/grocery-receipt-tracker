'use strict';
/**
 * store.js — storage with two backends:
 *   - PostgreSQL when DATABASE_URL is set and reachable (Neon).
 *   - JSON file (data/data.json) otherwise.
 *
 * Same pattern as the Teen Patti Phase-3 store: on the first boot where
 * Postgres is reachable AND the JSON file already has data, the JSON data
 * is migrated into Postgres exactly once (the file is then renamed to
 * data.json.migrated so it never migrates twice).
 *
 * A bad or unreachable DATABASE_URL never crashes the server: we log it
 * and fall back to the JSON file.
 */

const fs = require('fs');
const path = require('path');
const summary = require('./summary'); // month helpers only (no cycle: summary requires nothing)

let DATA_DIR = path.join(__dirname, 'data');
function setDataDir(dir) {
  DATA_DIR = dir;
  cache = null; // tests point the store at a temp dir
}
const JSON_PATH = () => path.join(DATA_DIR, 'data.json');
const MIGRATED_PATH = () => path.join(DATA_DIR, 'data.json.migrated');

let pg = null;
try {
  pg = require('pg');
} catch (e) {
  console.warn('[store] pg module not installed — JSON storage only');
}

let pool = null;
let backend = null; // 'pg' | 'json'
let cache = null;

// ---------------------------------------------------------------- JSON ---
function blankDb() {
  return {
    users: [], // {id, username, passHash, role, email, name, email_verified, verification_token, verification_expires, house_id, created_at}
    houses: [], // {id, name, invite_code, created_by, created_at}
    receipts: [], // {id, store, date, total, uploaded_by, uploaded_by_name, photo, created_at}
    items: [], // {id, receipt_id, name, name_raw, price}
    sessions: [], // {id, user_id, username, role, created_at}
    settings: { budget: 500, budgets: {} },
    // settings.budgets: { "2026-09": { base, collection, adjustments: [{amount, at, by}], topups: [{user_id, username, amount, at}], lowBalanceNotified: [userId] } }
    // settings.budget is the legacy single global budget (fallback for old months).
    seq: { user: 1, receipt: 1, item: 1, house: 1 },
  };
}

function loadCache() {
  if (cache) return cache;
  const p = JSON_PATH();
  try {
    cache = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : blankDb();
  } catch (e) {
    console.warn('[store] data.json unreadable, starting fresh:', e.message);
    cache = blankDb();
  }
  cache.settings = cache.settings || { budget: 500, budgets: {} };
  cache.settings.budgets = cache.settings.budgets || {};
  cache.seq = cache.seq || { user: 1, receipt: 1, item: 1 };
  if (cache.seq.house == null) cache.seq.house = 1;
  for (const k of ['users', 'houses', 'receipts', 'items', 'sessions']) cache[k] = cache[k] || [];
  // Migration-tolerant: fill in v2 fields on old records.
  for (const u of cache.users) {
    if (u.email === undefined) u.email = null;
    if (u.name === undefined) u.name = null;
    if (u.verification_token === undefined) u.verification_token = null;
    if (u.verification_expires === undefined) u.verification_expires = null;
    if (u.house_id === undefined) u.house_id = null;
    // NOTE: email_verified is intentionally left alone — old accounts
    // (no email) have it undefined and must keep logging in.
  }
  for (const e of Object.values(cache.settings.budgets)) {
    if (!Array.isArray(e.topups)) e.topups = [];
    if (!Array.isArray(e.lowBalanceNotified)) e.lowBalanceNotified = [];
  }
  return cache;
}

function saveCache() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = JSON_PATH() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, JSON_PATH());
}

const nextId = (kind) => String(loadCache().seq[kind]++);
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const jsonBackend = {
  async getBudget() {
    return Number(loadCache().settings.budget) || 500;
  },
  async setBudget(n) {
    loadCache().settings.budget = n;
    saveCache();
  },
  /**
   * Per-month budget: { base, added, total, adjustments, hasEntry,
   *   collection, topups, lowBalanceNotified }.
   * hasEntry is false when the month was never given a starting budget —
   * the dashboard then asks instead of silently using a default.
   * Old months without an entry fall back to the legacy global budget.
   * collection is the house's monthly collection (v2); it falls back to
   * base, then the legacy budget, then 500.
   */
  async getMonthBudget(month) {
    const db = loadCache();
    const e = db.settings.budgets[String(month)];
    const legacy = Number(db.settings.budget) || 0;
    if (!e) {
      const collection = legacy > 0 ? legacy : 500;
      return { base: legacy, added: 0, total: legacy, adjustments: [], hasEntry: false, collection, topups: [], lowBalanceNotified: [] };
    }
    const adjustments = Array.isArray(e.adjustments) ? e.adjustments : [];
    const added = summary.round2(adjustments.reduce((s, a) => s + (Number(a.amount) || 0), 0));
    const base = Number(e.base) || 0;
    const collection = e.collection != null ? Number(e.collection) : (base || legacy || 500);
    const topups = Array.isArray(e.topups) ? e.topups : [];
    const lowBalanceNotified = Array.isArray(e.lowBalanceNotified) ? e.lowBalanceNotified : [];
    return { base, added, total: summary.round2(base + added), adjustments, hasEntry: true, collection, topups, lowBalanceNotified };
  },
  /** Set (or create) the month's starting budget. Never touches adjustments. */
  async setMonthBudgetBase(month, amount) {
    const db = loadCache();
    const key = String(month);
    const e = db.settings.budgets[key] || { base: 0, adjustments: [] };
    e.base = summary.round2(amount);
    if (!Array.isArray(e.adjustments)) e.adjustments = [];
    db.settings.budgets[key] = e;
    saveCache();
  },
  /** Record extra money added mid-month as its own entry (base is untouched). */
  async addMonthFunds(month, amount, by) {
    const db = loadCache();
    const key = String(month);
    const e = db.settings.budgets[key] || { base: 0, adjustments: [] };
    if (!Array.isArray(e.adjustments)) e.adjustments = [];
    e.adjustments.push({ amount: summary.round2(amount), at: new Date().toISOString(), by: String(by || '') });
    db.settings.budgets[key] = e;
    saveCache();
  },
  /**
   * Set the house's monthly collection (v2). base is kept in sync so the
   * legacy budget views keep working unchanged.
   */
  async setMonthCollection(month, amount) {
    const db = loadCache();
    const key = String(month);
    const e = db.settings.budgets[key] || { base: 0, adjustments: [] };
    e.base = summary.round2(amount);
    e.collection = summary.round2(amount);
    if (!Array.isArray(e.adjustments)) e.adjustments = [];
    if (!Array.isArray(e.topups)) e.topups = [];
    if (!Array.isArray(e.lowBalanceNotified)) e.lowBalanceNotified = [];
    db.settings.budgets[key] = e;
    saveCache();
  },
  /** A member tops up their own share mid-month; logged as its own entry. */
  async addMemberTopup(month, userId, username, amount) {
    const db = loadCache();
    const key = String(month);
    const e = db.settings.budgets[key] || { base: 0, adjustments: [] };
    if (!Array.isArray(e.topups)) e.topups = [];
    e.topups.push({
      user_id: String(userId), username: String(username || ''),
      amount: summary.round2(amount), at: new Date().toISOString(),
    });
    db.settings.budgets[key] = e;
    saveCache();
  },
  /**
   * Record that a member got their low-balance email this month.
   * Returns true when this is the first time (so the mail fires once).
   */
  async markLowBalanceNotified(month, userId) {
    const db = loadCache();
    const key = String(month);
    const e = db.settings.budgets[key] || { base: 0, adjustments: [] };
    if (!Array.isArray(e.lowBalanceNotified)) e.lowBalanceNotified = [];
    const id = String(userId);
    if (e.lowBalanceNotified.map(String).includes(id)) return false;
    e.lowBalanceNotified.push(id);
    db.settings.budgets[key] = e;
    saveCache();
    return true;
  },
  /** Prefill for the "starting budget?" prompt: last month's base, else legacy, else 500. */
  async getBudgetPrefill(month) {
    const db = loadCache();
    const prev = db.settings.budgets[summary.prevMonth(String(month))];
    if (prev) return Number(prev.base) || 0;
    const legacy = Number(db.settings.budget);
    return legacy > 0 ? legacy : 500;
  },
  async createUser({ username, passHash, role, email, name, emailVerified, verificationToken, verificationExpires }) {
    const db = loadCache();
    if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('username-taken');
    }
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    if (cleanEmail && db.users.some((u) => u.email && u.email.toLowerCase() === cleanEmail)) {
      throw new Error('email-taken');
    }
    const user = {
      id: nextId('user'), username, passHash, role: role || 'member',
      email: cleanEmail, name: name ? String(name).trim().slice(0, 40) : null,
      // email_verified stays undefined for old-style accounts so they keep logging in.
      email_verified: emailVerified === undefined ? undefined : !!emailVerified,
      verification_token: verificationToken || null,
      verification_expires: verificationExpires || null,
      house_id: null,
      created_at: new Date().toISOString(),
    };
    db.users.push(user);
    saveCache();
    return { id: user.id, username: user.username, role: user.role };
  },
  async findUserByUsername(username) {
    return loadCache().users.find((u) => u.username.toLowerCase() === String(username).toLowerCase()) || null;
  },
  async getUserById(id) {
    return loadCache().users.find((u) => u.id === String(id)) || null;
  },
  async findUserByEmail(email) {
    const clean = String(email || '').trim().toLowerCase();
    return loadCache().users.find((u) => u.email && u.email.toLowerCase() === clean) || null;
  },
  /** Finds by token only while it hasn't expired; expired tokens return null. */
  async findUserByVerificationToken(token) {
    if (!token) return null;
    const u = loadCache().users.find((x) => x.verification_token === String(token));
    if (!u) return null;
    if (!u.verification_expires || new Date(u.verification_expires).getTime() <= Date.now()) return null;
    return u;
  },
  async setVerificationToken(id, token, expires) {
    const u = loadCache().users.find((x) => x.id === String(id));
    if (!u) throw new Error('not-found');
    u.verification_token = token;
    u.verification_expires = expires;
    saveCache();
  },
  async verifyUser(id) {
    const u = loadCache().users.find((x) => x.id === String(id));
    if (!u) throw new Error('not-found');
    u.email_verified = true;
    u.verification_token = null;
    u.verification_expires = null;
    saveCache();
  },
  async setUserHouse(id, houseId) {
    const u = loadCache().users.find((x) => x.id === String(id));
    if (!u) throw new Error('not-found');
    u.house_id = houseId ? String(houseId) : null;
    saveCache();
  },
  // ------------------------------------------------------------- houses ---
  /** Short, unambiguous invite codes (no 0/O, 1/I/L lookalikes). */
  _newInviteCode(db) {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    } while (db.houses.some((h) => h.invite_code === code));
    return code;
  },
  async createHouse({ name, created_by }) {
    const db = loadCache();
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) throw new Error('name-required');
    const house = {
      id: 'h' + nextId('house'),
      name: clean,
      invite_code: jsonBackend._newInviteCode(db),
      created_by: created_by ? String(created_by) : null,
      created_at: new Date().toISOString(),
    };
    db.houses.push(house);
    saveCache();
    return { ...house };
  },
  async listHouses() {
    return loadCache().houses.map((h) => ({ ...h }));
  },
  async getHouse(id) {
    return loadCache().houses.find((h) => h.id === String(id)) || null;
  },
  async deleteHouse(id) {
    const db = loadCache();
    const hid = String(id);
    db.houses = db.houses.filter((h) => h.id !== hid);
    for (const u of db.users) if (u.house_id === hid) u.house_id = null;
    saveCache();
  },
  async joinHouse(userId, code) {
    const db = loadCache();
    const clean = String(code || '').trim().toUpperCase();
    const house = db.houses.find((h) => h.invite_code === clean);
    if (!house) throw new Error('bad-code');
    const u = db.users.find((x) => x.id === String(userId));
    if (!u) throw new Error('not-found');
    u.house_id = house.id;
    saveCache();
    return { ...house };
  },
  async leaveHouse(userId) {
    const u = loadCache().users.find((x) => x.id === String(userId));
    if (!u) throw new Error('not-found');
    u.house_id = null;
    saveCache();
  },
  async listHouseMembers(houseId) {
    return loadCache()
      .users.filter((u) => u.house_id === String(houseId))
      .sort((a, b) => String(a.username).localeCompare(String(b.username)))
      .map((u) => ({
        id: u.id, username: u.username, name: u.name, email: u.email,
        role: u.role, email_verified: u.email_verified, house_id: u.house_id,
        created_at: u.created_at,
      }));
  },
  async listUsers() {
    return loadCache().users.map((u) => ({
      id: u.id, username: u.username, role: u.role, created_at: u.created_at,
      email: u.email || null, name: u.name || null,
      email_verified: u.email_verified, house_id: u.house_id || null,
    }));
  },
  async setUserPassword(id, passHash) {
    const u = loadCache().users.find((x) => x.id === String(id));
    if (!u) throw new Error('not-found');
    u.passHash = passHash;
    saveCache();
  },
  async deleteUser(id) {
    const db = loadCache();
    db.users = db.users.filter((u) => u.id !== String(id));
    saveCache();
  },
  async createReceipt({ store, date, total, uploaded_by, uploaded_by_name, photo }) {
    const db = loadCache();
    const r = {
      id: nextId('receipt'), store, date, total,
      uploaded_by, uploaded_by_name, photo,
      created_at: new Date().toISOString(),
    };
    db.receipts.push(r);
    saveCache();
    return r;
  },
  async listReceipts() {
    return [...loadCache().receipts].sort(
      (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.id) - Number(a.id)
    );
  },
  async getReceipt(id) {
    return loadCache().receipts.find((r) => r.id === String(id)) || null;
  },
  async deleteReceipt(id) {
    const db = loadCache();
    const rid = String(id);
    db.receipts = db.receipts.filter((r) => r.id !== rid);
    db.items = db.items.filter((i) => String(i.receipt_id) !== rid);
    saveCache();
  },
  async addItems(receiptId, items) {
    const db = loadCache();
    for (const it of items) {
      db.items.push({
        id: nextId('item'),
        receipt_id: String(receiptId),
        name: it.name,
        name_raw: it.name_raw || it.name,
        price: Number(it.price) || 0,
      });
    }
    saveCache();
  },
  async getItemsForReceipts(ids) {
    const set = new Set(ids.map(String));
    const map = {};
    for (const it of loadCache().items) {
      if (set.has(String(it.receipt_id))) (map[String(it.receipt_id)] = map[String(it.receipt_id)] || []).push(it);
    }
    return map;
  },
  async createSession(s) {
    loadCache().sessions.push({ ...s, created_at: new Date().toISOString() });
    saveCache();
  },
  async getSession(id) {
    const s = loadCache().sessions.find((x) => x.id === id);
    if (!s) return null;
    if (Date.now() - new Date(s.created_at).getTime() > SESSION_TTL_MS) {
      await jsonBackend.deleteSession(id);
      return null;
    }
    return s;
  },
  async deleteSession(id) {
    const db = loadCache();
    db.sessions = db.sessions.filter((x) => x.id !== id);
    saveCache();
  },
};

// ------------------------------------------------------------ Postgres ---
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (LOWER(username));
-- v2 columns (idempotent so old databases upgrade in place)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS house_id TEXT;
CREATE TABLE IF NOT EXISTS houses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS receipts (
  id SERIAL PRIMARY KEY,
  store TEXT NOT NULL,
  date TEXT NOT NULL,
  total NUMERIC NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  uploaded_by_name TEXT,
  photo TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_raw TEXT,
  price NUMERIC NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budgets (
  month TEXT PRIMARY KEY,          -- "2026-09"
  base NUMERIC NOT NULL DEFAULT 0, -- starting budget for the month
  adjustments JSONB NOT NULL DEFAULT '[]' -- [{amount, at, by}] added mid-month
);
-- v2 columns (idempotent so old databases upgrade in place)
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS collection NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS topups JSONB NOT NULL DEFAULT '[]';
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS low_balance_notified JSONB NOT NULL DEFAULT '[]';
`;

const q = (text, params) => pool.query(text, params);
const mapUser = (r) => ({
  id: String(r.id), username: r.username, role: r.role,
  email: r.email || null, name: r.name || null,
  email_verified: r.email_verified === undefined ? undefined : r.email_verified,
  verification_token: r.verification_token || null,
  verification_expires: r.verification_expires || null,
  house_id: r.house_id || null,
  created_at: r.created_at,
});

const pgBackend = {
  async getBudget() {
    const r = await q("SELECT value FROM settings WHERE key='budget'");
    return r.rows.length ? Number(r.rows[0].value) : 500;
  },
  async setBudget(n) {
    await q("INSERT INTO settings(key,value) VALUES('budget',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [String(n)]);
  },
  async getMonthBudget(month) {
    const r = await q('SELECT base, collection, adjustments, topups, low_balance_notified FROM budgets WHERE month=$1', [String(month)]);
    const legacy = await pgBackend.getBudget();
    if (!r.rows.length) {
      const collection = legacy > 0 ? legacy : 500;
      return { base: legacy, added: 0, total: legacy, adjustments: [], hasEntry: false, collection, topups: [], lowBalanceNotified: [] };
    }
    const adjustments = Array.isArray(r.rows[0].adjustments) ? r.rows[0].adjustments : [];
    const added = summary.round2(adjustments.reduce((s, a) => s + (Number(a.amount) || 0), 0));
    const base = Number(r.rows[0].base) || 0;
    const collection = r.rows[0].collection != null ? Number(r.rows[0].collection) : (base || legacy || 500);
    const topups = Array.isArray(r.rows[0].topups) ? r.rows[0].topups : [];
    const lowBalanceNotified = Array.isArray(r.rows[0].low_balance_notified) ? r.rows[0].low_balance_notified : [];
    return { base, added, total: summary.round2(base + added), adjustments, hasEntry: true, collection, topups, lowBalanceNotified };
  },
  async setMonthBudgetBase(month, amount) {
    const n = summary.round2(amount);
    await q(
      "INSERT INTO budgets(month, base, adjustments) VALUES($1,$2,'[]') " +
      'ON CONFLICT(month) DO UPDATE SET base=EXCLUDED.base',
      [String(month), n]
    );
  },
  async addMonthFunds(month, amount, by) {
    const entry = { amount: summary.round2(amount), at: new Date().toISOString(), by: String(by || '') };
    const cur = await q('SELECT adjustments FROM budgets WHERE month=$1', [String(month)]);
    if (!cur.rows.length) {
      await q('INSERT INTO budgets(month, base, adjustments) VALUES($1, 0, $2::jsonb)', [String(month), JSON.stringify([entry])]);
    } else {
      const arr = Array.isArray(cur.rows[0].adjustments) ? cur.rows[0].adjustments : [];
      arr.push(entry);
      await q('UPDATE budgets SET adjustments=$1::jsonb WHERE month=$2', [JSON.stringify(arr), String(month)]);
    }
  },
  async setMonthCollection(month, amount) {
    const n = summary.round2(amount);
    await q(
      "INSERT INTO budgets(month, base, collection, adjustments) VALUES($1,$2,$2,'[]') " +
      'ON CONFLICT(month) DO UPDATE SET base=EXCLUDED.base, collection=EXCLUDED.collection',
      [String(month), n]
    );
  },
  async addMemberTopup(month, userId, username, amount) {
    const entry = { user_id: String(userId), username: String(username || ''), amount: summary.round2(amount), at: new Date().toISOString() };
    const cur = await q('SELECT topups FROM budgets WHERE month=$1', [String(month)]);
    if (!cur.rows.length) {
      await q('INSERT INTO budgets(month, base, topups) VALUES($1, 0, $2::jsonb)', [String(month), JSON.stringify([entry])]);
    } else {
      const arr = Array.isArray(cur.rows[0].topups) ? cur.rows[0].topups : [];
      arr.push(entry);
      await q('UPDATE budgets SET topups=$1::jsonb WHERE month=$2', [JSON.stringify(arr), String(month)]);
    }
  },
  async markLowBalanceNotified(month, userId) {
    const cur = await q('SELECT low_balance_notified FROM budgets WHERE month=$1', [String(month)]);
    if (!cur.rows.length) {
      await q('INSERT INTO budgets(month, base, low_balance_notified) VALUES($1, 0, $2::jsonb)', [String(month), JSON.stringify([String(userId)])]);
      return true;
    }
    const arr = Array.isArray(cur.rows[0].low_balance_notified) ? cur.rows[0].low_balance_notified : [];
    if (arr.map(String).includes(String(userId))) return false;
    arr.push(String(userId));
    await q('UPDATE budgets SET low_balance_notified=$1::jsonb WHERE month=$2', [JSON.stringify(arr), String(month)]);
    return true;
  },
  async getBudgetPrefill(month) {
    const prev = await q('SELECT base FROM budgets WHERE month=$1', [summary.prevMonth(String(month))]);
    if (prev.rows.length) return Number(prev.rows[0].base) || 0;
    const legacy = await pgBackend.getBudget();
    return legacy > 0 ? legacy : 500;
  },
  async createUser({ username, passHash, role, email, name, emailVerified, verificationToken, verificationExpires }) {
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;
    try {
      const r = await q(
        'INSERT INTO users(username, pass_hash, role, email, name, email_verified, verification_token, verification_expires) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, username, role',
        [username, passHash, role || 'member', cleanEmail, name ? String(name).trim().slice(0, 40) : null,
          emailVerified === undefined ? null : !!emailVerified, verificationToken || null,
          verificationExpires ? new Date(verificationExpires) : null]
      );
      return { id: String(r.rows[0].id), username: r.rows[0].username, role: r.rows[0].role };
    } catch (e) {
      if (e.code === '23505') {
        // Could be username or email uniqueness — report generically; the
        // server checks each field first for a precise message.
        throw new Error('username-taken');
      }
      throw e;
    }
  },
  async findUserByUsername(username) {
    const r = await q('SELECT id, username, pass_hash AS "passHash", role, email, name, email_verified, verification_token, verification_expires, house_id, created_at FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (!r.rows.length) return null;
    const u = r.rows[0];
    return { ...mapUser(u), passHash: u.passHash };
  },
  async getUserById(id) {
    const r = await q('SELECT id, username, pass_hash AS "passHash", role, email, name, email_verified, verification_token, verification_expires, house_id, created_at FROM users WHERE id=$1', [Number(id)]);
    if (!r.rows.length) return null;
    const u = r.rows[0];
    return { ...mapUser(u), passHash: u.passHash };
  },
  async findUserByEmail(email) {
    const r = await q('SELECT id, username, pass_hash AS "passHash", role, email, name, email_verified, verification_token, verification_expires, house_id, created_at FROM users WHERE LOWER(email)=LOWER($1)', [String(email || '').trim().toLowerCase()]);
    if (!r.rows.length) return null;
    const u = r.rows[0];
    return { ...mapUser(u), passHash: u.passHash };
  },
  async findUserByVerificationToken(token) {
    if (!token) return null;
    const r = await q('SELECT id, username, pass_hash AS "passHash", role, email, name, email_verified, verification_token, verification_expires, house_id, created_at FROM users WHERE verification_token=$1 AND verification_expires > now()', [String(token)]);
    if (!r.rows.length) return null;
    const u = r.rows[0];
    return { ...mapUser(u), passHash: u.passHash };
  },
  async setVerificationToken(id, token, expires) {
    await q('UPDATE users SET verification_token=$1, verification_expires=$2 WHERE id=$3', [token, expires ? new Date(expires) : null, Number(id)]);
  },
  async verifyUser(id) {
    await q('UPDATE users SET email_verified=TRUE, verification_token=NULL, verification_expires=NULL WHERE id=$1', [Number(id)]);
  },
  async setUserHouse(id, houseId) {
    await q('UPDATE users SET house_id=$1 WHERE id=$2', [houseId ? String(houseId) : null, Number(id)]);
  },
  async listUsers() {
    const r = await q('SELECT id, username, role, email, name, email_verified, house_id, created_at FROM users ORDER BY username');
    return r.rows.map(mapUser);
  },
  async setUserPassword(id, passHash) {
    const r = await q('UPDATE users SET pass_hash=$1 WHERE id=$2', [passHash, Number(id)]);
    if (!r.rowCount) throw new Error('not-found');
  },
  async deleteUser(id) {
    await q('DELETE FROM users WHERE id=$1', [Number(id)]);
  },
  // ------------------------------------------------------------- houses ---
  async _newInviteCode() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for (let tries = 0; tries < 50; tries++) {
      const code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
      const r = await q('SELECT 1 FROM houses WHERE invite_code=$1', [code]);
      if (!r.rows.length) return code;
    }
    throw new Error('code-generation-failed');
  },
  async createHouse({ name, created_by }) {
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) throw new Error('name-required');
    const id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const code = await pgBackend._newInviteCode();
    const r = await q('INSERT INTO houses(id, name, invite_code, created_by) VALUES($1,$2,$3,$4) RETURNING *', [id, clean, code, created_by ? String(created_by) : null]);
    return houseRow(r.rows[0]);
  },
  async listHouses() {
    const r = await q('SELECT * FROM houses ORDER BY created_at');
    return r.rows.map(houseRow);
  },
  async getHouse(id) {
    const r = await q('SELECT * FROM houses WHERE id=$1', [String(id)]);
    return r.rows.length ? houseRow(r.rows[0]) : null;
  },
  async deleteHouse(id) {
    const hid = String(id);
    await q('UPDATE users SET house_id=NULL WHERE house_id=$1', [hid]);
    await q('DELETE FROM houses WHERE id=$1', [hid]);
  },
  async joinHouse(userId, code) {
    const clean = String(code || '').trim().toUpperCase();
    const r = await q('SELECT * FROM houses WHERE invite_code=$1', [clean]);
    if (!r.rows.length) throw new Error('bad-code');
    await q('UPDATE users SET house_id=$1 WHERE id=$2', [r.rows[0].id, Number(userId)]);
    return houseRow(r.rows[0]);
  },
  async leaveHouse(userId) {
    await q('UPDATE users SET house_id=NULL WHERE id=$1', [Number(userId)]);
  },
  async listHouseMembers(houseId) {
    const r = await q('SELECT id, username, role, email, name, email_verified, house_id, created_at FROM users WHERE house_id=$1 ORDER BY username', [String(houseId)]);
    return r.rows.map(mapUser);
  },
  async createReceipt({ store, date, total, uploaded_by, uploaded_by_name, photo }) {
    const r = await q(
      'INSERT INTO receipts(store, date, total, uploaded_by, uploaded_by_name, photo) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [store, date, total, uploaded_by, uploaded_by_name, photo]
    );
    return rowToReceipt(r.rows[0]);
  },
  async listReceipts() {
    const r = await q('SELECT * FROM receipts ORDER BY date DESC, id DESC');
    return r.rows.map(rowToReceipt);
  },
  async getReceipt(id) {
    const r = await q('SELECT * FROM receipts WHERE id=$1', [Number(id)]);
    return r.rows.length ? rowToReceipt(r.rows[0]) : null;
  },
  async deleteReceipt(id) {
    await q('DELETE FROM receipts WHERE id=$1', [Number(id)]); // items cascade
  },
  async addItems(receiptId, items) {
    for (const it of items) {
      await q('INSERT INTO items(receipt_id, name, name_raw, price) VALUES($1,$2,$3,$4)', [Number(receiptId), it.name, it.name_raw || it.name, Number(it.price) || 0]);
    }
  },
  async getItemsForReceipts(ids) {
    if (!ids.length) return {};
    const r = await q('SELECT * FROM items WHERE receipt_id = ANY($1)', [ids.map(Number)]);
    const map = {};
    for (const it of r.rows) {
      const k = String(it.receipt_id);
      (map[k] = map[k] || []).push({ id: String(it.id), receipt_id: k, name: it.name, name_raw: it.name_raw, price: Number(it.price) });
    }
    return map;
  },
  async createSession(s) {
    await q('INSERT INTO sessions(id, user_id, username, role) VALUES($1,$2,$3,$4)', [s.id, s.user_id, s.username, s.role]);
  },
  async getSession(id) {
    const r = await q('SELECT * FROM sessions WHERE id=$1', [id]);
    if (!r.rows.length) return null;
    const s = r.rows[0];
    if (Date.now() - new Date(s.created_at).getTime() > SESSION_TTL_MS) {
      await pgBackend.deleteSession(id);
      return null;
    }
    return { id: s.id, user_id: s.user_id, username: s.username, role: s.role };
  },
  async deleteSession(id) {
    await q('DELETE FROM sessions WHERE id=$1', [id]);
  },
};

function rowToReceipt(r) {
  return {
    id: String(r.id), store: r.store, date: r.date, total: Number(r.total),
    uploaded_by: r.uploaded_by, uploaded_by_name: r.uploaded_by_name,
    photo: r.photo, created_at: r.created_at,
  };
}

function houseRow(r) {
  return {
    id: String(r.id), name: r.name, invite_code: r.invite_code,
    created_by: r.created_by, created_at: r.created_at,
  };
}

async function pgIsEmpty() {
  const u = await q('SELECT COUNT(*)::int AS c FROM users');
  const r = await q('SELECT COUNT(*)::int AS c FROM receipts');
  return u.rows[0].c === 0 && r.rows[0].c === 0;
}

/** One-time JSON -> Postgres migration. Never runs twice. */
async function maybeMigrate() {
  const jp = JSON_PATH();
  if (!fs.existsSync(jp) || fs.existsSync(MIGRATED_PATH())) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jp, 'utf8'));
  } catch {
    return;
  }
  const hasData = (data.users && data.users.length) || (data.receipts && data.receipts.length) ||
    (data.settings && data.settings.budgets && Object.keys(data.settings.budgets).length);
  if (!hasData) return;
  if (!(await pgIsEmpty())) {
    fs.renameSync(jp, MIGRATED_PATH()); // Postgres already has data; archive the file
    return;
  }
  console.log('[store] One-time migration: JSON -> PostgreSQL...');
  const userMap = {};
  for (const u of data.users || []) {
    const r = await q(
      'INSERT INTO users(username, pass_hash, role, email, name, email_verified, verification_token, verification_expires, house_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [u.username, u.passHash, u.role || 'member', u.email || null, u.name || null,
        u.email_verified === undefined ? null : !!u.email_verified,
        u.verification_token || null,
        u.verification_expires ? new Date(u.verification_expires) : null,
        u.house_id || null]
    );
    userMap[String(u.id)] = r.rows[0].id;
  }
  for (const h of data.houses || []) {
    await q(
      'INSERT INTO houses(id, name, invite_code, created_by) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
      [String(h.id), h.name, h.invite_code, h.created_by ? (userMap[String(h.created_by)] ? String(userMap[String(h.created_by)]) : h.created_by) : null]
    );
  }
  for (const rc of data.receipts || []) {
    const r = await q(
      'INSERT INTO receipts(store, date, total, uploaded_by, uploaded_by_name, photo) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [rc.store, rc.date, rc.total, userMap[String(rc.uploaded_by)] ? String(userMap[String(rc.uploaded_by)]) : rc.uploaded_by, rc.uploaded_by_name, rc.photo]
    );
    const newRid = r.rows[0].id;
    for (const it of (data.items || []).filter((i) => String(i.receipt_id) === String(rc.id))) {
      await q('INSERT INTO items(receipt_id, name, name_raw, price) VALUES($1,$2,$3,$4)', [newRid, it.name, it.name_raw, it.price]);
    }
  }
  if (data.settings && data.settings.budget != null) await pgBackend.setBudget(Number(data.settings.budget));
  for (const [month, e] of Object.entries((data.settings && data.settings.budgets) || {})) {
    await q(
      'INSERT INTO budgets(month, base, collection, adjustments, topups, low_balance_notified) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) ON CONFLICT(month) DO NOTHING',
      [month, Number(e.base) || 0,
        e.collection != null ? Number(e.collection) : (Number(e.base) || 0),
        JSON.stringify(Array.isArray(e.adjustments) ? e.adjustments : []),
        JSON.stringify(Array.isArray(e.topups) ? e.topups : []),
        JSON.stringify(Array.isArray(e.lowBalanceNotified) ? e.lowBalanceNotified : [])]
    );
  }
  fs.renameSync(jp, MIGRATED_PATH());
  console.log('[store] Migration complete.');
}

// ---------------------------------------------------------------- init ---
async function init() {
  const url = process.env.DATABASE_URL;
  if (url && pg) {
    try {
      pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000, max: 5 });
      await pool.query('SELECT 1');
      await pool.query(SCHEMA);
      await maybeMigrate();
      backend = 'pg';
      console.log('[store] Storage: PostgreSQL (DATABASE_URL is set)');
      return 'pg';
    } catch (e) {
      console.warn('[store] PostgreSQL not reachable (' + (e.message || e) + ') — falling back to JSON file storage');
      try {
        await pool.end();
      } catch (e2) { /* ignore */ }
      pool = null;
    }
  } else if (url && !pg) {
    console.warn('[store] DATABASE_URL is set but the pg module is missing — using JSON file storage');
  } else {
    console.log('[store] Storage: JSON file (DATABASE_URL is not set)');
  }
  loadCache();
  backend = 'json';
  return 'json';
}

function use() {
  return backend === 'pg' ? pgBackend : jsonBackend;
}

module.exports = {
  init,
  setDataDir,
  getBackend: () => backend,
  getBudget: (...a) => use().getBudget(...a),
  setBudget: (...a) => use().setBudget(...a),
  getMonthBudget: (...a) => use().getMonthBudget(...a),
  setMonthBudgetBase: (...a) => use().setMonthBudgetBase(...a),
  setMonthCollection: (...a) => use().setMonthCollection(...a),
  addMonthFunds: (...a) => use().addMonthFunds(...a),
  addMemberTopup: (...a) => use().addMemberTopup(...a),
  markLowBalanceNotified: (...a) => use().markLowBalanceNotified(...a),
  getBudgetPrefill: (...a) => use().getBudgetPrefill(...a),
  createUser: (...a) => use().createUser(...a),
  findUserByUsername: (...a) => use().findUserByUsername(...a),
  getUserById: (...a) => use().getUserById(...a),
  findUserByEmail: (...a) => use().findUserByEmail(...a),
  findUserByVerificationToken: (...a) => use().findUserByVerificationToken(...a),
  setVerificationToken: (...a) => use().setVerificationToken(...a),
  verifyUser: (...a) => use().verifyUser(...a),
  setUserHouse: (...a) => use().setUserHouse(...a),
  createHouse: (...a) => use().createHouse(...a),
  listHouses: (...a) => use().listHouses(...a),
  getHouse: (...a) => use().getHouse(...a),
  deleteHouse: (...a) => use().deleteHouse(...a),
  joinHouse: (...a) => use().joinHouse(...a),
  leaveHouse: (...a) => use().leaveHouse(...a),
  listHouseMembers: (...a) => use().listHouseMembers(...a),
  listUsers: (...a) => use().listUsers(...a),
  setUserPassword: (...a) => use().setUserPassword(...a),
  deleteUser: (...a) => use().deleteUser(...a),
  createReceipt: (...a) => use().createReceipt(...a),
  listReceipts: (...a) => use().listReceipts(...a),
  getReceipt: (...a) => use().getReceipt(...a),
  deleteReceipt: (...a) => use().deleteReceipt(...a),
  addItems: (...a) => use().addItems(...a),
  getItemsForReceipts: (...a) => use().getItemsForReceipts(...a),
  createSession: (...a) => use().createSession(...a),
  getSession: (...a) => use().getSession(...a),
  deleteSession: (...a) => use().deleteSession(...a),
};
