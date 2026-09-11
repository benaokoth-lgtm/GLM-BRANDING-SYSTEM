import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import {
  computeOrderTotals,
  computePay,
  EMPLOYEE_TYPES,
  EXPENSE_CATEGORIES,
  PAYROLL_PAYMENT_SOURCES,
  PETTY_CASH_SOURCES,
  splitVatInclusive,
} from '@glm/shared';
import type { LineItemInput } from '@glm/shared';

export const financeRouter = Router();
financeRouter.use(requireAuth, requirePermission('canAccessFinance'));

function inRange(d: string, from: string, to: string): boolean {
  return d >= from && d <= to;
}

function parseRange(req: { query: Record<string, unknown> }): { from: string; to: string } | null {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  return { from, to };
}

// Current Petty Cash float: all-time top-ups minus all-time Expense rows
// minus all-time PayrollEntry rows paid from 'Petty Cash' (netPay only — the
// statutory deductions on a petty-cash-paid salary are a separate downstream
// remittance, not cash that left the tin). Shared by the /petty-cash read
// endpoint and the insufficient-funds guards on new Expense/Payroll entries
// below, so both always agree on the same number.
export async function computePettyCashBalance(asOfDate?: string): Promise<number> {
  const [topUps, expenses, pettyPayroll] = await Promise.all([
    prisma.pettyCashTopUp.findMany(),
    prisma.expense.findMany(),
    prisma.payrollEntry.findMany({ where: { paymentSource: 'Petty Cash' } }),
  ]);
  const cutoff = asOfDate ?? '9999-12-31';
  const topUpsTotal = topUps.filter((t) => t.date <= cutoff).reduce((a, t) => a + t.amount, 0);
  const expensesTotal = expenses.filter((e) => e.date <= cutoff).reduce((a, e) => a + e.amount, 0);
  const payrollTotal = pettyPayroll
    .filter((p) => p.date <= cutoff)
    .reduce((a, p) => a + computePay(p.grossPay, p.employeeType as 'Employee' | 'Casual').netPay, 0);
  return topUpsTotal - expensesTotal - payrollTotal;
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
      paymentSource: e.paymentSource,
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

// Employees are paid a fixed monthly salary (grossPay entered directly) —
// no daysWorked/rate. Casuals stay day-rate (grossPay = daysWorked * rate).
const payrollSchema = z.discriminatedUnion('employeeType', [
  z.object({
    employeeType: z.literal('Employee'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    staffId: z.number().int(),
    department: z.string().max(100).optional(),
    grossPay: z.number().positive(),
    paymentSource: z.enum(PAYROLL_PAYMENT_SOURCES),
  }),
  z.object({
    employeeType: z.literal('Casual'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    staffId: z.number().int(),
    department: z.string().max(100).optional(),
    daysWorked: z.number().positive(),
    rate: z.number().positive(),
    paymentSource: z.enum(PAYROLL_PAYMENT_SOURCES),
  }),
]);

financeRouter.post('/payroll', async (req, res) => {
  const parsed = payrollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const data = parsed.data;

  const staff = await prisma.user.findUnique({ where: { id: data.staffId } });
  if (!staff) return res.status(400).json({ error: 'Selected staff member not found' });

  const grossPay = data.employeeType === 'Employee' ? data.grossPay : data.daysWorked * data.rate;

  if (data.paymentSource === 'Petty Cash') {
    const netPay = computePay(grossPay, data.employeeType).netPay;
    const balance = await computePettyCashBalance();
    if (netPay > balance) {
      return res.status(400).json({ error: `Insufficient petty cash balance (Ksh ${Math.round(balance).toLocaleString('en-KE')} available, Ksh ${Math.round(netPay).toLocaleString('en-KE')} needed)` });
    }
  }

  const entry = await prisma.payrollEntry.create({
    data: {
      date: data.date,
      staffId: data.staffId,
      employeeType: data.employeeType,
      department: data.department ?? '',
      daysWorked: data.employeeType === 'Casual' ? data.daysWorked : null,
      rate: data.employeeType === 'Casual' ? data.rate : null,
      grossPay,
      paymentSource: data.paymentSource,
      capturedByName: req.user!.name,
    },
  });
  res.status(201).json({ ...entry, name: staff.name });
});

// No direct DELETE for payroll — see the generic DeletionRequest flow below.

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
      heatPressFee: li.heatPressFee,
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
  // Optional generally, but a "DTF Film Rolls" expense needs one on file to
  // later be picked when installing a roll (see routes/film.ts).
  invoiceNumber: z.string().max(100).optional(),
});

// Every Expense row is implicitly petty-cash-funded (see the Petty Cash
// ledger's balance calc) — so no expense can be captured for more than the
// float currently holds, full stop. This is the same rule payroll's
// 'Petty Cash' payment source enforces, just applied unconditionally here
// since there's no separate funding-source field on Expense.
financeRouter.post('/expenses', async (req, res) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const balance = await computePettyCashBalance();
  if (parsed.data.amount > balance) {
    return res.status(400).json({ error: `Insufficient petty cash balance (Ksh ${Math.round(balance).toLocaleString('en-KE')} available, Ksh ${Math.round(parsed.data.amount).toLocaleString('en-KE')} needed)` });
  }

  const expense = await prisma.expense.create({
    data: { ...parsed.data, note: parsed.data.note ?? '', capturedByName: req.user!.name },
  });
  res.status(201).json(expense);
});

// No direct DELETE for expenses — see the generic DeletionRequest flow below.

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

  const [allTopUps, allExpenses, allPettyPayroll, cashPayments] = await Promise.all([
    prisma.pettyCashTopUp.findMany(),
    prisma.expense.findMany(),
    prisma.payrollEntry.findMany({ where: { paymentSource: 'Petty Cash' }, include: { staff: true } }),
    prisma.payment.findMany({ where: { method: 'Cash', date: { gte: range.from, lte: range.to } } }),
  ]);
  const pettyPayrollNet = allPettyPayroll.map((p) => ({ ...p, netPay: computePay(p.grossPay, p.employeeType as 'Employee' | 'Casual').netPay }));

  const balance = await computePettyCashBalance(range.to);

  const periodTopUps = allTopUps.filter((t) => inRange(t.date, range.from, range.to));
  const periodExpenses = allExpenses.filter((e) => inRange(e.date, range.from, range.to));
  const periodPayroll = pettyPayrollNet.filter((p) => inRange(p.date, range.from, range.to));
  const periodTopUpsTotal = periodTopUps.reduce((a, t) => a + t.amount, 0);
  const periodExpensesTotal = periodExpenses.reduce((a, e) => a + e.amount, 0) + periodPayroll.reduce((a, p) => a + p.netPay, 0);
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
    ...periodPayroll.map((p) => ({
      id: 'p' + p.id,
      date: p.date,
      type: 'expense' as const,
      description: `Payroll: ${p.staff.name} (net pay)`,
      amountIn: 0,
      amountOut: p.netPay,
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

// No direct DELETE for petty cash top-ups — see the generic DeletionRequest flow below.

// ── Deletion requests — the only way to remove an Expense, PayrollEntry, or ──
// PettyCashTopUp. Requires a reason and approval from a *different* finance
// manager/general manager/admin before the row is actually deleted, same
// segregation-of-duties rule as expense amendments above.
const DELETABLE_TYPES = ['Expense', 'PayrollEntry', 'PettyCashTopUp'] as const;
type DeletableType = (typeof DELETABLE_TYPES)[number];

async function buildDeletionSummary(recordType: DeletableType, recordId: number): Promise<string | null> {
  if (recordType === 'Expense') {
    const e = await prisma.expense.findUnique({ where: { id: recordId } });
    if (!e) return null;
    return `Expense: ${e.category} — Ksh ${Math.round(e.amount).toLocaleString('en-KE')} (${e.date})`;
  }
  if (recordType === 'PayrollEntry') {
    const p = await prisma.payrollEntry.findUnique({ where: { id: recordId }, include: { staff: true } });
    if (!p) return null;
    return `Payroll: ${p.staff.name} — Ksh ${Math.round(p.grossPay).toLocaleString('en-KE')} (${p.date})`;
  }
  const t = await prisma.pettyCashTopUp.findUnique({ where: { id: recordId } });
  if (!t) return null;
  return `Petty cash top-up: ${t.source} — Ksh ${Math.round(t.amount).toLocaleString('en-KE')} (${t.date})`;
}

financeRouter.get('/deletion-requests', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const requests = await prisma.deletionRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: { requestedAt: 'desc' },
  });
  res.json(requests);
});

const deletionRequestSchema = z.object({
  recordType: z.enum(DELETABLE_TYPES),
  recordId: z.number().int(),
  reason: z.string().min(1, 'A reason for the deletion is required'),
});

financeRouter.post('/deletion-requests', async (req, res) => {
  const parsed = deletionRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const summary = await buildDeletionSummary(parsed.data.recordType, parsed.data.recordId);
  if (!summary) return res.status(404).json({ error: 'Record not found' });

  const request = await prisma.deletionRequest.create({
    data: { ...parsed.data, summary, requestedByName: req.user!.name },
  });
  res.status(201).json(request);
});

async function decideDeletionRequest(req: Request, res: Response, approve: boolean) {
  const request = await prisma.deletionRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!request) return res.status(404).json({ error: 'Deletion request not found' });
  if (request.status !== 'Pending') return res.status(400).json({ error: 'Deletion request has already been decided' });
  if (request.requestedByName === req.user!.name) {
    return res.status(400).json({ error: 'You cannot approve or reject your own deletion request' });
  }

  if (approve) {
    const recordType = request.recordType as DeletableType;
    if (recordType === 'Expense') await prisma.expense.delete({ where: { id: request.recordId } }).catch(() => null);
    else if (recordType === 'PayrollEntry') await prisma.payrollEntry.delete({ where: { id: request.recordId } }).catch(() => null);
    else await prisma.pettyCashTopUp.delete({ where: { id: request.recordId } }).catch(() => null);
  }

  const updated = await prisma.deletionRequest.update({
    where: { id: request.id },
    data: { status: approve ? 'Approved' : 'Rejected', decidedByName: req.user!.name, decidedAt: new Date() },
  });
  res.json(updated);
}

financeRouter.post('/deletion-requests/:id/approve', (req, res) => decideDeletionRequest(req, res, true));
financeRouter.post('/deletion-requests/:id/reject', (req, res) => decideDeletionRequest(req, res, false));
