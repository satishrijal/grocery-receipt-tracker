'use strict';
/**
 * views.js — server-rendered HTML pages. Mobile-first, big tap targets,
 * works in iPhone Safari. All user content is HTML-escaped.
 */
const summary = require('./summary');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function money(n) {
  const v = Number(n) || 0;
  return '$' + v.toFixed(2);
}

function layout(title, body, user) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · Grocery Tracker</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topbar">
  <div class="brand">🧾 Grocery Tracker</div>
  ${user ? `<div class="userbox"><span class="uname">${esc(user.username)}${user.role === 'admin' ? ' (admin)' : ''}</span>
  <form method="post" action="/logout"><button class="linkbtn" type="submit">Log out</button></form></div>` : ''}
</header>
<main class="wrap">${body}</main>
<script src="/app.js"></script>
</body>
</html>`;
}

function nav(user, isAdmin) {
  return `<nav class="tabs">
    <a href="/app">📊 Dashboard</a>
    <a href="/upload">📸 Upload receipt</a>
    ${isAdmin ? `<a href="/admin">⚙️ Admin</a>` : ''}
  </nav>`;
}

function loginPage(error) {
  return layout('Log in', `
    <div class="card narrow">
      <h1>Welcome back</h1>
      <p class="muted">Log in to track this month's grocery spending.</p>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <form method="post" action="/login">
        <label>Username<input name="username" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary" type="submit">Log in</button>
      </form>
    </div>`);
}

function dashboardPage({ user, isAdmin, month, data }) {
  const pct = data.budget > 0 ? Math.min(100, Math.round((data.spent / data.budget) * 100)) : 0;
  const over = data.remaining < 0;

  const itemRows = data.items.length
    ? data.items.map((it) => `<tr><td>${esc(it.name)}</td><td class="num">${money(it.total)}</td></tr>`).join('')
    : `<tr><td colspan="2" class="muted">No items yet this month.</td></tr>`;

  const storeRows = data.stores.length
    ? data.stores.map((s) => `<tr><td>${esc(s.store)}</td><td class="num">${money(s.total)}</td></tr>`).join('')
    : `<tr><td colspan="2" class="muted">No receipts yet this month.</td></tr>`;

  const receiptCards = data.receipts.length
    ? data.receipts.map((r) => {
        const canDelete = isAdmin || r.uploaded_by === user.id;
        return `<div class="rcard">
          <a class="rphoto" href="/uploads/${esc(r.photo)}" target="_blank" rel="noopener">
            ${r.photo ? '🧾' : '—'}
          </a>
          <div class="rinfo">
            <div class="rtitle">${esc(r.store)}</div>
            <div class="rmeta">${esc(r.date)} · ${money(r.total)} · by ${esc(r.uploaded_by_name || '—')}</div>
          </div>
          ${canDelete ? `<form method="post" action="/receipts/${esc(r.id)}/delete" onsubmit="return confirm('Delete this receipt?')">
            <input type="hidden" name="month" value="${esc(month)}">
            <button class="btn danger sm" type="submit">Delete</button>
          </form>` : ''}
        </div>`;
      }).join('')
    : `<p class="muted">No receipts for ${esc(summary.prettyMonth(month))} yet. Upload your first one!</p>`;

  return layout('Dashboard', `
    ${nav(user, isAdmin)}
    <div class="card">
      <div class="monthnav">
        <a class="btn sm" href="/app?month=${esc(summary.prevMonth(month))}">‹ Prev</a>
        <div>
          <div class="monthtitle">${esc(summary.prettyMonth(month))}</div>
          <input type="month" value="${esc(month)}" onchange="location.href='/app?month='+this.value" aria-label="Choose month">
        </div>
        <a class="btn sm" href="/app?month=${esc(summary.nextMonth(month))}">Next ›</a>
      </div>
    </div>

    <div class="card budget">
      ${data.budgetPrompt ? `
        <form method="post" action="/budget/start">
          <h2>How much money are you starting with this month?</h2>
          <p class="muted">Set the grocery budget for ${esc(summary.prettyMonth(month))}.</p>
          ${data.budgetError ? `<p class="err">${esc(data.budgetError)}</p>` : ''}
          <label class="grow">Starting amount ($)
            <input name="amount" inputmode="decimal" value="${esc(String(data.budgetPrompt.prefill))}" required>
          </label>
          <button class="btn primary" type="submit">Set budget</button>
        </form>
      ` : `
        <div class="brow"><span>Starting budget</span><strong>${money(data.base)}</strong></div>
        ${data.added > 0 ? `<div class="brow"><span>Added funds</span><strong class="pos">+${money(data.added)}</strong></div>` : ''}
        <div class="brow"><span>Total budget</span><strong>${money(data.budget)}</strong></div>
        <div class="brow big"><span>Spent</span><strong>${money(data.spent)}</strong></div>
        <div class="brow big ${over ? 'neg' : 'pos'}"><span>Remaining</span><strong>${money(data.remaining)}</strong></div>
        <div class="bar"><div class="fill ${over ? 'over' : ''}" style="width:${pct}%"></div></div>
        <div class="muted small">${data.receiptCount} receipt${data.receiptCount === 1 ? '' : 's'} · ${pct}% of budget${over ? ' — over budget!' : ''}</div>
        ${data.budgetError ? `<p class="err">${esc(data.budgetError)}</p>` : ''}
        <form method="post" action="/budget/add" class="inline addmoney">
          <label class="grow">Add money ($)<input name="amount" inputmode="decimal" placeholder="e.g. 100" required></label>
          <button class="btn sm" type="submit">Add money</button>
        </form>
      `}
    </div>

    <div class="card">
      <h2>Spending by item</h2>
      <table><thead><tr><th>Item</th><th class="num">Total</th></tr></thead><tbody>${itemRows}</tbody></table>
    </div>

    <div class="card">
      <h2>Spending by store</h2>
      <table><thead><tr><th>Store</th><th class="num">Total</th></tr></thead><tbody>${storeRows}</tbody></table>
    </div>

    <div class="card">
      <h2>Receipts</h2>
      ${receiptCards}
    </div>
  `, user);
}

const STORE_SUGGESTIONS = ['Walmart', 'India Bazaar', 'Costco', 'Target', 'Aldi', 'Kroger', 'Sam\u2019s Club', 'Whole Foods'];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function uploadPage(user, isAdmin, error) {
  const options = STORE_SUGGESTIONS.map((s) => `<option value="${esc(s)}">`).join('');
  return layout('Upload receipt', `
    ${nav(user, isAdmin)}
    <div class="card narrow">
      <h1>Upload receipt</h1>
      <p class="muted">Take a photo of the receipt — iPhone HEIC photos work too. The app will read the items — you'll review them before anything is saved.</p>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <form method="post" action="/upload" enctype="multipart/form-data" id="uploadForm">
        <label>Receipt photo
          <input type="file" name="photo" accept="image/*" capture="environment" required>
        </label>
        <label>Store
          <input name="store" list="stores" placeholder="e.g. Walmart" autocomplete="off">
          <datalist id="stores">${options}</datalist>
        </label>
        <label>Date<input name="date" type="date" value="${todayStr()}" required></label>
        <button class="btn primary" type="submit" id="uploadBtn">Read receipt</button>
        <p class="muted small" id="uploadNote" hidden>⏳ Reading the receipt… this can take up to a minute the first time.</p>
      </form>
    </div>
  `, user);
}

function reviewPage(user, isAdmin, { photo, store, date, items, detectedTotal, ocrOk }) {
  const rows = items.map((it) => `
    <div class="item-row">
      <input name="item_name" value="${esc(it.name_raw)}" placeholder="Item name" autocomplete="off">
      <input name="item_price" value="${it.price.toFixed(2)}" inputmode="decimal" placeholder="0.00" aria-label="Price">
      <button type="button" class="btn sm danger" onclick="removeRow(this)" aria-label="Remove item">✕</button>
    </div>`).join('');

  return layout('Review receipt', `
    ${nav(user, isAdmin)}
    <div class="card">
      <h1>Review items</h1>
      ${ocrOk
        ? `<p class="muted">${items.length} item${items.length === 1 ? '' : 's'} found. Fix anything the camera misread, then save.</p>`
        : `<p class="warn">⚠️ Couldn't read this photo automatically — please add the items by hand.</p>`}
      ${detectedTotal != null ? `<p class="muted small">Receipt total detected: <strong>${money(detectedTotal)}</strong> (compare with your items total below)</p>` : ''}
      <form method="post" action="/save" id="reviewForm">
        <input type="hidden" name="photo" value="${esc(photo)}">
        <div class="grid2">
          <label>Store<input name="store" value="${esc(store)}" required></label>
          <label>Date<input name="date" type="date" value="${esc(date)}" required></label>
        </div>
        ${photo ? `<a href="/uploads/${esc(photo)}" target="_blank" rel="noopener" class="muted small">View receipt photo</a>` : ''}
        <div id="rows">${rows}</div>
        <button type="button" class="btn sm" onclick="addRow()">+ Add item</button>
        <div class="totalbar">Items total: <strong id="liveTotal">$0.00</strong></div>
        <button class="btn primary" type="submit">Save receipt</button>
        <a class="btn" href="/upload">Cancel</a>
      </form>
    </div>
  `, user);
}

function adminPage(user, { members, budget, addedThisMonth, monthLabel, error, msg }) {
  const rows = members.map((m) => `
    <div class="mrow">
      <div><strong>${esc(m.username)}</strong><div class="muted small">member</div></div>
      <div class="mactions">
        <form method="post" action="/admin/members/${esc(m.id)}/reset" class="inline">
          <input name="password" type="text" placeholder="New password" required minlength="4" autocomplete="off">
          <button class="btn sm" type="submit">Reset password</button>
        </form>
        <form method="post" action="/admin/members/${esc(m.id)}/delete" class="inline" onsubmit="return confirm('Delete ${esc(m.username)}? Their receipts stay.')">
          <button class="btn sm danger" type="submit">Delete</button>
        </form>
      </div>
    </div>`).join('') || '<p class="muted">No members yet. Create the first login below.</p>';

  return layout('Admin', `
    ${nav(user, true)}
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    ${msg ? `<p class="ok">${esc(msg)}</p>` : ''}
    <div class="card">
      <h1>Monthly budget</h1>
      <p class="muted">Starting budget for <strong>${esc(monthLabel || '')}</strong>${(addedThisMonth || 0) > 0 ? ` · added this month: <strong class="pos">+${money(addedThisMonth)}</strong>` : ''}. Past months keep their own budgets.</p>
      <form method="post" action="/admin/budget" class="inline">
        <label class="grow">Base budget ($)<input name="budget" inputmode="decimal" value="${esc(String(budget))}" required></label>
        <button class="btn primary" type="submit">Save</button>
      </form>
    </div>
    <div class="card">
      <h1>Family logins</h1>
      <p class="muted">Create a login for each family member. They all share the same budget and receipts.</p>
      <form method="post" action="/admin/members/create" class="grid2">
        <label>Username<input name="username" required minlength="3" maxlength="24" autocomplete="off"></label>
        <label>Password<input name="password" type="text" required minlength="4" autocomplete="off"></label>
        <button class="btn primary" type="submit">Create login</button>
      </form>
    </div>
    <div class="card">
      <h2>Members</h2>
      ${rows}
    </div>
  `, user);
}

module.exports = { layout, loginPage, dashboardPage, uploadPage, reviewPage, adminPage, esc, money, todayStr };
