import { Router } from 'express';
import { z } from 'zod';
import { timingSafeEqual } from 'crypto';
import { prisma } from '../db';
import { requireAuth, requireRole, userHasPermission } from '../middleware/auth';
import { seal } from '../crypto';
import { autoMatch, normaliseDate, storeReceipt } from '../accounting/mpesaMatching';
import { todayStr } from '@glm/shared';
import { canAccessOrder, canTakePayment, orderInclude, recordOrderPayments, serializeSummary } from './orders';
import { DarajaError, callbackUrls, darajaBaseUrl, darajaTimestamp, getAccessToken, getSettingsRow, isB2cReady, isReady, loadMpesaConfig, newCallbackSecret, parseCertificate, securityCredential } from '../mpesaConfig';
import { handleB2cResult, handleB2cTimeout } from '../mpesaB2c';
import type { MpesaConfig } from '../mpesaConfig';

export const mpesaRouter = Router();

const MAX_STK_AMOUNT = 250_000; // M-Pesa's own limit for one payment

const NOT_SET_UP = "M-Pesa isn't set up (or is switched off) — an Admin can set it up under Master Data → M-Pesa";

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

// ── Settings (Master Data → M-Pesa, Admin only). Secrets are never sent back to the browser. ──
function publicSettings(c: MpesaConfig) {
  return {
    source: c.source, // 'env' = still running from the server's MPESA_* variables; the first save moves it into Master Data
    enabled: c.enabled,
    ready: isReady(c),
    environment: c.environment,
    shortCode: c.shortCode,
    isTill: c.isTill,
    publicBaseUrl: c.publicBaseUrl,
    hasConsumerKey: !!c.consumerKey,
    hasConsumerSecret: !!c.consumerSecret,
    hasPasskey: !!c.passkey,
    // Pay-outs to phones (B2C): the secret and certificate are never sent back — only whether they are set
    b2cReady: isB2cReady(c),
    b2cShortCode: c.b2cShortCode,
    initiatorName: c.initiatorName,
    hasInitiatorPassword: !!c.initiatorPassword,
    hasSecurityCert: !!c.securityCert,
    b2cCommand: c.b2cCommand,
    c2bRegisteredAt: c.c2bRegisteredAt,
    callbackUrls: callbackUrls(c),
  };
}

mpesaRouter.get('/settings', requireAuth, requireRole('Admin'), async (_req, res) => {
  res.json(publicSettings(await loadMpesaConfig()));
});

const settingsSchema = z.object({
  environment: z.enum(['sandbox', 'production']).optional(),
  shortCode: z.string().trim().max(20).optional(),
  isTill: z.boolean().optional(),
  publicBaseUrl: z.string().trim().max(200).optional(),
  // Blank = keep what is saved (the browser never has the saved values to send back).
  consumerKey: z.string().trim().max(200).optional(),
  consumerSecret: z.string().trim().max(200).optional(),
  passkey: z.string().trim().max(300).optional(),
  enabled: z.boolean().optional(),
  // Pay-outs to phones (B2C). Blank password / certificate = keep what is saved.
  b2cShortCode: z.string().trim().max(20).optional(),
  initiatorName: z.string().trim().max(100).optional(),
  initiatorPassword: z.string().max(300).optional(),
  securityCert: z.string().trim().max(10000).optional(),
  b2cCommand: z.enum(['BusinessPayment', 'SalaryPayment', 'PromotionPayment']).optional(),
});

mpesaRouter.put('/settings', requireAuth, requireRole('Admin'), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const b = parsed.data;
  const current = await loadMpesaConfig();
  const row = await getSettingsRow();

  // First save from an install still on server variables: carry its values over so nothing has to be retyped.
  const base = row.consumerKey || row.shortCode ? row : { ...row, consumerKey: current.consumerKey, consumerSecret: current.consumerSecret, passkey: current.passkey, shortCode: current.shortCode, publicBaseUrl: current.publicBaseUrl, environment: current.environment, callbackSecret: current.callbackSecret, enabled: current.enabled };

  const data: Record<string, unknown> = {
    environment: b.environment ?? base.environment,
    shortCode: b.shortCode ?? base.shortCode,
    isTill: b.isTill ?? base.isTill,
    consumerKey: seal(b.consumerKey ? b.consumerKey : base.consumerKey),
    consumerSecret: seal(b.consumerSecret ? b.consumerSecret : base.consumerSecret),
    passkey: seal(b.passkey ? b.passkey : base.passkey),
    publicBaseUrl: base.publicBaseUrl,
    callbackSecret: seal(base.callbackSecret || newCallbackSecret()),
    enabled: b.enabled ?? base.enabled,
    b2cShortCode: b.b2cShortCode ?? base.b2cShortCode,
    initiatorName: b.initiatorName ?? base.initiatorName,
    initiatorPassword: seal(b.initiatorPassword ? b.initiatorPassword : base.initiatorPassword),
    securityCert: b.securityCert ? b.securityCert : base.securityCert,
    b2cCommand: b.b2cCommand ?? (base.b2cCommand || 'BusinessPayment'),
  };
  if (b.securityCert) {
    try {
      parseCertificate(b.securityCert);
    } catch {
      return res.status(400).json({ error: "That does not look like Safaricom's certificate. Paste the whole of the .cer file from the Daraja portal (it starts with -----BEGIN CERTIFICATE-----)." });
    }
  }
  if (b.publicBaseUrl !== undefined) {
    const v = b.publicBaseUrl.replace(/\/+$/, '');
    if (v && !/^https:\/\//.test(v)) return res.status(400).json({ error: 'The public web address must start with https:// — Safaricom will not call back over plain http' });
    data.publicBaseUrl = v;
  }
  if (data.enabled && !(data.consumerKey && data.consumerSecret && data.passkey && data.shortCode)) {
    return res.status(400).json({ error: 'Fill in the Paybill/Till number, consumer key, consumer secret and passkey before switching M-Pesa on' });
  }
  const saved = await prisma.mpesaSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  void saved;
  res.json(publicSettings(await loadMpesaConfig()));
});

// Proves the consumer key and secret work, without prompting anyone.
mpesaRouter.post('/settings/test', requireAuth, requireRole('Admin'), async (_req, res) => {
  try {
    const c = await loadMpesaConfig();
    await getAccessToken(c);
    // If pay-outs are set up, prove the certificate and password can make a security credential too.
    let b2c: string | null = null;
    if (c.initiatorPassword && c.securityCert) {
      try {
        securityCredential(c);
        b2c = 'ready';
      } catch {
        b2c = 'The certificate could not be used — paste the whole certificate again';
      }
    }
    res.json({ ok: true, b2c });
  } catch (e) {
    if (e instanceof DarajaError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

// Tells Safaricom where to send Paybill/Till payments made WITHOUT a prompt (C2B).
async function registerC2B(_req: unknown, res: import('express').Response) {
  const c = await loadMpesaConfig();
  if (!c.consumerKey || !c.consumerSecret || !c.shortCode) return res.status(400).json({ error: 'Save the Paybill/Till number, consumer key and secret first' });
  const urls = callbackUrls(c);
  if (!urls) return res.status(400).json({ error: 'Save this installation’s public web address (https://…) first — the callback addresses are built from it' });
  try {
    const token = await getAccessToken(c);
    const r = await fetch(`${darajaBaseUrl(c)}/mpesa/c2b/v1/registerurl`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ShortCode: c.shortCode, ResponseType: 'Completed', ConfirmationURL: urls.confirmation, ValidationURL: urls.validation }),
    });
    const data = (await r.json().catch(() => ({}))) as { ResponseDescription?: string; errorMessage?: string };
    if (!r.ok) return res.status(502).json({ error: data.errorMessage || data.ResponseDescription || 'Safaricom rejected the registration' });
  } catch (e) {
    if (e instanceof DarajaError) return res.status(400).json({ error: e.message });
    return res.status(502).json({ error: e instanceof Error ? e.message : 'Failed to reach M-Pesa' });
  }
  if (c.source === 'settings') await prisma.mpesaSettings.update({ where: { id: 1 }, data: { c2bRegisteredAt: new Date() } });
  res.json(publicSettings(await loadMpesaConfig()));
}
mpesaRouter.post('/settings/register-c2b', requireAuth, requireRole('Admin'), registerC2B);
mpesaRouter.post('/c2b/register', requireAuth, requireRole('Admin'), registerC2B); // older address, same thing

// ── STK push: a payment prompt on the customer's own phone ──────────────────
const stkPushSchema = z.object({
  phone: z.string().min(9),
  amount: z.number().positive(),
  accountReference: z.string().min(1).max(40),
  description: z.string().max(100).optional(),
  orderId: z.number().int().optional(),
});

// Used both during order capture (before the order exists yet — orderId omitted) and from an existing order's payment flow.
// Returns immediately with a checkoutRequestId; the result arrives asynchronously via the callback (needs a public https
// address) or is confirmed by staff via /:checkoutRequestId/confirm-manually once they've seen the payment SMS.
mpesaRouter.post('/stkpush', requireAuth, async (req, res) => {
  const cfg = await loadMpesaConfig();
  if (!isReady(cfg)) return res.status(501).json({ error: NOT_SET_UP });
  const urls = callbackUrls(cfg);
  if (!urls) return res.status(501).json({ error: 'M-Pesa needs this installation’s public web address — an Admin can add it under Master Data → M-Pesa' });
  const parsed = stkPushSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  // A push raised against an existing order is money for that order: only someone allowed to see it and take payments on it may raise one.
  if (parsed.data.orderId) {
    const target = await prisma.order.findUnique({ where: { id: parsed.data.orderId }, include: orderInclude });
    if (!target) return res.status(404).json({ error: 'Order not found' });
    if (!(await canAccessOrder(req.user!, target)) || !(await canTakePayment(req.user!, target))) return res.status(403).json({ error: 'Not permitted' });
    // never ask a customer for more than the order still owes
    const owed = serializeSummary(target).totals.balanceDue;
    if (Math.round(parsed.data.amount) > Math.ceil(owed)) return res.status(400).json({ error: `This order only has Ksh ${Math.round(owed).toLocaleString('en-KE')} still to pay` });
  }
  if (parsed.data.amount > MAX_STK_AMOUNT) return res.status(400).json({ error: `M-Pesa takes at most Ksh ${MAX_STK_AMOUNT.toLocaleString('en-KE')} in one payment` });
  // Prompts pop up on a real person's phone: no more than 10 from one user, or 3 to one number, in ten minutes.
  const recent = new Date(Date.now() - 10 * 60_000);
  if ((await prisma.mpesaTransaction.count({ where: { createdByName: req.user!.name, kind: 'STK', createdAt: { gt: recent } } })) >= 10) return res.status(429).json({ error: 'You have sent a lot of M-Pesa prompts in the last few minutes. Wait a little before sending another.' });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan phone number (e.g. 07xx xxx xxx)' });
  if ((await prisma.mpesaTransaction.count({ where: { phone, kind: 'STK', createdAt: { gt: new Date(Date.now() - 10 * 60_000) } } })) >= 3) return res.status(429).json({ error: 'That number has already been sent several prompts in the last few minutes. Ask the customer to check their phone, or wait a little.' });

  try {
    const token = await getAccessToken(cfg);
    const timestamp = darajaTimestamp();
    const password = Buffer.from(`${cfg.shortCode}${cfg.passkey}${timestamp}`).toString('base64');

    const stkRes = await fetch(`${darajaBaseUrl(cfg)}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: cfg.shortCode,
        Password: password,
        Timestamp: timestamp,
        // A Till (Buy Goods) takes the amount only; a Paybill also carries an account reference.
        TransactionType: cfg.isTill ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
        Amount: Math.round(parsed.data.amount),
        PartyA: phone,
        PartyB: cfg.shortCode,
        PhoneNumber: phone,
        CallBackURL: urls.stk,
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
  // Closes the loop straight from the STK push into the order's payment ledger — no separate manual "Record payment" step. Only
  // applies when the push was raised against an existing order; a push raised before a walk-in order exists is turned into the
  // order's payment when the order is created (its receipt code is claimed — see recordOrderPayments).
  if (tx.orderId) {
    const order = await prisma.order.findUnique({ where: { id: tx.orderId }, include: { corporateClient: true } });
    if (order) {
      await prisma.$transaction((db) =>
        recordOrderPayments(db, order, [{ method: 'M-Pesa', amount: tx.amount, reference: mpesaReceipt, linkedTransactionId: tx.id }], null),
      );
    }
  }
}

interface StkCallbackItem {
  Name: string;
  Value?: string | number;
}

const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

async function handleStkCallback(body: unknown) {
  const stkCallback = (body as { Body?: { stkCallback?: { CheckoutRequestID?: string; ResultCode?: number; ResultDesc?: string; CallbackMetadata?: { Item: StkCallbackItem[] } } } })?.Body?.stkCallback;
  if (!stkCallback?.CheckoutRequestID) return;
  const tx = await prisma.mpesaTransaction.findUnique({ where: { checkoutRequestId: stkCallback.CheckoutRequestID } });
  if (!tx || tx.status !== 'Pending') return;
  if (stkCallback.ResultCode === 0) {
    const receipt = stkCallback.CallbackMetadata?.Item.find((i) => i.Name === 'MpesaReceiptNumber')?.Value;
    await markSuccess(tx, receipt != null ? String(receipt) : null);
  } else {
    await prisma.mpesaTransaction.update({
      where: { id: tx.id },
      data: { status: stkCallback.ResultCode === 1032 ? 'Cancelled' : 'Failed', resultCode: stkCallback.ResultCode, resultDesc: stkCallback.ResultDesc },
    });
  }
}

function secretOk(given: string, want: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return want.length >= 16 && a.length === b.length && timingSafeEqual(a, b);
}

// Safaricom's STK webhook. It can't sign in as staff, so the address carries a random secret (set up under Master Data → M-Pesa)
// as the only proof the call is genuine. Always answers 200 so Safaricom doesn't retry.
mpesaRouter.post('/callback/:secret', async (req, res) => {
  const cfg = await loadMpesaConfig();
  if (secretOk(req.params.secret, cfg.callbackSecret)) await handleStkCallback(req.body).catch((e) => console.error('STK callback failed', e));
  res.json(ACK);
});

// The older address, with no secret in it. Only honoured while the install is still on server variables; once the Admin has
// saved M-Pesa under Master Data, callbacks must carry the secret.
mpesaRouter.post('/callback', async (req, res) => {
  const cfg = await loadMpesaConfig();
  if (cfg.source === 'env') await handleStkCallback(req.body).catch((e) => console.error('STK callback failed', e));
  res.json(ACK);
});

// Polled by the frontend after initiating a push — reflects whatever the callback (or a manual confirm) has recorded so far.
mpesaRouter.get('/status/:checkoutRequestId', requireAuth, async (req, res) => {
  const tx = await prisma.mpesaTransaction.findUnique({ where: { checkoutRequestId: req.params.checkoutRequestId } });
  if (!tx) return res.status(404).json({ error: 'STK push not found' });
  res.json({ status: tx.status, amount: tx.amount, mpesaReceipt: tx.mpesaReceipt, resultDesc: tx.resultDesc });
});

// Fallback when no public callback can reach this server (e.g. local development): staff confirms payment really arrived through
// other means (the till's own SMS). Only usable while still Pending, so it can't override a callback that already resolved the push.
// This books a payment on the word of whoever presses it, so it is limited to a manager who handles payments, and (outside the sandbox) it needs
// the M-Pesa confirmation code from the SMS — a code that must not already be on record.
const confirmSchema = z.object({ receipt: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'Enter the M-Pesa confirmation code from the SMS (10 letters and numbers)').optional() });

mpesaRouter.post('/:checkoutRequestId/confirm-manually', requireAuth, async (req, res) => {
  if (!(await userHasPermission(req.user!.role, 'canManagePayments'))) {
    return res.status(403).json({ error: 'Only a manager who handles payments can confirm an M-Pesa payment by hand. Ask one to check the till SMS.' });
  }
  const parsed = confirmSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const receipt = parsed.data.receipt ?? null;
  const cfg = await loadMpesaConfig();
  if (!receipt && cfg.environment === 'production') return res.status(400).json({ error: 'Enter the M-Pesa confirmation code from the SMS (10 letters and numbers)' });

  const tx = await prisma.mpesaTransaction.findUnique({ where: { checkoutRequestId: req.params.checkoutRequestId } });
  if (!tx) return res.status(404).json({ error: 'STK push not found' });
  if (tx.status !== 'Pending') return res.status(400).json({ error: 'This push has already been resolved' });
  if (receipt && ((await prisma.mpesaTransaction.findUnique({ where: { mpesaReceipt: receipt } })) || (await prisma.payment.findFirst({ where: { reference: receipt } })))) {
    return res.status(400).json({ error: `${receipt} is already on record. If it arrived as a Paybill/Till payment, apply it from Accounting → M-Pesa instead.` });
  }
  await prisma.mpesaTransaction.update({ where: { id: tx.id }, data: { confirmedManually: true, confirmedByName: req.user!.name } });
  await markSuccess(tx, receipt);
  res.json({ ok: true });
});

// ── Paybill / Till payments made WITHOUT a prompt (C2B) ────────────────────
// Safaricom calls these two addresses for every payment to the shortcode. Both always answer 200 "Accepted": Safaricom retries
// anything else, and a payment already taken from the customer can't be un-taken by refusing to acknowledge it. Each received
// payment is stored Unmatched (and booked to Unallocated M-Pesa Receipts), then matched to an order automatically when the
// customer typed the order number as the account reference — see accounting/mpesaMatching.ts. (Safaricom hashes the customer's
// phone number on production, so matching is by order number, not phone.)
// Safaricom's answer to a payment SENT to a phone (B2C): the result, or a timeout when it was never processed. Same secret-in-the-address proof.
mpesaRouter.post('/b2c/:secret/result', async (req, res) => {
  const cfg = await loadMpesaConfig();
  if (secretOk(req.params.secret, cfg.callbackSecret)) await handleB2cResult(req.body).catch((e) => console.error('B2C result failed', e));
  res.json(ACK);
});
mpesaRouter.post('/b2c/:secret/timeout', async (req, res) => {
  const cfg = await loadMpesaConfig();
  if (secretOk(req.params.secret, cfg.callbackSecret)) await handleB2cTimeout(req.body).catch((e) => console.error('B2C timeout failed', e));
  res.json(ACK);
});

mpesaRouter.post('/c2b/:secret/validation', (_req, res) => res.json(ACK));

mpesaRouter.post('/c2b/:secret/confirmation', async (req, res) => {
  const cfg = await loadMpesaConfig();
  if (!secretOk(req.params.secret, cfg.callbackSecret)) return res.json(ACK);
  try {
    const b = req.body as Record<string, string | number | undefined>;
    const receipt = String(b.TransID || '').toUpperCase();
    const amount = Number(b.TransAmount);
    if (receipt && amount > 0) {
      await storeReceipt(
        {
          kind: 'C2B',
          receipt,
          amount,
          date: normaliseDate(String(b.TransTime || '')) ?? todayStr(),
          phone: String(b.MSISDN || ''),
          name: [b.FirstName, b.MiddleName, b.LastName].filter(Boolean).join(' '),
          reference: String(b.BillRefNumber || ''),
          raw: b,
        },
        'M-Pesa (Paybill/Till)',
      );
      await autoMatch('M-Pesa (Paybill/Till)');
    }
  } catch (err) {
    console.error('C2B confirmation failed', err);
  }
  res.json(ACK);
});
