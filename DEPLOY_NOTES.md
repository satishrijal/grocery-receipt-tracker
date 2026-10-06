# Deploy notes — v2 (household finance upgrade)

You already have the v1 app repo + Render service (or the v1 zip). This is an
**update, not a new service**. All from your iPhone browser, no terminal.

## What you're uploading

The v2 source (this folder). It adds: Gmail self-signup + email verification,
houses with invite codes, monthly collection split per member, per-member
top-ups, and low-balance (< $50) alerts. Old admin-created logins, receipts,
and budgets carry over untouched.

## Steps (do these yourself — I can't touch your accounts)

1. **GitHub** → open your existing `grocery-receipt-tracker` repo → *Add file →
   Upload files* → drag in ALL files from this v2 folder (server.js, email.js,
   store.js, auth.js, views.js, summary.js, parser.js, heic.js, multipart.js,
   package.json, package-lock.json, public/, test/, README.md,
   DEPLOY_NOTES.md). **Skip `node_modules`** and **skip `data/`**. Commit.
   Render will auto-redeploy (a minute or two).

2. **Resend (free)** — needed for the verification + low-balance emails:
   - resend.com → sign up free (100 emails/day, no card).
   - *API Keys* → create one → copy it.
   - Render → your service → *Environment* → add `RESEND_API_KEY` = the key.
   - Optional: add `FROM_EMAIL` = an address on a domain you verified in
     Resend. If you skip this, emails come from `onboarding@resend.dev`,
     which Resend only delivers to your own address — fine for testing,
     verify a domain before the whole family signs up.

3. **ADMIN_USER / ADMIN_PASS** — unchanged, leave them as they are.

4. **DATABASE_URL** — unchanged. If v1 ran on the JSON file, v2 keeps using
   it; if you added Postgres, the new tables/columns are created
   automatically on first boot and your data migrates as before.

## If you skip step 2

The app still runs. New signups will see "email isn't set up yet — ask the
admin", and the Admin page shows each unverified member's verification link
plus a **Verify by hand** button. Low-balance alerts still show in the app;
the emails just won't send until you add the key.

## After deploy

1. Log in as admin → **Admin** → create a **house** → copy the invite code.
2. Set the **monthly collection** (default $500).
3. Family: open the app → **Sign up with your Gmail** → click the email link →
   log in → **Join your house** with the invite code.
4. Everyone snaps receipts as before — spending is now tracked per member.

## Rollback

The v1 zip is untouched at `~/workspace/your_files/grocery-receipt-tracker.zip`.
Re-upload those files to GitHub if you ever need to go back (data stays safe).
