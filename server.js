'use strict';
/**
 * server.js — zero-dependency HTTP server (beyond pg + tesseract.js).
 * Routes, sessions, uploads, OCR, and form handling live here.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('./store');
const auth = require('./auth');
const parser = require('./parser');
const summary = require('./summary');
const views = require('./views');
const heic = require('./heic');
const { parseMultipart } = require('./multipart');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
  console.warn('⚠️  WARNING: ADMIN_USER / ADMIN_PASS are not set — using dev fallback (admin / admin123). Set real values in production!');
}

// ------------------------------------------------------------------ OCR ---
// tesseract.js is lazy-loaded so the server still boots (with manual entry)
// if the module is missing. OCR jobs run one at a time through a queue.
let Tesseract = null;
let tesseractMissing = false;
function getTesseract() {
  if (tesseractMissing) return null;
  if (!Tesseract) {
    try {
      Tesseract = require('tesseract.js');
    } catch (e) {
      tesseractMissing = true;
      console.warn('[ocr] tesseract.js not available — receipts will need manual entry:', e.message);
      return null;
    }
  }
  return Tesseract;
}
let ocrChain = Promise.resolve();
function ocrImage(buffer) {
  const job = ocrChain.then(() => runOcr(buffer));
  ocrChain = job.catch(() => {}); // keep the queue alive even if a job fails
  return job;
}
async function runOcr(buffer) {
  const T = getTesseract();
  if (!T) return '';
  try {
    const worker = await T.createWorker('eng');
    try {
      const { data } = await worker.recognize(buffer);
      return (data && data.text) || '';
    } finally {
      await worker.terminate();
    }
  } catch (e) {
    console.warn('[ocr] recognition failed:', e.message);
    return '';
  }
}

// ---------------------------------------------------------------- helpers ---
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readUrlEncoded(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('form-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
  });
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}
function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

async function getUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = await store.getSession(sid);
  if (!s) return null;
  return { id: s.user_id, username: s.username, role: s.role };
}

const CONTENT_TYPES = { '.css': 'text/css', '.js': 'application/javascript', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif' };

/** Re-render the current month's dashboard with a budget form error. */
async function sendBudgetError(res, user, isAdmin, message) {
  const month = summary.currentMonthKey();
  const receipts = await store.listReceipts();
  const itemsByReceipt = await store.getItemsForReceipts(receipts.map((r) => r.id));
  const mb = await store.getMonthBudget(month);
  const data = summary.summarizeMonth({
    receipts, itemsByReceipt, budget: mb.total, month, base: mb.base, added: mb.added,
  });
  data.budgetPrompt = summary.needsBudgetPrompt({ month, currentMonth: month, hasEntry: mb.hasEntry })
    ? { prefill: await store.getBudgetPrefill(month) } : null;
  data.budgetError = message;
  return sendHtml(res, views.dashboardPage({ user, isAdmin, month, data }));
}

function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!abs.startsWith(PUBLIC_DIR + path.sep) && abs !== PUBLIC_DIR) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  });
}

// ------------------------------------------------------------------ routes ---
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method;

  // Static assets (no auth needed for css/js; photos need auth — checked below)
  if (method === 'GET' && (pathname === '/style.css' || pathname === '/app.js')) {
    return serveStatic(req, res, pathname);
  }

  const user = await getUser(req);
  const isAdmin = user && user.role === 'admin';

  if (pathname === '/' ) return redirect(res, user ? '/app' : '/login');

  // ---- login / logout ----
  if (pathname === '/login') {
    if (user) return redirect(res, '/app');
    if (method === 'GET') return sendHtml(res, views.loginPage(''));
    if (method === 'POST') {
      const form = await readUrlEncoded(req);
      const username = (form.get('username') || '').trim();
      const password = form.get('password') || '';
      let login = null;
      if (username === ADMIN_USER && password === ADMIN_PASS) {
        login = { user_id: 'admin', username: ADMIN_USER, role: 'admin' };
      } else {
        const member = await store.findUserByUsername(username);
        if (member && auth.verifyPassword(password, member.passHash)) {
          login = { user_id: member.id, username: member.username, role: 'member' };
        }
      }
      if (!login) return sendHtml(res, views.loginPage('Wrong username or password.'), 401);
      const sid = auth.newSessionId();
      await store.createSession({ id: sid, ...login });
      setSessionCookie(res, sid);
      return redirect(res, '/app');
    }
  }
  if (pathname === '/logout' && method === 'POST') {
    const sid = parseCookies(req).sid;
    if (sid) await store.deleteSession(sid).catch(() => {});
    clearSessionCookie(res);
    return redirect(res, '/login');
  }

  if (!user) return redirect(res, '/login');

  // ---- receipt photos (auth required) ----
  if (method === 'GET' && pathname.startsWith('/uploads/')) {
    return serveStatic(req, res, pathname);
  }

  // ---- dashboard ----
  if (pathname === '/app' && method === 'GET') {
    let month = url.searchParams.get('month') || summary.currentMonthKey();
    if (!/^\d{4}-\d{2}$/.test(month)) month = summary.currentMonthKey();
    const receipts = await store.listReceipts();
    const itemsByReceipt = await store.getItemsForReceipts(receipts.map((r) => r.id));
    const mb = await store.getMonthBudget(month);
    const data = summary.summarizeMonth({
      receipts, itemsByReceipt, budget: mb.total, month, base: mb.base, added: mb.added,
    });
    data.budgetPrompt = summary.needsBudgetPrompt({
      month, currentMonth: summary.currentMonthKey(), hasEntry: mb.hasEntry,
    }) ? { prefill: await store.getBudgetPrefill(month) } : null;
    return sendHtml(res, views.dashboardPage({ user, isAdmin, month, data }));
  }

  // ---- set this month's starting budget (any logged-in user) ----
  if (pathname === '/budget/start' && method === 'POST') {
    const form = await readUrlEncoded(req);
    const amount = Math.round((parseFloat(form.get('amount')) || 0) * 100) / 100;
    if (!(amount > 0) || amount > 1000000) {
      return sendBudgetError(res, user, isAdmin, 'Enter a valid starting amount.');
    }
    await store.setMonthBudgetBase(summary.currentMonthKey(), amount);
    return redirect(res, '/app');
  }

  // ---- add money mid-month (any logged-in user; recorded as its own entry) ----
  if (pathname === '/budget/add' && method === 'POST') {
    const form = await readUrlEncoded(req);
    const amount = Math.round((parseFloat(form.get('amount')) || 0) * 100) / 100;
    if (!(amount > 0) || amount > 1000000) {
      return sendBudgetError(res, user, isAdmin, 'Enter a valid amount to add.');
    }
    await store.addMonthFunds(summary.currentMonthKey(), amount, user.username);
    return redirect(res, '/app');
  }

  // ---- upload form ----
  if (pathname === '/upload' && method === 'GET') {
    return sendHtml(res, views.uploadPage(user, isAdmin, ''));
  }

  // ---- upload + OCR -> review screen ----
  if (pathname === '/upload' && method === 'POST') {
    let parts;
    try {
      parts = await parseMultipart(req, { maxBytes: 12 * 1024 * 1024 });
    } catch (e) {
      const msg = e.message === 'upload-too-large' ? 'That photo is too large (max ~12 MB).' : 'Upload failed — please try again.';
      return sendHtml(res, views.uploadPage(user, isAdmin, msg), 400);
    }
    const file = parts.files.find((f) => f.field === 'photo');
    if (!file || !file.data.length) {
      return sendHtml(res, views.uploadPage(user, isAdmin, 'Please choose a photo of the receipt.'), 400);
    }
    if (!String(file.contentType).startsWith('image/')) {
      return sendHtml(res, views.uploadPage(user, isAdmin, 'That file is not a photo.'), 400);
    }
    // iPhones upload HEIC — convert to JPEG so tesseract (and browsers) can read it.
    // The converted JPEG is what gets saved and OCR'd; other formats are untouched.
    let photoBuffer = file.data;
    let ext = extFor(file.contentType, file.filename);
    try {
      const prepared = await heic.preparePhoto({ buffer: file.data, contentType: file.contentType, filename: file.filename });
      photoBuffer = prepared.buffer;
      if (prepared.ext) ext = prepared.ext;
    } catch (e) {
      console.warn('[upload] HEIC conversion failed:', e.message);
      return sendHtml(res, views.uploadPage(user, isAdmin,
        'Couldn\u2019t read that HEIC photo. Try taking the picture again, or set your iPhone camera to \u201CMost Compatible\u201D (JPEG) and re-upload.'), 400);
    }
    const photoName = `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, photoName), photoBuffer);

    const storeName = (parts.fields.store || '').trim() || 'Unknown store';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(parts.fields.date || '') ? parts.fields.date : views.todayStr();

    const text = await ocrImage(photoBuffer);
    const parsed = parser.parseReceiptText(text);
    return sendHtml(res, views.reviewPage(user, isAdmin, {
      photo: photoName,
      store: storeName,
      date,
      items: parsed.items,
      detectedTotal: parsed.detectedTotal,
      ocrOk: text.trim().length > 0,
    }));
  }

  // ---- save reviewed receipt ----
  if (pathname === '/save' && method === 'POST') {
    const form = await readUrlEncoded(req);
    const photo = (form.get('photo') || '').replace(/[^a-zA-Z0-9.\-_]/g, '');
    const storeName = (form.get('store') || '').trim().slice(0, 80) || 'Unknown store';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(form.get('date') || '') ? form.get('date') : views.todayStr();
    const names = form.getAll('item_name');
    const prices = form.getAll('item_price');
    const items = [];
    for (let i = 0; i < names.length; i++) {
      const raw = (names[i] || '').trim();
      const price = Math.round((parseFloat(prices[i]) || 0) * 100) / 100;
      if (!raw) continue;
      if (price < 0 || price > 20000) continue;
      items.push({ name: parser.normalizeName(raw), name_raw: raw.slice(0, 120), price });
    }
    if (!items.length) {
      // Nothing to save — drop the orphan photo and go back.
      if (photo) fs.unlink(path.join(UPLOAD_DIR, photo), () => {});
      return redirect(res, '/upload');
    }
    const total = Math.round(items.reduce((s, it) => s + it.price, 0) * 100) / 100;
    const receipt = await store.createReceipt({
      store: storeName, date, total,
      uploaded_by: user.id, uploaded_by_name: user.username, photo,
    });
    await store.addItems(receipt.id, items);
    return redirect(res, '/app?month=' + encodeURIComponent(date.slice(0, 7)));
  }

  // ---- delete receipt (admin or the uploader) ----
  const delMatch = pathname.match(/^\/receipts\/([^/]+)\/delete$/);
  if (delMatch && method === 'POST') {
    const receipt = await store.getReceipt(delMatch[1]);
    if (!receipt) {
      res.writeHead(404);
      return res.end('not found');
    }
    if (!(isAdmin || receipt.uploaded_by === user.id)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    if (receipt.photo) fs.unlink(path.join(UPLOAD_DIR, path.basename(receipt.photo)), () => {});
    await store.deleteReceipt(receipt.id);
    const form = await readUrlEncoded(req).catch(() => new URLSearchParams());
    const month = /^\d{4}-\d{2}$/.test(form.get('month') || '') ? form.get('month') : summary.currentMonthKey();
    return redirect(res, '/app?month=' + encodeURIComponent(month));
  }

  // ---- admin ----
  // The admin budget form edits the CURRENT month's starting (base) budget.
  // Money added mid-month via "Add money" is kept as separate entries.
  const curMonth = summary.currentMonthKey();
  async function adminCtx(extra = {}) {
    const members = await store.listUsers();
    const mb = await store.getMonthBudget(curMonth);
    return { members, budget: mb.base, addedThisMonth: mb.added, monthLabel: summary.prettyMonth(curMonth), ...extra };
  }
  if (pathname === '/admin' && method === 'GET') {
    if (!isAdmin) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    return sendHtml(res, views.adminPage(user, await adminCtx()));
  }
  if (pathname === '/admin/budget' && method === 'POST') {
    if (!isAdmin) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    const form = await readUrlEncoded(req);
    const budget = Math.round((parseFloat(form.get('budget')) || 0) * 100) / 100;
    if (!(budget > 0) || budget > 1000000) {
      return sendHtml(res, views.adminPage(user, await adminCtx({ error: 'Enter a valid budget amount.' })));
    }
    await store.setMonthBudgetBase(curMonth, budget);
    return sendHtml(res, views.adminPage(user, await adminCtx({ msg: 'Budget updated.' })));
  }
  if (pathname === '/admin/members/create' && method === 'POST') {
    if (!isAdmin) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    const form = await readUrlEncoded(req);
    const username = (form.get('username') || '').trim();
    const password = form.get('password') || '';
    const fail = async (error) => sendHtml(res, views.adminPage(user, await adminCtx({ error })));
    if (!/^[A-Za-z0-9._-]{3,24}$/.test(username)) return fail('Username: 3–24 characters, letters/numbers/._- only.');
    if (password.length < 4) return fail('Password must be at least 4 characters.');
    try {
      await store.createUser({ username, passHash: auth.hashPassword(password), role: 'member' });
    } catch (e) {
      if (e.message === 'username-taken') return fail('That username is already taken.');
      throw e;
    }
    return sendHtml(res, views.adminPage(user, await adminCtx({ msg: `Login created for ${username}.` })));
  }
  const resetMatch = pathname.match(/^\/admin\/members\/([^/]+)\/reset$/);
  if (resetMatch && method === 'POST') {
    if (!isAdmin) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    const form = await readUrlEncoded(req);
    const password = form.get('password') || '';
    if (password.length < 4) {
      return sendHtml(res, views.adminPage(user, await adminCtx({ error: 'Password must be at least 4 characters.' })));
    }
    try {
      await store.setUserPassword(resetMatch[1], auth.hashPassword(password));
    } catch (e) {
      return sendHtml(res, views.adminPage(user, await adminCtx({ error: 'Member not found.' })));
    }
    return sendHtml(res, views.adminPage(user, await adminCtx({ msg: 'Password reset.' })));
  }
  const delUserMatch = pathname.match(/^\/admin\/members\/([^/]+)\/delete$/);
  if (delUserMatch && method === 'POST') {
    if (!isAdmin) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    await store.deleteUser(delUserMatch[1]);
    return sendHtml(res, views.adminPage(user, await adminCtx({ msg: 'Member deleted. Their receipts were kept.' })));
  }

  res.writeHead(404);
  res.end('not found');
}

function extFor(contentType, filename) {
  const fromName = (filename || '').match(/\.([a-zA-Z0-9]+)$/);
  if (fromName && ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'].includes(fromName[1].toLowerCase())) {
    const e = fromName[1].toLowerCase();
    return '.' + (e === 'jpeg' ? 'jpg' : e);
  }
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif' };
  return map[String(contentType).toLowerCase()] || '.jpg';
}

async function start() {
  await store.init();
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[server] request failed:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Something went wrong</h1><p><a href="/app">Back to dashboard</a></p>');
      } else {
        res.end();
      }
    });
  });
  // OCR on a big photo can take a while — don't cut slow uploads/processing.
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 65 * 1000;
  server.listen(PORT, () => console.log(`[server] Grocery Tracker listening on port ${PORT}`));
}

if (require.main === module) start();

module.exports = { start };
