// (Callers make sure the chart of accounts exists first — ensureChartOnce() — BEFORE opening the transaction this runs in.)
// Settling a freelance sales person's weekly payout: the expense that reaches the books, and the payout marked Paid. One place, so paying by hand (cash, bank, a
// transfer made outside) and an M-Pesa payment sent to their phone from here end up in exactly the same state.
import type { Prisma } from '@prisma/client';
import { round2, todayStr } from '@glm/shared';

export async function settlePayout(
  tx: Prisma.TransactionClient,
  payoutId: number,
  // `receipt` is the reference of the payment: an M-Pesa receipt code, a cheque number, a bank reference
  // `paidOut` is the money actually paid to them (after the tax withheld) when that is not simply the payout less its tax — an M-Pesa payment in
  // whole shillings: the cost is then worked back from it.
  o: { method: string; date?: string; byName: string; receipt?: string | null; paidOut?: number },
) {
  const payout = await tx.freelancePayout.findUniqueOrThrow({ where: { id: payoutId }, include: { agent: true } });
  if (payout.status === 'Paid') return payout;
  const date = o.date ?? todayStr();
  const wht = payout.withholdingTax;
  const amount = o.paidOut !== undefined ? round2(o.paidOut + wht) : payout.amount; // the commission earned (the cost)
  const expense = await tx.expense.create({
    data: {
      date,
      category: 'Freelance Commission',
      amount,
      withholdingTax: wht,
      supplier: payout.agent.name,
      note: `Freelance commission, week of ${payout.weekStart} — ${payout.agent.name}${o.receipt ? ` (${o.method} ${o.receipt})` : ''}`,
      capturedByName: o.byName,
      paid: true,
      method: o.method,
    },
  });
  return tx.freelancePayout.update({
    where: { id: payout.id },
    data: { status: 'Paid', amount, paidOn: date, paidMethod: o.method, paidByName: o.byName, expenseId: expense.id, receipt: o.receipt ?? null },
  });
}
