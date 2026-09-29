# 🧾 Grocery Receipt Tracker

Family grocery budget app. Everyone gets a login, snaps a photo of each
grocery receipt (Walmart, India Bazaar, anywhere), the app reads the items
off the photo, you review and fix them, and the dashboard shows this month's
spending: total spent, money left of the **monthly budget**, spending per item
(e.g. $50 on chicken, $50 on water) and per store.

iPhone photos work as-is: **HEIC pictures are converted to JPEG automatically**
before the app reads them.

No terminal needed for any of this — everything below is done in the browser.

## Deploy (browser only)

1. **Create a GitHub repo** named `grocery-receipt-tracker` (github.com → New repository).
2. **Upload the project files**: in the new repo click *Add file → Upload files* and
   drag in everything from this project folder (server.js, package.json, public/,
   all the .js files, README.md). Do NOT upload the `node_modules` folder.
   Commit the files.
3. **Render → New Web Service**: go to dashboard.render.com → *New → Web Service* →
   connect the `grocery-receipt-tracker` repo. Set **Build Command** to
   `npm install` and **Start Command** to `npm start`. (No build step otherwise.)
4. **Environment tab** — add these yourself, never share the values with anyone:
   - `ADMIN_USER` — your admin username (your choice)
   - `ADMIN_PASS` — your admin password (your choice)
   - `DATABASE_URL` — from Neon. You already have a Neon account/project from
     Teen Patti — in the Neon dashboard create a **second database** in the same
     project and copy its connection string here.
5. Click **Deploy**, wait for it to go live, then open the URL.

First visit: log in with your `ADMIN_USER` / `ADMIN_PASS`, open **Admin**, create
a login for each family member. When you first open the dashboard each month,
it asks **"How much money are you starting with this month?"** — it suggests
last month's amount (or $500 the very first time). The admin can also change
the current month's starting budget from the Admin panel.

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
