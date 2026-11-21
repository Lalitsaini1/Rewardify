# Rewardify Deployment & Admin Account Setup Guide

## 1. Enable Email/Password & Google Sign-In in Firebase Console
Firebase provisioning enables Google Sign-In by default. Before signing in as Admin (or allowing users to register with Email & Password):
1. Open the [Firebase Console](https://console.firebase.google.com/) and select project **`gen-lang-client-0157034067`**.
2. Navigate to **Authentication -> Sign-in method**.
3. Click **Add new provider -> Email/Password**, toggle **Enable**, and save.
4. Confirm **Google** is enabled under Sign-in providers.
5. Under **Authentication -> Settings -> Authorized domains**, verify your preview/production domain is listed.

---

## 2. Secure Initial Admin Account Setup (Choose Method A or Method B)

### Method A: Firebase Admin SDK Setup Script or Cloud Function (Custom Email, Password & Custom Claims)
Use this method when running on a **user-owned / Blaze** Firebase project with IAM access:

#### Option A1 — Interactive CLI Setup Script (Zero Hardcoded Passwords)
```bash
cd functions
npm install
# Authenticate with Google Cloud ADC for your Firebase project:
gcloud auth application-default login
# Run interactive setup (prompts for your chosen Admin Email, Name, and Password):
npm run setup-admin
```
This script:
- Creates or updates the Firebase Auth user with your chosen Email and Password (`emailVerified: true`).
- Assigns Firebase Custom Claims `{ admin: true, role: "admin" }` via `setCustomUserClaims()`.
- Creates `/admins/{uid}`, sets `/users/{uid}.role = "admin"`, initializes `/wallets/{uid}`, and logs an immutable audit event in Firestore database `ai-studio-0c95fbf6-ffe1-4bc2-b901-bd3079fc4e9e`.

#### Option A2 — One-Time Cloud Function (`bootstrapInitialAdmin`)
Deploy Cloud Functions with a one-time bootstrap secret (never hardcoded in source):
```bash
cd functions
npm install
npm run build
firebase functions:secrets:set ADMIN_BOOTSTRAP_SECRET
firebase functions:secrets:set RAZORPAY_KEY_ID
firebase functions:secrets:set RAZORPAY_KEY_SECRET
firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET
firebase deploy --only functions
```
Call `bootstrapInitialAdmin({ email, password, displayName, bootstrapSecret })` once. It automatically locks itself permanently as soon as an Admin exists in `/admins`.

### Method B: Starter Tier (AI Studio Hosted Project) Email & Password Setup
If you are using the AI Studio Starter Tier project (`gen-lang-client-0157034067`) without upgrading IAM/Billing:
1. Enable **Email/Password** in Firebase Console (**Authentication -> Sign-in method**).
2. Create your Admin user:
   - Either register via `/register` (or **Authentication -> Users -> Add user**) using your primary bootstrapped Admin email (`lalit.kumar@oorjaa.tech`), verify your email link, and sign in at `/admin/login`.
   - Or, to designate a different custom Email/Password account as Admin:
     1. Create/register the user in **Authentication -> Users** (and verify their email).
     2. Copy their **User UID** from Firebase Console.
     3. In **Firestore Database (`ai-studio-0c95fbf6-ffe1-4bc2-b901-bd3079fc4e9e`)**, add document `/admins/<USER_UID>` with fields:
        - `uid` (string): `<USER_UID>`
        - `email` (string): `<your-admin-email>`
        - `grantedBy` (string): `"console_setup"`
        - `createdAt` (timestamp): current time
3. Visit **`/admin/login`** (or click **Admin Login** in the footer) and sign in with your Email and Password. You will be routed directly to the **Admin Dashboard** (`/admin`). Normal registered users cannot access `/admin` and are automatically redirected to the **User Dashboard**.

---

## 3. Configure Payment Gateway Credentials (Razorpay)
Never store secret gateway credentials in client-side code or Firestore. Set these server environment variables in AI Studio Secrets / hosting config:
- `RAZORPAY_KEY_ID` — Public Razorpay Key ID
- `RAZORPAY_KEY_SECRET` — Private Razorpay Secret for HMAC-SHA256 verification
- `RAZORPAY_WEBHOOK_SECRET` — Private Webhook Secret for `/api/payments/webhook`

When gateway keys are omitted, Rewardify safely operates in **Admin-Verified Dynamic UPI QR** mode (`upi://pay?...`).

---

## 4. Deploy Firestore Security Rules
```bash
npm run lint
npx eslint firestore.rules
firebase deploy --only firestore:rules
```

---

## 5. Build & Run Production Server
```bash
npm run build
NODE_ENV=production npm start
```
