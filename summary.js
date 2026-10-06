'use strict';
/**
 * summary.js — pure dashboard math (no I/O), so it is easy to unit test.
 * The server and the tests both use these functions.
 */

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** "2026-09-28" -> "2026-09" */
function monthKeyOf(dateStr) {
  return String(dateStr || '').slice(0, 7);
}

/** Current month as "YYYY-MM" in the server's local timezone. */
function currentMonthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return currentMonthKey(d);
}
function prevMonth(ym) { return shiftMonth(ym, -1); }
function nextMonth(ym) { return shiftMonth(ym, +1); }

/** Item-name normalization: lowercase + trim + collapse whitespace. */
function normalizeName(name) {
  return String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function prettyMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Build everything the dashboard needs for one month.
 * receipts: [{id, store, date, total, ...}]
 * itemsByReceipt: { receiptId: [{name, price}, ...] }
 * budget: the month's TOTAL budget (base + added funds).
 * base/added are optional display breakdowns (default: base=budget, added=0).
 */
function summarizeMonth({ receipts, itemsByReceipt, budget, month, base, added }) {
  const inMonth = receipts.filter((r) => monthKeyOf(r.date) === month);

  const spent = round2(inMonth.reduce((s, r) => s + (Number(r.total) || 0), 0));
  const totalBudget = Number(budget) || 0;
  const remaining = round2(totalBudget - spent);

  // Per-item totals, grouped by normalized name.
  const itemTotals = new Map();
  for (const r of inMonth) {
    for (const it of itemsByReceipt[r.id] || []) {
      const key = normalizeName(it.name);
      if (!key) continue;
      itemTotals.set(key, round2((itemTotals.get(key) || 0) + (Number(it.price) || 0)));
    }
  }
  const items = [...itemTotals.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);

  // Per-store totals.
  const storeTotals = new Map();
  for (const r of inMonth) {
    const key = (r.store || 'Unknown').trim() || 'Unknown';
    storeTotals.set(key, round2((storeTotals.get(key) || 0) + (Number(r.total) || 0)));
  }
  const stores = [...storeTotals.entries()]
    .map(([store, total]) => ({ store, total }))
    .sort((a, b) => b.total - a.total);

  return { month, budget: totalBudget, base: base != null ? Number(base) || 0 : totalBudget, added: Number(added) || 0, spent, remaining, receiptCount: inMonth.length, items, stores, receipts: inMonth };
}

/**
 * True when the dashboard should ask "How much money are you starting
 * with this month?" — i.e. viewing the current month and no starting
 * budget has been set for it yet.
 */
function needsBudgetPrompt({ month, currentMonth, hasEntry }) {
  return String(month) === String(currentMonth) && !hasEntry;
}

// ------------------------------------------------- household finance ---
/** A member's remaining balance triggers the low-money alert below this. */
const LOW_BALANCE_THRESHOLD = 50;

/** One member's equal share of the monthly collection (recalculated live). */
function memberShare(collection, memberCount) {
  const n = Number(memberCount) || 0;
  if (n <= 0) return 0;
  return round2((Number(collection) || 0) / n);
}

/** A member's remaining money: their share + top-ups − what they spent. */
function memberRemaining({ share, topups, spent }) {
  return round2((Number(share) || 0) + (Number(topups) || 0) - (Number(spent) || 0));
}

/** True when the remaining balance should trigger the low-money alert. */
function isLowBalance(remaining) {
  return (Number(remaining) || 0) < LOW_BALANCE_THRESHOLD;
}

module.exports = {
  round2,
  monthKeyOf,
  currentMonthKey,
  prevMonth,
  nextMonth,
  normalizeName,
  prettyMonth,
  summarizeMonth,
  needsBudgetPrompt,
  LOW_BALANCE_THRESHOLD,
  memberShare,
  memberRemaining,
  isLowBalance,
};
