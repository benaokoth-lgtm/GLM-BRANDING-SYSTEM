// (Callers make sure the chart of accounts exists first — ensureChartOnce() — BEFORE opening the transaction this runs in.)
// Sales persons paid as contractors (Commission → Team & payouts, from the month set in Commission → Pay details): the month's total less withholding tax, outside payroll. Settling a payout —
// the expense that reaches the books (Sales Commission, with the tax withheld held in Withholding Tax Payable) and the payout marked Paid — is one place, so paying by hand (cash, bank, a transfer
// made outside) and an M-Pesa payment sent to their phone from here end up in exactly the same state.
import type { Prisma } from '@prisma/client';
import { round2, todayStr } from '@glm/shared';
import { prisma } from './db';

export async function settleCommissionPayout(
  tx: Prisma.TransactionClient,
  payoutId: number,
  // `receipt` is the reference of the payment: an M-Pesa receipt code, a cheque number, a bank reference
  // `paidOut` is the money actually paid to them (after the tax withheld) when that is not simply the payout less its tax — an M-Pesa payment in whole shillings: the cost is then worked back from it.
  o: { method: string; date?: string; byName: string; receipt?: string | null; paidOut?: number },
) {
  const payout = await tx.commissionPayout.findUniqueOrThrow({ where: { id: payoutId }, include: { staff: { select: { name: true } } } });
  if (payout.status === 'Paid') return payout;
  const date = o.date ?? todayStr();
  const wht = payout.withholdingTax;
  const amount = o.paidOut !== undefined ? round2(o.paidOut + wht) : payout.amount; // the commission earned (the cost)
  const expense = await tx.expense.create({
    data: {
      date,
      category: 'Sales Commission',
      amount,
      withholdingTax: wht,
      supplier: payout.staff.name,
      note: `Sales commission ${payout.period} — ${payout.staff.name}${o.receipt ? ` (${o.method} ${o.receipt})` : ''}`,
      capturedByName: o.byName,
      paid: true,
      method: o.method,
    },
  });
  return tx.commissionPayout.update({
    where: { id: payout.id },
    data: { status: 'Paid', amount, paidOn: date, paidMethod: o.method, paidByName: o.byName, expenseId: expense.id, receipt: o.receipt ?? null },
  });
}

/** The first month ('YYYY-MM') sales persons are paid as contractors, or '' while that is not switched on. */
export async function contractorFromMonth(): Promise<string> {
  return (await prisma.commissionSettings.findUnique({ where: { id: 1 } }))?.contractorFrom ?? '';
}

/** Are sales persons paid as contractors in this month (and so is no order credited to a freelance account any more)? */
export function contractorsOn(from: string, period: string): boolean {
  return !!from && period >= from;
}

/** The phone a contractor's pay is sent to: their M-Pesa number, else their phone — as 2547XXXXXXXX, or null when neither is usable. */
export function payPhone(p: { mpesaNumber?: string | null; phone?: string | null } | null | undefined): string | null {
  for (const raw of [p?.mpesaNumber, p?.phone]) {
    const d = (raw ?? '').replace(/\D/g, '');
    const n = d.startsWith('254') ? d : d.startsWith('0') ? '254' + d.slice(1) : d.length === 9 ? '254' + d : d;
    if (/^254[17]\d{8}$/.test(n)) return n;
  }
  return null;
}
