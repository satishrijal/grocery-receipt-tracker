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
