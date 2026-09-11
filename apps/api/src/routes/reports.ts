import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { buildLineTotal } from '@glm/shared';
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
