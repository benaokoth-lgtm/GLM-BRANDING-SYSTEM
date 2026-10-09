import express, { Router } from 'express';
import { z } from 'zod';
import { timingSafeEqual } from 'crypto';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { seal } from '../crypto';
import { todayStr } from '@glm/shared';
import { autoMatch, normaliseDate, storeReceipt } from '../accounting/mpesaMatching';
import { markSuccess } from './mpesa';
import {
  NCBA_BASE_URL,
  NcbaError,
  credentialsOk,
  getNcbaRow,
  hashOk,
  loadNcbaConfig,
  ncbaBaseUrlOk,
  ncbaNotifyUrl,
  ncbaReady,
  ncbaToken,
  newNcbaSecret,
  parseNotice,
  phoneMatches,
  replyFor,
  resetNcbaToken,
} from '../ncba';
import type { NcbaConfig, NcbaNotice } from '../ncba';

export const ncbaRouter = Router();

const LABEL = 'M-Pesa (NCBA Paybill)';

// ── Settings (Master Data → NCBA, Admin only). Secrets are never sent back to the browser. ──
function publicSettings(c: NcbaConfig) {
  return {
    enabled: c.enabled,
    ready: ncbaReady(c),
    baseUrl: c.baseUrl,
    apiUsername: c.apiUsername,
    hasApiSecret: !!c.apiSecret,
    payBillNo: c.payBillNo,
    accountNo: c.accountNo,
    network: c.network,
    publicBaseUrl: c.publicBaseUrl,
    notifyUrl: ncbaNotifyUrl(c),
    pushUser: c.pushUser,
    hasPushCredentials: !!(c.pushUser && c.pushPassword && c.pushSecret),
    checkHash: c.checkHash,
  };
}

ncbaRouter.get('/settings', requireAuth, requireRole('Admin'), async (_req, res) => {
  res.json(publicSettings(await loadNcbaConfig()));
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().trim().max(200).optional(),
  apiUsername: z.string().trim().max(200).optional(),
  apiSecret: z.string().trim().max(300).optional(), // blank = keep what is saved
  payBillNo: z.string().trim().max(20).optional(),
  accountNo: z.string().trim().max(60).optional(),
  network: z.string().trim().max(30).optional(),
  publicBaseUrl: z.string().trim().max(200).optional(),
  checkHash: z.boolean().optional(),
});

ncbaRouter.put('/settings', requireAuth, requireRole('Admin'), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const b = parsed.data;
  const row = await getNcbaRow();
  const cur = await loadNcbaConfig();
  const data: Record<string, unknown> = {};
  if (b.baseUrl !== undefined) {
    const v = (b.baseUrl || NCBA_BASE_URL).replace(/\/+$/, '');
    if (!ncbaBaseUrlOk(v)) return res.status(400).json({ error: "That is not an NCBA address. It should be https://c2bapis.ncbagroup.com unless NCBA gave you a test address on ncbagroup.com." });
    data.baseUrl = v;
  }
  if (b.publicBaseUrl !== undefined) {
    const v = b.publicBaseUrl.replace(/\/+$/, '');
    if (v && !/^https:\/\//.test(v)) return res.status(400).json({ error: 'The public web address must start with https:// — NCBA will not send notifications over plain http' });
    data.publicBaseUrl = v;
  }
  if (b.apiUsername !== undefined) data.apiUsername = b.apiUsername;
  if (b.apiSecret) data.apiSecret = seal(b.apiSecret);
  if (b.payBillNo !== undefined) data.payBillNo = b.payBillNo || '880100';
  if (b.accountNo !== undefined) data.accountNo = b.accountNo;
  if (b.network !== undefined) data.network = b.network || 'Safaricom';
  if (b.checkHash !== undefined) data.checkHash = b.checkHash;
  if (b.enabled !== undefined) data.enabled = b.enabled;
  if (!row.callbackSecret) data.callbackSecret = seal(newNcbaSecret());
  const willBe = {
    enabled: (data.enabled as boolean | undefined) ?? cur.enabled,
    apiUsername: (data.apiUsername as string | undefined) ?? cur.apiUsername,
    hasSecret: !!(b.apiSecret || cur.apiSecret),
    payBillNo: (data.payBillNo as string | undefined) ?? cur.payBillNo,
    accountNo: (data.accountNo as string | undefined) ?? cur.accountNo,
  };
  if (willBe.enabled && !(willBe.apiUsername && willBe.hasSecret && willBe.payBillNo && willBe.accountNo)) {
    return res.status(400).json({ error: 'Fill in the API username, the secret key, the Paybill number and the account number before switching NCBA on' });
  }
  await prisma.ncbaSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  resetNcbaToken();
  res.json(publicSettings(await loadNcbaConfig()));
});

// Proves the API username and secret work, without prompting anyone.
ncbaRouter.post('/settings/test', requireAuth, requireRole('Admin'), async (_req, res) => {
  try {
    await ncbaToken(await loadNcbaConfig());
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof NcbaError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

// Makes the username, password and secret key NCBA must send with every notification. They are shown here once — they go into the signed instruction
// letter to NCBA — and kept sealed, so they cannot be shown again (making new ones replaces them, and NCBA must then be given the new ones).
ncbaRouter.post('/credentials/generate', requireAuth, requireRole('Admin'), async (_req, res) => {
  const row = await getNcbaRow();
  const creds = { pushUser: `glm${newNcbaSecret(4)}`, pushPassword: newNcbaSecret(12), pushSecret: newNcbaSecret(16) };
  await prisma.ncbaSettings.update({
    where: { id: 1 },
    data: { pushUser: seal(creds.pushUser), pushPassword: seal(creds.pushPassword), pushSecret: seal(creds.pushSecret), ...(row.callbackSecret ? {} : { callbackSecret: seal(newNcbaSecret()) }) },
  });
  res.json({ ...creds, settings: publicSettings(await loadNcbaConfig()) });
});

// ── What NCBA has told us ───────────────────────────────────────────────────
ncbaRouter.get('/notifications', requireAuth, requireRole('Admin'), async (_req, res) => {
  const rows = await prisma.ncbaNotification.findMany({ orderBy: { id: 'desc' }, take: 40, select: { id: true, receivedAt: true, transId: true, amount: true, billRef: true, phone: true, payerName: true, outcome: true, note: true } });
  res.json(rows);
});

// Books a notification that was held (its signature did not check out) once an Admin has looked at it and is satisfied it is real.
ncbaRouter.post('/notifications/:id/accept', requireAuth, requireRole('Admin'), async (req, res) => {
  const row = await prisma.ncbaNotification.findUnique({ where: { id: Number(req.params.id) } });
  if (!row) return res.status(404).json({ error: 'Notification not found' });
  if (row.outcome !== 'Held') return res.status(400).json({ error: 'Only a held notification can be accepted' });
  const notice = JSON.parse(row.rawJson) as NcbaNotice;
  const result = await applyNotice(notice, req.user!.name);
  await prisma.ncbaNotification.update({ where: { id: row.id }, data: { outcome: result.outcome, note: `Accepted by ${req.user!.name}. ${result.note}` } });
  res.json({ ok: true, outcome: result.outcome });
});

// ── NCBA's payment notification ─────────────────────────────────────────────
function secretOk(given: string, want: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return want.length >= 16 && a.length === b.length && timingSafeEqual(a, b);
}

type Outcome = 'Matched' | 'Received' | 'Duplicate';

/** Books a payment NCBA reported: against the prompt we sent for it when there is one, otherwise as a Paybill payment to be matched to an order. */
async function applyNotice(n: NcbaNotice, by: string): Promise<{ outcome: Outcome; note: string }> {
  const receipt = n.transId.toUpperCase();
  const amount = Number(n.amount);
  if (!receipt || !(amount > 0)) throw new Error('The notification has no receipt code or amount');
  if (await prisma.mpesaTransaction.findUnique({ where: { mpesaReceipt: receipt } })) return { outcome: 'Duplicate', note: 'Already on record' };

  // A prompt we sent in the last hour that this could be the answer to: same amount and, when NCBA tells us the number, the same phone.
  const open = await prisma.mpesaTransaction.findMany({
    where: { kind: 'STK', checkoutRequestId: { startsWith: 'NCBA-' }, mpesaReceipt: null, status: { in: ['Pending', 'Success', 'Failed'] }, createdAt: { gt: new Date(Date.now() - 60 * 60_000) } },
    orderBy: { id: 'asc' },
  });
  const sameAmount = open.filter((t) => Math.abs(t.amount - amount) <= 0.5);
  const byPhone = n.mobile ? sameAmount.filter((t) => phoneMatches(t.phone, n.mobile)) : [];
  const target = byPhone[0] ?? (!n.mobile && sameAmount.length === 1 ? sameAmount[0] : undefined);
  if (target) {
    try {
      if (target.status === 'Success') {
        // already marked paid when we asked NCBA; this only adds the receipt code
        await prisma.mpesaTransaction.update({ where: { id: target.id }, data: { mpesaReceipt: receipt } });
        await prisma.payment.updateMany({ where: { mpesaTransactionId: target.id, reference: null }, data: { reference: receipt } });
      } else {
        await markSuccess(target, receipt);
      }
      return { outcome: 'Matched', note: `Matched to the prompt sent to ${target.phone}` };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return { outcome: 'Duplicate', note: 'Already on record' };
      throw e;
    }
  }

  const date = normaliseDate(n.transTime) ?? todayStr();
  const kept = await storeReceipt({ kind: 'C2B', receipt, amount, date, phone: n.mobile, name: n.name, reference: n.billRef || n.narrative, raw: { ...n, username: undefined, password: undefined, hash: undefined } }, LABEL).catch((e) => {
    if ((e as { code?: string }).code === 'P2002') return null;
    throw e;
  });
  if (!kept) return { outcome: 'Duplicate', note: 'Already on record' };
  await autoMatch(LABEL);
  return { outcome: 'Received', note: 'Recorded as a Paybill payment; Accounting → M-Pesa matches it to an order' };
}

const plain = (n: NcbaNotice) => ({ transType: n.transType, transId: n.transId, ftRef: n.ftRef, transTime: n.transTime, amount: n.amount, account: n.account, billRef: n.billRef, narrative: n.narrative, mobile: n.mobile, name: n.name });

async function log(n: NcbaNotice, outcome: string, note: string) {
  await prisma.ncbaNotification.create({
    data: { transId: n.transId.toUpperCase(), amount: Number(n.amount) || 0, billRef: n.billRef || n.narrative, phone: n.mobile, payerName: n.name, outcome, note, rawJson: JSON.stringify(plain(n)) },
  });
}

// NCBA cannot sign in as staff, so three things stand in for that: the random secret in this address, the username and password only this installation and
// NCBA know, and the signature on the notification. Anything that fails the first two is refused; one that fails only the signature is held for an Admin.
ncbaRouter.post('/notify/:secret', express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml', 'text/plain'], limit: '200kb' }), async (req, res) => {
  const cfg = await loadNcbaConfig();
  const send = (format: 'json' | 'xml', ok: boolean) => {
    const r = replyFor(format, ok);
    res.type(r.type).send(r.body);
  };
  if (!secretOk(String(req.params.secret), cfg.callbackSecret)) return res.status(404).end();
  const parsed = parseNotice(req.body);
  if (!parsed) return send(typeof req.body === 'string' ? 'xml' : 'json', false);
  const { notice, format } = parsed;
  try {
    if (!credentialsOk(cfg, notice)) {
      await log(notice, 'Rejected', 'The username or password on the notification is not the one given to NCBA');
      return send(format, false);
    }
    if (cfg.checkHash && !hashOk(cfg.pushSecret, notice)) {
      await log(notice, 'Held', 'The signature on the notification did not match. An Admin can accept it after checking the payment is real (Master Data → NCBA).');
      return send(format, true); // answered OK so NCBA does not keep re-sending it; it waits for an Admin
    }
    const result = await applyNotice(notice, LABEL);
    await log(notice, result.outcome, result.note);
    send(format, true);
  } catch (e) {
    console.error('NCBA notification failed', e);
    send(format, false); // NCBA may try again
  }
});
