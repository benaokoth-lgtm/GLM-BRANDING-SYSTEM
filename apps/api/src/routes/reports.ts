import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { buildLineTotal, computeOrderTotals, defaultBusinessHeadName, UV_DTF_HEAD, EMBROIDERY_CONSUMABLE_MATERIAL_NAMES, EMBROIDERY_ORIGINATION_SERVICE, EMBROIDERY_PIECE_SERVICE, EMBROIDERY_SETUP_SERVICE, GENERAL_ORDER_HEAD, todayStr, VAT_RATE } from '@glm/shared';
import { ensureBusinessHeadsOnce, ensurePurchasesOnce } from '../purchases';
import type { LineItemInput, PaymentRecord } from '@glm/shared';
import type { Prisma } from '@prisma/client';
import { DTF_HEAD, primaryHead } from '../orderHeads';
import { isSalesPersonOrder, salesPersonIds } from '../orderSource';
import { clientKeyFor } from '@glm/shared';

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

// ── Sales performance: GLM's own sales against the sales persons' ──────────────────────────────────────────────
// Orders raised in the period (orders and invoices, not quotations), told apart by who they are credited to: GLM's own (the shop's) or a sales person's (the person it was allocated to, the one whose
// client it is, or an old freelance account). For each: how many orders, what was sold (net of the 16% VAT, after discounts), how much of it has been paid and what is still owed, the average order, and
// the clients; then each line of business and each month; then each sales person with what they were paid for the months in the period, as a share of what they sold.
reportsRouter.get('/sales-performance', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });
  await ensureBusinessHeadsOnce();
  const round = (n: number) => Math.round(n * 100) / 100;
  const people = await salesPersonIds();
  const orders = await prisma.order.findMany({
    where: { status: { not: 'Quote' }, createdDate: { gte: range.from, lte: range.to } },
    include: { ...headInclude, staff: { select: { id: true, name: true } } },
  });
  const paidBy = new Map<number, number>();
  if (orders.length) {
    for (const p of await prisma.payment.findMany({ where: { orderId: { in: orders.map((o) => o.id) } }, select: { orderId: true, amount: true } })) paidBy.set(p.orderId, (paidBy.get(p.orderId) ?? 0) + p.amount);
  }
  type Src = 'glm' | 'sales';
  const blank = () => ({ orders: 0, gross: 0, net: 0, paid: 0, balance: 0, clients: new Set<string>() });
  const totals: Record<Src, ReturnType<typeof blank>> = { glm: blank(), sales: blank() };
  const byHead = new Map<string, Record<Src, { orders: Set<number>; net: number }>>();
  const byMonth = new Map<string, Record<Src, { orders: number; net: number }>>();
  const per = new Map<number, { staffId: number; name: string; orders: number; net: number; paid: number; clients: Set<string> }>();
  let legacy = { orders: 0, net: 0, paid: 0 };
  const nameOf = new Map<number, string>();
  for (const o of orders) {
    const src: Src = isSalesPersonOrder(o, people) ? 'sales' : 'glm';
    const { grandTotal, lines } = headLines(o);
    const net = grandTotal / (1 + VAT_RATE);
    const paid = Math.min(paidBy.get(o.id) ?? 0, grandTotal);
    const t = totals[src];
    t.orders++;
    t.gross += grandTotal;
    t.net += net;
    t.paid += paid;
    t.balance += Math.max(0, grandTotal - paid);
    const key = clientKeyFor({ corporateClientId: o.corporateClientId, phone: o.phone, name: o.customerName });
    if (key) t.clients.add(key);
    const m = byMonth.get(o.createdDate.slice(0, 7)) ?? { glm: { orders: 0, net: 0 }, sales: { orders: 0, net: 0 } };
    m[src].orders++;
    m[src].net += net;
    byMonth.set(o.createdDate.slice(0, 7), m);
    for (const l of lines) {
      const h = byHead.get(l.head) ?? { glm: { orders: new Set<number>(), net: 0 }, sales: { orders: new Set<number>(), net: 0 } };
      h[src].orders.add(o.id);
      h[src].net += l.gross / (1 + VAT_RATE);
      byHead.set(l.head, h);
    }
    if (src === 'sales') {
      if (o.freelanceAgentId != null) {
        legacy = { orders: legacy.orders + 1, net: legacy.net + net, paid: legacy.paid + paid };
      } else {
        const id = o.sourcedByStaffId ?? o.staffId;
        if (!nameOf.has(id)) nameOf.set(id, id === o.staff.id ? o.staff.name : '');
        const r = per.get(id) ?? { staffId: id, name: '', orders: 0, net: 0, paid: 0, clients: new Set<string>() };
        r.orders++;
        r.net += net;
        r.paid += paid;
        if (key) r.clients.add(key);
        per.set(id, r);
      }
    }
  }
  // names of the sales persons (someone credited through a client may not be the one who keyed the order)
  const users = per.size ? await prisma.user.findMany({ where: { id: { in: [...per.keys()] } }, select: { id: true, name: true } }) : [];
  for (const u of users) nameOf.set(u.id, u.name);
  // what they were paid for the months of the period (contractor payouts: the gross, before the tax)
  const months = [...new Set([range.from.slice(0, 7), range.to.slice(0, 7), ...byMonth.keys()])];
  const payouts = per.size ? await prisma.commissionPayout.findMany({ where: { staffId: { in: [...per.keys()] }, period: { gte: range.from.slice(0, 7), lte: range.to.slice(0, 7) } } }) : [];
  void months;
  const paidOut = new Map<number, number>();
  for (const p of payouts) paidOut.set(p.staffId, (paidOut.get(p.staffId) ?? 0) + p.amount);
  const salesNet = totals.sales.net || 0;
  const fin = (t: ReturnType<typeof blank>) => ({ orders: t.orders, sales: round(t.net), salesWithVat: round(t.gross), paid: round(t.paid), balance: round(t.balance), avgOrder: t.orders > 0 ? round(t.net / t.orders) : null, clients: t.clients.size });
  const allNet = totals.glm.net + totals.sales.net;
  res.json({
    from: range.from,
    to: range.to,
    glm: { ...fin(totals.glm), sharePct: allNet > 0 ? round((totals.glm.net / allNet) * 100) : null },
    sales: { ...fin(totals.sales), sharePct: allNet > 0 ? round((totals.sales.net / allNet) * 100) : null },
    heads: [...byHead.entries()]
      .map(([head, v]) => ({ head, glm: { orders: v.glm.orders.size, sales: round(v.glm.net) }, sales: { orders: v.sales.orders.size, sales: round(v.sales.net) } }))
      .sort((a, b) => b.glm.sales + b.sales.sales - (a.glm.sales + a.sales.sales)),
    months: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, v]) => ({ month, glm: { orders: v.glm.orders, sales: round(v.glm.net) }, sales: { orders: v.sales.orders, sales: round(v.sales.net) } })),
    people: [...per.values()]
      .map((r) => ({
        staffId: r.staffId,
        name: nameOf.get(r.staffId) || r.name || `#${r.staffId}`,
        orders: r.orders,
        sales: round(r.net),
        paid: round(r.paid),
        avgOrder: r.orders > 0 ? round(r.net / r.orders) : null,
        clients: r.clients.size,
        sharePct: salesNet > 0 ? round((r.net / salesNet) * 100) : null,
        paidToThem: round(paidOut.get(r.staffId) ?? 0),
        paidToThemPct: r.net > 0 && paidOut.has(r.staffId) ? round(((paidOut.get(r.staffId) ?? 0) / r.net) * 100) : null,
      }))
      .sort((a, b) => b.sales - a.sales),
    legacyFreelancers: { orders: legacy.orders, sales: round(legacy.net), paid: round(legacy.paid) },
  });
});

// Accounts Receivable — every order (corporate or walk-in/DTF) currently
// sitting at status 'Invoice' with money still owed, aged off its due date.
// Sales by business head: DTF Printing, UV Printing, Laser Engraving, Large Format Printing, Embroidery and General Order. Every
// service belongs to one head; a material sold over the counter is General Order. Figures are sales raised in the period (orders and
// invoices, not quotations), after discounts, with the 16% VAT taken out — before any credit notes.
// ── How an order is counted under the business heads ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A service line counts under its service's business head (or the head its name suggests). A material sold WITH a service — a shirt on an embroidery order, a blank sold
// alongside a DTF job — counts under the head of the order's main service, so the work and what was sold with it stay together; a material sold on its own is General Order.
// DTF Printing and UV DTF Printing are each reported with their film sales and artwork sales shown apart.
const headInclude = { lineItems: { include: { service: { include: { businessHead: true } }, material: true } }, corporateClient: true, dtfFilmSale: { select: { id: true } }, dtfArtworkJob: { select: { id: true } } } satisfies Prisma.OrderInclude;
type HeadOrder = Prisma.OrderGetPayload<{ include: typeof headInclude }>;

function headLines(o: HeadOrder) {
  const inputs: LineItemInput[] = o.lineItems.map((li) => ({ itemType: li.itemType as LineItemInput['itemType'], serviceId: li.serviceId, materialId: li.materialId, qty: li.qty, unitPrice: li.unitPrice, discountPct: li.discountPct, discountAmt: li.discountAmt, heatPressFee: li.heatPressFee }));
  const subtotal = inputs.reduce((a, li) => a + buildLineTotal(li), 0);
  const { grandTotal } = computeOrderTotals({ lineItems: inputs, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt });
  const scale = subtotal > 0 ? grandTotal / subtotal : 0; // what the order-level discount leaves of each line
  const main = primaryHead(o.lineItems.map((li, i) => ({ ...inputs[i]!, service: li.service })));
  const hasService = o.lineItems.some((li) => li.service);
  const kind = o.dtfFilmSale ? 'Film sales' : o.dtfArtworkJob ? 'Artwork sales' : 'Other sales';
  return {
    grandTotal,
    lines: o.lineItems.map((li, i) => {
      const head = li.service ? li.service.businessHead?.name ?? defaultBusinessHeadName(li.service.name) : hasService ? main : GENERAL_ORDER_HEAD;
      return { li, head, gross: buildLineTotal(inputs[i]!) * scale, split: head === DTF_HEAD || head === UV_DTF_HEAD ? kind : null };
    }),
  };
}

reportsRouter.get('/sales-by-business-head', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });
  await ensureBusinessHeadsOnce();

  const heads = await prisma.businessHead.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  const orders = await prisma.order.findMany({
    where: { status: { not: 'Quote' }, createdDate: { gte: range.from, lte: range.to } },
    include: headInclude,
  });

  type Bucket = { sales: number; collected: number; orders: Set<number>; services: Map<string, { qty: number; sales: number }>; splits: Map<string, { sales: number; orders: Set<number> }> };
  const buckets = new Map<string, Bucket>();
  const bucket = (name: string): Bucket => {
    let b = buckets.get(name);
    if (!b) buckets.set(name, (b = { sales: 0, collected: 0, orders: new Set(), services: new Map(), splits: new Map() }));
    return b;
  };

  for (const o of orders) {
    for (const { li, head, gross, split } of headLines(o).lines) {
      const net = gross / (1 + VAT_RATE);
      const b = bucket(head);
      b.sales += net;
      b.orders.add(o.id);
      const label = li.service ? li.service.name : 'Materials sold';
      const s = b.services.get(label) ?? { qty: 0, sales: 0 };
      s.qty += li.qty;
      s.sales += net;
      b.services.set(label, s);
      if (split) {
        const sp = b.splits.get(split) ?? { sales: 0, orders: new Set<number>() };
        sp.sales += net;
        sp.orders.add(o.id);
        b.splits.set(split, sp);
      }
    }
  }

  // Collected: the money received in the period (by the day it was paid, whenever the order was raised), less refunds, VAT out — shared between the heads by each order's lines.
  // It is the same measure Commission pays on, so what a head sold and what it collected can be put side by side.
  const [payments, notes] = await Promise.all([
    prisma.payment.findMany({ where: { date: { gte: range.from, lte: range.to } }, select: { orderId: true, amount: true } }),
    prisma.adjustmentNote.findMany({ where: { type: 'Credit', date: { gte: range.from, lte: range.to }, orderId: { not: null } }, select: { orderId: true, creditAmt: true } }),
  ]);
  const flow = new Map<number, number>();
  for (const p of payments) flow.set(p.orderId, (flow.get(p.orderId) ?? 0) + p.amount);
  for (const n of notes) if (n.orderId) flow.set(n.orderId, (flow.get(n.orderId) ?? 0) - n.creditAmt);
  const flowOrders = flow.size ? await prisma.order.findMany({ where: { id: { in: [...flow.keys()] }, status: { not: 'Quote' } }, include: headInclude }) : [];
  for (const o of flowOrders) {
    const money = flow.get(o.id) ?? 0;
    const { grandTotal, lines } = headLines(o);
    if (grandTotal <= 0) continue;
    for (const l of lines) bucket(l.head).collected += ((money * l.gross) / grandTotal) / (1 + VAT_RATE);
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
      collected: round(b?.collected ?? 0),
      // DTF Printing and UV DTF Printing: the film sales and the artwork sales shown apart (the costs belong to the head as a whole)
      splits: [...(b?.splits.entries() ?? [])].map(([name, v]) => ({ name, sales: round(v.sales), orders: v.orders.size })).sort((x, y) => y.sales - x.sales),
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
    totalCollected: round([...buckets.values()].reduce((a, b) => a + b.collected, 0)),
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
      include: headInclude,
      orderBy: [{ createdDate: 'desc' }, { id: 'desc' }],
    });
    for (const o of orders) {
      for (const { li, head, gross } of headLines(o).lines) {
        if (head !== headName) continue;
        salesLines.push({
          date: o.createdDate,
          orderId: o.id,
          orderNo: o.orderNo,
          customer: o.customerName || o.corporateClient?.name || 'Walk-in',
          item: li.service?.name ?? li.material?.name ?? 'Item',
          qty: li.qty,
          sales: round(gross / (1 + VAT_RATE)),
        });
      }
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
