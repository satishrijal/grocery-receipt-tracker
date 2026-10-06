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
<meta name="theme-color" content="#01566d">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Home Finance">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
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

function loginPage(error, opts = {}) {
  return layout('Log in', `
    <div class="card narrow">
      <h1>Welcome back</h1>
      <p class="muted">Log in to track this month's grocery spending.</p>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <form method="post" action="/login">
        <label>Username or Gmail<input name="username" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary" type="submit">Log in</button>
      </form>
      ${opts.showResend ? `
        <form method="post" action="/verify/resend" class="inline" style="margin-top:12px">
          <input type="hidden" name="email" value="${esc(opts.resendEmail || '')}">
          <button class="btn sm" type="submit">Resend verification email</button>
        </form>` : `
        <p class="muted small" style="margin-top:12px">New here? <a href="/signup">Sign up with your Gmail</a></p>
        <p class="muted small">Didn't get the verification link? <a href="/verify/resend">Resend it</a></p>`}
    </div>`);
}

// v3: member login via Firebase phone auth (SMS code). cfg = { apiKey,
// authDomain, projectId } from the server env. When Firebase isn't
// configured, show a graceful notice instead of a broken form.
function phoneLoginPage(cfg) {
  const ready = cfg && cfg.apiKey && cfg.authDomain && cfg.projectId;
  if (!ready) {
    return layout('Log in', `
    <div class="card narrow">
      <h1>Log in &#x1F4F1;</h1>
      <p class="warn">&#x26A0;&#xFE0F; Phone login isn&rsquo;t set up on this server yet. Ask the admin (Satish) to add the Firebase keys in the Render dashboard, then come back.</p>
      <p class="muted small"><a href="/login/password">Log in with password (admin or older accounts)</a></p>
    </div>`);
  }
  const cfgJson = JSON.stringify({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId })
    .replace(/</g, '\\u003c');
  return layout('Log in', `
    <div class="card narrow">
      <h1>Log in &#x1F4F1;</h1>
      <p class="muted">Enter your phone number &mdash; we&rsquo;ll text you a code. No password needed.</p>
      <p id="phone-err" class="err" hidden></p>
      <div id="step-phone">
        <label>Phone number<input id="phone" type="tel" autocomplete="tel" inputmode="tel" value="+1"></label>
        <button id="send-code" class="btn primary" type="button">Text me a code</button>
      </div>
      <div id="step-code" hidden>
        <label>Code from the text<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code"></label>
        <button id="verify-code" class="btn primary" type="button">Verify &amp; log in</button>
        <p class="muted small"><a href="#" id="change-number">Use a different number</a></p>
      </div>
      <div id="step-name" hidden>
        <p class="muted">First time here? Tell us your name to finish creating your account.</p>
        <label>Your name<input id="display-name" autocomplete="name" maxlength="40"></label>
        <button id="finish-signup" class="btn primary" type="button">Continue</button>
      </div>
      <p class="muted small" style="margin-top:12px"><a href="/login/password">Log in with password (admin or older accounts)</a></p>
    </div>
    <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
    <script>
    (function () {
      var cfg = ${cfgJson};
      var errBox = document.getElementById('phone-err');
      function showErr(m) { errBox.textContent = m; errBox.hidden = false; }
      function clearErr() { errBox.hidden = true; }
      function show(id) {
        ['step-phone', 'step-code', 'step-name'].forEach(function (s) {
          document.getElementById(s).hidden = (s !== id);
        });
      }
      function normPhone(v) {
        var t = String(v || '').trim();
        if (/^\\+\d{7,15}$/.test(t)) return t;
        var d = t.replace(/\\D/g, '');
        if (d.length === 10) return '+1' + d;
        if (d.length === 11 && d[0] === '1') return '+' + d;
        return null;
      }
      function friendly(e) {
        var c = (e && e.code) || '';
        if (c === 'auth/invalid-phone-number') return 'That phone number looks invalid.';
        if (c === 'auth/too-many-requests') return 'Too many tries \\u2014 wait a bit and try again.';
        if (c === 'auth/quota-exceeded') return 'Texting is temporarily unavailable \\u2014 try again later.';
        if (c === 'auth/user-disabled') return 'This login is disabled.';
        return 'Something went wrong \\u2014 try again.';
      }
      var confirmationResult = null;
      var idToken = null;
      function postSession(payload) {
        return fetch('/auth/phone/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (r) { return r.json(); });
      }
      try { firebase.initializeApp(cfg); }
      catch (e) { showErr('Could not start phone login. Please try again later.'); return; }
      var fbAuth = firebase.auth();
      var verifier;
      try { verifier = new firebase.auth.RecaptchaVerifier('send-code', { size: 'invisible' }); }
      catch (e) { showErr('Could not start the bot check. Please reload and try again.'); return; }
      document.getElementById('send-code').addEventListener('click', function () {
        clearErr();
        var phone = normPhone(document.getElementById('phone').value);
        if (!phone) { showErr('Enter a valid phone number.'); return; }
        var btn = this;
        btn.disabled = true;
        fbAuth.signInWithPhoneNumber(phone, verifier).then(function (cr) {
          confirmationResult = cr;
          show('step-code');
        }).catch(function (e) {
          btn.disabled = false;
          showErr(friendly(e));
        });
      });
      document.getElementById('verify-code').addEventListener('click', function () {
        clearErr();
        var code = document.getElementById('code').value.trim();
        if (!confirmationResult) { showErr('Please request a code first.'); return; }
        var btn = this;
        btn.disabled = true;
        confirmationResult.confirm(code).then(function (cred) {
          return cred.user.getIdToken();
        }).then(function (tok) {
          idToken = tok;
          return postSession({ idToken: tok });
        }).then(function (j) {
          if (j.ok) { window.location.href = j.redirect || '/app'; return; }
          if (j.code === 'needs-name') { show('step-name'); return; }
          showErr('Login failed \\u2014 please try again.');
          btn.disabled = false;
        }).catch(function () {
          showErr('Wrong code \\u2014 check the text and try again.');
          btn.disabled = false;
        });
      });
      document.getElementById('finish-signup').addEventListener('click', function () {
        clearErr();
        var name = document.getElementById('display-name').value.trim();
        if (!name) { showErr('Please enter your name.'); return; }
        var btn = this;
        btn.disabled = true;
        postSession({ idToken: idToken, name: name }).then(function (j) {
          if (j.ok) { window.location.href = j.redirect || '/app'; return; }
          showErr('Could not create your account \\u2014 try again.');
          btn.disabled = false;
        }).catch(function () {
          showErr('Could not create your account \\u2014 try again.');
          btn.disabled = false;
        });
      });
      document.getElementById('change-number').addEventListener('click', function (e) {
        e.preventDefault();
        confirmationResult = null;
        show('step-phone');
      });
    })();
    </script>`);
}

function signupPage(error, prefill = {}) {
  return layout('Sign up', `
    <div class="card narrow">
      <h1>Create your account</h1>
      <p class="muted">Sign up with your Gmail — we'll send a verification link before you can log in.</p>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <form method="post" action="/signup">
        <label>Your name<input name="name" value="${esc(prefill.name || '')}" autocomplete="name" maxlength="40" required></label>
        <label>Gmail address<input name="email" type="email" value="${esc(prefill.email || '')}" autocomplete="email" placeholder="you@gmail.com" required></label>
        <label>Password (min 8 characters)<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
        <label>Confirm password<input name="confirm" type="password" autocomplete="new-password" required></label>
        <button class="btn primary" type="submit">Sign up</button>
      </form>
      <p class="muted small" style="margin-top:12px">Already have an account? <a href="/login">Log in</a></p>
    </div>`);
}

function signupDonePage(emailAddr, emailSent) {
  return layout('Check your Gmail', `
    <div class="card narrow">
      <h1>Almost done ✉️</h1>
      <p>We sent a verification link to <strong>${esc(emailAddr)}</strong>. Tap it within 24 hours, then log in.</p>
      ${emailSent
        ? `<p class="muted small">Didn't see it? Check spam, or <a href="/verify/resend">resend the link</a>.</p>`
        : `<p class="warn">⚠️ Email sending isn't set up on this server yet, so the link couldn't be emailed. Ask the admin (Satish) for your verification link — or the admin can verify you by hand from the Admin page.</p>`}
      <p><a class="btn" href="/login">Back to log in</a></p>
    </div>`);
}

function resendPage(error, msg) {
  return layout('Resend verification', `
    <div class="card narrow">
      <h1>Resend verification link</h1>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      ${msg ? `<p class="ok">${esc(msg)}</p>` : ''}
      <form method="post" action="/verify/resend">
        <label>Gmail address<input name="email" type="email" autocomplete="email" placeholder="you@gmail.com" required></label>
        <button class="btn primary" type="submit">Resend link</button>
      </form>
      <p class="muted small" style="margin-top:12px"><a href="/login">Back to log in</a></p>
    </div>`);
}

function verifyResultPage(ok, msg) {
  return layout(ok ? 'Verified!' : 'Link problem', `
    <div class="card narrow">
      ${ok ? `
        <h1>You're verified ✅</h1>
        <p>Your Gmail is confirmed — you can log in now.</p>
        <p><a class="btn primary" href="/login">Log in</a></p>` : `
        <h1>Hmm, that link didn't work</h1>
        <p class="err">${esc(msg || 'Invalid or expired link.')}</p>
        <p><a class="btn" href="/verify/resend">Get a new link</a></p>`}
    </div>`);
}

function dashboardPage({ user, isAdmin, month, data, houseView, adminHouses, joinError, topupError }) {
  houseView = houseView || null;
  adminHouses = adminHouses || null;
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

  // ---- top money card: house share card for members, classic budget otherwise ----
  let moneyCard;
  if (houseView) {
    const hv = houseView;
    moneyCard = `
    <div class="card budget">
      <h2>🏠 ${esc(hv.house.name)}</h2>
      <p class="muted small">Monthly collection ${money(hv.collection)} ÷ ${hv.members.length} member${hv.members.length === 1 ? '' : 's'} · invite code <strong>${esc(hv.house.invite_code)}</strong></p>
      ${!hv.collectionSet ? `<p class="warn small">⚠️ Admin hasn't set this month's collection yet — showing the $500 default.</p>` : ''}
      ${hv.lowBalance ? `
        <div class="lowbanner">
          <strong>⚠️ Money is low — add more money</strong>
          <div class="muted small">You're below $50. Top up so the shopping doesn't stop.</div>
        </div>` : ''}
      <div class="brow"><span>My share</span><strong>${money(hv.share)}</strong></div>
      ${hv.topups > 0 ? `<div class="brow"><span>Added by me</span><strong class="pos">+${money(hv.topups)}</strong></div>` : ''}
      <div class="brow big"><span>My spending</span><strong>${money(hv.spent)}</strong></div>
      <div class="brow big ${hv.remaining < 50 ? 'neg' : 'pos'}"><span>My remaining</span><strong>${money(hv.remaining)}</strong></div>
      <div class="bar"><div class="fill ${over ? 'over' : ''}" style="width:${pct}%"></div></div>
      ${topupError ? `<p class="err">${esc(topupError)}</p>` : ''}
      <form method="post" action="/topup/add" class="inline addmoney">
        <label class="grow">Add money to my share ($)<input name="amount" inputmode="decimal" placeholder="e.g. 50" required></label>
        <button class="btn sm primary" type="submit">Add money</button>
      </form>
      <form method="post" action="/house/leave" onsubmit="return confirm('Leave this house?')" style="margin-top:8px">
        <button class="linkbtn muted small" type="submit">Leave house</button>
      </form>
    </div>`;
  } else {
    moneyCard = `
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
    ${(!isAdmin && !houseView) ? `
    <div class="card">
      <h2>Join your house 🏠</h2>
      <p class="muted">Got an invite code from the admin? Enter it to join the house and get your share of the monthly collection.</p>
      ${joinError ? `<p class="err">${esc(joinError)}</p>` : ''}
      <form method="post" action="/house/join" class="inline">
        <label class="grow">Invite code<input name="code" autocomplete="off" placeholder="e.g. K7Q2MD" required style="text-transform:uppercase"></label>
        <button class="btn primary" type="submit">Join house</button>
      </form>
    </div>` : ''}`;
  }

  // ---- admin: per-house member money table ----
  let houseSections = '';
  if (adminHouses && adminHouses.length) {
    houseSections = adminHouses.map(({ house, collection, members }) => {
      const rows = members.length ? members.map((m) => `
        <tr class="${m.low ? 'lowrow' : ''}">
          <td>${esc(m.name || m.username)}${m.low ? ' ⚠️' : ''}<div class="muted small">${esc(m.username)}${m.email_verified === false ? ' · <span class="warn">unverified</span>' : ''}</div></td>
          <td class="num">${money(m.share)}</td>
          <td class="num">${money(m.spent)}</td>
          <td class="num">${m.topups > 0 ? '+' + money(m.topups) : '—'}</td>
          <td class="num"><strong class="${m.low ? 'neg' : 'pos'}">${money(m.remaining)}</strong></td>
        </tr>`).join('')
        : `<tr><td colspan="5" class="muted">No members yet — share the invite code.</td></tr>`;
      return `<div class="card">
        <h2>🏠 ${esc(house.name)}</h2>
        <p class="muted">Invite code: <strong>${esc(house.invite_code)}</strong> · monthly collection ${money(collection)} · ${members.length} member${members.length === 1 ? '' : 's'}</p>
        <table><thead><tr><th>Member</th><th class="num">Share</th><th class="num">Spent</th><th class="num">Added</th><th class="num">Remaining</th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>`;
    }).join('');
  }

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

    ${moneyCard}
    ${houseSections}

    <div class="card">
      <h2>Spending by item${houseView ? ' (mine)' : ''}</h2>
      <table><thead><tr><th>Item</th><th class="num">Total</th></tr></thead><tbody>${itemRows}</tbody></table>
    </div>

    <div class="card">
      <h2>Spending by store${houseView ? ' (mine)' : ''}</h2>
      <table><thead><tr><th>Store</th><th class="num">Total</th></tr></thead><tbody>${storeRows}</tbody></table>
    </div>

    <div class="card">
      <h2>Receipts${houseView ? ' (mine)' : ''}</h2>
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

function adminPage(user, { members, budget, collection, addedThisMonth, monthLabel, houses, unverified, emailConfigured, error, msg }) {
  houses = houses || [];
  unverified = unverified || [];
  const houseNameOf = (m) => {
    const h = houses.find((hh) => hh.id === m.house_id);
    return h ? h.name : null;
  };

  const houseCards = houses.length ? houses.map((h) => `
    <div class="hrow">
      <div><strong>🏠 ${esc(h.name)}</strong>
        <div class="muted small">Invite code: <strong>${esc(h.invite_code)}</strong> · ${h.members.length} member${h.members.length === 1 ? '' : 's'}</div>
      </div>
      <form method="post" action="/admin/houses/${esc(h.id)}/delete" class="inline" onsubmit="return confirm('Delete house ${esc(h.name)}? Members will be unlinked.')">
        <button class="btn sm danger" type="submit">Delete house</button>
      </form>
    </div>`).join('')
    : '<p class="muted">No houses yet — create one below and share its invite code with the family.</p>';

  const unverifiedRows = unverified.length ? unverified.map((m) => `
    <div class="mrow">
      <div><strong>${esc(m.name || m.username)}</strong><div class="muted small">${esc(m.email || '')}</div></div>
      <div class="mactions">
        <form method="post" action="/admin/members/${esc(m.id)}/verify" class="inline">
          <button class="btn sm primary" type="submit">Verify by hand</button>
        </form>
      </div>
      ${m.verifyLink ? `<div class="muted small" style="flex-basis:100%">Share this link with them: <a href="${esc(m.verifyLink)}">${esc(m.verifyLink)}</a></div>` : ''}
    </div>`).join('') : '';

  const rows = members.map((m) => {
    const hn = houseNameOf(m);
    const verifiedBadge = m.email
      ? (m.email_verified === false ? '<span class="warn small">unverified</span>' : '<span class="ok small">✓ verified</span>')
      : '<span class="muted small">classic login</span>';
    return `
    <div class="mrow">
      <div><strong>${esc(m.name || m.username)}</strong>
        <div class="muted small">${esc(m.username)} · ${verifiedBadge}${hn ? ` · 🏠 ${esc(hn)}` : ''}</div>
      </div>
      <div class="mactions">
        ${m.house_id ? `
        <form method="post" action="/admin/members/${esc(m.id)}/unhouse" class="inline">
          <button class="btn sm" type="submit">Remove from house</button>
        </form>` : ''}
        <form method="post" action="/admin/members/${esc(m.id)}/reset" class="inline">
          <input name="password" type="text" placeholder="New password" required minlength="4" autocomplete="off">
          <button class="btn sm" type="submit">Reset password</button>
        </form>
        <form method="post" action="/admin/members/${esc(m.id)}/delete" class="inline" onsubmit="return confirm('Delete ${esc(m.username)}? Their receipts stay.')">
          <button class="btn sm danger" type="submit">Delete</button>
        </form>
      </div>
    </div>`;
  }).join('') || '<p class="muted">No members yet. Create the first login below, or share a house invite code and let them sign up themselves.</p>';

  return layout('Admin', `
    ${nav(user, true)}
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    ${msg ? `<p class="ok">${esc(msg)}</p>` : ''}
    ${emailConfigured ? '' : `
    <div class="card">
      <p class="warn">⚠️ <strong>Email is not configured.</strong> Verification and low-balance emails won't send — new signups will see a notice instead, and you can verify them by hand below. To fix it: create a free account at resend.com and add <strong>RESEND_API_KEY</strong> in Render → Environment (optional: FROM_EMAIL).</p>
    </div>`}
    <div class="card">
      <h1>Houses</h1>
      <p class="muted">Create a house, share its invite code — family members log in with their phone number (texted code) and join with the code. Each member then gets an equal share of the monthly collection.</p>
      <form method="post" action="/admin/houses/create" class="inline">
        <label class="grow">House name<input name="name" placeholder="e.g. Our Home" maxlength="60" required></label>
        <button class="btn primary" type="submit">Create house</button>
      </form>
      <div style="margin-top:12px">${houseCards}</div>
    </div>
    <div class="card">
      <h1>Monthly collection</h1>
      <p class="muted">How much the house collects for <strong>${esc(monthLabel || '')}</strong> — split equally between members${(addedThisMonth || 0) > 0 ? ` · classic added funds this month: <strong class="pos">+${money(addedThisMonth)}</strong>` : ''}. Past months keep their own numbers.</p>
      <form method="post" action="/admin/collection" class="inline">
        <label class="grow">Collection ($)<input name="collection" inputmode="decimal" value="${esc(String(collection != null ? collection : budget))}" required></label>
        <button class="btn primary" type="submit">Save</button>
      </form>
    </div>
    ${unverifiedRows ? `<div class="card"><h1>Waiting for email verification</h1>${unverifiedRows}</div>` : ''}
    <div class="card">
      <h1>Family logins</h1>
      <p class="muted">Create a classic login for a family member — or let them log in themselves with their phone number and join a house with the invite code.</p>
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

module.exports = { layout, loginPage, phoneLoginPage, signupPage, signupDonePage, resendPage, verifyResultPage, dashboardPage, uploadPage, reviewPage, adminPage, esc, money, todayStr };
