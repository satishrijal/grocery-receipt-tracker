# Firebase setup — phone login for Home Finance

The app's member login now uses **Firebase Phone Auth**: family members type
their phone number, get a texted code, and they're in. No passwords, no
email. Firebase gives **10,000 phone verifications a month free** — way more
than a family will ever use.

Do this once, from your iPhone browser (Safari). Takes about 5 minutes.

## 1. Create the Firebase project

1. Go to **console.firebase.google.com** → sign in with your Google account.
2. Tap **Add project** (or *Create a project*).
3. Name it `home-finance` → Continue.
4. When it asks about Google Analytics → **turn it off** (toggle) → Continue →
   **Create project**. Wait for it to finish → Continue.

## 2. Turn on phone sign-in

1. In the left menu tap **Build** → **Authentication** → **Get started**.
2. Tap the **Sign-in method** tab → tap **Phone** → flip **Enable** to on →
   **Save**.

## 3. Register the web app + copy the keys

1. Back on the project home (tap **Project Overview**), tap the **`</>`**
   (web) icon to add a web app.
2. Nickname: `home-finance-web` → **Register app** (skip hosting).
3. It shows you a code block with `firebaseConfig`. Copy these three values:
   - `apiKey` → this becomes `FIREBASE_API_KEY`
   - `authDomain` → this becomes `FIREBASE_AUTH_DOMAIN`
   - `projectId` → this becomes `FIREBASE_PROJECT_ID`

   (They're public web keys — safe to handle normally. Never paste them to
   anyone in chat; put them straight into Render in the next step.)

## 4. Add the keys to Render

1. **dashboard.render.com** → your `grocery-receipt-tracker` service →
   **Environment**.
2. Add three variables:
   - `FIREBASE_API_KEY` = the apiKey you copied
   - `FIREBASE_AUTH_DOMAIN` = the authDomain you copied
   - `FIREBASE_PROJECT_ID` = the projectId you copied
3. **Save** — Render redeploys automatically (a minute or two).

## 5. IMPORTANT — allow your Render address

Phone login will fail on the live site until you do this:

1. Firebase console → **Build** → **Authentication** → **Settings** tab →
   **Authorized domains**.
2. Tap **Add domain** → type your Render domain exactly as it appears, e.g.
   `grocery-receipt-tracker.onrender.com` → **Add**.
3. (Your localhost is already allowed, so testing on a computer works too.)

## 6. Try it

1. Open your app's URL on your iPhone → you should see **Log in 📱**.
2. Type your phone number → **Text me a code** → enter the code.
3. First time: enter your name → you're logged in → **Join your house** with
   the invite code from the Admin page.

## If phone login shows a warning instead

*"Phone login isn't set up on this server yet"* means one of the three keys
is missing on Render — re-check step 4 and wait for the deploy to finish.

## Free quota

Phone verification is free up to **10,000 verifications/month**. After that
Firebase would charge, but a family will never get close. The app itself
never sends paid SMS alerts — low-balance warnings stay in-app (plus email
if you kept the optional Resend key).
