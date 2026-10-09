import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { buildLineTotal, computeOrderTotals, defaultBusinessHeadName, EMBROIDERY_CONSUMABLE_MATERIAL_NAMES, EMBROIDERY_ORIGINATION_SERVICE, EMBROIDERY_PIECE_SERVICE, EMBROIDERY_SETUP_SERVICE, GENERAL_ORDER_HEAD, todayStr, VAT_RATE } from '@glm/shared';
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

// Embroidery profitability. Embroidery is priced by stitch count (routes/embroidery.ts), so this reports on the jobs themselves: what was sold (pieces, setup,
// design origination), the garments and stitches behind it, the setup fees charged and waived, the discounts given below the recommended price, and a gross
// profit against what was bought for Embroidery — purchases tagged to the Embroidery head or of the thread and needle consumables, and expenses tagged to it.
// Revenue is net of the 16% VAT (like Sales by business head) and counts approved jobs only; a job waiting in the price-approval queue is shown apart. Orders
// sold on the older per-sqm "Embroidery" service (now retired) are still counted, as their own line, so history is not lost.
reportsRouter.get('/embroidery-profitability', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });
  await ensureBusinessHeadsOnce();
  await ensurePurchasesOnce();
  const round = (n: number) => Math.round(n * 100) / 100;

  const orders = await prisma.order.findMany({
    where: { status: { not: 'Quote' }, createdDate: { gte: range.from, lte: range.to } },
    include: { lineItems: { include: { service: { include: { businessHead: true } } } }, embroideryJob: true },
  });

  const parts = { pieces: 0, setup: 0, origination: 0, legacy: 0 };
  const orderIds = new Set<number>();
  let garments = 0;
  let placements = 0;
  let stitches = 0;
  let legacyPieces = 0;
  let setupCharged = 0;
  let setupWaived = 0;
  let originationJobs = 0;
  let belowJobs = 0;
  let given = 0;
  let quantityDiscounts = 0;
  let pendingJobs = 0;
  let pendingValue = 0;
  const bands = new Map<number, { jobs: number; garments: number; revenue: number }>();

  for (const o of orders) {
    const inputs: LineItemInput[] = o.lineItems.map((li) => ({ itemType: li.itemType as LineItemInput['itemType'], serviceId: li.serviceId, materialId: li.materialId, qty: li.qty, unitPrice: li.unitPrice, discountPct: li.discountPct, discountAmt: li.discountAmt, heatPressFee: li.heatPressFee }));
    const subtotal = inputs.reduce((a, li) => a + buildLineTotal(li), 0);
    const { grandTotal } = computeOrderTotals({ lineItems: inputs, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt });
    const scale = subtotal > 0 ? grandTotal / subtotal : 0; // what the order-level discount leaves of each line
    const isEmb = (li: (typeof o.lineItems)[number]) => !!li.service && (li.service.businessHead?.name ?? defaultBusinessHeadName(li.service.name)) === 'Embroidery';
    const net = (i: number) => (buildLineTotal(inputs[i]!) * scale) / (1 + VAT_RATE);
    const mine = o.lineItems.map((li, i) => ({ li, i })).filter(({ li }) => isEmb(li));
    if (mine.length === 0) continue;

    const job = o.embroideryJob;
    if (job?.approvalStatus === 'Pending') {
      pendingJobs++;
      pendingValue += mine.reduce((a, { i }) => a + net(i), 0);
      continue; // counted once approved
    }
    orderIds.add(o.id);
    let revenue = 0;
    for (const { li, i } of mine) {
      const v = net(i);
      revenue += v;
      const name = li.service!.name;
      if (name === EMBROIDERY_PIECE_SERVICE) parts.pieces += v;
      else if (name === EMBROIDERY_SETUP_SERVICE) parts.setup += v;
      else if (name === EMBROIDERY_ORIGINATION_SERVICE) parts.origination += v;
      else {
        parts.legacy += v;
        legacyPieces += li.qty;
      }
    }
    if (job) {
      const designs = JSON.parse(job.designsJson || '[]') as { stitches: number; setupWaived?: boolean; setup?: number; recommended?: number; lowest?: number; stitchPrice?: number; basis?: string; piece?: number }[];
      garments += job.qty;
      placements += job.qty * designs.length;
      stitches += job.qty * designs.reduce((a, d) => a + (Number(d.stitches) || 0), 0);
      for (const d of designs) {
        if (d.setupWaived) setupWaived++;
        else if ((d.setup ?? 0) > 0) setupCharged++;
        // given away = below the lowest standard price (the price by quantity; the recommended price for jobs made before the two prices existed)
        const floor = d.lowest ?? d.recommended;
        if (floor != null && d.piece != null && d.piece < floor) given += (floor - d.piece) * job.qty;
        // a quantity discount is a standard price, not a giveaway: shown apart
        if (d.basis === 'quantity' && d.stitchPrice != null && d.piece != null && d.piece < d.stitchPrice) quantityDiscounts += (d.stitchPrice - d.piece) * job.qty;
      }
      if (!job.clientSupplied) originationJobs++;
      if (job.belowRecommended) belowJobs++;
      // the quantity band, from the tiers the job was priced with
      let starts: number[] = [];
      try {
        const snap = JSON.parse(job.settingsJson || '{}') as { qtyTiers?: { min: number }[]; tiers?: { min: number }[] };
        starts = (snap.qtyTiers ?? snap.tiers ?? []).map((t) => Number(t.min)).filter((m) => Number.isFinite(m));
      } catch {
        /* an unreadable snapshot leaves the job out of the bands */
      }
      if (starts.length) {
        const from = Math.max(...starts.filter((m) => m <= job.qty), Math.min(...starts));
        const band = bands.get(from) ?? { jobs: 0, garments: 0, revenue: 0 };
        band.jobs++;
        band.garments += job.qty;
        band.revenue += revenue;
        bands.set(from, band);
      }
    }
  }

  // What was bought for Embroidery: purchases tagged to its head or of its consumables (thread, needles), and the expenses tagged to it.
  const head = await prisma.businessHead.findUnique({ where: { name: 'Embroidery' } });
  const consumables = await prisma.material.findMany({ where: { name: { in: [...EMBROIDERY_CONSUMABLE_MATERIAL_NAMES] } }, select: { id: true } });
  const purchaseLines = await prisma.purchaseLine.findMany({
    where: {
      purchase: { status: 'Accepted', date: { gte: range.from, lte: range.to } },
      OR: [...(head ? [{ businessHeadId: head.id }] : []), ...(consumables.length ? [{ materialId: { in: consumables.map((m) => m.id) } }] : [])],
    },
    include: { material: true },
  });
  const expenses = head ? await prisma.expense.findMany({ where: { businessHeadId: head.id, date: { gte: range.from, lte: range.to }, purchase: { is: null } } }) : [];
  const byMaterial = new Map<string, { qty: number; totalCost: number }>();
  let purchases = 0;
  for (const l of purchaseLines) {
    purchases += l.totalCost;
    const m = byMaterial.get(l.material.name) ?? { qty: 0, totalCost: 0 };
    m.qty += l.receivedQty ?? l.qty;
    m.totalCost += l.totalCost;
    byMaterial.set(l.material.name, m);
  }
  const byCategory = new Map<string, number>();
  let expenseTotal = 0;
  for (const e of expenses) {
    expenseTotal += e.amount;
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount);
  }

  const revenue = parts.pieces + parts.setup + parts.origination + parts.legacy;
  const cost = purchases + expenseTotal;
  const grossProfit = revenue - cost;
  const perGarment = (v: number) => (garments > 0 ? round(v / garments) : null);
  const marginPerGarment = garments > 0 ? round((revenue - parts.legacy - cost) / garments) : null;
  res.json({
    fromDate: range.from,
    toDate: range.to,
    revenue: round(revenue),
    revenueByPart: { pieces: round(parts.pieces), setup: round(parts.setup), origination: round(parts.origination), legacy: round(parts.legacy) },
    orders: orderIds.size,
    garments,
    placements,
    stitches,
    legacyPieces,
    avgRevenuePerGarment: perGarment(parts.pieces + parts.setup + parts.origination),
    revenuePer1000Stitches: stitches > 0 ? round((parts.pieces / stitches) * 1000) : null,
    avgStitchesPerPlacement: placements > 0 ? Math.round(stitches / placements) : null,
    setup: { charged: setupCharged, waived: setupWaived },
    originationJobs,
    belowRecommended: { jobs: belowJobs, given: round(given) },
    quantityDiscounts: round(quantityDiscounts),
    pendingApproval: { jobs: pendingJobs, value: round(pendingValue) },
    cost: { purchases: round(purchases), expenses: round(expenseTotal), total: round(cost) },
    consumableBreakdown: [...byMaterial.entries()].map(([materialName, v]) => ({ materialName, qty: v.qty, totalCost: round(v.totalCost) })).sort((x, y) => y.totalCost - x.totalCost),
    expenseBreakdown: [...byCategory.entries()].map(([category, amount]) => ({ category, amount: round(amount) })).sort((x, y) => y.amount - x.amount),
    grossProfit: round(grossProfit),
    marginPct: revenue > 0 ? round((grossProfit / revenue) * 100) : null,
    costPerGarment: perGarment(cost),
    costPer1000Stitches: stitches > 0 ? round((cost / stitches) * 1000) : null,
    marginPerGarment,
    underpriced: marginPerGarment != null && marginPerGarment < 0,
    byBand: [...bands.entries()].sort((x, y) => x[0] - y[0]).map(([from, v]) => ({ from, jobs: v.jobs, garments: v.garments, revenue: round(v.revenue), avgPerGarment: v.garments > 0 ? round(v.revenue / v.garments) : null })),
  });
});

// Accounts Receivable — every order (corporate or walk-in/DTF) currently
// sitting at status 'Invoice' with money still owed, aged off its due date.
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

  // Costs: what was bought for each line of business (purchase lines, tagged), plus the expenses tagged to it. An expense that backs a
  // purchase is counted through the purchase's lines, never twice. Anything not tagged is shown apart as shared (unassigned) cost.
  const headName = new Map(heads.map((h) => [h.id, h.name]));
  const [purchaseLines, expenses] = await Promise.all([
    prisma.purchaseLine.findMany({ where: { purchase: { status: { not: 'Rejected' }, date: { gte: range.from, lte: range.to } } } }),
    prisma.expense.findMany({ where: { date: { gte: range.from, lte: range.to }, purchase: { is: null } } }),
  ]);
  type Cost = { purchases: number; expenses: number; categories: Map<string, number> };
  const costs = new Map<string, Cost>();
  const UNASSIGNED = '\u0000unassigned';
  const cost = (key: string): Cost => {
    let c = costs.get(key);
    if (!c) costs.set(key, (c = { purchases: 0, expenses: 0, categories: new Map() }));
    return c;
  };
  for (const l of purchaseLines) {
    // (A line is tagged when the purchase is captured — from its material's usual head, or as chosen — so an untagged one is shared cost.)
    cost(l.businessHeadId != null ? headName.get(l.businessHeadId) ?? UNASSIGNED : UNASSIGNED).purchases += l.totalCost;
  }
  for (const e of expenses) {
    const c = cost(e.businessHeadId != null ? headName.get(e.businessHeadId) ?? UNASSIGNED : UNASSIGNED);
    c.expenses += e.amount;
    c.categories.set(e.category, (c.categories.get(e.category) ?? 0) + e.amount);
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  const names = [...heads.map((h) => h.name), ...[...buckets.keys()].filter((n) => !heads.some((h) => h.name === n))];
  const total = [...buckets.values()].reduce((a, b) => a + b.sales, 0);
  const costOut = (c: Cost | undefined) => ({
    purchases: round(c?.purchases ?? 0),
    expenses: round(c?.expenses ?? 0),
    total: round((c?.purchases ?? 0) + (c?.expenses ?? 0)),
    expenseCategories: [...(c?.categories.entries() ?? [])].map(([category, amount]) => ({ category, amount: round(amount) })).sort((x, y) => y.amount - x.amount),
  });
  const headRows = names.map((name) => {
    const b = buckets.get(name);
    const head = heads.find((h) => h.name === name);
    const sales = round(b?.sales ?? 0);
    const c = costOut(costs.get(name));
    return {
      name,
      active: head?.active ?? true,
      sales,
      orders: b?.orders.size ?? 0,
      sharePct: total > 0 ? round(((b?.sales ?? 0) / total) * 100) : 0,
      costs: c,
      margin: round(sales - c.total),
      marginPct: sales > 0 ? round(((sales - c.total) / sales) * 100) : null,
      services: [...(b?.services.entries() ?? [])].map(([n, v]) => ({ name: n, qty: round(v.qty), sales: round(v.sales) })).sort((x, y) => y.sales - x.sales),
    };
  });
  const unassigned = costOut(costs.get(UNASSIGNED));
  const taggedCosts = round(headRows.reduce((a, h) => a + h.costs.total, 0));
  res.json({
    fromDate: range.from,
    toDate: range.to,
    heads: headRows,
    totalSales: round(total),
    unassignedCosts: unassigned,
    totalCosts: round(taggedCosts + unassigned.total),
    totalMargin: round(total - taggedCosts - unassigned.total),
  });
});

// What is behind one business head's figures for the period: the sales lines, the purchase lines tagged to it and the expenses tagged
// to it. head = the head's name, or "__shared__" for the costs nobody tagged to a head.
reportsRouter.get('/business-head-detail', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });
  await ensureBusinessHeadsOnce();
  const headName = String(req.query.head || '');
  const shared = headName === '__shared__';
  const heads = await prisma.businessHead.findMany();
  const head = shared ? null : heads.find((h) => h.name === headName);
  if (!shared && !head) return res.status(404).json({ error: 'Business head not found' });
  const round = (n: number) => Math.round(n * 100) / 100;

  const salesLines: { date: string; orderId: number; orderNo: string; customer: string; item: string; qty: number; sales: number }[] = [];
  if (!shared) {
    const orders = await prisma.order.findMany({
      where: { status: { not: 'Quote' }, createdDate: { gte: range.from, lte: range.to } },
      include: { corporateClient: true, lineItems: { include: { service: { include: { businessHead: true } }, material: true } } },
      orderBy: [{ createdDate: 'desc' }, { id: 'desc' }],
    });
    for (const o of orders) {
      const inputs: LineItemInput[] = o.lineItems.map((li) => ({ itemType: li.itemType as LineItemInput['itemType'], serviceId: li.serviceId, materialId: li.materialId, qty: li.qty, unitPrice: li.unitPrice, discountPct: li.discountPct, discountAmt: li.discountAmt, heatPressFee: li.heatPressFee }));
      const subtotal = inputs.reduce((a, li) => a + buildLineTotal(li), 0);
      const { grandTotal } = computeOrderTotals({ lineItems: inputs, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt });
      const scale = subtotal > 0 ? grandTotal / subtotal : 0;
      o.lineItems.forEach((li, i) => {
        const name = li.service ? li.service.businessHead?.name ?? defaultBusinessHeadName(li.service.name) : GENERAL_ORDER_HEAD;
        if (name !== headName) return;
        salesLines.push({
          date: o.createdDate,
          orderId: o.id,
          orderNo: o.orderNo,
          customer: o.customerName || o.corporateClient?.name || 'Walk-in',
          item: li.service?.name ?? li.material?.name ?? 'Item',
          qty: li.qty,
          sales: round((buildLineTotal(inputs[i]!) * scale) / (1 + VAT_RATE)),
        });
      });
    }
  }

  const headFilter = shared ? null : head!.id;
  const [purchaseLines, expenses] = await Promise.all([
    prisma.purchaseLine.findMany({
      where: { businessHeadId: headFilter, purchase: { status: { not: 'Rejected' }, date: { gte: range.from, lte: range.to } } },
      include: { material: true, purchase: true },
      orderBy: { id: 'desc' },
    }),
    prisma.expense.findMany({ where: { businessHeadId: headFilter, date: { gte: range.from, lte: range.to }, purchase: { is: null } }, orderBy: [{ date: 'desc' }, { id: 'desc' }] }),
  ]);
  const purchases = purchaseLines.map((l) => ({ date: l.purchase.date, poRef: l.purchase.poRef, supplier: l.purchase.supplier, item: l.material.name, qty: l.qty, unitCost: l.unitCost, amount: round(l.totalCost) }));
  const expenseRows = expenses.map((e) => ({ id: e.id, date: e.date, category: e.category, note: e.note, supplier: e.supplier, amount: round(e.amount) }));
  res.json({
    head: shared ? 'Shared (not tagged to a head)' : headName,
    from: range.from,
    to: range.to,
    sales: salesLines,
    purchases: purchases.sort((a, b) => (a.date < b.date ? 1 : -1)),
    expenses: expenseRows,
    totals: {
      sales: round(salesLines.reduce((a, l) => a + l.sales, 0)),
      purchases: round(purchases.reduce((a, p) => a + p.amount, 0)),
      expenses: round(expenseRows.reduce((a, e) => a + e.amount, 0)),
    },
  });
});
