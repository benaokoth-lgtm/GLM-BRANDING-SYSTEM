import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { buildLineTotal, EMBROIDERY_CONSUMABLE_MATERIAL_NAMES } from '@glm/shared';
import type { LineItemInput } from '@glm/shared';

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
// Matches the FilmRoll margin-analysis pattern (avgRatePerMeter/
// marginPerMeter/undercharged) translated to a per-piece view, since
// Embroidery has no roll/usage model of its own to derive it from directly.
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
  const purchases = materialIds.length
    ? await prisma.purchase.findMany({ where: { materialId: { in: materialIds }, status: 'Accepted' }, include: { material: true } })
    : [];

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
