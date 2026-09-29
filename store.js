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
    users: [], // {id, username, passHash, role, created_at}
    receipts: [], // {id, store, date, total, uploaded_by, uploaded_by_name, photo, created_at}
    items: [], // {id, receipt_id, name, name_raw, price}
    sessions: [], // {id, user_id, username, role, created_at}
    settings: { budget: 500, budgets: {} },
    // settings.budgets: { "2026-09": { base: 500, adjustments: [{amount, at, by}] } }
    // settings.budget is the legacy single global budget (fallback for old months).
    seq: { user: 1, receipt: 1, item: 1 },
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
  for (const k of ['users', 'receipts', 'items', 'sessions']) cache[k] = cache[k] || [];
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
   * Per-month budget: { base, added, total, adjustments, hasEntry }.
   * hasEntry is false when the month was never given a starting budget —
   * the dashboard then asks instead of silently using a default.
   * Old months without an entry fall back to the legacy global budget.
   */
  async getMonthBudget(month) {
    const db = loadCache();
    const e = db.settings.budgets[String(month)];
    if (!e) {
      const legacy = Number(db.settings.budget) || 0;
      return { base: legacy, added: 0, total: legacy, adjustments: [], hasEntry: false };
    }
    const adjustments = Array.isArray(e.adjustments) ? e.adjustments : [];
    const added = summary.round2(adjustments.reduce((s, a) => s + (Number(a.amount) || 0), 0));
    const base = Number(e.base) || 0;
    return { base, added, total: summary.round2(base + added), adjustments, hasEntry: true };
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
  /** Prefill for the "starting budget?" prompt: last month's base, else legacy, else 500. */
  async getBudgetPrefill(month) {
    const db = loadCache();
    const prev = db.settings.budgets[summary.prevMonth(String(month))];
    if (prev) return Number(prev.base) || 0;
    const legacy = Number(db.settings.budget);
    return legacy > 0 ? legacy : 500;
  },
  async createUser({ username, passHash, role }) {
    const db = loadCache();
    if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('username-taken');
    }
    const user = { id: nextId('user'), username, passHash, role: role || 'member', created_at: new Date().toISOString() };
    db.users.push(user);
    saveCache();
    return { id: user.id, username: user.username, role: user.role };
  },
  async findUserByUsername(username) {
    return loadCache().users.find((u) => u.username.toLowerCase() === String(username).toLowerCase()) || null;
  },
  async listUsers() {
    return loadCache().users.map((u) => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at }));
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
`;

const q = (text, params) => pool.query(text, params);
const mapUser = (r) => ({ id: String(r.id), username: r.username, role: r.role });

const pgBackend = {
  async getBudget() {
    const r = await q("SELECT value FROM settings WHERE key='budget'");
    return r.rows.length ? Number(r.rows[0].value) : 500;
  },
  async setBudget(n) {
    await q("INSERT INTO settings(key,value) VALUES('budget',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [String(n)]);
  },
  async getMonthBudget(month) {
    const r = await q('SELECT base, adjustments FROM budgets WHERE month=$1', [String(month)]);
    if (!r.rows.length) {
      const legacy = await pgBackend.getBudget();
      return { base: legacy, added: 0, total: legacy, adjustments: [], hasEntry: false };
    }
    const adjustments = Array.isArray(r.rows[0].adjustments) ? r.rows[0].adjustments : [];
    const added = summary.round2(adjustments.reduce((s, a) => s + (Number(a.amount) || 0), 0));
    const base = Number(r.rows[0].base) || 0;
    return { base, added, total: summary.round2(base + added), adjustments, hasEntry: true };
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
  async getBudgetPrefill(month) {
    const prev = await q('SELECT base FROM budgets WHERE month=$1', [summary.prevMonth(String(month))]);
    if (prev.rows.length) return Number(prev.rows[0].base) || 0;
    const legacy = await pgBackend.getBudget();
    return legacy > 0 ? legacy : 500;
  },
  async createUser({ username, passHash, role }) {
    try {
      const r = await q('INSERT INTO users(username, pass_hash, role) VALUES($1,$2,$3) RETURNING id, username, role', [username, passHash, role || 'member']);
      return mapUser(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw new Error('username-taken');
      throw e;
    }
  },
  async findUserByUsername(username) {
    const r = await q('SELECT id, username, pass_hash AS "passHash", role FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (!r.rows.length) return null;
    const u = r.rows[0];
    return { id: String(u.id), username: u.username, passHash: u.passHash, role: u.role };
  },
  async listUsers() {
    const r = await q('SELECT id, username, role, created_at FROM users ORDER BY username');
    return r.rows.map(mapUser);
  },
  async setUserPassword(id, passHash) {
    const r = await q('UPDATE users SET pass_hash=$1 WHERE id=$2', [passHash, Number(id)]);
    if (!r.rowCount) throw new Error('not-found');
  },
  async deleteUser(id) {
    await q('DELETE FROM users WHERE id=$1', [Number(id)]);
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
    const r = await q('INSERT INTO users(username, pass_hash, role) VALUES($1,$2,$3) RETURNING id', [u.username, u.passHash, u.role || 'member']);
    userMap[String(u.id)] = r.rows[0].id;
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
      'INSERT INTO budgets(month, base, adjustments) VALUES($1,$2,$3::jsonb) ON CONFLICT(month) DO NOTHING',
      [month, Number(e.base) || 0, JSON.stringify(Array.isArray(e.adjustments) ? e.adjustments : [])]
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
  addMonthFunds: (...a) => use().addMonthFunds(...a),
  getBudgetPrefill: (...a) => use().getBudgetPrefill(...a),
  createUser: (...a) => use().createUser(...a),
  findUserByUsername: (...a) => use().findUserByUsername(...a),
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
