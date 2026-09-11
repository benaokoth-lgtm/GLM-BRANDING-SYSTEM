import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { todayStr } from '@glm/shared';

export const mpesaRouter = Router();

function darajaBaseUrl(): string {
  return process.env.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

function isConfigured(): boolean {
  return !!(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET && process.env.MPESA_SHORTCODE && process.env.MPESA_PASSKEY && process.env.MPESA_CALLBACK_URL);
}

// Normalizes a Kenyan phone number to the 2547XXXXXXXX / 2541XXXXXXXX shape
// Daraja requires — accepts the common local forms staff are likely to type
// (07xx…, 01xx…, +2547xx…, 2547xx… already).
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^[17]\d{8}$/.test(digits)) return '254' + digits;
  return null;
}

async function getAccessToken(): Promise<string> {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await fetch(`${darajaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error('Failed to authenticate with M-Pesa');
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

function darajaTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const stkPushSchema = z.object({
  phone: z.string().min(9),
  amount: z.number().positive(),
  accountReference: z.string().min(1).max(40),
  description: z.string().max(100).optional(),
  orderId: z.number().int().optional(),
});

// Initiates an STK push (a payment prompt on the customer's own phone) —
// used both during order capture (before the order exists yet — orderId
// omitted, see NewWalkinOrder.tsx) and from an existing order's payment
// flow (orderId set — see OrderDetailDialog.tsx). Returns immediately with
// a checkoutRequestId; the actual result arrives asynchronously via
// /callback (production, with a public HTTPS URL configured) or is
// confirmed by staff via /:checkoutRequestId/confirm-manually once they've
// verified payment through other means (e.g. the till's own SMS alert).
mpesaRouter.post('/stkpush', requireAuth, async (req, res) => {
  if (!isConfigured()) {
    return res.status(501).json({ error: 'M-Pesa STK push isn\'t configured yet — set MPESA_* in apps/api/.env (see comments there)' });
  }
  const parsed = stkPushSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan phone number (e.g. 07xx xxx xxx)' });

  try {
    const token = await getAccessToken();
    const shortcode = process.env.MPESA_SHORTCODE!;
    const timestamp = darajaTimestamp();
    const password = Buffer.from(`${shortcode}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');

    const stkRes = await fetch(`${darajaBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(parsed.data.amount),
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: process.env.MPESA_CALLBACK_URL,
        AccountReference: parsed.data.accountReference,
        TransactionDesc: parsed.data.description || parsed.data.accountReference,
      }),
    });
    const stkData = (await stkRes.json()) as { CheckoutRequestID?: string; MerchantRequestID?: string; errorMessage?: string; ResponseDescription?: string };
    if (!stkRes.ok || !stkData.CheckoutRequestID) {
      return res.status(502).json({ error: stkData.errorMessage || stkData.ResponseDescription || 'M-Pesa rejected the STK push request' });
    }

    await prisma.mpesaTransaction.create({
      data: {
        checkoutRequestId: stkData.CheckoutRequestID,
        merchantRequestId: stkData.MerchantRequestID || '',
        phone,
        amount: parsed.data.amount,
        accountReference: parsed.data.accountReference,
        orderId: parsed.data.orderId ?? null,
        createdByName: req.user!.name,
      },
    });

    res.status(201).json({ checkoutRequestId: stkData.CheckoutRequestID });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to reach M-Pesa' });
  }
});

async function markSuccess(tx: { id: number; orderId: number | null; amount: number }, mpesaReceipt: string | null) {
  await prisma.mpesaTransaction.update({
    where: { id: tx.id },
    data: { status: 'Success', resultCode: 0, mpesaReceipt },
  });
  // Closes the loop straight from the STK push into the order's payment
  // ledger — no separate manual "Record payment" step needed once the
  // customer has actually paid on their phone. Only applies when this push
  // was raised against an existing order (see stkpush's orderId param); a
  // push raised before a walk-in order exists is instead turned into the
  // order's initial payment by the frontend once it creates the order (see
  // NewWalkinOrder.tsx).
  if (tx.orderId) {
    await prisma.payment.create({ data: { orderId: tx.orderId, date: todayStr(), amount: tx.amount, method: 'M-Pesa' } });
  }
}

interface StkCallbackItem {
  Name: string;
  Value?: string | number;
}

// Safaricom's webhook target — must be a publicly reachable HTTPS URL (set
// as MPESA_CALLBACK_URL) since Safaricom's servers, not this app, call it.
// Deliberately not behind requireAuth: Safaricom doesn't hold a session
// token for this app, and Daraja doesn't sign callbacks in a way this app
// can verify — acceptable here since the only effect of a forged callback is
// marking an already-initiated STK push's own row, not creating new charges.
mpesaRouter.post('/callback', async (req, res) => {
  const stkCallback = req.body?.Body?.stkCallback as
    | { CheckoutRequestID?: string; ResultCode?: number; ResultDesc?: string; CallbackMetadata?: { Item: StkCallbackItem[] } }
    | undefined;
  if (!stkCallback?.CheckoutRequestID) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const tx = await prisma.mpesaTransaction.findUnique({ where: { checkoutRequestId: stkCallback.CheckoutRequestID } });
  if (!tx || tx.status !== 'Pending') return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  if (stkCallback.ResultCode === 0) {
    const receipt = stkCallback.CallbackMetadata?.Item.find((i) => i.Name === 'MpesaReceiptNumber')?.Value;
    await markSuccess(tx, receipt != null ? String(receipt) : null);
  } else {
    await prisma.mpesaTransaction.update({
      where: { id: tx.id },
      data: { status: stkCallback.ResultCode === 1032 ? 'Cancelled' : 'Failed', resultCode: stkCallback.ResultCode, resultDesc: stkCallback.ResultDesc },
    });
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Polled by the frontend after initiating a push (see mpesa.ts helpers in
// apps/web) — reflects whatever the callback (or a manual confirm below)
// has recorded so far.
mpesaRouter.get('/status/:checkoutRequestId', requireAuth, async (req, res) => {
  const tx = await prisma.mpesaTransaction.findUnique({ where: { checkoutRequestId: req.params.checkoutRequestId } });
  if (!tx) return res.status(404).json({ error: 'STK push not found' });
  res.json({ status: tx.status, amount: tx.amount, mpesaReceipt: tx.mpesaReceipt, resultDesc: tx.resultDesc });
});

// Fallback for an environment with no reachable public callback URL (e.g.
// local development) — staff confirms payment was actually received
// through other means (the till's own SMS alert) rather than being blocked
// waiting on a webhook that can never arrive. Only usable while still
// Pending, so it can't override a callback that already resolved the push.
mpesaRouter.post('/:checkoutRequestId/confirm-manually', requireAuth, async (req, res) => {
  const tx = await prisma.mpesaTransaction.findUnique({ where: { checkoutRequestId: req.params.checkoutRequestId } });
  if (!tx) return res.status(404).json({ error: 'STK push not found' });
  if (tx.status !== 'Pending') return res.status(400).json({ error: 'This push has already been resolved' });
  await prisma.mpesaTransaction.update({ where: { id: tx.id }, data: { confirmedManually: true } });
  await markSuccess(tx, null);
  res.json({ ok: true });
});
