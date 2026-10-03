import { prisma } from '../db';
import { matchPayment, phoneKey, round2, todayStr } from '@glm/shared';
import type { OpenTarget } from '@glm/shared';
import { PaymentError, recordOrderPayments } from '../routes/orders';
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

  // Already recorded by hand against an order (the cashier typed the receipt code)? Tie them together instead of booking it twice.
  const manual = await prisma.payment.findFirst({ where: { method: 'M-Pesa', reference: r.receipt, mpesaTransactionId: null } });
  const linkable = manual && Math.abs(manual.amount - r.amount) <= 1 ? manual : null;

  const tx = await prisma.mpesaTransaction.create({
    data: {
      checkoutRequestId: `${r.kind}-${r.receipt}`,
      merchantRequestId: '',
      phone: r.phone,
      amount: r.amount,
      accountReference: r.reference,
      status: linkable ? 'Applied' : 'Unmatched',
      mpesaReceipt: r.receipt,
      orderId: linkable?.orderId ?? null,
      createdByName: by,
      kind: r.kind,
      payerName: r.name,
      receivedOn: r.date,
      appliedByName: linkable ? 'Matched to a payment already recorded' : null,
      appliedAt: linkable ? new Date() : null,
      rawJson: JSON.stringify(r.raw ?? {}),
    },
  });
  if (linkable) await prisma.payment.update({ where: { id: linkable.id }, data: { mpesaTransactionId: tx.id } });
  return { tx, linked: !!linkable };
}

/** Applies a received M-Pesa payment to an order: records the order payment and marks the receipt Applied. */
export async function applyReceiptToOrder(txId: number, orderId: number, by: string) {
  const tx = await prisma.mpesaTransaction.findUnique({ where: { id: txId } });
  if (!tx) throw new PaymentError('M-Pesa payment not found');
  if (tx.status !== 'Unmatched') throw new PaymentError('This payment has already been dealt with');
  if (!tx.mpesaReceipt) throw new PaymentError('This payment has no M-Pesa receipt code to match on');
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { corporateClient: true } });
  if (!order) throw new PaymentError('Order not found');
  const targets = await openTargets();
  const target = targets.find((t) => t.orderId === orderId);
  if (!target) throw new PaymentError(`${order.orderNo} has nothing outstanding`);
  if (round2(tx.amount) > round2(target.balance) + 1) {
    throw new PaymentError(`${order.orderNo} only owes Ksh ${Math.round(target.balance).toLocaleString('en-KE')} — less than the Ksh ${Math.round(tx.amount).toLocaleString('en-KE')} received`);
  }
  await prisma.$transaction(async (db) => {
    // Entering the receipt code links the payment to this statement line (see recordOrderPayments).
    await recordOrderPayments(db, order, [{ method: 'M-Pesa', amount: tx.amount, reference: tx.mpesaReceipt }], null, tx.receivedOn ?? todayStr());
    await db.mpesaTransaction.update({ where: { id: tx.id }, data: { appliedByName: by } });
  });
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
