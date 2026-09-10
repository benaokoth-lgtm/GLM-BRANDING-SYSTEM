import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { computeOrderTotals, computePay, EMPLOYEE_TYPES, PAYMENT_METHODS, splitVatInclusive } from '@glm/shared';
import type { LineItemInput } from '@glm/shared';

export const financeRouter = Router();
financeRouter.use(requireAuth, requireRole('Supervisor', 'Admin'));

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
    orderBy: { date: 'desc' },
  });

  const rows = entries.map((e) => {
    const pay = computePay(e.grossPay, e.employeeType as 'Employee' | 'Casual');
    return {
      id: e.id,
      date: e.date,
      name: e.name,
      employeeType: e.employeeType,
      department: e.department,
      daysWorked: e.daysWorked,
      rate: e.rate,
      paymentMethod: e.paymentMethod,
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
  name: z.string().min(1),
  employeeType: z.enum(EMPLOYEE_TYPES),
  department: z.string().max(100).optional(),
  daysWorked: z.number().positive(),
  rate: z.number().positive(),
  paymentMethod: z.enum(PAYMENT_METHODS),
});

financeRouter.post('/payroll', async (req, res) => {
  const parsed = payrollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const { daysWorked, rate } = parsed.data;
  const entry = await prisma.payrollEntry.create({
    data: { ...parsed.data, department: parsed.data.department ?? '', grossPay: daysWorked * rate },
  });
  res.status(201).json(entry);
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
