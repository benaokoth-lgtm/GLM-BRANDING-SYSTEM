import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { buildLineTotal, computeOrderTotals, defaultBusinessHeadName, EMBROIDERY_CONSUMABLE_MATERIAL_NAMES, GENERAL_ORDER_HEAD, todayStr, VAT_RATE } from '@glm/shared';
import { ensureBusinessHeadsOnce, ensurePurchasesOnce } from '../purchases';
import type { LineItemInput, PaymentRecord } from '@glm/shared';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requirePermission('canAccessReports'));

function inRange(d: string, from: string, to: string): boolean {
  return d >= from && d <= to;
}

function parseRange(req: { query: Record<string, unknown> }): { from: string; to: string } | null {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  return { from, to };
}

// Revenue by service ("which machines/services perform best") over a date
// range — every walk-in order and invoiced corporate order in range, line
// items grouped by service name (material-only lines roll up into a single
// "Materials" bucket instead, since they're products sold, not a
// production service/machine).
reportsRouter.get('/sales-by-category', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });

  const orders = await prisma.order.findMany({
    where: { OR: [{ kind: 'walkin' }, { status: 'Invoice' }] },
    include: { lineItems: { include: { service: true } } },
  });

  const byService = new Map<string, { qty: number; revenue: number }>();
  let materialsQty = 0;
  let materialsRevenue = 0;

  for (const o of orders) {
    if (!inRange(o.createdDate, range.from, range.to)) continue;
    for (const li of o.lineItems) {
      const input: LineItemInput = {
        itemType: li.itemType as LineItemInput['itemType'],
        serviceId: li.serviceId,
        materialId: li.materialId,
        qty: li.qty,
        unitPrice: li.unitPrice,
        discountPct: li.discountPct,
        discountAmt: li.discountAmt,
        heatPressFee: li.heatPressFee,
      };
      const lineTotal = buildLineTotal(input);
      if (li.itemType === 'material' || !li.service) {
        materialsQty += li.qty;
        materialsRevenue += lineTotal;
      } else {
        const name = li.service.name;
        const bucket = byService.get(name) ?? { qty: 0, revenue: 0 };
        bucket.qty += li.qty;
        bucket.revenue += lineTotal;
        byService.set(name, bucket);
      }
    }
  }

  const categories = Array.from(byService.entries())
    .map(([name, v]) => ({ name, qty: v.qty, revenue: v.revenue }))
    .sort((a, b) => b.revenue - a.revenue);

  res.json({
    fromDate: range.from,
    toDate: range.to,
    categories,
    materials: { qty: materialsQty, revenue: materialsRevenue },
  });
});

// Gross profitability for the Embroidery service: revenue from Embroidery
// line items (same accrual basis as sales-by-category) against the cost of
// its own consumables — thread and needles — bought through the Stock
// Purchases pipeline (only 'Accepted' purchases count as real, reconciled
// cost; 'Held'/'Rejected' purchases haven't actually entered the store).
// Reports revenue-per-piece against cost-per-piece (avgRevenuePerPiece/
// avgCostPerPiece/marginPerPiece/underpriced), since Embroidery has no
// roll/usage model of its own to derive it from directly.
reportsRouter.get('/embroidery-profitability', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });

  const embroideryService = await prisma.service.findFirst({ where: { name: 'Embroidery' } });

  let revenue = 0;
  let qtyPieces = 0;
  if (embroideryService) {
    const orders = await prisma.order.findMany({
      where: { OR: [{ kind: 'walkin' }, { status: 'Invoice' }] },
      include: { lineItems: { where: { serviceId: embroideryService.id } } },
    });
    for (const o of orders) {
      if (!inRange(o.createdDate, range.from, range.to)) continue;
      for (const li of o.lineItems) {
        const lineTotal = buildLineTotal({
          itemType: li.itemType as LineItemInput['itemType'],
          serviceId: li.serviceId,
          materialId: li.materialId,
          qty: li.qty,
          unitPrice: li.unitPrice,
          discountPct: li.discountPct,
          discountAmt: li.discountAmt,
          heatPressFee: li.heatPressFee,
        });
        revenue += lineTotal;
        qtyPieces += li.qty;
      }
    }
  }

  const consumableMaterials = await prisma.material.findMany({
    where: { name: { in: [...EMBROIDERY_CONSUMABLE_MATERIAL_NAMES] } },
  });
  const materialIds = consumableMaterials.map((m) => m.id);
  await ensurePurchasesOnce();
  const purchaseLines = materialIds.length
    ? await prisma.purchaseLine.findMany({ where: { materialId: { in: materialIds }, purchase: { status: 'Accepted' } }, include: { material: true, purchase: true } })
    : [];
  const purchases = purchaseLines.map((l) => ({ date: l.purchase.date, material: l.material, qty: l.receivedQty ?? l.qty, totalCost: l.totalCost }));

  const breakdownMap = new Map<string, { qty: number; totalCost: number }>();
  let consumablesCost = 0;
  for (const p of purchases) {
    if (!inRange(p.date, range.from, range.to)) continue;
    consumablesCost += p.totalCost;
    const b = breakdownMap.get(p.material.name) ?? { qty: 0, totalCost: 0 };
    b.qty += p.qty;
    b.totalCost += p.totalCost;
    breakdownMap.set(p.material.name, b);
  }
  const consumableBreakdown = Array.from(breakdownMap.entries())
    .map(([materialName, v]) => ({ materialName, qty: v.qty, totalCost: v.totalCost }))
    .sort((a, b) => b.totalCost - a.totalCost);

  const grossProfit = revenue - consumablesCost;
  const marginPct = revenue > 0 ? (grossProfit / revenue) * 100 : null;
  const avgRevenuePerPiece = qtyPieces > 0 ? revenue / qtyPieces : null;
  const avgCostPerPiece = qtyPieces > 0 ? consumablesCost / qtyPieces : null;
  const marginPerPiece = avgRevenuePerPiece != null && avgCostPerPiece != null ? avgRevenuePerPiece - avgCostPerPiece : null;

  res.json({
    fromDate: range.from,
    toDate: range.to,
    serviceFound: !!embroideryService,
    revenue,
    qtyPieces,
    consumablesCost,
    grossProfit,
    marginPct,
    avgRevenuePerPiece,
    avgCostPerPiece,
    marginPerPiece,
    underpriced: marginPerPiece != null && marginPerPiece < 0,
    consumableBreakdown,
  });
});

// Accounts Receivable — every order (corporate or walk-in/DTF) currently
// sitting at status 'Invoice' with money still owed, aged off its due date.
// A live snapshot ("as of today"), not a date-range report like the others
// above: an invoice doesn't stop being owed just because it falls outside a
// chosen range, so there's no from/to filter here.
reportsRouter.get('/accounts-receivable', async (req, res) => {
  const today = todayStr();
  const orders = await prisma.order.findMany({
    where: { status: 'Invoice' },
    include: { corporateClient: true, lineItems: true, payments: true, staff: true },
    orderBy: { dueDate: 'asc' },
  });

  const rows = orders
    .map((o) => {
      const lineItems: LineItemInput[] = o.lineItems.map((li) => ({
        itemType: li.itemType as LineItemInput['itemType'],
        serviceId: li.serviceId,
        materialId: li.materialId,
        qty: li.qty,
        unitPrice: li.unitPrice,
        discountPct: li.discountPct,
        discountAmt: li.discountAmt,
        heatPressFee: li.heatPressFee,
      }));
      const payments: PaymentRecord[] = o.payments.map((p) => ({ date: p.date, amount: p.amount, method: p.method as PaymentRecord['method'] }));
      const totals = computeOrderTotals({ lineItems, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt }, payments);
      const daysOverdue = o.dueDate && o.dueDate < today ? Math.round((Date.parse(today) - Date.parse(o.dueDate)) / 86400000) : 0;
      return {
        id: o.id,
        orderNo: o.orderNo,
        kind: o.kind,
        channel: o.channel,
        client: o.kind === 'corporate' ? o.corporateClient?.name ?? '—' : o.customerName ?? '—',
        staffName: o.staff.name,
        createdDate: o.createdDate,
        dueDate: o.dueDate,
        grandTotal: totals.grandTotal,
        paidTotal: totals.paidTotal,
        balanceDue: totals.balanceDue,
        daysOverdue,
      };
    })
    .filter((r) => r.balanceDue > 0)
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  const bucket = (r: (typeof rows)[number]) =>
    r.daysOverdue <= 0 ? 'current' : r.daysOverdue <= 30 ? 'days1to30' : r.daysOverdue <= 60 ? 'days31to60' : r.daysOverdue <= 90 ? 'days61to90' : 'days90plus';
  const buckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, days90plus: 0 };
  for (const r of rows) buckets[bucket(r)] += r.balanceDue;

  res.json({
    asOf: today,
    totalOutstanding: rows.reduce((a, r) => a + r.balanceDue, 0),
    buckets,
    rows,
  });
});

// Sales by business head: DTF Printing, UV Printing, Laser Engraving, Large Format Printing, Embroidery and General Order. Every
// service belongs to one head; a material sold over the counter is General Order. Figures are sales raised in the period (orders and
// invoices, not quotations), after discounts, with the 16% VAT taken out — before any credit notes.
reportsRouter.get('/sales-by-business-head', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });
  await ensureBusinessHeadsOnce();

  const heads = await prisma.businessHead.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  const orders = await prisma.order.findMany({
    where: { status: { not: 'Quote' }, createdDate: { gte: range.from, lte: range.to } },
    include: { lineItems: { include: { service: { include: { businessHead: true } } } } },
  });

  type Bucket = { sales: number; orders: Set<number>; services: Map<string, { qty: number; sales: number }> };
  const buckets = new Map<string, Bucket>();
  const bucket = (name: string): Bucket => {
    let b = buckets.get(name);
    if (!b) buckets.set(name, (b = { sales: 0, orders: new Set(), services: new Map() }));
    return b;
  };

  for (const o of orders) {
    const inputs: LineItemInput[] = o.lineItems.map((li) => ({ itemType: li.itemType as LineItemInput['itemType'], serviceId: li.serviceId, materialId: li.materialId, qty: li.qty, unitPrice: li.unitPrice, discountPct: li.discountPct, discountAmt: li.discountAmt, heatPressFee: li.heatPressFee }));
    const subtotal = inputs.reduce((a, li) => a + buildLineTotal(li), 0);
    const { grandTotal } = computeOrderTotals({ lineItems: inputs, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt });
    const scale = subtotal > 0 ? grandTotal / subtotal : 0; // what the order-level discount leaves of each line
    o.lineItems.forEach((li, i) => {
      const gross = buildLineTotal(inputs[i]!) * scale;
      const name = li.service ? li.service.businessHead?.name ?? defaultBusinessHeadName(li.service.name) : GENERAL_ORDER_HEAD;
      const b = bucket(name);
      b.sales += gross / (1 + VAT_RATE);
      b.orders.add(o.id);
      const label = li.service ? li.service.name : 'Materials sold';
      const s = b.services.get(label) ?? { qty: 0, sales: 0 };
      s.qty += li.qty;
      s.sales += gross / (1 + VAT_RATE);
      b.services.set(label, s);
    });
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  const names = [...heads.map((h) => h.name), ...[...buckets.keys()].filter((n) => !heads.some((h) => h.name === n))];
  const total = [...buckets.values()].reduce((a, b) => a + b.sales, 0);
  res.json({
    fromDate: range.from,
    toDate: range.to,
    heads: names.map((name) => {
      const b = buckets.get(name);
      const head = heads.find((h) => h.name === name);
      return {
        name,
        active: head?.active ?? true,
        sales: round(b?.sales ?? 0),
        orders: b?.orders.size ?? 0,
        sharePct: total > 0 ? round(((b?.sales ?? 0) / total) * 100) : 0,
        services: [...(b?.services.entries() ?? [])].map(([n, v]) => ({ name: n, qty: round(v.qty), sales: round(v.sales) })).sort((a, c) => c.sales - a.sales),
      };
    }),
    totalSales: round(total),
  });
});
