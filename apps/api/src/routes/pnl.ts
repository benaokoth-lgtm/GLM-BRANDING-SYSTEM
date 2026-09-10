import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { computeOrderTotals, EXPENSE_CATEGORIES, FINANCE_ROLES } from '@glm/shared';
import type { LineItemInput, PaymentRecord } from '@glm/shared';

export const pnlRouter = Router();
pnlRouter.use(requireAuth, requireRole(...FINANCE_ROLES));

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
    })),
    payments: o.payments.map((p) => ({ date: p.date, amount: p.amount, method: p.method as PaymentRecord['method'] })),
  }));
}

function inRange(d: string, from: string, to: string): boolean {
  return d >= from && d <= to;
}

function computeAgg(orders: OrderForPnl[], expenses: ExpenseRow[], cogsPct: number, from: string, to: string) {
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
  const cogs = revAccrual * (cogsPct / 100);
  const grossProfit = revAccrual - cogs;
  const expensesInRange = expenses.filter((e) => inRange(e.date, from, to));
  const totalExpenses = expensesInRange.reduce((a, e) => a + e.amount, 0);
  const netProfit = grossProfit - totalExpenses;
  const byCategory: Record<string, number> = {};
  for (const e of expensesInRange) byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
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

  const [orders, allExpenses, settings] = await Promise.all([
    loadOrdersForPnl(),
    prisma.expense.findMany({ orderBy: { date: 'desc' } }),
    prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} }),
  ]);
  const cogsPct = settings.cogsPct;

  const agg = computeAgg(orders, allExpenses, cogsPct, from, to);
  const prior = priorRange(from, to);
  const priorAgg = computeAgg(orders, allExpenses, cogsPct, prior.from, prior.to);

  const toDateObj = new Date(to + 'T00:00:00');
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(toDateObj.getFullYear(), toDateObj.getMonth() - i, 1);
    const mFrom = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const mTo = monthEnd.toISOString().slice(0, 10);
    const mAgg = computeAgg(orders, allExpenses, cogsPct, mFrom, mTo);
    trend.push({ label: `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`, revenue: mAgg.revAccrual, netProfit: mAgg.netProfit });
  }

  res.json({
    fromDate: from,
    toDate: to,
    cogsPct,
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
    expenseCategories: EXPENSE_CATEGORIES,
  });
});

// Expense capture (add/remove) lives under Finance > Expenses now
// (apps/api/src/routes/finance.ts) — this router only reads/aggregates.

const cogsSchema = z.object({ cogsPct: z.number().min(0).max(100) });

pnlRouter.put('/cogs-pct', async (req, res) => {
  const parsed = cogsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const settings = await prisma.setting.upsert({
    where: { id: 1 },
    create: { id: 1, cogsPct: parsed.data.cogsPct },
    update: { cogsPct: parsed.data.cogsPct },
  });
  res.json({ cogsPct: settings.cogsPct });
});
