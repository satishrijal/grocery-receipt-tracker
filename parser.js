'use strict';
/**
 * parser.js — turns raw OCR text from a receipt photo into line items.
 *
 * How it works:
 *  1. Split the OCR text into lines, trim, drop empties.
 *  2. Throw away "junk" lines: store headers, dates, times, phone numbers,
 *     thank-you footers, and totals/tax/tender lines (the TOTAL is captured
 *     separately as a hint, not as an item).
 *  3. An item line looks like "<name>  <price>" where the price is the LAST
 *     thing on the line, e.g. "CHICKEN BREAST 12.99" or "WATER 24PK $4.98T"
 *     (the trailing T = taxed flag on many US receipts).
 *  4. Names are cleaned (leading "2X " quantity markers, stray #/* chars)
 *     and normalized (lowercase + trim) for aggregation.
 *
 * OCR is never trusted blindly — the review screen always lets the user
 * fix names/prices before anything is saved.
 */

function normalizeName(name) {
  return String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Lines that can never be grocery items.
const JUNK_PATTERNS = [
  /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/, // dates like 09/28/2026
  /\d{1,2}:\d{2}(:\d{2})?/, // times like 14:32
  /\(\d{3}\)\s*\d{3}[-.]\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b/, // phone numbers
  /thank you|thanks for shopping|visit again/i,
  /welcome to/i,
  /\breceipt\b/i,
  /cashier|associate|operator|register/i,
  /sub\s*total/i,
  /^\s*(total|amount due|balance due|grand total)\b/i,
  /\b(tax|hst|gst|vat)\b/i, // "TAX 1.12" lines
  /\b(change|tendered|cash|debit|credit|visa|mastercard|amex|discover)\b/i,
  /\b(save|saving|coupon|discount|promo)\b/i, // "YOU SAVED 2.00" lines
  /items?\s+sold/i,
  /^[\d\s$.,\-*#:;()\/]+$/, // only digits/symbols: barcodes, id numbers
  /^\*+$/, // divider lines
];

function isJunkLine(line) {
  return JUNK_PATTERNS.some((re) => re.test(line));
}

/** Strip quantity markers and stray symbols from a raw item name. */
function cleanName(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^\d+\s*[xX@]\s*/, ''); // leading "2X " / "2 @ "
  s = s.replace(/[#*]+/g, ''); // stray markers
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// "<name> <price>" — price is last, optional $, optional single trailing
// letter (tax flags like T/F on US receipts). Lazy name group + anchored
// price keeps "SAVE 2.00"-style lines from splitting weirdly.
const ITEM_RE = /^(.*?)\s+\$?(\d{1,4}(?:,\d{3})*\.\d{2})\s*([A-Za-z])?\s*$/;

/**
 * @param {string} text raw OCR text
 * @returns {{ items: Array<{name, name_raw, price}>, detectedTotal: number|null }}
 */
function parseReceiptText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const items = [];
  let detectedTotal = null;

  // The receipt total: scan from the bottom, first total-like line wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/(?:^|\b)(total|amount due|balance due|grand total)\b[^\d]*\$?\s*([\d,]+\.\d{2})/i);
    if (m) {
      detectedTotal = parseFloat(m[2].replace(/,/g, ''));
      break;
    }
  }

  for (const line of lines) {
    if (isJunkLine(line)) continue;
    const m = line.match(ITEM_RE);
    if (!m) continue;
    const price = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(price) || price <= 0 || price > 20000) continue;
    const name = cleanName(m[1]);
    if (name.length < 2) continue;
    if (/^[\d\s.,/-]+$/.test(name)) continue; // name was really just numbers
    items.push({
      name: normalizeName(name),
      name_raw: name,
      price: Math.round(price * 100) / 100,
    });
  }

  return { items, detectedTotal };
}

module.exports = { parseReceiptText, normalizeName, isJunkLine, cleanName };
