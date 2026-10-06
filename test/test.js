'use strict';
/**
 * Automated tests: run with `npm test` (node --test test/).
 * Covers budget math, name normalization + aggregation, the OCR
 * line-parsing heuristics, auth flows, month boundaries, and the
 * multipart upload parser.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const summary = require('../summary');
const parser = require('../parser');
const auth = require('../auth');
const { parseMultipart } = require('../multipart');

// ---------------------------------------------------------------- budget ---
describe('budget math', () => {
  const mk = (id, date, total, store = 'Walmart') => ({ id, date, total, store });

  it('computes spent and remaining for a month', () => {
    const receipts = [mk('1', '2026-09-05', 120.5), mk('2', '2026-09-20', 79.5), mk('3', '2026-10-01', 50)];
    const out = summary.summarizeMonth({ receipts, itemsByReceipt: {}, budget: 500, month: '2026-09' });
    assert.equal(out.spent, 200);
    assert.equal(out.remaining, 300);
    assert.equal(out.receiptCount, 2);
  });

  it('empty month shows full budget remaining', () => {
    const out = summary.summarizeMonth({ receipts: [], itemsByReceipt: {}, budget: 500, month: '2026-09' });
    assert.equal(out.spent, 0);
    assert.equal(out.remaining, 500);
  });

  it('going over budget yields a negative remaining', () => {
    const receipts = [mk('1', '2026-09-05', 650)];
    const out = summary.summarizeMonth({ receipts, itemsByReceipt: {}, budget: 500, month: '2026-09' });
    assert.equal(out.remaining, -150);
  });

  it('per-store totals group correctly', () => {
    const receipts = [mk('1', '2026-09-05', 100, 'Walmart'), mk('2', '2026-09-06', 40, 'India Bazaar'), mk('3', '2026-09-07', 60, 'Walmart')];
    const out = summary.summarizeMonth({ receipts, itemsByReceipt: {}, budget: 500, month: '2026-09' });
    const byStore = Object.fromEntries(out.stores.map((s) => [s.store, s.total]));
    assert.equal(byStore['Walmart'], 160);
    assert.equal(byStore['India Bazaar'], 40);
  });
});

// ------------------------------------------------------- normalization -----
describe('item name normalization + aggregation', () => {
  it('lowercases, trims, collapses whitespace', () => {
    assert.equal(parser.normalizeName('  CHICKEN   Breast '), 'chicken breast');
    assert.equal(summary.normalizeName('\tWater\n'), 'water');
  });

  it('aggregates spelling variants of the same item', () => {
    const receipts = [{ id: '1', date: '2026-09-05', total: 100, store: 'Walmart' }];
    const itemsByReceipt = {
      1: [
        { name: 'chicken', price: 30 },
        { name: 'Chicken', price: 20 },
        { name: '  CHICKEN ', price: 10 },
        { name: 'water', price: 50 },
      ],
    };
    const out = summary.summarizeMonth({ receipts, itemsByReceipt, budget: 500, month: '2026-09' });
    const byItem = Object.fromEntries(out.items.map((i) => [i.name, i.total]));
    assert.equal(byItem['chicken'], 60); // $50 chicken-style aggregation works
    assert.equal(byItem['water'], 50);
  });
});

// ---------------------------------------------------------- receipt parse ---
const WALMART_SAMPLE = `
WAL-MART SUPERCENTER
Thank you for shopping with us
CHICKEN BREAST            12.99
GREAT VALUE WATER 24PK     4.98
BANANAS                    0.68
SUBTOTAL                  18.65
TAX                        1.12
TOTAL                     19.77
CASH                      20.00
CHANGE                     0.23
09/28/2026 14:32
`;

const INDIA_BAZAAR_SAMPLE = `
INDIA BAZAAR
BASMATI RICE 10LB     18.99T
TOOR DAL 4LB           7.49T
AMUL GHEE             12.99
YOU SAVED              2.00
SUBTOTAL              39.47
TOTAL                 39.47
Thank You Visit Again
(214) 555-0134
`;

describe('receipt text parsing', () => {
  it('parses a Walmart-style receipt', () => {
    const { items, detectedTotal } = parser.parseReceiptText(WALMART_SAMPLE);
    const byName = Object.fromEntries(items.map((i) => [i.name, i.price]));
    assert.equal(byName['chicken breast'], 12.99);
    assert.equal(byName['great value water 24pk'], 4.98);
    assert.equal(byName['bananas'], 0.68);
    assert.equal(items.length, 3); // subtotal/tax/total/cash/change skipped
    assert.equal(detectedTotal, 19.77);
  });

  it('parses an India Bazaar-style receipt with tax flags', () => {
    const { items, detectedTotal } = parser.parseReceiptText(INDIA_BAZAAR_SAMPLE);
    const byName = Object.fromEntries(items.map((i) => [i.name, i.price]));
    assert.equal(byName['basmati rice 10lb'], 18.99);
    assert.equal(byName['toor dal 4lb'], 7.49);
    assert.equal(byName['amul ghee'], 12.99);
    assert.equal(detectedTotal, 39.47);
  });

  it('skips junk lines: dates, phones, thank-yous, totals', () => {
    assert.ok(parser.isJunkLine('09/28/2026 14:32'));
    assert.ok(parser.isJunkLine('(214) 555-0134'));
    assert.ok(parser.isJunkLine('Thank you for shopping'));
    assert.ok(parser.isJunkLine('SUBTOTAL 18.65'));
    assert.ok(parser.isJunkLine('TOTAL 19.77'));
    assert.ok(parser.isJunkLine('TAX 1.12'));
    assert.ok(!parser.isJunkLine('CHICKEN BREAST 12.99'));
  });

  it('strips leading quantity markers from names', () => {
    assert.equal(parser.cleanName('2X MILK'), 'MILK');
    assert.equal(parser.cleanName('2 @ EGGS'), 'EGGS');
  });

  it('handles empty / garbage OCR text gracefully', () => {
    const out = parser.parseReceiptText('');
    assert.deepEqual(out.items, []);
    assert.equal(out.detectedTotal, null);
    const out2 = parser.parseReceiptText('lorem ipsum no prices here');
    assert.deepEqual(out2.items, []);
  });
});

// ------------------------------------------------------------------- auth ---
describe('auth + member accounts (JSON store)', () => {
  let store;
  before(async () => {
    delete process.env.DATABASE_URL; // force JSON backend for tests
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grt-test-'));
    store = require('../store');
    store.setDataDir(tmp);
    await store.init();
    assert.equal(store.getBackend(), 'json');
  });

  it('creates a member and verifies the password', async () => {
    await store.createUser({ username: 'ram', passHash: auth.hashPassword('secret123'), role: 'member' });
    const member = await store.findUserByUsername('ram');
    assert.ok(member);
    assert.ok(auth.verifyPassword('secret123', member.passHash)); // login works
    assert.ok(!auth.verifyPassword('wrongpass', member.passHash)); // wrong password rejected
  });

  it('rejects duplicate usernames (case-insensitive)', async () => {
    await assert.rejects(
      store.createUser({ username: 'RAM', passHash: auth.hashPassword('x'), role: 'member' }),
      /username-taken/
    );
  });

  it('resets a password and deletes a member', async () => {
    const member = await store.findUserByUsername('ram');
    await store.setUserPassword(member.id, auth.hashPassword('newpass'));
    const updated = await store.findUserByUsername('ram');
    assert.ok(auth.verifyPassword('newpass', updated.passHash));
    assert.ok(!auth.verifyPassword('secret123', updated.passHash));
    await store.deleteUser(member.id);
    assert.equal(await store.findUserByUsername('ram'), null);
  });

  it('sessions round-trip and expire', async () => {
    await store.createSession({ id: 'sess-1', user_id: 'u1', username: 'ram', role: 'member' });
    const s = await store.getSession('sess-1');
    assert.equal(s.username, 'ram');
    await store.deleteSession('sess-1');
    assert.equal(await store.getSession('sess-1'), null);
  });
});

// -------------------------------------------------------- month boundary ---
describe('month boundaries', () => {
  it('a receipt on Sep 30 counts for September, Oct 1 for October', () => {
    assert.equal(summary.monthKeyOf('2026-09-30'), '2026-09');
    assert.equal(summary.monthKeyOf('2026-10-01'), '2026-10');
    const receipts = [
      { id: '1', date: '2026-09-30', total: 25, store: 'Walmart' },
      { id: '2', date: '2026-10-01', total: 75, store: 'Walmart' },
    ];
    const sept = summary.summarizeMonth({ receipts, itemsByReceipt: {}, budget: 500, month: '2026-09' });
    const oct = summary.summarizeMonth({ receipts, itemsByReceipt: {}, budget: 500, month: '2026-10' });
    assert.equal(sept.spent, 25);
    assert.equal(oct.spent, 75);
  });

  it('prev/next month wrap the year correctly', () => {
    assert.equal(summary.prevMonth('2026-01'), '2025-12');
    assert.equal(summary.nextMonth('2026-12'), '2027-01');
  });
});

// --------------------------------------------------------------- multipart ---
describe('multipart upload parser', () => {
  function fakeReq(body, boundary) {
    const req = new EventEmitter();
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    process.nextTick(() => {
      req.emit('data', body);
      req.emit('end');
    });
    return req;
  }

  it('extracts text fields and a binary file intact', async () => {
    const boundary = '----testboundary';
    const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xd8]); // binary, incl. non-utf8 bytes
    const body = Buffer.concat([
      Buffer.from(`------testboundary\r\nContent-Disposition: form-data; name="store"\r\n\r\nWalmart\r\n`, 'utf8'),
      Buffer.from(`------testboundary\r\nContent-Disposition: form-data; name="photo"; filename="bill.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`, 'utf8'),
      fileBytes,
      Buffer.from(`\r\n------testboundary--\r\n`, 'utf8'),
    ]);
    const { fields, files } = await parseMultipart(fakeReq(body, boundary));
    assert.equal(fields.store, 'Walmart');
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, 'bill.jpg');
    assert.ok(files[0].data.equals(fileBytes)); // binary survived byte-for-byte
  });

  it('rejects non-multipart requests', async () => {
    const req = new EventEmitter();
    req.headers = { 'content-type': 'application/json' };
    await assert.rejects(parseMultipart(req), /not-multipart/);
  });
});

// ------------------------------------------------------------------ heic ---
const heic = require('../heic');

describe('HEIC detection', () => {
  it('detects HEIC by content-type', () => {
    assert.ok(heic.isHeicUpload('image/heic', 'photo.jpg'));
    assert.ok(heic.isHeicUpload('image/heif', 'photo.jpg'));
    assert.ok(heic.isHeicUpload('IMAGE/HEIC', 'photo.jpg'));
    assert.ok(heic.isHeicUpload('image/heic; charset=binary', 'photo.jpg'));
  });

  it('detects HEIC by filename extension', () => {
    assert.ok(heic.isHeicUpload('application/octet-stream', 'IMG_1234.heic'));
    assert.ok(heic.isHeicUpload('application/octet-stream', 'IMG_1234.HEIC'));
    assert.ok(heic.isHeicUpload('image/jpeg', 'scan.heif'));
  });

  it('leaves regular photos alone', () => {
    assert.ok(!heic.isHeicUpload('image/jpeg', 'bill.jpg'));
    assert.ok(!heic.isHeicUpload('image/png', 'bill.png'));
    assert.ok(!heic.isHeicUpload('image/webp', 'bill.webp'));
    assert.ok(!heic.isHeicUpload('', ''));
  });
});

describe('HEIC conversion routing', () => {
  const fakeJpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  it('routes HEIC uploads through the converter and returns JPEG bytes', async () => {
    let calls = 0;
    const fakeConvert = async ({ buffer, format }) => {
      calls++;
      assert.equal(format, 'JPEG');
      assert.ok(Buffer.isBuffer(buffer));
      return fakeJpeg();
    };
    const out = await heic.preparePhoto(
      { buffer: Buffer.from('fake-heic-bytes'), contentType: 'image/heic', filename: 'IMG_1.heic' },
      fakeConvert
    );
    assert.equal(calls, 1);
    assert.equal(out.converted, true);
    assert.equal(out.ext, '.jpg');
    assert.equal(out.buffer[0], 0xff);
    assert.equal(out.buffer[1], 0xd8); // JPEG magic bytes
  });

  it('JPEG uploads skip conversion completely untouched', async () => {
    const fakeConvert = async () => { throw new Error('must not be called'); };
    const buf = Buffer.from([1, 2, 3, 4]);
    const out = await heic.preparePhoto(
      { buffer: buf, contentType: 'image/jpeg', filename: 'bill.jpg' },
      fakeConvert
    );
    assert.equal(out.converted, false);
    assert.equal(out.ext, null);
    assert.ok(out.buffer === buf); // identical buffer object, byte-for-byte
  });

  it('propagates converter failures so the server can show an error', async () => {
    await assert.rejects(
      heic.preparePhoto(
        { buffer: Buffer.from('x'), contentType: 'image/heic', filename: 'a.heic' },
        async () => { throw new Error('boom'); }
      ),
      /boom/
    );
  });

  it('the real heic-convert module is installed and wired as the default', () => {
    assert.equal(typeof require('heic-convert'), 'function');
  });
});

// ------------------------------------------------------- monthly budgets ---
describe('monthly budgets (JSON store)', () => {
  const store = require('../store'); // same tmp-dir store the auth suite initialized

  it('a fresh month has no budget entry', async () => {
    const b = await store.getMonthBudget('2026-09');
    assert.equal(b.hasEntry, false);
    assert.deepEqual(b.adjustments, []);
  });

  it('the starting-budget prompt shows only for the current month without an entry', () => {
    assert.ok(summary.needsBudgetPrompt({ month: '2026-09', currentMonth: '2026-09', hasEntry: false }));
    assert.ok(!summary.needsBudgetPrompt({ month: '2026-08', currentMonth: '2026-09', hasEntry: false }));
    assert.ok(!summary.needsBudgetPrompt({ month: '2026-10', currentMonth: '2026-09', hasEntry: false }));
    assert.ok(!summary.needsBudgetPrompt({ month: '2026-09', currentMonth: '2026-09', hasEntry: true }));
  });

  it('prefill uses last month\u2019s budget, falls back to 500', async () => {
    assert.equal(await store.getBudgetPrefill('2026-09'), 500); // nothing set yet
    await store.setMonthBudgetBase('2026-08', 600);
    assert.equal(await store.getBudgetPrefill('2026-09'), 600);
    await store.setBudget(650); // legacy global becomes the fallback
    assert.equal(await store.getBudgetPrefill('2026-11'), 650); // no 2026-10 entry
  });

  it('add-money math: remaining = (base + added) \u2212 spent', async () => {
    await store.setMonthBudgetBase('2026-09', 500);
    await store.addMonthFunds('2026-09', 100, 'ram');
    await store.addMonthFunds('2026-09', 50, 'sita');
    const b = await store.getMonthBudget('2026-09');
    assert.equal(b.base, 500);
    assert.equal(b.added, 150);
    assert.equal(b.total, 650);
    assert.equal(b.hasEntry, true);
    assert.equal(b.adjustments.length, 2);
    assert.equal(b.adjustments[0].by, 'ram');
    assert.equal(b.adjustments[1].amount, 50);

    const out = summary.summarizeMonth({
      receipts: [{ id: '1', date: '2026-09-05', total: 250, store: 'Walmart' }],
      itemsByReceipt: {},
      budget: b.total, base: b.base, added: b.added, month: '2026-09',
    });
    assert.equal(out.spent, 250);
    assert.equal(out.remaining, 400); // (500 + 150) - 250
    assert.equal(out.base, 500);
    assert.equal(out.added, 150);
  });

  it('editing the base never erases added funds', async () => {
    await store.setMonthBudgetBase('2026-09', 700);
    const b = await store.getMonthBudget('2026-09');
    assert.equal(b.base, 700);
    assert.equal(b.added, 150); // top-ups survived
    assert.equal(b.total, 850);
  });

  it('summarizeMonth defaults base/added when not provided (old callers)', () => {
    const out = summary.summarizeMonth({ receipts: [], itemsByReceipt: {}, budget: 500, month: '2026-09' });
    assert.equal(out.base, 500);
    assert.equal(out.added, 0);
  });
});

// ------------------------------------------------------- v2: signup -----
describe('self-signup validation', () => {
  it('rejects non-gmail addresses', () => {
    assert.match(auth.validateSignup({ name: 'Ram', email: 'ram@yahoo.com', password: 'password123', confirm: 'password123' }), /Gmail/i);
    assert.match(auth.validateSignup({ name: 'Ram', email: 'not-an-email', password: 'password123', confirm: 'password123' }), /Gmail/i);
    assert.match(auth.validateSignup({ name: 'Ram', email: 'ram@gmail', password: 'password123', confirm: 'password123' }), /Gmail/i);
  });

  it('accepts gmail case-insensitively and with dots/plus', () => {
    assert.equal(auth.validateSignup({ name: 'Ram', email: 'Ram.Prasad+home@GMAIL.com', password: 'password123', confirm: 'password123' }), null);
  });

  it('rejects short passwords and mismatched confirmation', () => {
    assert.match(auth.validateSignup({ name: 'Ram', email: 'ram@gmail.com', password: 'short', confirm: 'short' }), /8 characters/);
    assert.match(auth.validateSignup({ name: 'Ram', email: 'ram@gmail.com', password: 'password123', confirm: 'password124' }), /do not match/);
  });

  it('rejects a missing name', () => {
    assert.match(auth.validateSignup({ name: '  ', email: 'ram@gmail.com', password: 'password123', confirm: 'password123' }), /name/i);
  });

  it('verification tokens are 64 hex chars', () => {
    const t1 = auth.newVerifyToken();
    const t2 = auth.newVerifyToken();
    assert.match(t1, /^[0-9a-f]{64}$/);
    assert.notEqual(t1, t2);
  });

  it('password hashes are never plaintext and verify correctly', () => {
    const h = auth.hashPassword('mysecretpw');
    assert.ok(!h.includes('mysecretpw'));
    assert.ok(h.startsWith('scrypt$'));
    assert.ok(auth.verifyPassword('mysecretpw', h));
    assert.ok(!auth.verifyPassword('wrongpw', h));
  });

  it('login gate: unverified blocked, verified + legacy allowed', () => {
    assert.equal(auth.loginAllowed(null), false);
    assert.equal(auth.loginAllowed({ email_verified: false }), false); // explicit false blocks
    assert.equal(auth.loginAllowed({ email_verified: true }), true);
    assert.equal(auth.loginAllowed({ username: 'ram' }), true); // old account, no field
    assert.equal(auth.loginAllowed({ email_verified: null }), true);
  });
});

// ------------------------------------------- v2: houses + invite codes ---
describe('houses + invite codes (JSON store)', () => {
  const store = require('../store'); // same tmp-dir store

  it('creates a house with a short unambiguous invite code', async () => {
    const h = await store.createHouse({ name: 'Test Home', created_by: 'admin' });
    assert.ok(h.id);
    assert.match(h.invite_code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    const h2 = await store.createHouse({ name: 'Other Home', created_by: 'admin' });
    assert.notEqual(h.invite_code, h2.invite_code);
  });

  it('joins with a code (case-insensitive), rejects bad codes', async () => {
    const house = await store.createHouse({ name: 'Join Home', created_by: 'admin' });
    await store.createUser({ username: 'v2ram', passHash: auth.hashPassword('password123'), role: 'member' });
    const member = await store.findUserByUsername('v2ram');
    const joined = await store.joinHouse(member.id, house.invite_code.toLowerCase());
    assert.equal(joined.id, house.id);
    const updated = await store.getUserById(member.id);
    assert.equal(updated.house_id, house.id);
    const members = await store.listHouseMembers(house.id);
    assert.ok(members.some((m) => m.id === member.id));
    await assert.rejects(store.joinHouse(member.id, 'NOPE00'), /bad-code/);
  });

  it('leaving clears the house; deleting a house unlinks members', async () => {
    const house = await store.createHouse({ name: 'Leave Home', created_by: 'admin' });
    await store.createUser({ username: 'v2sita', passHash: auth.hashPassword('password123'), role: 'member' });
    const member = await store.findUserByUsername('v2sita');
    await store.joinHouse(member.id, house.invite_code);
    await store.leaveHouse(member.id);
    assert.equal((await store.getUserById(member.id)).house_id, null);
    await store.joinHouse(member.id, house.invite_code);
    await store.deleteHouse(house.id);
    assert.equal(await store.getHouse(house.id), null);
    assert.equal((await store.getUserById(member.id)).house_id, null);
  });
});

// --------------------------------------- v2: email verification (store) ---
describe('email verification flow (JSON store)', () => {
  const store = require('../store');

  it('unverified user is found by a live token, expired tokens vanish', async () => {
    const token = auth.newVerifyToken();
    await store.createUser({
      username: 'v2hari@gmail.com', passHash: auth.hashPassword('password123'), role: 'member',
      email: 'v2hari@gmail.com', name: 'Hari', emailVerified: false,
      verificationToken: token, verificationExpires: auth.verifyTokenExpiry(),
    });
    const found = await store.findUserByVerificationToken(token);
    assert.ok(found);
    assert.equal(found.username, 'v2hari@gmail.com');
    assert.equal(auth.loginAllowed(found), false); // gate blocks until verified

    // Expire it by hand.
    await store.setVerificationToken(found.id, token, new Date(Date.now() - 1000).toISOString());
    assert.equal(await store.findUserByVerificationToken(token), null);
    assert.equal(await store.findUserByVerificationToken('nope'), null);
  });

  it('verifyUser flips the flag and clears the token', async () => {
    const member = await store.findUserByEmail('v2hari@gmail.com');
    await store.verifyUser(member.id);
    const updated = await store.findUserByEmail('v2hari@gmail.com');
    assert.equal(updated.email_verified, true);
    assert.equal(updated.verification_token, null);
    assert.equal(auth.loginAllowed(updated), true);
  });

  it('duplicate emails are rejected case-insensitively', async () => {
    await assert.rejects(
      store.createUser({
        username: 'v2other@gmail.com', passHash: auth.hashPassword('password123'), role: 'member',
        email: 'V2HARI@GMAIL.COM', name: 'Dup', emailVerified: false,
        verificationToken: auth.newVerifyToken(), verificationExpires: auth.verifyTokenExpiry(),
      }),
      /email-taken/
    );
  });
});

// --------------------------------- v2: collection + shares + low balance ---
describe('monthly collection + member shares (JSON store)', () => {
  const store = require('../store');
  const MONTH = '2026-12';

  it('share math: $500 / 5 = $100, recalculates when members join', () => {
    assert.equal(summary.memberShare(500, 5), 100);
    assert.equal(summary.memberShare(500, 6), 83.33);
    assert.equal(summary.memberShare(500, 0), 0);
    assert.equal(summary.memberRemaining({ share: 100, topups: 20, spent: 75 }), 45);
  });

  it('low-balance threshold is strictly below $50', () => {
    assert.equal(summary.isLowBalance(49.99), true);
    assert.equal(summary.isLowBalance(0), true);
    assert.equal(summary.isLowBalance(50), false);
    assert.equal(summary.isLowBalance(120), false);
    assert.equal(summary.LOW_BALANCE_THRESHOLD, 50);
  });

  it('setMonthCollection keeps base in sync; getMonthBudget exposes collection', async () => {
    await store.setMonthCollection(MONTH, 500);
    const b = await store.getMonthBudget(MONTH);
    assert.equal(b.collection, 500);
    assert.equal(b.base, 500); // legacy views keep working
    assert.equal(b.hasEntry, true);
    assert.deepEqual(b.topups, []);
    assert.deepEqual(b.lowBalanceNotified, []);
  });

  it('per-member top-ups accumulate and feed the remaining math', async () => {
    const house = await store.createHouse({ name: 'Money Home', created_by: 'admin' });
    await store.createUser({ username: 'v2mina', passHash: auth.hashPassword('password123'), role: 'member' });
    const mina = await store.findUserByUsername('v2mina');
    await store.joinHouse(mina.id, house.invite_code);

    await store.addMemberTopup(MONTH, mina.id, 'Mina', 30);
    await store.addMemberTopup(MONTH, mina.id, 'Mina', 20);
    const b = await store.getMonthBudget(MONTH);
    const myTopups = summary.round2(b.topups
      .filter((t) => String(t.user_id) === String(mina.id))
      .reduce((s, t) => s + t.amount, 0));
    assert.equal(myTopups, 50);

    const members = await store.listHouseMembers(house.id);
    const share = summary.memberShare(b.collection, members.length);
    assert.equal(share, 500); // only member so far
    // Another member joins -> share recalculates live.
    await store.createUser({ username: 'v2gita', passHash: auth.hashPassword('password123'), role: 'member' });
    const gita = await store.findUserByUsername('v2gita');
    await store.joinHouse(gita.id, house.invite_code);
    const members2 = await store.listHouseMembers(house.id);
    assert.equal(summary.memberShare(b.collection, members2.length), 250);
    // Mina's remaining: 250 share + 50 top-ups - 0 spent.
    assert.equal(summary.memberRemaining({ share: 250, topups: 50, spent: 0 }), 300);
    assert.equal(summary.isLowBalance(300), false);
  });

  it('low-balance notification fires exactly once per member per month', async () => {
    const first = await store.markLowBalanceNotified(MONTH, 'u-1');
    const second = await store.markLowBalanceNotified(MONTH, 'u-1');
    const other = await store.markLowBalanceNotified(MONTH, 'u-2');
    assert.equal(first, true);
    assert.equal(second, false); // no re-fire
    assert.equal(other, true);
    const b = await store.getMonthBudget(MONTH);
    assert.deepEqual([...b.lowBalanceNotified].sort(), ['u-1', 'u-2']);
  });

  it('a member spending below $50 remaining trips the low flag', async () => {
    // $80 collection, 2 members -> $40 share each -> already below $50.
    await store.setMonthCollection('2027-01', 80);
    const b = await store.getMonthBudget('2027-01');
    assert.equal(b.collection, 80);
    assert.equal(summary.isLowBalance(summary.memberShare(80, 2)), true);
    assert.equal(summary.isLowBalance(summary.memberShare(500, 5)), false);
  });
});
