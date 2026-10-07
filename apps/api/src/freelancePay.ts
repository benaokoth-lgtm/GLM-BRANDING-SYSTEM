// (Callers make sure the chart of accounts exists first — ensureChartOnce() — BEFORE opening the transaction this runs in.)
// Settling a freelance sales person's weekly payout: the expense that reaches the books, and the payout marked Paid. One place, so paying by hand (cash, bank, a
// transfer made outside) and an M-Pesa payment sent to their phone from here end up in exactly the same state.
import type { Prisma } from '@prisma/client';
import { todayStr } from '@glm/shared';

export async function settlePayout(
  tx: Prisma.TransactionClient,
  payoutId: number,
  o: { method: string; date?: string; byName: string; receipt?: string | null; amount?: number },
) {
  const payout = await tx.freelancePayout.findUniqueOrThrow({ where: { id: payoutId }, include: { agent: true } });
  if (payout.status === 'Paid') return payout;
  const date = o.date ?? todayStr();
  const amount = o.amount ?? payout.amount;
  const expense = await tx.expense.create({
    data: {
      date,
      category: 'Freelance Commission',
      amount,
      supplier: payout.agent.name,
      note: `Freelance commission, week of ${payout.weekStart} — ${payout.agent.name}${o.receipt ? ` (M-Pesa ${o.receipt})` : ''}`,
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
