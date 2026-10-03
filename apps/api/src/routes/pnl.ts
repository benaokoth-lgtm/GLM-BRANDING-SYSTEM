import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { computeOrderTotals, EXPENSE_CATEGORIES } from '@glm/shared';
import type { LineItemInput, PaymentRecord } from '@glm/shared';

export const pnlRouter = Router();
pnlRouter.use(requireAuth, requirePermission('canAccessPnl'));

interface OrderForPnl {
  kind: string;
  status: string;
  createdDate: string;
  orderDiscountPct: number;
  orderDiscountAmt: number;
  lineItems: LineItemInput[];
  payments: PaymentRecord[];
}

interface ExpenseRow {
  id: number;
  date: string;
  category: string;
  note: string;
  amount: number;
}

interface PayrollForPnl {
  date: string;
  grossPay: number;
}

async function loadOrdersForPnl(): Promise<OrderForPnl[]> {
  const orders = await prisma.order.findMany({ include: { lineItems: true, payments: true } });
  return orders.map((o) => ({
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
    payments: o.payments.map((p) => ({ date: p.date, amount: p.amount, method: p.method as PaymentRecord['method'] })),
  }));
}

function inRange(d: string, from: string, to: string): boolean {
  return d >= from && d <= to;
}

// "Salaries & wages" is deliberately not a pickable Expense category (see
// EXPENSE_CATEGORIES in packages/shared/src/constants.ts) — it's captured
// exactly once, via Finance > Compliance > Payroll, and folded into the P&L
// expense breakdown here from PayrollEntry.grossPay directly. This keeps a
// single source of truth: there's no Expense row to also delete/amend when a
// payroll entry changes, and no way to double-book the same salary cost.
const SALARIES_CATEGORY = 'Salaries & wages';
// Expenses filed under this head are material purchases, i.e. cost of sales.
const PURCHASE_CATEGORY = 'Printing Materials & Consumables';

// Cost of sales is what was actually bought to sell and produce with — the purchases — not a percentage of revenue:
//  • the expense behind a stock purchase (whatever head it was filed under) and the "Printing Materials & Consumables" head;
//  • stock purchases with no expense behind them (China import batches), unless rejected.
// Those are taken out of the operating expenses below so nothing is counted twice.
interface CostItem {
  date: string;
  amount: number;
}

function computeAgg(orders: OrderForPnl[], expenses: ExpenseRow[], payroll: PayrollForPnl[], cosItems: CostItem[], cosExpenseIds: Set<number>, from: string, to: string) {
  let revAccrualWalkin = 0;
  let revAccrualCorp = 0;
  let revCash = 0;
  for (const o of orders) {
    const isRevenueOrder = o.kind === 'walkin' || o.status === 'Invoice';
    if (isRevenueOrder && inRange(o.createdDate, from, to)) {
      const totals = computeOrderTotals({ lineItems: o.lineItems, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt });
      if (o.kind === 'walkin') revAccrualWalkin += totals.grandTotal;
      else revAccrualCorp += totals.grandTotal;
    }
    for (const p of o.payments) {
      if (inRange(p.date, from, to)) revCash += p.amount;
    }
  }
  const revAccrual = revAccrualWalkin + revAccrualCorp;
  const cogs = cosItems.filter((c) => inRange(c.date, from, to)).reduce((a, c) => a + c.amount, 0);
  const grossProfit = revAccrual - cogs;
  const expensesInRange = expenses.filter((e) => inRange(e.date, from, to) && !cosExpenseIds.has(e.id));
  const payrollInRange = payroll.filter((p) => inRange(p.date, from, to));
  const salariesTotal = payrollInRange.reduce((a, p) => a + p.grossPay, 0);
  const totalExpenses = expensesInRange.reduce((a, e) => a + e.amount, 0) + salariesTotal;
  const netProfit = grossProfit - totalExpenses;
  const byCategory: Record<string, number> = {};
  for (const e of expensesInRange) byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  if (salariesTotal > 0) byCategory[SALARIES_CATEGORY] = (byCategory[SALARIES_CATEGORY] || 0) + salariesTotal;
  return { revAccrualWalkin, revAccrualCorp, revAccrual, revCash, cogs, grossProfit, totalExpenses, netProfit, byCategory };
}

function priorRange(from: string, to: string) {
  const fromD = new Date(from + 'T00:00:00');
  const toD = new Date(to + 'T00:00:00');
  const lengthMs = toD.getTime() - fromD.getTime();
  const priorTo = new Date(fromD);
  priorTo.setDate(priorTo.getDate() - 1);
  const priorFrom = new Date(priorTo.getTime() - lengthMs);
  const fmtD = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmtD(priorFrom), to: fmtD(priorTo) };
}

function pctChange(cur: number, prev: number): number | null {
  return prev ? Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10 : null;
}

pnlRouter.get('/', async (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });
  }

  const [orders, allExpenses, allPayroll, purchases] = await Promise.all([
    loadOrdersForPnl(),
    prisma.expense.findMany({ orderBy: { date: 'desc' } }),
    prisma.payrollEntry.findMany({ select: { date: true, grossPay: true } }),
    prisma.purchase.findMany({ where: { status: { not: 'Rejected' } }, select: { date: true, totalCost: true, expenseId: true } }),
  ]);
  const purchaseExpenseIds = new Set(purchases.filter((p) => p.expenseId != null).map((p) => p.expenseId as number));
  const cosExpenseIds = new Set(allExpenses.filter((e) => purchaseExpenseIds.has(e.id) || e.category === PURCHASE_CATEGORY).map((e) => e.id));
  const cosItems: CostItem[] = [
    ...allExpenses.filter((e) => cosExpenseIds.has(e.id)).map((e) => ({ date: e.date, amount: e.amount })),
    ...purchases.filter((p) => p.expenseId == null).map((p) => ({ date: p.date, amount: p.totalCost })),
  ];

  const agg = computeAgg(orders, allExpenses, allPayroll, cosItems, cosExpenseIds, from, to);
  const prior = priorRange(from, to);
  const priorAgg = computeAgg(orders, allExpenses, allPayroll, cosItems, cosExpenseIds, prior.from, prior.to);

  const toDateObj = new Date(to + 'T00:00:00');
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(toDateObj.getFullYear(), toDateObj.getMonth() - i, 1);
    const mFrom = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const mTo = monthEnd.toISOString().slice(0, 10);
    const mAgg = computeAgg(orders, allExpenses, allPayroll, cosItems, cosExpenseIds, mFrom, mTo);
    trend.push({ label: `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`, revenue: mAgg.revAccrual, netProfit: mAgg.netProfit });
  }

  res.json({
    fromDate: from,
    toDate: to,
    revAccrualWalkin: agg.revAccrualWalkin,
    revAccrualCorp: agg.revAccrualCorp,
    revAccrual: agg.revAccrual,
    revCash: agg.revCash,
    cogs: agg.cogs,
    grossProfit: agg.grossProfit,
    byCategory: agg.byCategory,
    totalExpenses: agg.totalExpenses,
    netProfit: agg.netProfit,
    netMarginPct: agg.revAccrual > 0 ? Math.round((agg.netProfit / agg.revAccrual) * 1000) / 10 : 0,
    revChangePct: pctChange(agg.revAccrual, priorAgg.revAccrual),
    profitChangePct: pctChange(agg.netProfit, priorAgg.netProfit),
    priorFrom: prior.from,
    priorTo: prior.to,
    trend,
    expenseCategories: [SALARIES_CATEGORY, ...EXPENSE_CATEGORIES],
  });
});

// Expense capture (add/remove) lives under Finance > Expenses now
// (apps/api/src/routes/finance.ts) — this router only reads/aggregates.
