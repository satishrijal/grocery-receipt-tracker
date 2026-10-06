# 🧾 Home Finance (v3) — was Grocery Receipt Tracker

Family home-finance app: everyone **logs in with their phone number** (a code
is texted to them — no password needed), joins a **house** with an invite
code, and gets an equal **share of the monthly collection** (e.g. $500 ÷ 5 =
$100 each). Snap a photo of each grocery receipt — the app reads the items,
you review and fix them, and your dashboard shows **your** share, spending,
and remaining. Drop **below $50** and you get a low-money alert (in the app,
plus one email per month if email is set up) with an **add-money** button to
top up your share.

**iPhone install:** deploy, then on your iPhone open the URL in Safari →
Share → **Add to Home Screen**. It installs as "Home Finance" with its own
app icon, opening fullscreen like a real app — free, no App Store.

iPhone photos work as-is: **HEIC pictures are converted to JPEG automatically**
before the app reads them.

No terminal needed for any of this — everything below is done in the browser.

## What's new in v3

- **Phone login (Firebase Phone Auth)**: members type their phone number,
  get a texted code, done. 10,000 free verifications/month. See
  **FIREBASE_SETUP.md** for the 5-minute setup. The admin password login and
  older accounts keep working; the Gmail signup pages still exist but are no
  longer the member path.
- **App icon + home-screen install**: new "Home Finance" icon, web manifest,
  and iOS meta tags — Add to Home Screen from Safari.
- Everything else from v2 is unchanged: houses + invite codes, monthly
  collection split per member, per-member top-ups, receipt AI, low-balance
  alerts.

## What v2 added (kept in v3)

- **Self-signup with Gmail**: name + Gmail address + password (min 8 chars).
  A verification link is emailed — **login is blocked until it's clicked**.
  "Resend verification email" is on the login page.
- **Houses + invite codes**: the admin creates a house (Admin → Houses) and
  shares the short invite code. Members sign up and join with the code —
  one house per person.
- **Monthly collection + per-member shares**: the admin sets how much the
  house collects each month (default $500). Each member's share = collection ÷
  members, recalculated live when someone joins. Members see *my share / my
  spending / my remaining*; the admin sees everyone in a per-house table.
- **Receipts stay the same**: photo snap + AI reading + editable review, now
  automatically attributed to whoever uploaded. Members see their own
  item/store breakdowns; the admin sees the whole house.
- **Low-balance alerts (< $50)**: a persistent red banner for the member
  ("⚠️ Money is low — add more money") with an add-money button, one email
  per member per month (no spam), and red flags on the admin's member table.
- **Top-ups**: "Add money" now adds to *your own share* mid-month and is
  logged in history.

Old admin-created logins keep working exactly as before — nothing breaks.

## Deploy (browser only)

1. **Create a GitHub repo** named `grocery-receipt-tracker` (github.com → New repository).
   If the v1 repo already exists, you're just updating it — see DEPLOY_NOTES.md.
2. **Upload the project files**: in the repo click *Add file → Upload files* and
   drag in everything from this project folder (server.js, email.js, package.json,
   public/, all the .js files, README.md, DEPLOY_NOTES.md). Do NOT upload the
   `node_modules` folder. Commit the files.
3. **Render → New Web Service**: go to dashboard.render.com → *New → Web Service* →
   connect the `grocery-receipt-tracker` repo. Set **Build Command** to
   `npm install` and **Start Command** to `npm start`. (No build step otherwise.)
4. **Environment tab** — add these yourself, never share the values with anyone:
   - `ADMIN_USER` — your admin username (your choice, unchanged from v1)
   - `ADMIN_PASS` — your admin password (your choice, unchanged from v1)
   - `DATABASE_URL` — from Neon (unchanged from v1; skip if you never set it)
   - `RESEND_API_KEY` — **new for v2**: from a free resend.com account
     (100 emails/day free). Needed for verification + low-balance emails.
     Without it the app still runs — new signups see a notice and the admin
     verifies them by hand from the Admin page (their links are shown there).
   - `FROM_EMAIL` — optional: the sender address for the emails. Defaults to
     `onboarding@resend.dev` (works without a custom domain, but Resend only
     delivers those to your own address — verify a domain in Resend to email
     the whole family).
5. Click **Deploy**, wait for it to go live, then open the URL.

First visit: log in with your `ADMIN_USER` / `ADMIN_PASS`, open **Admin**,
create a **house**, set the **monthly collection**, and share the invite code
with the family. They sign up at `/signup` with their Gmail and join.

## How it works

- **Upload**: 📸 Upload receipt → take a photo (the camera opens on iPhone).
  Pick the store, check the date, tap *Read receipt*.
- **Review**: the app reads the photo and lists the items it found. **Fix anything
  it misread** — edit names/prices, add or remove rows — then *Save receipt*.
  Nothing is saved until you confirm, so a bad photo read can never corrupt
  your totals.
- **Dashboard**: monthly budget card (starting budget + added funds = total,
  spent vs remaining), spending by item, spending by store, receipt history
  with a month picker. Anyone logged in sees the same shared budget. Delete a
  receipt if you're the admin or you uploaded it.
- **Add money**: ran short mid-month? Tap **Add money** on the dashboard and
  enter the extra amount. Each top-up is recorded as its own entry, so the
  dashboard always shows: starting budget + added funds = total available,
  and remaining = total − spent.

## Notes

- **iPhone HEIC photos**: converted to JPEG automatically on upload
  (via the `heic-convert` package — Render installs it with `npm install`, no
  extra setup). The original HEIC is not kept; the JPEG is what gets read and
  shown.
- **Monthly budgets**: each calendar month keeps its own starting budget plus
  any "Add money" top-ups. Past months keep their numbers when a new month
  starts — nothing carries over or gets overwritten.
- **No new environment variables**: this update needs nothing beyond the
  existing `ADMIN_USER`, `ADMIN_PASS`, and `DATABASE_URL`.

- **Photos on Render's free plan**: uploaded receipt photos live in
  `public/uploads/` on the server disk, which Render wipes on every redeploy.
  Your spending *data* is safe in Postgres — only the photo files reset.
  Moving photos to permanent object storage is a planned future upgrade.
- **First receipt read is slow**: the app downloads its reading engine
  (~15 MB) the first time it sees a photo, then it's cached. Later reads take
  ~20–60 seconds depending on photo size.
- **Database**: with `DATABASE_URL` set, everything lives in Postgres. Without
  it (local testing), the app uses a JSON file in `data/` instead and never
  crashes. If you start on JSON and add Postgres later, your data migrates
  over automatically the first time Postgres boots.
