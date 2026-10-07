// Paying money OUT to a phone with M-Pesa (Daraja "B2C"): the weekly commission of a freelance sales person. An STK push can only ask a customer to pay us, so
// to send money the other way the system asks Safaricom to pay from our Paybill to the person's number. Safaricom answers straight away only to say it has
// accepted the request; the real outcome arrives later on the result address, and only then is the payout marked Paid and the expense booked.
import { randomUUID } from 'node:crypto';
import { todayStr } from '@glm/shared';
import { prisma } from './db';
import { ensureChartOnce } from './accounting/chart';
import { settlePayout } from './freelancePay';
import { DarajaError, callbackUrls, darajaBaseUrl, getAccessToken, isB2cReady, loadMpesaConfig, securityCredential } from './mpesaConfig';

export const B2C_MIN = 10; // Safaricom's smallest B2C payment
export const B2C_MAX = 150_000; // and its largest in one go

export type SendOutcome = { ok: true; disbursementId: number } | { ok: false; error: string; disbursementId?: number };

/**
 * Sends a payout to the freelancer's M-Pesa phone. The payout goes Approved → Sending first (one attempt at a time, so a double click can never pay twice),
 * and back to Approved if Safaricom refuses the request. The outcome of an accepted request is settled by handleB2cResult.
 */
export async function sendPayoutToPhone(payoutId: number, requestedByName: string): Promise<SendOutcome> {
  const cfg = await loadMpesaConfig();
  if (!isB2cReady(cfg)) return { ok: false, error: 'Sending money to phones is not set up — an Admin can set it up under Master Data → M-Pesa (pay-outs).' };
  const urls = callbackUrls(cfg);
  if (!urls) return { ok: false, error: 'M-Pesa needs this installation’s public web address — add it under Master Data → M-Pesa.' };

  const payout = await prisma.freelancePayout.findUnique({ where: { id: payoutId }, include: { agent: true } });
  if (!payout) return { ok: false, error: 'Payout not found' };
  if (payout.status === 'Paid') return { ok: false, error: 'Already paid' };
  if (payout.status === 'Sending') return { ok: false, error: 'A payment to their phone is already on its way — wait for Safaricom’s answer.' };
  if (payout.agent.status !== 'Active') return { ok: false, error: `${payout.agent.name} is not an active freelance sales person, so this cannot be paid` };
  const phone = payout.agent.mpesaNumber || payout.agent.phone;
  if (!/^254[17]\d{8}$/.test(phone)) return { ok: false, error: `${payout.agent.name} has no valid M-Pesa number on file` };
  const amount = Math.round(payout.amount);
  if (amount < B2C_MIN) return { ok: false, error: `Ksh ${amount} is below the smallest M-Pesa payment (Ksh ${B2C_MIN}). Pay it another way, or let it build up to a later week.` };
  if (amount > B2C_MAX) return { ok: false, error: `M-Pesa sends at most Ksh ${B2C_MAX.toLocaleString('en-KE')} at a time. Pay this one another way.` };

  // One attempt at a time: only a payout that is Approved can start one.
  const locked = await prisma.freelancePayout.updateMany({ where: { id: payoutId, status: 'Approved' }, data: { status: 'Sending' } });
  if (locked.count !== 1) return { ok: false, error: 'This payout is not waiting to be paid (it may already be on its way)' };

  const originatorConversationId = randomUUID();
  const d = await prisma.mpesaDisbursement.create({ data: { payoutId, phone, amount, originatorConversationId, requestedByName } });
  const fail = async (error: string): Promise<SendOutcome> => {
    await prisma.$transaction([
      prisma.mpesaDisbursement.update({ where: { id: d.id }, data: { status: 'Failed', resultDesc: error, completedAt: new Date() } }),
      prisma.freelancePayout.update({ where: { id: payoutId }, data: { status: 'Approved' } }),
    ]);
    return { ok: false, error, disbursementId: d.id };
  };

  try {
    const token = await getAccessToken(cfg);
    const res = await fetch(`${darajaBaseUrl(cfg)}/mpesa/b2c/v3/paymentrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        OriginatorConversationID: originatorConversationId,
        InitiatorName: cfg.initiatorName,
        SecurityCredential: securityCredential(cfg),
        CommandID: cfg.b2cCommand || 'BusinessPayment',
        Amount: amount,
        PartyA: cfg.b2cShortCode || cfg.shortCode,
        PartyB: phone,
        Remarks: `Commission, week of ${payout.weekStart}`.slice(0, 100),
        QueueTimeOutURL: urls.b2cTimeout,
        ResultURL: urls.b2cResult,
        Occasion: payout.agent.name.slice(0, 100),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { ConversationID?: string; ResponseCode?: string | number; ResponseDescription?: string; errorMessage?: string };
    if (!res.ok || String(data.ResponseCode ?? '') !== '0') return fail(data.errorMessage || data.ResponseDescription || `Safaricom refused the request (${res.status})`);
    await prisma.mpesaDisbursement.update({ where: { id: d.id }, data: { conversationId: data.ConversationID ?? '' } });
    return { ok: true, disbursementId: d.id };
  } catch (err) {
    return fail(err instanceof DarajaError ? err.message : err instanceof Error ? err.message : 'Could not reach Safaricom');
  }
}

interface ResultBody {
  Result?: {
    ResultCode?: number | string;
    ResultDesc?: string;
    OriginatorConversationID?: string;
    ConversationID?: string;
    TransactionID?: string;
    ResultParameters?: { ResultParameter?: { Key: string; Value?: string | number }[] | { Key: string; Value?: string | number } };
  };
}

/** Safaricom's result for a payment we sent: success settles the payout; anything else puts it back to Approved so it can be tried again. */
export async function handleB2cResult(body: unknown): Promise<void> {
  const r = (body as ResultBody)?.Result;
  if (!r?.OriginatorConversationID) return;
  const d = await prisma.mpesaDisbursement.findUnique({ where: { originatorConversationId: r.OriginatorConversationID } });
  if (!d || d.status === 'Success') return; // unknown to us, or already settled (Safaricom may repeat a callback)
  const raw = JSON.stringify(body).slice(0, 8000);
  if (Number(r.ResultCode) === 0) {
    const list = r.ResultParameters?.ResultParameter;
    const params = new Map((Array.isArray(list) ? list : list ? [list] : []).map((p) => [p.Key, p.Value]));
    const receipt = String(params.get('TransactionReceipt') ?? r.TransactionID ?? '').toUpperCase() || null;
    await ensureChartOnce();
    await prisma.$transaction(async (tx) => {
      await tx.mpesaDisbursement.update({ where: { id: d.id }, data: { status: 'Success', resultCode: 0, resultDesc: r.ResultDesc ?? '', receipt, conversationId: r.ConversationID ?? d.conversationId, completedAt: new Date(), rawJson: raw } });
      await settlePayout(tx, d.payoutId, { method: 'M-Pesa', date: todayStr(), byName: `${d.requestedByName} (M-Pesa)`, receipt, amount: d.amount });
    });
  } else {
    await prisma.$transaction([
      prisma.mpesaDisbursement.update({ where: { id: d.id }, data: { status: 'Failed', resultCode: Number(r.ResultCode), resultDesc: r.ResultDesc ?? 'Safaricom could not send it', completedAt: new Date(), rawJson: raw } }),
      prisma.freelancePayout.updateMany({ where: { id: d.payoutId, status: 'Sending' }, data: { status: 'Approved' } }),
    ]);
  }
}

/** Safaricom could not process the request in time: nothing was sent, so the payout can be tried again. */
export async function handleB2cTimeout(body: unknown): Promise<void> {
  const id = (body as ResultBody)?.Result?.OriginatorConversationID;
  if (!id) return;
  const d = await prisma.mpesaDisbursement.findUnique({ where: { originatorConversationId: id } });
  if (!d || d.status !== 'Pending') return;
  await prisma.$transaction([
    prisma.mpesaDisbursement.update({ where: { id: d.id }, data: { status: 'Failed', resultDesc: 'Safaricom did not process the request in time — nothing was sent', completedAt: new Date(), rawJson: JSON.stringify(body).slice(0, 8000) } }),
    prisma.freelancePayout.updateMany({ where: { id: d.payoutId, status: 'Sending' }, data: { status: 'Approved' } }),
  ]);
}
