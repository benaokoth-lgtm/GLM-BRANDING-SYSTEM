import { prisma } from '../db';
import { matchPayment, phoneKey, round2, todayStr } from '@glm/shared';
import type { OpenTarget } from '@glm/shared';
import { PaymentError, receiptLeft, recordOrderPayments } from '../routes/orders';
import { buildReceivablesAging } from './reports';

// M-Pesa payment matching. Money arrives in M-Pesa without going through an order screen — a customer pays the Paybill/Till
// directly, or the owner uploads the M-Pesa statement. Each such receipt is stored as an MpesaTransaction (kind C2B or
// Import, status Unmatched) and booked straight away to M-Pesa / Unallocated M-Pesa Receipts, so the cash is on the books the
// day it arrives. Matching it to an order records a Payment (method M-Pesa, with the receipt code) which moves it out of
// suspense and clears the order's receivable. A receipt is matched automatically when the payer's reference contains the
// order number; otherwise it waits, with suggestions, for a person to confirm.

/** Orders that can still take a payment, as match targets. */
export async function openTargets(): Promise<OpenTarget[]> {
  // As of the end of time: a match target is any order with a balance, whatever its date.
  const aging = await buildReceivablesAging('9999-12-31');
  const orders = await prisma.order.findMany({ where: { id: { in: aging.rows.map((r) => r.orderId) } }, include: { corporateClient: true } });
  const byId = new Map(orders.map((o) => [o.id, o]));
  return aging.rows.map((r) => {
    const o = byId.get(r.orderId);
    return { orderId: r.orderId, ref: r.ref, party: r.party, phone: o?.phone || o?.corporateClient?.phone || '', balance: r.outstanding, createdDate: r.date };
  });
}

export interface ParsedReceipt {
  receipt: string;
  date: string; // YYYY-MM-DD
  phone: string;
  name: string;
  amount: number;
  reference: string;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if ((ch === ',' || ch === '\t') && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** 'DD-MM-YYYY', 'DD/MM/YYYY' or 'YYYY-MM-DD' (any trailing time) → 'YYYY-MM-DD', or null. */
export function normaliseDate(raw: string): string | null {
  const t = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})(\d{2})\d{6}$/.exec(t); // Daraja TransTime
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const toNumber = (v: string) => Number(String(v).replace(/[^\d.-]/g, '')) || 0;

/**
 * Reads an M-Pesa statement (CSV or tab-separated, as downloaded from the M-Pesa portal / Safaricom Business app) or a
 * simple "Receipt, Date, Phone, Name, Amount, Reference" sheet. Only money IN is kept. Columns are found by their headings,
 * so the order and any extra columns don't matter.
 */
export function parseStatement(text: string): { receipts: ParsedReceipt[]; skipped: number } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let headerAt = lines.findIndex((l) => /receipt/i.test(l) && /(paid ?in|amount|credit)/i.test(l));
  if (headerAt < 0) headerAt = lines.findIndex((l) => /receipt/i.test(l));
  if (headerAt < 0) return { receipts: [], skipped: lines.length };
  const head = splitCsvLine(lines[headerAt]!).map((h) => h.toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const iReceipt = col('receipt');
  const iTime = col('completion', 'time', 'date');
  const iDetails = col('details', 'description');
  const iPaidIn = col('paid in', 'paid_in', 'paidin', 'credit', 'amount');
  const iPhone = col('phone', 'msisdn', 'number');
  const iName = col('name');
  const iRef = col('reference', 'account', 'bill');
  const iStatus = col('status');

  const receipts: ParsedReceipt[] = [];
  let skipped = 0;
  for (const line of lines.slice(headerAt + 1)) {
    const c = splitCsvLine(line);
    const receipt = (c[iReceipt] || '').toUpperCase().replace(/\s+/g, '');
    const amount = iPaidIn >= 0 ? toNumber(c[iPaidIn] || '') : 0;
    const status = iStatus >= 0 ? (c[iStatus] || '').toLowerCase() : 'completed';
    const date = iTime >= 0 ? normaliseDate(c[iTime] || '') : null;
    if (!receipt || !(amount > 0) || !date || (status && !status.includes('complet'))) {
      skipped++;
      continue;
    }
    const details = iDetails >= 0 ? c[iDetails] || '' : '';
    const phone = (iPhone >= 0 ? c[iPhone] : '') || /(?:\+?254|0)[17]\d{8}/.exec(details)?.[0] || '';
    const name = (iName >= 0 ? c[iName] : '') || (/-\s*([A-Za-z][A-Za-z .'-]+?)(?:\s+Acc\b.*)?$/.exec(details)?.[1] ?? '');
    const reference = [iRef >= 0 ? c[iRef] : '', details].filter(Boolean).join(' ');
    receipts.push({ receipt, date, phone: phone.replace(/\D/g, ''), name: name.trim(), amount, reference });
  }
  return { receipts, skipped };
}

/** Stores one received M-Pesa payment (idempotent on the receipt code). Returns null if it was already known. */
export async function storeReceipt(r: ParsedReceipt & { kind: 'C2B' | 'Import'; raw?: unknown }, by: string) {
  if (await prisma.mpesaTransaction.findUnique({ where: { mpesaReceipt: r.receipt } })) return null;

  // Already recorded by hand against one or more orders (the cashier typed the receipt code on each)? Tie them together instead of booking it twice; what they do not use stays free on the receipt.
  const manuals = await prisma.payment.findMany({ where: { method: 'M-Pesa', reference: r.receipt, mpesaTransactionId: null }, orderBy: { id: 'asc' } });
  const manualTotal = round2(manuals.reduce((a, p) => a + p.amount, 0));
  const linkable = manuals.length > 0 && manualTotal <= r.amount + 1 ? manuals : [];
  const used = linkable.length > 0 && r.amount - manualTotal < 1; // all of it is on orders already

  const tx = await prisma.mpesaTransaction.create({
    data: {
      checkoutRequestId: `${r.kind}-${r.receipt}`,
      merchantRequestId: '',
      phone: r.phone,
      amount: r.amount,
      accountReference: r.reference,
      status: used ? 'Applied' : 'Unmatched',
      mpesaReceipt: r.receipt,
      orderId: linkable[0]?.orderId ?? null,
      createdByName: by,
      kind: r.kind,
      payerName: r.name,
      receivedOn: r.date,
      appliedByName: linkable.length ? (used ? 'Matched to a payment already recorded' : 'Part matched to payments already recorded') : null,
      appliedAt: used ? new Date() : null,
      rawJson: JSON.stringify(r.raw ?? {}),
    },
  });
  for (const p of linkable) await prisma.payment.update({ where: { id: p.id }, data: { mpesaTransactionId: tx.id } });
  const linked = linkable.length > 0;
  return { tx, linked };
}

/**
 * Applies a received M-Pesa / NCBA receipt to one or SEVERAL orders — a customer who owes on several orders pays them all with one payment. Each order takes the amount given (never more than it
 * owes), the receipt never gives away more than it holds, and what is left stays on the waiting list, with what is left, until it is applied or put right. Records one payment per order, all
 * carrying the receipt code. The receipt becomes Applied when nothing (under Ksh 1) is left on it.
 */
export async function allocateReceipt(txId: number, allocations: { orderId: number; amount: number }[], by: string) {
  const tx = await prisma.mpesaTransaction.findUnique({ where: { id: txId } });
  if (!tx) throw new PaymentError('M-Pesa payment not found');
  if (tx.status !== 'Unmatched') throw new PaymentError('This payment has already been dealt with');
  if (!tx.mpesaReceipt) throw new PaymentError('This payment has no M-Pesa receipt code to match on');
  const parts = allocations.filter((a) => a.amount > 0);
  if (parts.length === 0) throw new PaymentError('Enter the amount for at least one order');
  if (new Set(parts.map((a) => a.orderId)).size !== parts.length) throw new PaymentError('An order is listed twice — give it one amount');
  const left = await receiptLeft(prisma, tx);
  const total = round2(parts.reduce((a, p) => a + p.amount, 0));
  if (total > left + 1) throw new PaymentError(`The amounts add up to Ksh ${Math.round(total).toLocaleString('en-KE')}, but only Ksh ${Math.round(left).toLocaleString('en-KE')} of this payment is still free`);
  const targets = await openTargets();
  const orders = await prisma.order.findMany({ where: { id: { in: parts.map((p) => p.orderId) } }, include: { corporateClient: true } });
  for (const p of parts) {
    const order = orders.find((o) => o.id === p.orderId);
    if (!order) throw new PaymentError('Order not found');
    const target = targets.find((t) => t.orderId === p.orderId);
    if (!target) throw new PaymentError(`${order.orderNo} has nothing outstanding`);
    if (round2(p.amount) > round2(target.balance) + 1) {
      throw new PaymentError(`${order.orderNo} only owes Ksh ${Math.round(target.balance).toLocaleString('en-KE')} — less than the Ksh ${Math.round(p.amount).toLocaleString('en-KE')} given to it. Lower its amount, or split the payment across more orders.`);
    }
  }
  const remaining = round2(left - total);
  const used = remaining < 1;
  await prisma.$transaction(async (db) => {
    for (const p of parts) {
      const order = orders.find((o) => o.id === p.orderId)!;
      // Entering the receipt code links each payment to this statement line (see recordOrderPayments).
      await recordOrderPayments(db, order, [{ method: 'M-Pesa', amount: p.amount, reference: tx.mpesaReceipt, linkedTransactionId: tx.id }], null, tx.receivedOn ?? todayStr());
      if (parts.length > 1 || !used) await db.matchChange.create({ data: { transactionId: tx.id, receipt: tx.mpesaReceipt ?? '', amount: p.amount, fromOrderNo: '(unallocated)', toOrderNo: order.orderNo, reason: `Part of this receipt (Ksh ${Math.round(total).toLocaleString('en-KE')} of Ksh ${Math.round(tx.amount).toLocaleString('en-KE')})`.slice(0, 300), byName: by } });
    }
    await db.mpesaTransaction.update({
      where: { id: tx.id },
      data: { orderId: tx.orderId ?? parts[0]!.orderId, appliedByName: parts.length > 1 ? `${by} (split across ${parts.length} orders)` : used ? by : `${by} (part)`, ...(used ? { status: 'Applied', appliedAt: new Date() } : {}) },
    });
  });
  return { applied: total, remaining, orders: parts.length };
}

/** Applies a received M-Pesa payment to one order: all that is still free on the receipt goes to it. (To share it between orders, see allocateReceipt.) */
export async function applyReceiptToOrder(txId: number, orderId: number, by: string) {
  const tx = await prisma.mpesaTransaction.findUnique({ where: { id: txId } });
  if (!tx) throw new PaymentError('M-Pesa payment not found');
  const left = await receiptLeft(prisma, tx);
  return allocateReceipt(txId, [{ orderId, amount: left }], by);
}

/**
 * The orders a receipt could be split across: those that owe something, the payer's own first (the same phone number), oldest first, with a suggested split — the oldest orders filled first until the
 * receipt is used up. A person edits it before confirming.
 */
export async function splitSuggestion(txId: number) {
  const tx = await prisma.mpesaTransaction.findUnique({ where: { id: txId }, include: { payments: { include: { order: { select: { orderNo: true } } } } } });
  if (!tx) throw new PaymentError('M-Pesa payment not found');
  const left = await receiptLeft(prisma, tx);
  const key = phoneKey(tx.phone);
  const targets = await openTargets();
  const rows = targets
    .map((t) => ({ orderId: t.orderId, ref: t.ref, party: t.party, balance: round2(t.balance), date: t.createdDate, samePayer: !!key && phoneKey(t.phone) === key }))
    .sort((a, b) => Number(b.samePayer) - Number(a.samePayer) || a.date.localeCompare(b.date) || a.orderId - b.orderId);
  let free = left;
  const suggested: { orderId: number; amount: number }[] = [];
  for (const r of rows.filter((x) => x.samePayer)) {
    if (free < 0.5) break;
    const amount = round2(Math.min(free, r.balance));
    suggested.push({ orderId: r.orderId, amount });
    free = round2(free - amount);
  }
  return {
    id: tx.id,
    receipt: tx.mpesaReceipt,
    amount: tx.amount,
    left,
    phone: tx.phone,
    payerName: tx.payerName,
    status: tx.status,
    applied: tx.payments.map((p) => ({ orderNo: p.order.orderNo, amount: p.amount })),
    orders: rows.slice(0, 300),
    suggested,
  };
}

/** Applies every unmatched receipt whose own reference names an order; leaves the rest for a person. */
export async function autoMatch(by: string): Promise<number> {
  const unmatched = await prisma.mpesaTransaction.findMany({ where: { kind: { in: ['C2B', 'Import'] }, status: 'Unmatched' }, orderBy: { id: 'asc' } });
  let applied = 0;
  for (const t of unmatched) {
    const targets = await openTargets();
    const m = matchPayment({ amount: t.amount, phone: t.phone, accountReference: t.accountReference }, targets);
    if (m.matched && m.reason === 'reference') {
      try {
        await applyReceiptToOrder(t.id, m.target.orderId, `${by} (auto-matched on order number)`);
        applied++;
      } catch {
        // leave it for a person
      }
    }
  }
  return applied;
}

export async function importStatement(text: string, by: string) {
  const { receipts, skipped } = parseStatement(text);
  let added = 0;
  let duplicates = 0;
  let linked = 0;
  for (const r of receipts) {
    const stored = await storeReceipt({ ...r, kind: 'Import' }, by);
    if (!stored) duplicates++;
    else if (stored.linked) linked++;
    else added++;
  }
  const applied = await autoMatch(by);
  return { read: receipts.length, added, duplicates, linkedToRecorded: linked, autoApplied: applied, skipped };
}

export { phoneKey };

// ── Putting a wrong match right ─────────────────────────────────────────────
// A receipt that was matched to the wrong order (a mistyped order number, the wrong client with the same amount, an automatic match on a shared reference) can be MOVED to the right order, or taken
// off the order altogether (UNMATCHED) so it goes back to the waiting list. Both leave a line in the match log with who did it and why; the money never leaves the books, only the order it is
// counted against changes. Only M-Pesa and NCBA receipts are handled here: they are the ones with a statement line to be right about.

const kes = (n: number) => 'Ksh ' + Math.round(n).toLocaleString('en-KE');

/** The recorded payment behind an M-Pesa / NCBA receipt, with its order. A receipt shared by several orders has several payments: say which one (paymentId). */
async function matchedPayment(txId: number, paymentId?: number) {
  const tx = await prisma.mpesaTransaction.findUnique({ where: { id: txId }, include: { payments: { include: { order: true }, orderBy: { id: 'asc' } } } });
  if (!tx) throw new PaymentError('That M-Pesa payment was not found');
  if (tx.payments.length === 0) throw new PaymentError('That receipt is not matched to an order, so there is nothing to put right');
  const payment = paymentId ? tx.payments.find((p) => p.id === paymentId) : tx.payments.length === 1 ? tx.payments[0] : undefined;
  if (!payment) throw new PaymentError(paymentId ? 'That part of the receipt was not found' : 'This receipt is shared by several orders — choose which part to change');
  return { tx, payment, order: payment.order };
}

/** Moves a matched receipt from the order it is on to another order that still owes at least that much. */
export async function moveMatchedPayment(txId: number, toOrderId: number, by: string, reason: string, paymentId?: number) {
  const why = reason.trim();
  if (!why) throw new PaymentError('Say why the payment is being moved');
  const { tx, payment, order: from } = await matchedPayment(txId, paymentId);
  if (payment.method !== 'M-Pesa') throw new PaymentError('Only an M-Pesa or NCBA payment can be moved here');
  if (from.id === toOrderId) throw new PaymentError('It is already on that order');
  const to = await prisma.order.findUnique({ where: { id: toOrderId } });
  if (!to) throw new PaymentError('The order to move it to was not found');
  const target = (await openTargets()).find((t) => t.orderId === toOrderId);
  if (!target) throw new PaymentError(`${to.orderNo} has nothing outstanding to put it against`);
  if (round2(payment.amount) > round2(target.balance) + 1) {
    throw new PaymentError(`${to.orderNo} only owes ${kes(target.balance)} — less than the ${kes(payment.amount)} received`);
  }
  await prisma.$transaction(async (db) => {
    await db.payment.update({ where: { id: payment.id }, data: { orderId: to.id } });
    await db.mpesaTransaction.update({ where: { id: tx.id }, data: { orderId: tx.orderId === from.id ? to.id : tx.orderId, appliedByName: `${by} (moved from ${from.orderNo})` } });
    await db.matchChange.create({ data: { transactionId: tx.id, receipt: tx.mpesaReceipt ?? '', amount: payment.amount, fromOrderNo: from.orderNo, toOrderNo: to.orderNo, reason: why.slice(0, 300), byName: by } });
  });
  return { from: from.orderNo, to: to.orderNo };
}

/** Takes a matched Paybill / statement receipt off its order: the payment is removed and the receipt goes back to the waiting list (Unmatched), to be matched to the right order. */
export async function unmatchPayment(txId: number, by: string, reason: string, paymentId?: number) {
  const why = reason.trim();
  if (!why) throw new PaymentError('Say why the payment is being taken off the order');
  const { tx, payment, order: from } = await matchedPayment(txId, paymentId);
  if (payment.method !== 'M-Pesa') throw new PaymentError('Only an M-Pesa or NCBA payment can be taken off here');
  if (tx.kind === 'STK') throw new PaymentError('A payment from a push we sent belongs to the order it was sent for — move it to another order instead');
  await prisma.$transaction(async (db) => {
    await db.payment.delete({ where: { id: payment.id } });
    const others = tx.payments.filter((p) => p.id !== payment.id);
    // what is left on the receipt goes back to waiting (any other part stays where it is)
    await db.mpesaTransaction.update({ where: { id: tx.id }, data: { status: 'Unmatched', orderId: others[0]?.orderId ?? null, appliedByName: others.length ? 'Part matched' : null, appliedAt: null } });
    await db.matchChange.create({ data: { transactionId: tx.id, receipt: tx.mpesaReceipt ?? '', amount: payment.amount, fromOrderNo: from.orderNo, toOrderNo: null, reason: why.slice(0, 300), byName: by } });
  });
  return { from: from.orderNo };
}
