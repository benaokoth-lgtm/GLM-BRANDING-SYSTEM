import { ACCT, round2 } from '@glm/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { loadLedger } from './accounting/ledger';

// The cheque register (Finance → Cheques). Every cheque number the business uses is kept once: the cheque drawn to the finance head and cashed for the petty cash float (a Bank Withdrawal
// top-up), the cheques written to suppliers (an expense paid by cheque), and numbers that were spoilt or cancelled. A cheque is "issued" until it is seen on the bank statement and marked
// "cleared", so the cheques still unpresented are always known and the bank reconciliation has something to tick against.

/** A cheque number as it is kept: no spaces, upper case — so "000 457" and "000457" are the same cheque. */
export function normChequeNo(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : '';
}

export class ChequeError extends Error {}

type Db = Prisma.TransactionClient | typeof prisma;

/** Records a cheque number, refusing one already used. */
export async function recordCheque(
  db: Db,
  c: { chequeNo: string; date: string; payee: string; amount: number; kind: 'Withdrawal' | 'Payment' | 'Cancelled'; note?: string; topUpId?: number | null; expenseId?: number | null; expensePaymentId?: number | null; capturedByName: string },
) {
  const chequeNo = normChequeNo(c.chequeNo);
  if (!chequeNo || chequeNo.length > 30) throw new ChequeError('Enter the cheque number');
  const dup = await db.cheque.findUnique({ where: { chequeNo } });
  if (dup) throw new ChequeError(`Cheque ${chequeNo} is already recorded (${dup.date}, Ksh ${Math.round(dup.amount).toLocaleString('en-KE')}${dup.payee ? `, ${dup.payee}` : ''})`);
  return db.cheque.create({
    data: {
      chequeNo,
      date: c.date,
      payee: c.payee.trim().slice(0, 120),
      amount: c.amount,
      kind: c.kind,
      status: c.kind === 'Cancelled' ? 'Cancelled' : 'Issued',
      note: (c.note ?? '').slice(0, 300),
      topUpId: c.topUpId ?? null,
      expenseId: c.expenseId ?? null,
      expensePaymentId: c.expensePaymentId ?? null,
      capturedByName: c.capturedByName,
    },
  });
}

export type SpendGroup = 'Salaries' | 'Purchases' | 'Expenses' | 'Other';
const GROUPS: SpendGroup[] = ['Salaries', 'Purchases', 'Expenses', 'Other'];

export interface Funding {
  id: number;
  date: string;
  amount: number;
  source: string;
  note: string;
}
export interface Outflow {
  date: string;
  amount: number;
  label: string;
  group: SpendGroup;
}
export interface Slot extends Funding {
  left: number;
  spent: Record<SpendGroup, number>;
  items: { date: string; label: string; amount: number; group: SpendGroup }[];
}

/** Shares each payment out of the float between the top-ups made by the day it was paid, oldest first. What no top-up had covered is returned as unallocated. */
export function allocateFifo(funding: Funding[], outflows: Outflow[]): { slots: Slot[]; unallocated: number } {
  const slots: Slot[] = funding.map((t) => ({ ...t, left: t.amount, spent: { Salaries: 0, Purchases: 0, Expenses: 0, Other: 0 }, items: [] }));
  let unallocated = 0;
  for (const o of outflows) {
    let need = o.amount;
    for (const s of slots) {
      if (need <= 0.004) break;
      if (s.date > o.date || s.left <= 0.004) continue;
      const take = Math.min(s.left, need);
      s.left = round2(s.left - take);
      s.spent[o.group] = round2(s.spent[o.group] + take);
      if (s.items.length < 80) s.items.push({ date: o.date, label: o.label, amount: round2(take), group: o.group });
      need = round2(need - take);
    }
    if (need > 0.004) unallocated = round2(unallocated + need);
  }
  return { slots, unallocated };
}

/**
 * Where each cash withdrawal went. Money in the float is pooled, so the oldest money is taken to be spent first: each payment out of petty cash (salaries, stock purchases, other
 * expenses) is shared between the top-ups, oldest first, that had been made by the day it was paid. A cheque drawn for several purposes then shows how much of it went to each, and what
 * is left. What was paid before any top-up on record (an opening balance) is shown as unallocated.
 */
export async function withdrawalAccounting() {
  const [topUps, ledger, purchaseExpenses, cheques] = await Promise.all([
    prisma.pettyCashTopUp.findMany({ orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
    loadLedger(),
    prisma.purchase.findMany({ where: { expenseId: { not: null } }, select: { expense: { select: { id: true, invoiceNumber: true } } } }),
    prisma.cheque.findMany({ where: { topUpId: { not: null } } }),
  ]);
  const purchaseRefs = new Set(purchaseExpenses.map((p) => p.expense?.invoiceNumber || `EXP-${p.expense?.id}`));
  const petty = ledger.byCode.get(ACCT.pettyCash);
  const outflows = (petty ? ledger.postings.filter((p) => p.accountId === petty.id && p.credit > 0) : [])
    .map((p) => ({ date: p.date, amount: p.credit, label: p.memo || p.source, group: (p.source === 'Wages' ? 'Salaries' : p.source === 'Expense' ? (purchaseRefs.has(p.ref) ? 'Purchases' : 'Expenses') : 'Other') as SpendGroup }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const { slots, unallocated } = allocateFifo(topUps.map((t) => ({ id: t.id, date: t.date, amount: t.amount, source: t.source, note: t.note })), outflows);
  const chequeOf = new Map(cheques.map((c) => [c.topUpId!, c]));
  return {
    unallocated,
    withdrawals: slots
      .filter((s) => s.source === 'Bank Withdrawal')
      .map((s) => {
        const c = chequeOf.get(s.id);
        const spent = round2(GROUPS.reduce((a, g) => a + s.spent[g], 0));
        return { topUpId: s.id, date: s.date, amount: s.amount, note: s.note, chequeNo: c?.chequeNo ?? null, payee: c?.payee ?? '', spent, remaining: round2(s.amount - spent), breakdown: s.spent, items: s.items };
      })
      .reverse(),
  };
}
