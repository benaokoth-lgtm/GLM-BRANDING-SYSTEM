import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  computeOrderTotals,
  computePay,
  EMPLOYEE_TYPES,
  EXPENSE_CATEGORIES,
  FINANCE_ROLES,
  PAYMENT_METHODS,
  PETTY_CASH_SOURCES,
  splitVatInclusive,
} from '@glm/shared';
import type { LineItemInput } from '@glm/shared';

export const financeRouter = Router();
financeRouter.use(requireAuth, requireRole(...FINANCE_ROLES));

function inRange(d: string, from: string, to: string): boolean {
  return d >= from && d <= to;
}

function parseRange(req: { query: Record<string, unknown> }): { from: string; to: string } | null {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  return { from, to };
}

// ── Payroll (also backs the NSSF/SHIF derived views on the frontend) ───────
financeRouter.get('/payroll', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });

  const entries = await prisma.payrollEntry.findMany({
    where: { date: { gte: range.from, lte: range.to } },
    include: { staff: true },
    orderBy: { date: 'desc' },
  });

  const rows = entries.map((e) => {
    const pay = computePay(e.grossPay, e.employeeType as 'Employee' | 'Casual');
    return {
      id: e.id,
      date: e.date,
      staffId: e.staffId,
      name: e.staff.name,
      employeeType: e.employeeType,
      department: e.department,
      daysWorked: e.daysWorked,
      rate: e.rate,
      paymentMethod: e.paymentMethod,
      capturedByName: e.capturedByName,
      ...pay,
    };
  });

  const totals = rows.reduce(
    (a, r) => ({
      grossPayroll: a.grossPayroll + r.grossPay,
      totalStatutory: a.totalStatutory + r.totalDeductions,
      netPayroll: a.netPayroll + r.netPay,
      totalPaye: a.totalPaye + r.paye,
      totalNssf: a.totalNssf + r.nssf,
      totalShif: a.totalShif + r.shif,
      totalHousingLevy: a.totalHousingLevy + r.housingLevy,
    }),
    { grossPayroll: 0, totalStatutory: 0, netPayroll: 0, totalPaye: 0, totalNssf: 0, totalShif: 0, totalHousingLevy: 0 },
  );

  res.json({ fromDate: range.from, toDate: range.to, rows, ...totals });
});

const payrollSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  staffId: z.number().int(),
  employeeType: z.enum(EMPLOYEE_TYPES),
  department: z.string().max(100).optional(),
  daysWorked: z.number().positive(),
  rate: z.number().positive(),
  paymentMethod: z.enum(PAYMENT_METHODS),
});

financeRouter.post('/payroll', async (req, res) => {
  const parsed = payrollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const { daysWorked, rate, staffId } = parsed.data;

  const staff = await prisma.user.findUnique({ where: { id: staffId } });
  if (!staff) return res.status(400).json({ error: 'Selected staff member not found' });

  const entry = await prisma.payrollEntry.create({
    data: { ...parsed.data, department: parsed.data.department ?? '', grossPay: daysWorked * rate, capturedByName: req.user!.name },
  });
  res.status(201).json({ ...entry, name: staff.name });
});

financeRouter.delete('/payroll/:id', async (req, res) => {
  await prisma.payrollEntry.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});

// ── VAT — output VAT on real sales for the period ───────────────────────────
interface OrderForVat {
  kind: string;
  status: string;
  createdDate: string;
  orderDiscountPct: number;
  orderDiscountAmt: number;
  lineItems: LineItemInput[];
}

financeRouter.get('/vat', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });

  const orders = await prisma.order.findMany({ include: { lineItems: true } });
  const forVat: OrderForVat[] = orders.map((o) => ({
    kind: o.kind,
    status: o.status,
    createdDate: o.createdDate,
    orderDiscountPct: o.orderDiscountPct,
    orderDiscountAmt: o.orderDiscountAmt,
    lineItems: o.lineItems.map((li) => ({
      itemType: li.itemType as LineItemInput['itemType'],
      serviceId: li.serviceId,
      materialId: li.materialId,
      qty: li.qty,
      unitPrice: li.unitPrice,
      discountPct: li.discountPct,
      discountAmt: li.discountAmt,
    })),
  }));

  let walkinSales = 0;
  let corporateSales = 0;
  for (const o of forVat) {
    const isRevenueOrder = o.kind === 'walkin' || o.status === 'Invoice';
    if (isRevenueOrder && inRange(o.createdDate, range.from, range.to)) {
      const totals = computeOrderTotals({ lineItems: o.lineItems, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt });
      if (o.kind === 'walkin') walkinSales += totals.grandTotal;
      else corporateSales += totals.grandTotal;
    }
  }

  const totalSales = walkinSales + corporateSales;
  const { net: netSales, vat: outputVat } = splitVatInclusive(totalSales);

  res.json({ fromDate: range.from, toDate: range.to, walkinSales, corporateSales, totalSales, netSales, outputVat });
});

// ── Operating expenses (capture) — P&L reads/aggregates the same table ──────
financeRouter.get('/expenses', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });

  const rows = await prisma.expense.findMany({
    where: { date: { gte: range.from, lte: range.to } },
    orderBy: { date: 'desc' },
  });
  const totalExpenses = rows.reduce((a, e) => a + e.amount, 0);

  res.json({ fromDate: range.from, toDate: range.to, rows, totalExpenses, expenseCategories: EXPENSE_CATEGORIES });
});

const expenseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.enum(EXPENSE_CATEGORIES),
  note: z.string().max(200).optional(),
  amount: z.number().positive(),
});

financeRouter.post('/expenses', async (req, res) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const expense = await prisma.expense.create({
    data: { ...parsed.data, note: parsed.data.note ?? '', capturedByName: req.user!.name },
  });
  res.status(201).json(expense);
});

financeRouter.delete('/expenses/:id', async (req, res) => {
  await prisma.expense.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});

// ── Expense amendments — correct a wrong entry without editing history; the
// Expense row itself (and P&L numbers built from it) only change once a
// finance manager/general manager/admin approves the request. ─────────────
financeRouter.get('/expenses/amendments', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const amendments = await prisma.expenseAmendment.findMany({
    where: status ? { status } : undefined,
    include: { expense: true },
    orderBy: { requestedAt: 'desc' },
  });
  res.json(
    amendments.map((a) => ({
      id: a.id,
      expenseId: a.expenseId,
      currentDate: a.expense.date,
      currentCategory: a.expense.category,
      currentNote: a.expense.note,
      currentAmount: a.expense.amount,
      proposedDate: a.proposedDate,
      proposedCategory: a.proposedCategory,
      proposedNote: a.proposedNote,
      proposedAmount: a.proposedAmount,
      reason: a.reason,
      status: a.status,
      requestedByName: a.requestedByName,
      requestedAt: a.requestedAt,
      decidedByName: a.decidedByName,
      decidedAt: a.decidedAt,
    })),
  );
});

const amendSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.enum(EXPENSE_CATEGORIES),
  note: z.string().max(200).optional(),
  amount: z.number().positive(),
  reason: z.string().min(1, 'A reason for the amendment is required'),
});

financeRouter.post('/expenses/:id/amend', async (req, res) => {
  const parsed = amendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const expense = await prisma.expense.findUnique({ where: { id: Number(req.params.id) } });
  if (!expense) return res.status(404).json({ error: 'Expense not found' });

  const amendment = await prisma.expenseAmendment.create({
    data: {
      expenseId: expense.id,
      proposedDate: parsed.data.date,
      proposedCategory: parsed.data.category,
      proposedNote: parsed.data.note ?? '',
      proposedAmount: parsed.data.amount,
      reason: parsed.data.reason,
      requestedByName: req.user!.name,
    },
  });
  res.status(201).json(amendment);
});

async function decideAmendment(req: Request, res: Response, approve: boolean) {
  const amendment = await prisma.expenseAmendment.findUnique({ where: { id: Number(req.params.id) } });
  if (!amendment) return res.status(404).json({ error: 'Amendment not found' });
  if (amendment.status !== 'Pending') return res.status(400).json({ error: 'Amendment has already been decided' });
  if (amendment.requestedByName === req.user!.name) {
    return res.status(400).json({ error: 'You cannot approve or reject your own amendment request' });
  }

  if (approve) {
    await prisma.expense.update({
      where: { id: amendment.expenseId },
      data: { date: amendment.proposedDate, category: amendment.proposedCategory, note: amendment.proposedNote, amount: amendment.proposedAmount },
    });
  }

  const updated = await prisma.expenseAmendment.update({
    where: { id: amendment.id },
    data: { status: approve ? 'Approved' : 'Rejected', decidedByName: req.user!.name, decidedAt: new Date() },
  });
  res.json(updated);
}

financeRouter.post('/expenses/amendments/:id/approve', (req, res) => decideAmendment(req, res, true));
financeRouter.post('/expenses/amendments/:id/reject', (req, res) => decideAmendment(req, res, false));

// ── Petty cash — "in" from bank withdrawals / cash-sales allocations (this ──
// route is Finance-Manager/General-Manager/Admin only, so every top-up is
// inherently manager-authorized); "out" is the same Expense ledger as above.
financeRouter.get('/petty-cash', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });

  const [allTopUps, allExpenses, cashPayments] = await Promise.all([
    prisma.pettyCashTopUp.findMany(),
    prisma.expense.findMany(),
    prisma.payment.findMany({ where: { method: 'Cash', date: { gte: range.from, lte: range.to } } }),
  ]);

  const balance =
    allTopUps.filter((t) => t.date <= range.to).reduce((a, t) => a + t.amount, 0) -
    allExpenses.filter((e) => e.date <= range.to).reduce((a, e) => a + e.amount, 0);

  const periodTopUps = allTopUps.filter((t) => inRange(t.date, range.from, range.to));
  const periodExpenses = allExpenses.filter((e) => inRange(e.date, range.from, range.to));
  const periodTopUpsTotal = periodTopUps.reduce((a, t) => a + t.amount, 0);
  const periodExpensesTotal = periodExpenses.reduce((a, e) => a + e.amount, 0);
  const cashSalesInPeriod = cashPayments.reduce((a, p) => a + p.amount, 0);

  const ledger = [
    ...periodTopUps.map((t) => ({
      id: 't' + t.id,
      date: t.date,
      type: 'topup' as const,
      description: t.source + (t.note ? ': ' + t.note : '') + ` (by ${t.authorizedByName})`,
      amountIn: t.amount,
      amountOut: 0,
      topUpId: t.id,
    })),
    ...periodExpenses.map((e) => ({
      id: 'e' + e.id,
      date: e.date,
      type: 'expense' as const,
      description: e.category + (e.note ? ': ' + e.note : '') + (e.capturedByName ? ` (by ${e.capturedByName})` : ''),
      amountIn: 0,
      amountOut: e.amount,
      topUpId: null as number | null,
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));

  res.json({
    fromDate: range.from,
    toDate: range.to,
    balance,
    periodTopUpsTotal,
    periodExpensesTotal,
    cashSalesInPeriod,
    ledger,
    pettyCashSources: PETTY_CASH_SOURCES,
  });
});

const pettyCashSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.enum(PETTY_CASH_SOURCES),
  amount: z.number().positive(),
  note: z.string().max(200).optional(),
});

financeRouter.post('/petty-cash/topups', async (req, res) => {
  const parsed = pettyCashSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const topUp = await prisma.pettyCashTopUp.create({
    data: { ...parsed.data, note: parsed.data.note ?? '', authorizedByName: req.user!.name },
  });
  res.status(201).json(topUp);
});

financeRouter.delete('/petty-cash/topups/:id', async (req, res) => {
  await prisma.pettyCashTopUp.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});
