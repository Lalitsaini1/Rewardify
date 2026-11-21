import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { buildUpiPaymentUri } from './src/utils/rewardifyLogic';
import { pickNextRotatedUpiAccount } from './src/utils/upiAnalyticsLogic';
import type { UpiAccount, UpiRotationState } from './src/types/rewardify';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

interface FirebaseConfigFile {
  projectId: string;
  firestoreDatabaseId?: string;
}

function loadFirebaseConfig(): { projectId: string; databaseId: string } {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, 'firebase-applet-config.json'), 'utf8');
    const parsed = JSON.parse(raw) as FirebaseConfigFile;
    return {
      projectId: parsed.projectId || '',
      databaseId: parsed.firestoreDatabaseId || '(default)',
    };
  } catch {
    return { projectId: '', databaseId: '(default)' };
  }
}

const { projectId: FIREBASE_PROJECT_ID, databaseId: FIRESTORE_DATABASE_ID } = loadFirebaseConfig();
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

interface VerifiedAuthUser {
  uid: string;
  email: string;
  emailVerified: boolean;
}

async function verifyFirebaseBearerToken(authHeader: string | undefined): Promise<VerifiedAuthUser | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token || !FIREBASE_PROJECT_ID) return null;

  try {
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
    const uid = typeof payload.sub === 'string' ? payload.sub : '';
    const email = typeof payload.email === 'string' ? payload.email : '';
    const emailVerified = payload.email_verified === true;
    if (!uid) return null;
    return { uid, email, emailVerified };
  } catch {
    return null;
  }
}

function timingSafeCompareHex(expectedHex: string, actualHex: string): boolean {
  try {
    const a = Buffer.from(expectedHex, 'utf8');
    const b = Buffer.from(actualHex, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

interface FirestoreFieldValue {
  stringValue?: string;
  integerValue?: string;
  timestampValue?: string;
}

interface FirestoreDocument {
  fields?: Record<string, FirestoreFieldValue>;
}

function parseTimestampMs(iso?: string): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

async function fetchBackendUpiRotationSelection(idToken: string): Promise<{
  fetched: boolean;
  activeAccounts: UpiAccount[];
  selected: UpiAccount | null;
}> {
  if (!FIREBASE_PROJECT_ID || !idToken) {
    return { fetched: false, activeAccounts: [], selected: null };
  }

  const baseUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}/documents`;
  const headers = {
    Authorization: `Bearer ${idToken}`,
    'Content-Type': 'application/json',
  };

  try {
    const [accountsRes, rotationRes] = await Promise.all([
      fetch(`${baseUrl}:runQuery`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'upiAccounts' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'status' },
                op: 'EQUAL',
                value: { stringValue: 'active' },
              },
            },
          },
        }),
      }),
      fetch(`${baseUrl}/upiRotation/global`, { headers }),
    ]);

    if (!accountsRes.ok) {
      return { fetched: false, activeAccounts: [], selected: null };
    }

    const queryRows = (await accountsRes.json()) as Array<{ document?: FirestoreDocument }>;
    const activeAccounts: UpiAccount[] = [];
    for (const row of queryRows) {
      const f = row.document?.fields;
      if (!f) continue;
      const upiAccountId = f.upiAccountId?.stringValue || '';
      const upiId = f.upiId?.stringValue || '';
      const displayName = f.displayName?.stringValue || 'Rewardify';
      const status = f.status?.stringValue === 'active' ? 'active' : 'disabled';
      const createdMs = parseTimestampMs(f.createdAt?.timestampValue);
      const updatedMs = parseTimestampMs(f.updatedAt?.timestampValue);
      if (upiAccountId && upiId && status === 'active') {
        activeAccounts.push({
          upiAccountId,
          upiId,
          displayName,
          status,
          createdAt: { toMillis: () => createdMs } as UpiAccount['createdAt'],
          updatedAt: { toMillis: () => updatedMs } as UpiAccount['updatedAt'],
        });
      }
    }

    let rotationState: Pick<UpiRotationState, 'lastUpiAccountId' | 'sequenceNumber'> | null = null;
    if (rotationRes.ok) {
      const rotDoc = (await rotationRes.json()) as FirestoreDocument;
      if (rotDoc.fields) {
        rotationState = {
          lastUpiAccountId: rotDoc.fields.lastUpiAccountId?.stringValue || '',
          sequenceNumber: Number(rotDoc.fields.sequenceNumber?.integerValue || 0),
        };
      }
    }

    const selected = pickNextRotatedUpiAccount(activeAccounts, rotationState);
    return { fetched: true, activeAccounts, selected };
  } catch {
    return { fetched: false, activeAccounts: [], selected: null };
  }
}

async function startServer() {
  const app = express();

  // Raw body capture for webhook HMAC verification
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  app.get('/api/health', (_req, res) => {
    const razorpayConfigured = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
    res.json({
      status: 'ok',
      projectId: FIREBASE_PROJECT_ID,
      gatewayConfigured: razorpayConfigured,
      provider: razorpayConfigured ? 'razorpay' : 'upi_manual',
    });
  });

  app.get('/api/payments/gateway-config', (_req, res) => {
    const keyId = process.env.RAZORPAY_KEY_ID || '';
    const hasSecret = Boolean(process.env.RAZORPAY_KEY_SECRET);
    res.json({
      configured: Boolean(keyId && hasSecret),
      provider: keyId && hasSecret ? 'razorpay' : 'upi_manual',
      keyId: keyId && hasSecret ? keyId : null,
    });
  });

  app.post('/api/payments/create-order', async (req, res) => {
    const user = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: Valid Firebase ID token required.' });
      return;
    }
    if (!user.emailVerified) {
      res.status(403).json({ error: 'Email verification is required before initiating payments.' });
      return;
    }

    const body = req.body as { amount?: unknown; paymentId?: unknown; currency?: unknown };
    const amount = Number(body.amount);
    const paymentId = typeof body.paymentId === 'string' ? body.paymentId.trim() : '';

    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      res.status(400).json({ error: 'Invalid payment amount.' });
      return;
    }
    if (!paymentId || !/^[a-zA-Z0-9_-]{3,128}$/.test(paymentId)) {
      res.status(400).json({ error: 'Invalid payment reference ID.' });
      return;
    }

    const bearerToken = req.headers.authorization?.slice('Bearer '.length).trim() || '';
    const rotationResult = await fetchBackendUpiRotationSelection(bearerToken);

    if (rotationResult.fetched && rotationResult.activeAccounts.length === 0) {
      res.status(409).json({
        code: 'NO_ACTIVE_UPI',
        error: 'All merchant UPI IDs are currently disabled or unavailable. Please contact Admin.',
      });
      return;
    }

    const selectedUpi = rotationResult.selected
      ? {
          upiAccountId: rotationResult.selected.upiAccountId,
          upiId: rotationResult.selected.upiId,
          displayName: rotationResult.selected.displayName,
        }
      : null;

    const upiUri = selectedUpi
      ? buildUpiPaymentUri({
          upiId: selectedUpi.upiId,
          displayName: selectedUpi.displayName || 'Rewardify',
          amount,
          reference: paymentId,
          note: `Deposit ${paymentId}`,
        })
      : null;

    const keyId = process.env.RAZORPAY_KEY_ID || '';
    const keySecret = process.env.RAZORPAY_KEY_SECRET || '';

    if (!keyId || !keySecret) {
      res.json({
        configured: false,
        mode: 'upi_manual',
        paymentId,
        amount,
        currency: 'INR',
        backendUpiFetched: rotationResult.fetched,
        activeUpiCount: rotationResult.activeAccounts.length,
        selectedUpi,
        upiUri,
        message:
          'Dynamic UPI QR generated from active Admin rotation pool. Complete payment and submit UTR for verification.',
      });
      return;
    }

    try {
      const authBasic = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
      const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authBasic}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: Math.round(amount * 100),
          currency: 'INR',
          receipt: paymentId.slice(0, 40),
          notes: {
            uid: user.uid,
            paymentId,
          },
        }),
      });

      const rzpData = (await rzpRes.json()) as { id?: string; amount?: number; currency?: string; error?: { description?: string } };
      if (!rzpRes.ok || !rzpData.id) {
        res.status(502).json({
          error: rzpData.error?.description || 'Failed to create order with Razorpay.',
        });
        return;
      }

      res.json({
        configured: true,
        mode: 'razorpay',
        keyId,
        orderId: rzpData.id,
        amount: rzpData.amount,
        currency: rzpData.currency || 'INR',
        paymentId,
      });
    } catch {
      res.status(502).json({ error: 'Payment gateway communication failed.' });
    }
  });

  app.post('/api/payments/verify-signature', async (req, res) => {
    const user = await verifyFirebaseBearerToken(req.headers.authorization);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: Valid Firebase ID token required.' });
      return;
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
    if (!keySecret) {
      res.status(503).json({
        verified: false,
        error: 'Gateway secret is not configured on the server. Use Admin UTR verification or configure RAZORPAY_KEY_SECRET.',
      });
      return;
    }

    const body = req.body as {
      razorpay_order_id?: unknown;
      razorpay_payment_id?: unknown;
      razorpay_signature?: unknown;
    };

    const orderId = typeof body.razorpay_order_id === 'string' ? body.razorpay_order_id.trim() : '';
    const paymentId = typeof body.razorpay_payment_id === 'string' ? body.razorpay_payment_id.trim() : '';
    const signature = typeof body.razorpay_signature === 'string' ? body.razorpay_signature.trim() : '';

    if (!orderId || !paymentId || !signature) {
      res.status(400).json({ verified: false, error: 'Missing required payment signature fields.' });
      return;
    }

    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (!timingSafeCompareHex(expectedSignature, signature)) {
      res.status(400).json({ verified: false, error: 'Cryptographic signature verification failed.' });
      return;
    }

    res.json({
      verified: true,
      orderId,
      gatewayPaymentId: paymentId,
      verifiedUid: user.uid,
      verifiedAt: new Date().toISOString(),
    });
  });

  app.post('/api/payments/webhook', (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    if (!webhookSecret) {
      res.status(503).json({ error: 'Webhook secret not configured.' });
      return;
    }

    const signature = req.header('x-razorpay-signature') || '';
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
    if (!signature || !rawBody) {
      res.status(400).json({ error: 'Missing webhook signature or payload.' });
      return;
    }

    const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    if (!timingSafeCompareHex(expected, signature)) {
      res.status(401).json({ error: 'Invalid webhook signature.' });
      return;
    }

    const eventPayload = req.body as { event?: string; payload?: unknown };
    res.json({ received: true, event: eventPayload.event || 'unknown' });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Rewardify server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
