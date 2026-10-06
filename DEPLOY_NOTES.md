# Deploy notes — v3 (Firebase phone login + app icon + home-screen install)

This is an **update to your existing Render service**, not a new one. All
from your iPhone browser, no terminal.

## What v3 changes

- **Member login is now phone number + texted code** (Firebase Phone Auth,
  10,000 free verifications/month). The Gmail signup + email verification
  pages still exist but are no longer the member path.
- **Admin login (`ADMIN_USER` / `ADMIN_PASS`) is unchanged.** Old
  admin-created and email member logins keep working; their receipts, houses,
  and budgets carry over untouched.
- **New app icon + iPhone home-screen support**: deploy, then on your iPhone
  open the URL in Safari → Share → **Add to Home Screen**. It installs as
  "Home Finance" with its own icon, opening fullscreen like a real app.
- **Resend is now optional.** Low-balance alerts show in the app; the emails
  only send if `RESEND_API_KEY` is still set.

## Steps (do these yourself — I can't touch your accounts)

1. **GitHub** → your existing `grocery-receipt-tracker` repo → *Add file →
   Upload files* → drag in ALL files from this v3 folder (server.js,
   store.js, auth.js, firebase-auth.js, email.js, views.js, summary.js,
   parser.js, heic.js, multipart.js, package.json, package-lock.json,
   public/, test/, README.md, DEPLOY_NOTES.md, FIREBASE_SETUP.md).
   **Skip `node_modules`** and **skip `data/`**. Commit.
   Render will auto-redeploy (a minute or two).

2. **Firebase (free)** — follow **FIREBASE_SETUP.md** in this folder:
   create the project, enable Phone sign-in, copy the three keys, add
   `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID` to
   Render → Environment → Save, then add your `*.onrender.com` domain under
   Firebase → Authentication → Settings → Authorized domains.
   **Do this in parallel — nothing else waits on it.**

3. **ADMIN_USER / ADMIN_PASS / DATABASE_URL** — unchanged, leave them.

4. **Resend** — optional now. Leave `RESEND_API_KEY` if you want the
   low-balance emails too; remove it if not. The app runs fine either way.

## After deploy

1. Log in as admin → **Admin** → create a **house** (if you haven't) → copy
   the invite code. Set the **monthly collection**.
2. Family: open the app → **Log in 📱** → phone number → texted code →
   (first time) enter name → **Join your house** with the invite code.
3. iPhone home screen: Safari → Share → **Add to Home Screen**.

## If you skip step 2 (Firebase)

The app still boots and the admin login works, but the phone login page
shows "Phone login isn't set up on this server yet" until the three keys
are added. Nothing breaks.

## Rollback

The v1 and v2 zips are untouched
(`~/workspace/your_files/grocery-receipt-tracker.zip`,
`~/workspace/your_files/grocery-receipt-tracker-v2.zip`). Re-upload either
to GitHub if you ever need to go back (data stays safe).
