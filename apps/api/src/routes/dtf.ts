import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { notifyApprovers } from '../approvals';
import { labelFor } from '../orderSource';
import { returnOrderStock, takeOrderStock } from '../orderStock';
import type { OrderLabel } from '../orderSource';
import { randomUUID } from 'node:crypto';
import { sheetCalc, DISCOUNT_PRODUCTS, canGiveDiscount, unitDiscountAmount, canDiscountFlatbed, flatbedUnitDiscountProblem, DEFAULT_FLATBED_SETTINGS, UV_FLATBED_SERVICE, flatbedDescription, flatbedQuote, flatbedSettingsProblem, sortedFlatbedBands, sortedFlatbedDiscounts, DEFAULT_PEN_TIERS, DTF_PRINT_DEFAULT_RATE_PER_SQM, UV_PEN_SERVICE, penQuote, DTF_SERVICE_NAMES, penTiersProblem, sortedPenTiers, UV_DTF_HEAD, UV_DTF_SETTINGS, computeOrderTotals, DEFAULT_DTF_SETTINGS, jobCalc, jobTotals, lowestArtworkPrice, runningMetreCalc, usesSmallSharePrice, chargeToSnapshot, nextRollId, round2, saleCalc, todayStr } from '@glm/shared';
import type { DiscountProduct, UnitDiscount, DtfProduct, FlatbedSettings, LineItemInput, PaymentMethod } from '@glm/shared';
import { artworkListCalc } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { permissionsForRole } from '../permissions';
import { claimProblem, resolveSourcing } from '../commission';
import { resolveCapture } from '../frontOffice';
import { WALK_IN_CLIENT } from '@glm/shared';
import { DTF_HEAD } from '../orderHeads';
import { paymentLineSchema, recordOrderPayments, PaymentError, orderInclude, resolveWalkinStatus, serializeDetail } from './orders';
import type { PaymentLine } from './orders';

// DTF Sales & Roll Tracker. Two access levels (see Role model):
//   canAccessDtf — record film sales / artwork jobs (roll costs are never sent)
//   canManageDtf — roll costs, Setup, closing rolls, profit & wastage
// Deleting a sale or job is Admin-only, same as other destructive actions here.
export const dtfRouter = Router();
dtfRouter.use(requireAuth, requirePermission('canAccessDtf', 'canManageDtf'));

const manageOnly = requirePermission('canManageDtf');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

// DTF and UV DTF each have their own settings row (1 and 2) and their own rolls; everything else about them is the same.
const productOf = (v: unknown): DtfProduct => (v === 'uv' ? 'uv' : 'dtf');
const settingsId = (product: DtfProduct) => (product === 'uv' ? 2 : 1);
async function getSettings(product: DtfProduct = 'dtf') {
  if (product === 'uv') return prisma.dtfSetting.upsert({ where: { id: 2 }, update: {}, create: { id: 2, ...UV_DTF_SETTINGS } });
  return prisma.dtfSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1, ...DEFAULT_DTF_SETTINGS } });
}
/** The ids of the UV DTF rolls (a roll belongs to a product; the DTF ones are everything else). */
async function uvRollIds(): Promise<string[]> {
  return (await prisma.dtfRoll.findMany({ where: { product: 'uv' }, select: { id: true } })).map((r) => r.id);
}

// Translates a raw Prisma foreign-key failure (e.g. a stale reference left
// over from a reseed) into something a staff member can actually act on,
// instead of the query/stack-trace text Prisma throws by default.
function orderCreationErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
    return 'Something referenced by this order (staff, roll, or a catalog item) no longer exists — please log out and log back in, then try again.';
  }
  return err instanceof Error ? err.message : fallback;
}

// Optional merchandise sold alongside a film sale or artwork job (e.g. a
// blank cap the client also wants printed on) — becomes ordinary 'material'
// order line items, same shape New Walk-in Order captures. unitPrice
// defaults to the material's own catalog price server-side when omitted,
// but can be overridden the same way New Walk-in Order allows.
const materialLineSchema = z.object({
  materialId: z.number().int(),
  qty: z.number().positive(),
  unitPrice: z.number().nonnegative().optional(),
});

async function materialLineItems(
  tx: Prisma.TransactionClient,
  lines: { materialId: number; qty: number; unitPrice?: number }[],
) {
  const items: { itemType: string; materialId: number; qty: number; unitPrice: number; discountPct: number; discountAmt: number }[] = [];
  for (const line of lines) {
    let unitPrice = line.unitPrice;
    if (unitPrice == null) {
      const material = await tx.material.findUnique({ where: { id: line.materialId } });
      if (!material) throw new Error('Material not found');
      unitPrice = material.price;
    }
    items.push({ itemType: 'material', materialId: line.materialId, qty: line.qty, unitPrice, discountPct: 0, discountAmt: 0 });
  }
  return items;
}

// The payment lines for a request: the list form, or the older single amountPaid + paymentMethod.
function resolvePaymentLines(d: { payments?: PaymentLine[]; amountPaid: number; paymentMethod: PaymentMethod }): { lines: PaymentLine[]; paid: number } {
  const lines: PaymentLine[] = d.payments && d.payments.length ? d.payments : d.amountPaid > 0 ? [{ method: d.paymentMethod, amount: d.amountPaid }] : [];
  return { lines, paid: lines.reduce((a, p) => a + p.amount, 0) };
}

// Builds the Order + line items + optional Payment for a DTF Film Sale or
// Artwork Job's "Record sale"/"Record job" popup, inside the caller's own
// transaction — shared by both POST /sales and POST /jobs below so the
// receipt/invoice-vs-receipt logic (resolveWalkinStatus) and order
// numbering stay in exactly one place.
async function createDtfOrder(
  tx: Prisma.TransactionClient,
  opts: {
    customerName: string;
    phone: string;
    /** The sales person the order is credited to. */
    staffId: number;
    /** Who keyed it (the cashier): the same person when a sales person captures their own. */
    capturedById: number;
    capturedByName: string;
    product?: DtfProduct;
    /** The price list it was captured under (the menu it was keyed from). */
    priceList?: OrderLabel;
    /** 'dtf' for film sales and artwork jobs; UV pens are an ordinary order ('general'), so a sourced client earns the general-order commission. */
    channel?: 'dtf' | 'general';
    serviceLine: { itemType: string; serviceId: number; qty: number; unitPrice: number; heatPressFee?: number | null; description?: string };
    /** More lines of the same service at other prices (the sizes of an artwork sheet): the first line is serviceLine. */
    moreServiceLines?: { qty: number; unitPrice: number; description?: string; heatPressFee?: number | null }[];
    materialLines: { materialId: number; qty: number; unitPrice?: number }[];
    payments: PaymentLine[];
    // Set to the capturing staff member's own id when they sourced this client (credited to them for 12 months)
    sourcedBy?: number | null;
    // Brought by a freelance sales person instead: credited to their account, and to no staff member.
    freelanceAgentId?: number | null;
    // What one unit of the main line must reach to count as sold at base price (film's floor, an artwork job's recommended price)
    serviceBase?: number;
    /** The order's lines exactly as listed — the artwork, the heat press and the garment of each row in turn — used INSTEAD of serviceLine / moreServiceLines / materialLines (serviceLine is still the first line, for sourcing). */
    orderedLines?: { itemType: 'service' | 'material'; serviceId?: number; materialId?: number; qty: number; unitPrice: number; description?: string }[];
  },
) {
  // The order's staffId comes straight from the caller's JWT — if the dev
  // database was reseeded (or this user's row was otherwise removed) since
  // that token was issued, it no longer matches any User row and the
  // eventual order.create() fails with an opaque foreign-key error. Caught
  // here so the real cause ("log out and back in") surfaces instead of a
  // raw Prisma stack trace in the popup.
  const staffExists = await tx.user.findUnique({ where: { id: opts.staffId } });
  if (!staffExists) throw new Error('Your session is out of date (the underlying user record no longer exists) — please log out and log back in, then try again.');

  const materialItems = await materialLineItems(tx, opts.materialLines);
  const lineItemInputs: LineItemInput[] = opts.orderedLines
    ? opts.orderedLines.map((l) => ({ itemType: l.itemType, serviceId: l.serviceId ?? null, materialId: l.materialId ?? null, qty: l.qty, unitPrice: l.unitPrice, discountPct: 0, discountAmt: 0 }))
    : [
    { itemType: opts.serviceLine.itemType as LineItemInput['itemType'], serviceId: opts.serviceLine.serviceId, materialId: null, qty: opts.serviceLine.qty, unitPrice: opts.serviceLine.unitPrice, discountPct: 0, discountAmt: 0, heatPressFee: opts.serviceLine.heatPressFee ?? null },
    ...(opts.moreServiceLines ?? []).map((l) => ({ itemType: opts.serviceLine.itemType as LineItemInput['itemType'], serviceId: opts.serviceLine.serviceId, materialId: null, qty: l.qty, unitPrice: l.unitPrice, discountPct: 0, discountAmt: 0, heatPressFee: l.heatPressFee ?? null })),
    ...materialItems.map((li) => ({ itemType: li.itemType as LineItemInput['itemType'], serviceId: null, materialId: li.materialId, qty: li.qty, unitPrice: li.unitPrice, discountPct: 0, discountAmt: 0 })),
  ];
  const sourcing = await resolveSourcing(tx, {
    phone: opts.phone,
    name: opts.customerName,
    sourcedBy: opts.sourcedBy,
    freelanceAgentId: opts.freelanceAgentId,
    lines: lineItemInputs.map((li, i) => ({ ...li, baseUnit: i === 0 ? opts.serviceBase : undefined })),
  });
  const totals = computeOrderTotals(
    { lineItems: lineItemInputs, orderDiscountPct: 0, orderDiscountAmt: 0 },
    opts.payments.map((p) => ({ date: todayStr(), amount: p.amount, method: p.method as PaymentMethod })),
  );
  const { status, dueDate } = resolveWalkinStatus(totals.balanceDue);

  const settings = await tx.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  const uv = opts.product === 'uv';
  const orderNo = uv ? 'U-' + settings.nextUvDtfNo : 'F-' + settings.nextDtfNo;
  await tx.setting.update({ where: { id: 1 }, data: uv ? { nextUvDtfNo: settings.nextUvDtfNo + 1 } : { nextDtfNo: settings.nextDtfNo + 1 } });

  const order = await tx.order.create({
    data: {
      orderNo,
      kind: 'walkin',
      channel: opts.channel ?? 'dtf',
      priceList: opts.priceList ?? 'glm',
      customerName: opts.customerName || null,
      phone: opts.phone || null,
      staffId: opts.staffId,
      capturedById: opts.capturedById,
      capturedByName: opts.capturedByName,
      ...sourcing,
      createdDate: todayStr(),
      status,
      dueDate,
      stage: 'Order Received',
      lineItems: {
        create: opts.orderedLines
          ? opts.orderedLines.map((l) => ({ itemType: l.itemType, serviceId: l.serviceId ?? null, materialId: l.materialId ?? null, qty: l.qty, unitPrice: l.unitPrice, description: l.description ?? '' }))
          : [
          { itemType: opts.serviceLine.itemType, serviceId: opts.serviceLine.serviceId, qty: opts.serviceLine.qty, unitPrice: opts.serviceLine.unitPrice, heatPressFee: opts.serviceLine.heatPressFee ?? null, description: opts.serviceLine.description ?? '' },
          ...(opts.moreServiceLines ?? []).map((l) => ({ itemType: opts.serviceLine.itemType, serviceId: opts.serviceLine.serviceId, qty: l.qty, unitPrice: l.unitPrice, heatPressFee: l.heatPressFee ?? null, description: l.description ?? '' })),
          ...materialItems,
        ],
      },
    },
    include: orderInclude,
  });
  await takeOrderStock(tx, order.id); // any stock item on the order leaves the shelf
  if (opts.payments.length) {
    await recordOrderPayments(tx, { id: order.id, kind: 'walkin', status, corporateClient: null }, opts.payments, opts.capturedById); // the money is the cashier's
    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  }

  return order;
}

/**
 * The price-list service a DTF film sale ("DTF Sheet (per metre)") or artwork job ("DTF Printing") is recorded against. Found by its name, or — if it was renamed in
 * Master Data — as the DTF service of that kind; and created when the price list has none (a database that was never seeded), so a sale never stops for a missing row.
 */
async function dtfService(tx: Prisma.TransactionClient, kind: 'film' | 'artwork' | 'press', product: DtfProduct = 'dtf') {
  const uv = product === 'uv';
  const name = DTF_SERVICE_NAMES[product][kind];
  const unit = kind === 'film' ? 'metre' : kind === 'press' || uv ? 'piece' : 'sqm';
  // found by its name or, if it was renamed in Master Data, as this product's DTF service of that kind (UV services are told apart by "UV DTF" in the name)
  // (the heat press is found by its own name only: other DTF-module services are also sold by the piece)
  const found =
    (await tx.service.findFirst({ where: { name } })) ??
    (kind === 'press' ? null : await tx.service.findFirst({ where: { soldViaDtfModule: true, unit, ...(uv ? { name: { contains: 'UV DTF' } } : { NOT: { name: { contains: 'UV DTF' } } }) }, orderBy: { id: 'asc' } }));
  if (found) {
    // taken off the price list, or no longer marked as a DTF service: put right, since the DTF screens depend on it
    if (found.retired || !found.soldViaDtfModule) return tx.service.update({ where: { id: found.id }, data: { retired: false, soldViaDtfModule: true } });
    return found;
  }
  const headName = uv ? UV_DTF_HEAD : DTF_HEAD;
  const head =
    (await tx.businessHead.findFirst({ where: { name: headName } })) ??
    (uv ? await tx.businessHead.create({ data: { name: headName, sortOrder: ((await tx.businessHead.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1 } }) : null);
  const settings = uv ? await tx.dtfSetting.upsert({ where: { id: 2 }, update: {}, create: { id: 2, ...UV_DTF_SETTINGS } }) : await tx.dtfSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  return tx.service.create({
    data: {
      name,
      item: name,
      unit,
      price: kind === 'film' ? settings.stdPricePerM : kind === 'press' ? 0 : uv ? settings.minPricePerPiece : DTF_PRINT_DEFAULT_RATE_PER_SQM, // (the heat press is priced on each row, so its list price is a placeholder)
      soldViaDtfModule: true,
      chargesPressingFee: kind === 'artwork' && !uv, // a UV DTF sticker is applied cold: no heat press fee
      businessHeadId: head?.id ?? null,
    },
  });
}

/** The price-list service UV pen orders are recorded against: found by name, put right if retired, created on the first order. */
async function penService(tx: Prisma.TransactionClient) {
  const found = await tx.service.findFirst({ where: { name: UV_PEN_SERVICE } });
  if (found) {
    if (found.retired || !found.soldViaDtfModule) return tx.service.update({ where: { id: found.id }, data: { retired: false, soldViaDtfModule: true } });
    return found;
  }
  // UV pens are sold on the UV DTF screen and are counted under UV DTF Printing
  const head = (await tx.businessHead.findFirst({ where: { name: UV_DTF_HEAD } })) ?? (await tx.businessHead.create({ data: { name: UV_DTF_HEAD, sortOrder: ((await tx.businessHead.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1 } }));
  return tx.service.create({ data: { name: UV_PEN_SERVICE, item: UV_PEN_SERVICE, unit: 'piece', price: DEFAULT_PEN_TIERS[0]!.rate, soldViaDtfModule: true, businessHeadId: head?.id ?? null } });
}

// The full data set the tracker's calculations run on. Users without
// canManageDtf only get open rolls with their costs zeroed out — profit is
// derivable from roll cost, so cost never leaves the server for them.
dtfRouter.get('/data', async (req, res) => {
  const perms = await permissionsForRole(req.user!.role);
  const canManage = perms.canManageDtf;
  const product = productOf(req.query.product);
  // The order screens (scope=order) and anyone without canManageDtf only work on the OPEN rolls, so they get those rolls and the sales and jobs on them — not the whole history, which grows
  // every month and only the manager screens (dashboard, rolls, history) need.
  const openOnly = !canManage || req.query.scope === 'order';
  const [settings, rolls, sales, jobs] = await Promise.all([
    getSettings(product),
    prisma.dtfRoll.findMany({ where: { product, ...(openOnly ? { status: 'open' } : {}) }, orderBy: { id: 'asc' } }),
    prisma.dtfFilmSale.findMany({ where: { roll: { product, ...(openOnly ? { status: 'open' } : {}) } }, orderBy: [{ soldOn: 'desc' }, { id: 'desc' }] }),
    prisma.dtfArtworkJob.findMany({ where: { roll: { product, ...(openOnly ? { status: 'open' } : {}) } }, orderBy: [{ jobOn: 'desc' }, { id: 'desc' }] }),
  ]);
  const uvIds = await uvRollIds();
  res.json({
    product,
    canManage,
    settings: {
      rollLengthM: settings.rollLengthM,
      rollWidthCm: settings.rollWidthCm,
      stdPricePerM: settings.stdPricePerM,
      minPricePerM: settings.minPricePerM,
      wastageTolerancePct: settings.wastageTolerancePct,
      minPricePerPiece: settings.minPricePerPiece,
      fixedChargePerMetre: settings.fixedChargePerMetre,
      smallShareBelow: settings.smallShareBelow,
      smallSharePrice: settings.smallSharePrice,
    },
    rolls: rolls.map((r) => ({
      id: r.id,
      product: productOf(r.product),
      installedOn: r.installedOn,
      finishedOn: r.finishedOn,
      status: r.status,
      filmCost: canManage ? r.filmCost : 0,
      inkPowderCost: canManage ? r.inkPowderCost : 0,
      rollLengthM: r.rollLengthM,
      closeKind: r.closeKind,
      closeNote: r.closeNote,
      closedByName: r.closedByName,
      writtenOffM: r.writtenOffM,
      carriedInUsedM: r.carriedInUsedM,
    })),
    sales: sales.map((s) => ({
      id: s.id,
      rollId: s.rollId,
      soldOn: s.soldOn,
      client: s.client,
      metres: s.metres,
      pricePerM: s.pricePerM,
      stdPriceAtSale: s.stdPriceAtSale,
      amountPaid: s.amountPaid,
    })),
    jobs: jobs.map((j) => ({
      id: j.id,
      rollId: j.rollId,
      jobOn: j.jobOn,
      client: j.client,
      runningMetres: j.runningMetres,
      pieces: j.pieces,
      fixedChargePerMetreAtJob: j.fixedChargePerMetreAtJob,
      minPricePerPieceAtJob: j.minPricePerPieceAtJob,
      chargedPerPiece: j.chargedPerPiece,
      chargedTotal: j.chargedTotal,
      sheetId: j.sheetId,
      approvalStatus: j.approvalStatus,
      orderId: j.orderId,
      pricedBySales: j.pricedBySales,
    })),
    pendingApprovals: canManage ? await prisma.priceApproval.count({ where: { status: 'Pending', ...(product === 'uv' ? { rollId: { in: uvIds } } : { NOT: { rollId: { in: uvIds } } }) } }) : 0,
  });
});

// ── UV pen branding: the price picker's rate tiers ───────────────────────
// The rate a pen is charged at depends on how many pens are in the order; the whole order is charged at that one rate. Anyone with DTF access reads the tiers; only an Admin
// changes them. A new database starts with the owner's rates (1–99 at 20/=, 100–499 at 15/=, 500–1000 at 12/=, 1001+ at 10/=).
async function penTiers() {
  if ((await prisma.penTier.count()) === 0) await prisma.penTier.createMany({ data: DEFAULT_PEN_TIERS.map((t) => ({ fromQty: t.from, rate: t.rate })) });
  return (await prisma.penTier.findMany({ orderBy: { fromQty: 'asc' } })).map((t) => ({ from: t.fromQty, rate: t.rate }));
}

dtfRouter.get('/pen-tiers', async (req, res) => {
  res.json({ canManage: req.user!.role === 'Admin', canDiscount: canGiveDiscount(req.user!.role), tiers: await penTiers() });
});

dtfRouter.put('/pen-tiers', requireRole('Admin'), async (req, res) => {
  const parsed = z.object({ tiers: z.array(z.object({ from: z.number().int(), rate: z.number().max(1_000_000) })).min(1).max(20) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const tiers = sortedPenTiers(parsed.data.tiers);
  const problem = penTiersProblem(tiers);
  if (problem) return res.status(400).json({ error: problem });
  await prisma.$transaction([prisma.penTier.deleteMany({}), prisma.penTier.createMany({ data: tiers.map((t) => ({ fromQty: t.from, rate: t.rate })) })]);
  res.json({ canManage: true, tiers: await penTiers() });
});

// a discount on the unit price of a piece (see the discount requests below)
const unitDiscountSchema = z.object({ kind: z.enum(['amount', 'pct']), value: z.number().max(1_000_000) });

const penOrderSchema = z.object({
  pens: z.number().int().positive('Enter the number of pens').max(1_000_000),
  client: z.string().max(200).default(''),
  phone: z.string().max(40).default(''),
  amountPaid: z.number().min(0).default(0),
  paymentMethod: z.enum(['Cash', 'M-Pesa', 'Bank Transfer', 'Card']).default('Cash'),
  payments: z.array(paymentLineSchema).max(6).optional(),
  materialLines: z.array(materialLineSchema).default([]),
  sourcedBy: z.number().int().nullable().optional(),
  freelanceAgentId: z.number().int().nullable().optional(),
  // The sales person the order is credited to, when the front office captures it for them (see frontOffice.ts).
  staffId: z.number().int().nullable().optional(),
  // a discount on the unit price: given outright by Finance, the General Manager or an Admin, or taken from an approved request (see discount requests above)
  unitDiscount: unitDiscountSchema.nullable().default(null),
  discountRequestId: z.number().int().nullable().default(null),
});

// "Capture as order" on UV Pen Costing: the pens at the rate for their quantity — worked out here from the tiers, never taken from the screen — become an ordinary order
// (receipt or invoice, any payment, any merchandise sold with it). There is no roll to consume, so nothing else is recorded.
dtfRouter.post('/pen-orders', async (req, res) => {
  const parsed = penOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const ud = await resolveUnitDiscount(req.user!, 'pens', { pens: d.pens }, d.unitDiscount, d.discountRequestId);
  if (!ud.ok) return res.status(ud.status).json({ error: ud.error });
  const quote = penQuote(await penTiers(), d.pens, ud.discount);
  if (!quote.tier) return res.status(400).json({ error: 'No rate applies to that number of pens' });
  if (quote.discountProblem) return res.status(400).json({ error: quote.discountProblem });
  const cap = await resolveCapture(req.user!, d.staffId, d.sourcedBy);
  if (!cap.ok) return res.status(cap.status).json({ error: cap.error });
  const claim = await claimProblem(req.user!, { phone: d.phone, name: d.client, sourcedBy: d.sourcedBy, freelanceAgentId: d.freelanceAgentId });
  if (claim) return res.status(400).json({ error: claim });
  const { lines: paymentLines, paid } = resolvePaymentLines(d);
  const merch = await materialLineItems(prisma, d.materialLines).catch(() => null);
  if (!merch) return res.status(400).json({ error: 'Material not found' });
  const orderTotal = quote.total + merch.reduce((a, m) => a + m.qty * m.unitPrice, 0);
  if (paid > orderTotal + 0.005) return res.status(400).json({ error: 'Amount paid cannot exceed the order total' });
  try {
    const order = await prisma.$transaction(async (tx) => {
      const service = await penService(tx);
      const made = await createDtfOrder(tx, {
        product: 'uv',
        channel: 'general',
        customerName: d.client.trim() || WALK_IN_CLIENT,
        phone: d.phone.trim(),
        staffId: cap.staffId,
        capturedById: cap.capturedById,
        capturedByName: cap.capturedByName,
        serviceLine: { itemType: 'service', serviceId: service.id, qty: d.pens, unitPrice: quote.discountedRate, description: quote.unitDiscount > 0 ? quote.unitDiscount + '/= off each pen' : '' },
        materialLines: d.materialLines,
        payments: paymentLines,
        sourcedBy: d.sourcedBy,
        freelanceAgentId: d.freelanceAgentId,
        serviceBase: quote.rate, // sold at the tier rate, with nothing above it to earn a premium on
      });
      await spendDiscountRequest(tx, ud.requestId, made.orderNo);
      return made;
    });
    res.status(201).json({ order: serializeDetail(order) });
  } catch (err) {
    res.status(400).json({ error: orderCreationErrorMessage(err, 'Failed to record the pen order') });
  }
});

// ── UV flatbed printing (diaries and other flat items): the price bands ───────
// The artwork is priced by its area in bands (at least the minimum for a piece); a volume discount and a discount on the unit price are given only when Finance, the General Manager or an Admin applies
// them; and a setup fee is added when it is asked for (see flatbed.ts in shared).
// Anyone with DTF access reads the settings; only an Admin changes them. A new database starts with the owner's bands.
async function flatbedSettings(): Promise<FlatbedSettings> {
  const row = await prisma.flatbedSetting.findUnique({ where: { id: 1 } });
  if (!row) return DEFAULT_FLATBED_SETTINGS;
  try {
    const s = JSON.parse(row.data) as FlatbedSettings;
    return { ...DEFAULT_FLATBED_SETTINGS, ...s, bands: sortedFlatbedBands(s.bands ?? DEFAULT_FLATBED_SETTINGS.bands), discounts: sortedFlatbedDiscounts(s.discounts ?? DEFAULT_FLATBED_SETTINGS.discounts) };
  } catch {
    return DEFAULT_FLATBED_SETTINGS;
  }
}

dtfRouter.get('/flatbed', async (req, res) => {
  res.json({ canManage: req.user!.role === 'Admin', canDiscount: canDiscountFlatbed(req.user!.role), settings: await flatbedSettings() });
});

const flatbedSettingsSchema = z.object({
  maxWidthCm: z.number().max(1000),
  maxLengthCm: z.number().max(1000),
  minPiecePrice: z.number().max(1_000_000),
  setupFee: z.number().max(1_000_000),
  bands: z.array(z.object({ upToCm2: z.number().max(1_000_000), price: z.number().max(1_000_000) })).min(1).max(20),
  discounts: z.array(z.object({ from: z.number().int(), pct: z.number() })).min(1).max(10),
});

dtfRouter.put('/flatbed', requireRole('Admin'), async (req, res) => {
  const parsed = flatbedSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const settings: FlatbedSettings = { ...parsed.data, bands: sortedFlatbedBands(parsed.data.bands), discounts: sortedFlatbedDiscounts(parsed.data.discounts) };
  const problem = flatbedSettingsProblem(settings);
  if (problem) return res.status(400).json({ error: problem });
  await prisma.flatbedSetting.upsert({ where: { id: 1 }, update: { data: JSON.stringify(settings) }, create: { id: 1, data: JSON.stringify(settings) } });
  res.json({ canManage: true, settings: await flatbedSettings() });
});

/** The price-list service flatbed orders are recorded against: found by name, put right if retired, created on the first order under UV Printing. */
async function flatbedService(tx: Prisma.TransactionClient, price: number) {
  const found = await tx.service.findFirst({ where: { name: UV_FLATBED_SERVICE } });
  if (found) {
    if (found.retired || !found.soldViaDtfModule) return tx.service.update({ where: { id: found.id }, data: { retired: false, soldViaDtfModule: true } });
    return found;
  }
  const head = (await tx.businessHead.findFirst({ where: { name: 'UV Printing' } })) ?? (await tx.businessHead.create({ data: { name: 'UV Printing', sortOrder: ((await tx.businessHead.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0) + 1 } }));
  return tx.service.create({ data: { name: UV_FLATBED_SERVICE, item: UV_FLATBED_SERVICE, unit: 'job', price, soldViaDtfModule: true, businessHeadId: head.id } });
}

const flatbedOrderSchema = z.object({
  widthCm: z.number().positive('Enter the artwork width').max(1000),
  heightCm: z.number().positive('Enter the artwork height').max(1000),
  pieces: z.number().int().positive('Enter the number of pieces').max(1_000_000),
  // the setup fee is added to the job only when it is asked for
  withSetup: z.boolean().default(false),
  // discounts are given only by Finance, the General Manager or an Admin (checked below)
  volumeDiscount: z.boolean().default(false),
  unitDiscount: unitDiscountSchema.nullable().default(null),
  discountRequestId: z.number().int().nullable().default(null),
  note: z.string().max(100).default(''),
  client: z.string().max(200).default(''),
  phone: z.string().max(40).default(''),
  amountPaid: z.number().min(0).default(0),
  paymentMethod: z.enum(['Cash', 'M-Pesa', 'Bank Transfer', 'Card']).default('Cash'),
  payments: z.array(paymentLineSchema).max(6).optional(),
  materialLines: z.array(materialLineSchema).default([]),
  sourcedBy: z.number().int().nullable().optional(),
  freelanceAgentId: z.number().int().nullable().optional(),
  staffId: z.number().int().nullable().optional(),
});

// "Capture as order" on UV Flatbed: the run, priced here from the bands — never taken from the screen — becomes an ordinary order with one line for the whole job, whose
// description says what was printed (size, pieces, band), plus any merchandise sold with it. There is no roll to consume.
dtfRouter.post('/flatbed-orders', async (req, res) => {
  const parsed = flatbedOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const settings = await flatbedSettings();
  if (d.volumeDiscount && !canDiscountFlatbed(req.user!.role)) return res.status(403).json({ error: 'Only Finance, the General Manager or an Admin can apply the volume discount' });
  const ud = await resolveUnitDiscount(req.user!, 'flatbed', { widthCm: d.widthCm, heightCm: d.heightCm, pieces: d.pieces }, d.unitDiscount, d.discountRequestId);
  if (!ud.ok) return res.status(ud.status).json({ error: ud.error });
  const opts = { setup: d.withSetup, volume: d.volumeDiscount, unitDiscount: ud.discount };
  const udProblem = flatbedUnitDiscountProblem(ud.discount);
  if (udProblem) return res.status(400).json({ error: udProblem });
  const quote = flatbedQuote(settings, d.widthCm, d.heightCm, d.pieces, opts);
  if (!quote.ok) return res.status(400).json({ error: quote.problem ?? 'No price applies to that job' });
  const cap = await resolveCapture(req.user!, d.staffId, d.sourcedBy);
  if (!cap.ok) return res.status(cap.status).json({ error: cap.error });
  const claim = await claimProblem(req.user!, { phone: d.phone, name: d.client, sourcedBy: d.sourcedBy, freelanceAgentId: d.freelanceAgentId });
  if (claim) return res.status(400).json({ error: claim });
  const { lines: paymentLines, paid } = resolvePaymentLines(d);
  const merch = await materialLineItems(prisma, d.materialLines).catch(() => null);
  if (!merch) return res.status(400).json({ error: 'Material not found' });
  const orderTotal = quote.total + merch.reduce((a, m) => a + m.qty * m.unitPrice, 0);
  if (paid > orderTotal + 0.005) return res.status(400).json({ error: 'Amount paid cannot exceed the order total' });
  try {
    const order = await prisma.$transaction(async (tx) => {
      const service = await flatbedService(tx, quote.unitPrice);
      const made = await createDtfOrder(tx, {
        product: 'uv',
        channel: 'general',
        customerName: d.client.trim() || WALK_IN_CLIENT,
        phone: d.phone.trim(),
        staffId: cap.staffId,
        capturedById: cap.capturedById,
        capturedByName: cap.capturedByName,
        serviceLine: { itemType: 'service', serviceId: service.id, qty: 1, unitPrice: quote.total, description: flatbedDescription(settings, d.widthCm, d.heightCm, d.pieces, opts, d.note) },
        materialLines: d.materialLines,
        payments: paymentLines,
        sourcedBy: d.sourcedBy,
        freelanceAgentId: d.freelanceAgentId,
        serviceBase: quote.total, // sold at the quoted price, with nothing above it to earn a premium on
      });
      await spendDiscountRequest(tx, ud.requestId, made.orderNo);
      return made;
    });
    res.status(201).json({ order: serializeDetail(order) });
  } catch (err) {
    res.status(400).json({ error: orderCreationErrorMessage(err, 'Failed to record the flatbed order') });
  }
});

// ── Unit price discounts that need approval (UV Pen Costing and UV Flatbed) ───────────────────
// Finance Manager, General Manager and Admin give a discount on the unit price straight away. Anyone else asks: the request is for one job (the pens, or the artwork size and the number of
// pieces), it is decided by one of them, and an approved request can be used on that job — once, by the person who asked — when the order is captured. The discount comes from the request,
// never from the screen.

type DiscountSpec = { pens: number } | { widthCm: number; heightCm: number; pieces: number };
const specKey = (s: DiscountSpec) => JSON.stringify(s);

/** The unit price a request is about (before the discount), or why there is none. */
async function discountUnitPrice(product: DiscountProduct, spec: DiscountSpec): Promise<{ unit: number; problem: string | null }> {
  if (product === 'pens') {
    const q = penQuote(await penTiers(), (spec as { pens: number }).pens);
    return q.tier ? { unit: q.rate, problem: null } : { unit: 0, problem: 'No rate applies to that number of pens' };
  }
  const f = spec as { widthCm: number; heightCm: number; pieces: number };
  const q = flatbedQuote(await flatbedSettings(), f.widthCm, f.heightCm, f.pieces);
  return q.ok ? { unit: q.unitPrice, problem: null } : { unit: 0, problem: q.problem ?? 'No price applies to that job' };
}

const discountRequestSchema = z.object({
  product: z.enum(DISCOUNT_PRODUCTS),
  pens: z.number().int().positive().max(1_000_000).optional(),
  widthCm: z.number().positive().max(1000).optional(),
  heightCm: z.number().positive().max(1000).optional(),
  pieces: z.number().int().positive().max(1_000_000).optional(),
  discount: unitDiscountSchema,
});

const showRequest = (r: Prisma.DiscountRequestGetPayload<object>) => ({
  id: r.id,
  product: r.product,
  spec: JSON.parse(r.spec) as DiscountSpec,
  kind: r.kind,
  value: r.value,
  unitBefore: r.unitBefore,
  unitAfter: r.unitAfter,
  requestedByName: r.requestedByName,
  requestedAt: r.requestedAt.toISOString(),
  status: r.status,
  decidedByName: r.decidedByName,
  decidedAt: r.decidedAt?.toISOString() ?? null,
  reason: r.reason,
  orderNo: r.orderNo,
  mine: false,
});

// Ask for a discount on one job.
dtfRouter.post('/discount-requests', async (req, res) => {
  const parsed = discountRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  if (canGiveDiscount(req.user!.role)) return res.status(400).json({ error: 'You can give this discount yourself — it needs no approval' });
  let spec: DiscountSpec;
  if (d.product === 'pens') {
    if (!d.pens) return res.status(400).json({ error: 'Enter the number of pens' });
    spec = { pens: d.pens };
  } else {
    if (!d.widthCm || !d.heightCm || !d.pieces) return res.status(400).json({ error: 'Enter the artwork size and the number of pieces' });
    spec = { widthCm: d.widthCm, heightCm: d.heightCm, pieces: d.pieces };
  }
  if (!(d.discount.value > 0)) return res.status(400).json({ error: 'Enter the discount you are asking for' });
  const base = await discountUnitPrice(d.product, spec);
  if (base.problem) return res.status(400).json({ error: base.problem });
  const applied = unitDiscountAmount(base.unit, d.discount);
  if (applied.problem) return res.status(400).json({ error: applied.problem });
  const row = await prisma.discountRequest.create({
    data: { product: d.product, spec: specKey(spec), kind: d.discount.kind, value: d.discount.value, unitBefore: base.unit, unitAfter: round2(base.unit - applied.amount), requestedById: req.user!.id, requestedByName: req.user!.name },
  });
  notifyApprovers('discount', 'unit price discount', `${req.user!.name} asks for a unit price discount on ${d.product === 'pens' ? 'UV pens' : 'the UV flatbed'}: ${d.discount.kind === 'pct' ? d.discount.value + '% off' : d.discount.value + '/= off each'} (${base.unit}/= → ${round2(base.unit - applied.amount)}/=).`, { id: req.user!.id });
  res.status(201).json(showRequest(row));
});

// Those who decide see what is waiting (and what was decided lately); everyone else sees their own requests.
dtfRouter.get('/discount-requests', async (req, res) => {
  const product = DISCOUNT_PRODUCTS.find((p) => p === req.query.product);
  const approver = canGiveDiscount(req.user!.role);
  const where: Prisma.DiscountRequestWhereInput = { ...(product ? { product } : {}), ...(approver ? {} : { requestedById: req.user!.id }) };
  const rows = await prisma.discountRequest.findMany({ where, orderBy: { id: 'desc' }, take: 60 });
  const pending = rows.filter((r) => r.status === 'Pending');
  const rest = rows.filter((r) => r.status !== 'Pending').slice(0, 20);
  res.json({ canApprove: approver, requests: [...pending, ...rest].map((r) => ({ ...showRequest(r), mine: r.requestedById === req.user!.id })) });
});

dtfRouter.post('/discount-requests/:id/approve', async (req, res) => {
  if (!canGiveDiscount(req.user!.role)) return res.status(403).json({ error: 'Only Finance, the General Manager or an Admin can approve a discount' });
  const r = await prisma.discountRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!r) return res.status(404).json({ error: 'Discount request not found' });
  if (r.status !== 'Pending') return res.status(400).json({ error: `This request has already been ${r.status.toLowerCase()}` });
  if (r.requestedById === req.user!.id) return res.status(400).json({ error: 'You cannot approve your own request' });
  const row = await prisma.discountRequest.update({ where: { id: r.id }, data: { status: 'Approved', decidedByName: req.user!.name, decidedAt: new Date() } });
  res.json(showRequest(row));
});

dtfRouter.post('/discount-requests/:id/reject', async (req, res) => {
  if (!canGiveDiscount(req.user!.role)) return res.status(403).json({ error: 'Only Finance, the General Manager or an Admin can decide a discount' });
  const parsed = z.object({ reason: z.string().trim().min(1, 'Give a reason for turning the discount down').max(300) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const r = await prisma.discountRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!r) return res.status(404).json({ error: 'Discount request not found' });
  if (r.status !== 'Pending') return res.status(400).json({ error: `This request has already been ${r.status.toLowerCase()}` });
  const row = await prisma.discountRequest.update({ where: { id: r.id }, data: { status: 'Rejected', reason: parsed.data.reason, decidedByName: req.user!.name, decidedAt: new Date() } });
  res.json(showRequest(row));
});

/**
 * The unit price discount an order is captured with. Finance, the General Manager and Admin may give one outright. Anyone else needs an APPROVED request of their own for this very job
 * (the same product, the same pens or the same artwork size and pieces) that has not been used yet; the discount is then the request's, whatever the screen sent.
 */
async function resolveUnitDiscount(
  user: { id: number; role: string },
  product: DiscountProduct,
  spec: DiscountSpec,
  direct: UnitDiscount | null | undefined,
  requestId: number | null | undefined,
): Promise<{ ok: true; discount: UnitDiscount | null; requestId: number | null } | { ok: false; status: number; error: string }> {
  if (requestId) {
    const r = await prisma.discountRequest.findUnique({ where: { id: requestId } });
    if (!r || r.product !== product || r.requestedById !== user.id) return { ok: false, status: 400, error: 'That discount request is not yours, or is not for this job' };
    if (r.status !== 'Approved') return { ok: false, status: 400, error: r.status === 'Used' ? 'That discount has already been used on an order' : `That discount request is ${r.status.toLowerCase()}, not approved` };
    if (r.spec !== specKey(spec)) return { ok: false, status: 400, error: 'That discount was approved for a different job — the pens, size or number of pieces has changed. Ask again.' };
    return { ok: true, discount: { kind: r.kind as UnitDiscount['kind'], value: r.value }, requestId: r.id };
  }
  if (direct && direct.value > 0) {
    if (!canGiveDiscount(user.role)) return { ok: false, status: 403, error: 'A unit price discount needs approval: ask for it, and apply it once Finance, the General Manager or an Admin has approved it' };
    return { ok: true, discount: direct, requestId: null };
  }
  return { ok: true, discount: null, requestId: null };
}

/** An approved request is spent by the order it was used on. */
async function spendDiscountRequest(tx: Prisma.TransactionClient, id: number | null, orderNo: string) {
  if (!id) return;
  const done = await tx.discountRequest.updateMany({ where: { id, status: 'Approved' }, data: { status: 'Used', orderNo } });
  if (done.count !== 1) throw new Error('That discount has already been used on an order');
}

// ── Setup ────────────────────────────────────────────────────────────────
const settingsSchema = z
  .object({
    rollLengthM: z.number().positive(),
    rollWidthCm: z.number().positive(),
    stdPricePerM: z.number().positive(),
    minPricePerM: z.number().positive(),
    wastageTolerancePct: z.number().min(0).max(100),
    minPricePerPiece: z.number().min(0),
    fixedChargePerMetre: z.number().min(0),
    smallShareBelow: z.number().min(0).optional(),
    smallSharePrice: z.number().min(0).optional(),
  })
  .refine((s) => s.minPricePerM <= s.stdPricePerM, { message: 'Minimum price cannot be above the standard price' })
  .refine((s) => !(s.minPricePerPiece > 0 && (s.smallSharePrice ?? 0) > 0 && (s.smallSharePrice ?? 0) < s.minPricePerPiece), { message: 'The price used for a small share cannot be below the lowest price of an artwork' })
  .refine((s) => !((s.smallShareBelow ?? 0) > 0 && (s.smallSharePrice ?? 0) > 0 && (s.smallSharePrice ?? 0) < (s.smallShareBelow ?? 0)), { message: 'The price used for a small share cannot be below the share it applies to' });

dtfRouter.put('/settings', manageOnly, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const product = productOf(req.query.product);
  await getSettings(product);
  await prisma.dtfSetting.update({ where: { id: settingsId(product) }, data: parsed.data });
  res.json(parsed.data);
});

// ── The price per running metre of artwork, on its own ──────────────────────
// What every artwork order is worked out from: (price per running metre × running metres) ÷ artworks. It lives in Setup with the rest, but a manager changes it often, so it has its own
// place (DTF → Artwork price, and on the artwork order screen). It changes only this one figure, for new orders from that moment; jobs already recorded keep the price they were saved with.
// The audit log keeps who set what and when, and the history below is read from it.
const artworkRateSchema = z.object({
  product: z.enum(['dtf', 'uv']).optional(),
  pricePerMetre: z.number({ required_error: 'Enter the price per running metre', invalid_type_error: 'Enter the price per running metre' }).positive('The price per running metre must be more than 0').max(1_000_000),
});
dtfRouter.put('/artwork-rate', manageOnly, async (req, res) => {
  const parsed = artworkRateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const product = productOf(parsed.data.product ?? req.query.product);
  const before = await getSettings(product);
  const price = round2(parsed.data.pricePerMetre);
  await prisma.dtfSetting.update({ where: { id: settingsId(product) }, data: { fixedChargePerMetre: price } });
  res.json({ product, pricePerMetre: price, previous: before.fixedChargePerMetre });
});

dtfRouter.get('/artwork-rate/history', manageOnly, async (req, res) => {
  const product = productOf(req.query.product);
  const rows = await prisma.auditLog.findMany({ where: { action: 'PUT /api/dtf/artwork-rate', status: { lt: 400 } }, orderBy: { id: 'desc' }, take: 200 });
  const out = rows
    .map((r) => {
      const price = Number(/pricePerMetre=([0-9.]+)/.exec(r.detail)?.[1]);
      const prod = /product=(uv|dtf)/.exec(r.detail)?.[1] ?? 'dtf';
      return { at: r.at.toISOString(), by: r.userName, pricePerMetre: price, product: prod };
    })
    .filter((r) => r.product === product && Number.isFinite(r.pricePerMetre))
    .slice(0, 15);
  res.json(out);
});

// ── Rolls ────────────────────────────────────────────────────────────────
const noteSchema = z.string().trim().min(3, 'Say why the roll is being terminated').max(300);
const rollSchema = z.object({
  installedOn: dateStr.optional(),
  // A roll belongs to one product; a UV DTF roll's costs are Film A (printing) in filmCost and Film B (laminating) in inkPowderCost.
  product: z.enum(['dtf', 'uv']).default('dtf'),
  filmCost: z.number().min(0).default(0),
  inkPowderCost: z.number().min(0).default(0),
  // A roll that is already part-used (the system is starting up, or the roll was begun before it was recorded): the metres LEFT on it. The costs sent are then the whole roll's,
  // and the system keeps only the share that matches the metres left.
  metresLeft: z.number().positive().optional(),
  // Rolls that have physically run out but still show a balance on the system: closed at this roll's install date, the balance written off as waste.
  terminate: z.array(z.object({ rollId: z.string().min(1), note: noteSchema })).max(10).optional(),
});

class RollError extends Error {}

/**
 * Terminates an open roll that has been physically used up while the system still shows a balance: the roll is closed at the cut-off date and the balance is written off as
 * waste (a closed roll's unused metres are its wastage). Refused when there are artwork jobs waiting for price approval (their metres are only reserved), or sales and jobs
 * recorded after the cut-off. Throws a RollError with the reason.
 */
async function terminateRoll(db: Prisma.TransactionClient | typeof prisma, rollId: string, cutOff: string, note: string, byName: string) {
  const roll = await db.dtfRoll.findUnique({ where: { id: rollId } });
  if (!roll) throw new RollError(`Roll ${rollId} was not found`);
  if (roll.status !== 'open') throw new RollError(`${rollId} is already closed`);
  const [sales, jobs] = await Promise.all([db.dtfFilmSale.findMany({ where: { rollId } }), db.dtfArtworkJob.findMany({ where: { rollId } })]);
  if (jobs.some((j) => j.approvalStatus === 'Pending')) throw new RollError(`${rollId} has artwork jobs waiting for price approval — decide those first`);
  if (roll.installedOn && cutOff < roll.installedOn) throw new RollError(`The cut-off cannot be before ${rollId} was installed (${roll.installedOn})`);
  if (cutOff > todayStr()) throw new RollError('The cut-off date cannot be in the future');
  const after = sales.filter((s) => s.soldOn > cutOff).length + jobs.filter((j) => j.jobOn > cutOff).length;
  if (after > 0) throw new RollError(`${rollId} has ${after} sale${after === 1 ? '' : 's'} or job${after === 1 ? '' : 's'} recorded after ${cutOff}, so it cannot be cut off then`);
  const settings = await db.dtfSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  const used = sales.reduce((a, s) => a + s.metres, 0) + jobs.reduce((a, j) => a + j.runningMetres, 0);
  const remaining = Math.max(0, Math.round(((roll.rollLengthM || settings.rollLengthM) - used) * 1000) / 1000);
  return db.dtfRoll.update({ where: { id: rollId }, data: { status: 'closed', finishedOn: cutOff, closeKind: 'terminated', closeNote: note, closedByName: byName, writtenOffM: remaining } });
}

dtfRouter.post('/rolls', manageOnly, async (req, res) => {
  const parsed = rollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const product = parsed.data.product;
  const settings = await getSettings(product);
  const installedOn = parsed.data.installedOn ?? todayStr();
  const fullLen = settings.rollLengthM;
  const left = parsed.data.metresLeft;
  if (left !== undefined && left >= fullLen) return res.status(400).json({ error: `A part-used roll has less than a full roll left (${fullLen} m) — leave the box unticked to install a new full roll` });
  const part = left !== undefined ? left / fullLen : 1;
  try {
    // terminating the old rolls and installing the new one happen together: if any roll cannot be terminated, nothing is installed
    const roll = await prisma.$transaction(async (tx) => {
      for (const t of parsed.data.terminate ?? []) await terminateRoll(tx, t.rollId, installedOn, t.note, req.user!.name);
      const existing = await tx.dtfRoll.findMany({ where: { product }, select: { id: true } });
      return tx.dtfRoll.create({
        data: {
          id: nextRollId(existing, product),
          product,
          installedOn,
          filmCost: Math.round(parsed.data.filmCost * part * 100) / 100,
          inkPowderCost: Math.round(parsed.data.inkPowderCost * part * 100) / 100,
          rollLengthM: left ?? fullLen,
          carriedInUsedM: left !== undefined ? Math.round((fullLen - left) * 1000) / 1000 : 0,
          createdByName: req.user!.name,
        },
      });
    });
    res.status(201).json(roll);
  } catch (e) {
    if (e instanceof RollError) return res.status(400).json({ error: e.message });
    res.status(409).json({ error: 'Another roll was just installed — try again' });
  }
});

const rollUpdateSchema = z
  .object({ installedOn: dateStr, filmCost: z.number().min(0), inkPowderCost: z.number().min(0), metresLeft: z.number().positive() })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

dtfRouter.put('/rolls/:id', manageOnly, async (req, res) => {
  const parsed = rollUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const { metresLeft, ...fields } = parsed.data;
  const data: Prisma.DtfRollUpdateInput = { ...fields };
  if (metresLeft !== undefined) {
    // Correcting the metres left on a roll that was installed part-used: allowed while the roll still has room for what has been recorded against it.
    // The costs (as sent, or as stored) are for the current metres and are rescaled to the new ones.
    const cur = await prisma.dtfRoll.findUnique({ where: { id: String(req.params.id) } });
    if (!cur) return res.status(404).json({ error: 'Roll not found' });
    if (!(cur.carriedInUsedM > 0)) return res.status(400).json({ error: 'The metres left can only be corrected on a roll that was installed part-used' });
    const fullLen = cur.rollLengthM + cur.carriedInUsedM;
    if (metresLeft >= fullLen) return res.status(400).json({ error: `A part-used roll has less than the full ${fullLen} m left` });
    const [sales, jobs] = await Promise.all([prisma.dtfFilmSale.findMany({ where: { rollId: cur.id } }), prisma.dtfArtworkJob.findMany({ where: { rollId: cur.id } })]);
    const used = sales.reduce((a, x) => a + x.metres, 0) + jobs.reduce((a, x) => a + x.runningMetres, 0);
    if (metresLeft < used) return res.status(400).json({ error: `${used} m have already been sold or used on this roll, so fewer than that cannot have been left` });
    const k = metresLeft / cur.rollLengthM;
    data.rollLengthM = metresLeft;
    data.carriedInUsedM = Math.round((fullLen - metresLeft) * 1000) / 1000;
    data.filmCost = Math.round((fields.filmCost ?? cur.filmCost) * k * 100) / 100;
    data.inkPowderCost = Math.round((fields.inkPowderCost ?? cur.inkPowderCost) * k * 100) / 100;
  }
  const roll = await prisma.dtfRoll.update({ where: { id: String(req.params.id) }, data }).catch(() => null);
  if (!roll) return res.status(404).json({ error: 'Roll not found' });
  res.json(roll);
});

dtfRouter.post('/rolls/:id/close', manageOnly, async (req, res) => {
  const roll = await prisma.dtfRoll.findUnique({ where: { id: String(req.params.id) } });
  if (!roll) return res.status(404).json({ error: 'Roll not found' });
  if (roll.status === 'closed') return res.status(400).json({ error: 'Roll is already closed' });
  res.json(await prisma.dtfRoll.update({ where: { id: roll.id }, data: { status: 'closed', finishedOn: todayStr(), closeKind: '', closeNote: '', closedByName: req.user!.name, writtenOffM: 0 } }));
});

// Terminate: the roll is physically finished but the system still shows a balance. Close it at the cut-off date and write the balance off as waste.
const terminateSchema = z.object({ cutOff: dateStr.optional(), note: noteSchema });
dtfRouter.post('/rolls/:id/terminate', manageOnly, async (req, res) => {
  const parsed = terminateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  try {
    const roll = await prisma.$transaction((tx) => terminateRoll(tx, String(req.params.id), parsed.data.cutOff ?? todayStr(), parsed.data.note, req.user!.name));
    res.json(roll);
  } catch (e) {
    if (e instanceof RollError) return res.status(400).json({ error: e.message });
    throw e;
  }
});

dtfRouter.post('/rolls/:id/reopen', manageOnly, async (req, res) => {
  const roll = await prisma.dtfRoll.findUnique({ where: { id: String(req.params.id) } });
  if (!roll) return res.status(404).json({ error: 'Roll not found' });
  if (roll.status === 'open') return res.status(400).json({ error: 'Roll is already open' });
  res.json(await prisma.dtfRoll.update({ where: { id: roll.id }, data: { status: 'open', finishedOn: null, closeKind: '', closeNote: '', closedByName: '', writtenOffM: 0 } }));
});

async function openRoll(rollId: string) {
  const roll = await prisma.dtfRoll.findUnique({ where: { id: rollId } });
  if (!roll) return { error: 'Roll not found' as const };
  if (roll.status !== 'open') return { error: 'That roll is closed — pick an open roll' as const };
  return { roll };
}

// ── Film sales ───────────────────────────────────────────────────────────
const saleSchema = z.object({
  rollId: z.string().min(1),
  soldOn: dateStr.optional(),
  client: z.string().max(200).default(''),
  phone: z.string().max(40).default(''),
  metres: z.number().positive('Metres must be greater than 0'),
  pricePerM: z.number().nullable().optional(), // blank ⇒ standard price
  amountPaid: z.number().min(0).default(0),
  paymentMethod: z.enum(['Cash', 'M-Pesa', 'Bank Transfer', 'Card']).default('Cash'),
  // Preferred: any mix of methods, e.g. part cash and part M-Pesa. Overrides amountPaid/paymentMethod.
  payments: z.array(paymentLineSchema).max(6).optional(),
  materialLines: z.array(materialLineSchema).default([]),
  sourcedBy: z.number().int().nullable().optional(),
  freelanceAgentId: z.number().int().nullable().optional(),
  // The sales person the sale is credited to, when the front office captures it for them (see frontOffice.ts).
  staffId: z.number().int().nullable().optional(),
});

// "Record sale" — the popup's Print button. Builds the DtfFilmSale (roll
// consumption/revenue ledger, unchanged pricing rules) AND the Order it
// prints as a receipt/invoice (line items, any merchandise sold alongside
// the film, the payment taken), linked via DtfFilmSale.orderId, in one
// transaction — either both are created or neither is.
dtfRouter.post('/sales', async (req, res) => {
  const parsed = saleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const found = await openRoll(d.rollId);
  if ('error' in found) return res.status(400).json({ error: found.error });
  const product = productOf(found.roll.product);
  const cap = await resolveCapture(req.user!, d.staffId, d.sourcedBy);
  if (!cap.ok) return res.status(cap.status).json({ error: cap.error });
  const label = await labelFor(cap.staffId);
  const settings = await getSettings(product);
  const { lines: paymentLines, paid } = resolvePaymentLines(d);
  // The floor is enforced here, not just in the form. There is no ceiling: charging more is rewarded (see Sales Commission).
  const c = saleCalc(settings, d.metres, d.pricePerM ?? null, paid);
  if (!c.valid) {
    return res.status(400).json({ error: `Price cannot be below ${settings.minPricePerM} KES/m` });
  }
  const claim = await claimProblem(req.user!, { phone: d.phone, name: d.client, sourcedBy: d.sourcedBy, freelanceAgentId: d.freelanceAgentId });
  if (claim) return res.status(400).json({ error: claim });
  if (paid > c.total) return res.status(400).json({ error: 'Amount paid cannot exceed the sale total' });

  try {
    const { sale, order } = await prisma.$transaction(async (tx) => {
      const service = await dtfService(tx, 'film', product);
      const order = await createDtfOrder(tx, {
        product,
        customerName: d.client.trim() || WALK_IN_CLIENT,
        phone: d.phone.trim(),
        staffId: cap.staffId,
        capturedById: cap.capturedById,
        capturedByName: cap.capturedByName,
        priceList: label,
        serviceLine: { itemType: 'per-metre', serviceId: service.id, qty: d.metres, unitPrice: c.price },
        materialLines: d.materialLines,
        payments: paymentLines,
        sourcedBy: d.sourcedBy,
        freelanceAgentId: d.freelanceAgentId,
        serviceBase: settings.minPricePerM, // film is sold above its floor price, which is enforced above
      });
      const sale = await tx.dtfFilmSale.create({
        data: {
          rollId: d.rollId,
          soldOn: d.soldOn ?? todayStr(),
          client: d.client.trim() || WALK_IN_CLIENT,
          metres: d.metres,
          pricePerM: c.price,
          stdPriceAtSale: settings.stdPricePerM,
          minPriceAtSale: settings.minPricePerM,
          amountPaid: paid,
          capturedByName: req.user!.name,
          orderId: order.id,
        },
      });
      return { sale, order };
    });
    res.status(201).json({ sale, order: serializeDetail(order) });
  } catch (err) {
    res.status(400).json({ error: orderCreationErrorMessage(err, 'Failed to record sale') });
  }
});

// Keeps the linked Order's Payment in sync when a sale's amountPaid
// is topped up here — otherwise "Mark paid" would settle the sale for roll
// revenue purposes while its printed invoice (and Accounts Receivable) kept
// showing it as still owed. Only handles a top-up (the only way this route
// is actually used — the "Mark paid" button always sets amountPaid to the
// full total); a decrease just adjusts the sale's own record, since there's
// no matching "un-pay" for an already-recorded Order Payment.
async function syncOrderPayment(tx: Prisma.TransactionClient, orderId: number | null, topUp: number) {
  if (!orderId || topUp <= 0) return;
  const order = await tx.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) return;
  await tx.payment.create({ data: { orderId, date: todayStr(), amount: topUp, method: 'Cash' } });
  // An invoice stays an invoice once it is paid in full (it is tracked to completion), so the status is left alone.
}

dtfRouter.patch('/sales/:id/paid', manageOnly, async (req, res) => {
  const amountPaid = Number((req.body as { amountPaid?: number }).amountPaid);
  const sale = await prisma.dtfFilmSale.findUnique({ where: { id: Number(req.params.id) } });
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const total = Math.round(sale.metres * sale.pricePerM * 100) / 100;
  if (!Number.isFinite(amountPaid) || amountPaid < 0 || amountPaid > total) {
    return res.status(400).json({ error: `Amount paid must be between 0 and ${total}` });
  }
  const topUp = amountPaid - sale.amountPaid;
  const updated = await prisma.$transaction(async (tx) => {
    await syncOrderPayment(tx, sale.orderId, topUp);
    return tx.dtfFilmSale.update({ where: { id: sale.id }, data: { amountPaid } });
  });
  res.json(updated);
});

dtfRouter.delete('/sales/:id', requireRole('Admin'), async (req, res) => {
  await prisma.dtfFilmSale.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});

// ── Artwork jobs ─────────────────────────────────────────────────────────
// Price per piece = fixedChargePerMetre × runningMetres ÷ pieces — see runningMetreCalc in packages/shared/src/dtf.ts (the empty space on the film is borne by the artworks). One physical film
// print is consumed per piece pressed (a DTF transfer is single-use), so
// there's no way to press the same printed design onto more pieces than
// were actually printed on the film — the client only enters pieces and
// running metres; there's no separate "artworks" or width measurement.
const jobSchema = z.object({
  rollId: z.string().min(1),
  jobOn: dateStr.optional(),
  client: z.string().max(200).default(''),
  phone: z.string().max(40).default(''),
  runningMetres: z.number().positive('Running metres must be greater than 0'),
  pieces: z.number().int().positive('Pieces must be at least 1'),
  // Ksh/piece, staff-picked — see HEAT_PRESS_FEE_OPTIONS. Required: no artwork job is processed without it.
  // Required for DTF (checked below); a UV DTF sticker is applied cold, so it carries none.
  heatPressFee: z.number({ invalid_type_error: 'Choose the heat press fee — a job cannot be processed without it' }).positive('Choose the heat press fee — a job cannot be processed without it').optional(),
  // Price per piece actually charged. Blank = the system-recommended price. Above it, the extra is the staff member's commission base.
  // Below it (but not under the per-piece floor) is a discount: it needs a manager's approval before the job is paid for or produced, and
  // no other discount applies on top of it.
  pricePerPiece: z.number().positive().nullable().optional(),
  sourcedBy: z.number().int().nullable().optional(),
  freelanceAgentId: z.number().int().nullable().optional(),
  // The sales person the job is credited to, when the front office captures it for them (see frontOffice.ts).
  staffId: z.number().int().nullable().optional(),
  amountPaid: z.number().min(0).default(0),
  paymentMethod: z.enum(['Cash', 'M-Pesa', 'Bank Transfer', 'Card']).default('Cash'),
  payments: z.array(paymentLineSchema).max(6).optional(),
  materialLines: z.array(materialLineSchema).default([]),
});

// "Record job" — same Print-time order generation as /sales above, but for
// an artwork job: the per-piece line item optionally carries a heat press
// fee (jobs are print-and-press; a pure film sale never is), and the linked
// service is "DTF Printing" rather than "DTF Sheet (per metre)".
dtfRouter.post('/jobs', async (req, res) => {
  const parsed = jobSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const found = await openRoll(d.rollId);
  if ('error' in found) return res.status(400).json({ error: found.error });
  const product = productOf(found.roll.product);
  if (product === 'dtf' && d.heatPressFee == null) return res.status(400).json({ error: 'Choose the heat press fee — a job cannot be processed without it' });
  const heatPressFee = product === 'uv' ? null : (d.heatPressFee ?? null);
  const cap = await resolveCapture(req.user!, d.staffId, d.sourcedBy);
  if (!cap.ok) return res.status(cap.status).json({ error: cap.error });
  const label = await labelFor(cap.staffId);
  const settings = await getSettings(product);
  const sys = runningMetreCalc(d.runningMetres, d.pieces, settings.fixedChargePerMetre, settings.smallShareBelow, settings.smallSharePrice);
  const smallShare = usesSmallSharePrice(d.runningMetres, d.pieces, settings.fixedChargePerMetre, settings.smallShareBelow, settings.smallSharePrice);
  const lowest = lowestArtworkPrice(settings.minPricePerPiece, sys.finalPerPiece);
  if (d.pricePerPiece != null && d.pricePerPiece < lowest - 0.005) {
    return res.status(400).json({ error: `The price per piece cannot be below the minimum of ${lowest} KES` });
  }
  const chargedPerPiece = d.pricePerPiece != null && Math.abs(d.pricePerPiece - sys.finalPerPiece) > 0.005 ? Math.round(d.pricePerPiece * 100) / 100 : null;
  const needsApproval = chargedPerPiece != null && chargedPerPiece < sys.finalPerPiece - 0.005;
  const c = { ...sys, finalPerPiece: chargedPerPiece ?? sys.finalPerPiece };
  const jobTotal = c.finalPerPiece * d.pieces + (heatPressFee ?? 0) * d.pieces;
  const claim = await claimProblem(req.user!, { phone: d.phone, name: d.client, sourcedBy: d.sourcedBy, freelanceAgentId: d.freelanceAgentId });
  if (claim) return res.status(400).json({ error: claim });
  const { lines: paymentLines, paid } = resolvePaymentLines(d);
  if (paid > jobTotal) return res.status(400).json({ error: 'Amount paid cannot exceed the job total' });
  if (needsApproval && paid > 0) return res.status(400).json({ error: 'A price below the recommended price needs a manager’s approval first — take the payment once it is approved' });

  try {
    const { job, order } = await prisma.$transaction(async (tx) => {
      const service = await dtfService(tx, 'artwork', product);
      const order = await createDtfOrder(tx, {
        product,
        priceList: label,
        customerName: d.client.trim() || WALK_IN_CLIENT,
        phone: d.phone.trim(),
        staffId: cap.staffId,
        capturedById: cap.capturedById,
        capturedByName: cap.capturedByName,
        serviceLine: { itemType: 'service', serviceId: service.id, qty: d.pieces, unitPrice: c.finalPerPiece, heatPressFee },
        materialLines: d.materialLines,
        payments: paymentLines,
        sourcedBy: d.sourcedBy,
        freelanceAgentId: d.freelanceAgentId,
        serviceBase: sys.finalPerPiece, // an artwork job counts only when charged at least the recommended price
      });
      const job = await tx.dtfArtworkJob.create({
        data: {
          rollId: d.rollId,
          jobOn: d.jobOn ?? todayStr(),
          client: d.client.trim() || WALK_IN_CLIENT,
          runningMetres: d.runningMetres,
          pieces: d.pieces,
          fixedChargePerMetreAtJob: chargeToSnapshot(d.runningMetres, sys, settings.fixedChargePerMetre, smallShare), // (when the small-share price applied, the charge that makes the length come to exactly that)
          minPricePerPieceAtJob: 0, // nothing is added per piece: the price is the artwork's share of the running metres
          chargedPerPiece,
          approvalStatus: needsApproval ? 'Pending' : 'Approved',
          capturedByName: req.user!.name,
          orderId: order.id,
        },
      });
      if (needsApproval) {
        await tx.priceApproval.create({
          data: {
            orderId: order.id,
            orderNo: order.orderNo,
            rollId: d.rollId,
            client: d.client.trim() || WALK_IN_CLIENT,
            pieces: d.pieces,
            runningMetres: d.runningMetres,
            systemPerPiece: sys.finalPerPiece,
            chargedPerPiece: chargedPerPiece!,
            shortfall: Math.round((sys.finalPerPiece - chargedPerPiece!) * d.pieces * 100) / 100,
            valueAtRecommended: Math.round(sys.finalPerPiece * d.pieces * 100) / 100,
            valueAtCharged: Math.round(chargedPerPiece! * d.pieces * 100) / 100,
            requestedById: req.user!.id,
            requestedByName: req.user!.name,
          },
        });
        notifyApprovers('artwork', `${order.orderNo} priced below the recommended price`, `${req.user!.name} captured artwork job ${order.orderNo} for ${d.client.trim() || 'a walk-in'} at a price below the recommended one. It cannot be paid for or produced until it is approved.`, { id: req.user!.id });
      }
      return { job, order };
    });
    // The order is re-read so its summary carries the approval flag.
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    res.status(201).json({ job, order: serializeDetail(fresh), approval: needsApproval ? 'Pending' : null });
  } catch (err) {
    res.status(400).json({ error: orderCreationErrorMessage(err, 'Failed to record job') });
  }
});

// ── Artwork sheets: artworks of different sizes (and clients) on one length of film ───────────────────────────
// The sales person enters rows — a size, how many artworks, the price of each — and the rows must add up to at least the recommended total for the whole length (see dtfSheet.ts in shared;
// the cost is shared by number of artworks). Each client's rows become that client's own order, one line per size, with their own payment; the film is taken from the roll once, as the metres
// entered, each order carrying its share by number of artworks. A client may pay less than their share when another pays more. Nothing waits for approval, because the total is never below the
// recommendation; commission is on what the sheet brings in above it (see jobExtras).
const sheetSchema = z.object({
  rollId: z.string().min(1),
  jobOn: dateStr.optional(),
  /** The client for rows that name none. */
  client: z.string().max(200).default(''),
  phone: z.string().max(40).default(''),
  runningMetres: z.number().positive('Running metres must be greater than 0'),
  /** The number of artworks on the length, as entered beside the metres (the base price comes from it): required, and the rows must add up to it exactly. */
  pieces: z.number({ required_error: 'Enter the number of artworks on the length', invalid_type_error: 'Enter the number of artworks on the length' }).int('Enter a whole number of artworks').positive('Enter the number of artworks on the length'),
  heatPressFee: z.number().positive('Choose the heat press fee — a job cannot be processed without it').optional(),
  rows: z
    .array(
      z.object({
        client: z.string().max(200).default(''),
        phone: z.string().max(40).default(''),
        label: z.string().max(80).default(''),
        qty: z.number().int('Enter a whole number of artworks').positive('Enter how many artworks'),
        price: z.number().positive('Enter the price of an artwork'),
      }),
    )
    .min(1, 'Add at least one row of artworks')
    .max(60),
  /** What each client pays now, by the key of the client in the sheet's calculation. */
  clientPayments: z.array(z.object({ key: z.string(), payments: z.array(paymentLineSchema).max(6) })).default([]),
  sourcedBy: z.number().int().nullable().optional(),
  staffId: z.number().int().nullable().optional(),
});

dtfRouter.post('/sheets', async (req, res) => {
  const parsed = sheetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const found = await openRoll(d.rollId);
  if ('error' in found) return res.status(400).json({ error: found.error });
  const product = productOf(found.roll.product);
  if (product === 'dtf' && d.heatPressFee == null) return res.status(400).json({ error: 'Choose the heat press fee — a job cannot be processed without it' });
  const heatPressFee = product === 'uv' ? null : (d.heatPressFee ?? null);
  const cap = await resolveCapture(req.user!, d.staffId, d.sourcedBy);
  if (!cap.ok) return res.status(cap.status).json({ error: cap.error });
  const label = await labelFor(cap.staffId);
  const settings = await getSettings(product);
  const calc = sheetCalc(d.rows, d.runningMetres, settings.fixedChargePerMetre, settings.minPricePerPiece, d.client, d.phone, d.pieces, settings.smallSharePrice, settings.smallShareBelow);
  const sheetSmallShare = calc.pieces > 0 && d.runningMetres > 0 && usesSmallSharePrice(d.runningMetres, d.pieces ?? calc.pieces, settings.fixedChargePerMetre, settings.smallShareBelow, settings.smallSharePrice);
  if (!calc.ok) return res.status(400).json({ error: calc.problems[0] ?? 'The sheet cannot be priced' });
  for (const c of calc.clients) {
    const claim = await claimProblem(req.user!, { phone: c.phone, name: c.client, sourcedBy: d.sourcedBy });
    if (claim) return res.status(400).json({ error: claim });
  }
  // what each client pays now, and no more than their order comes to
  const payFor = new Map(d.clientPayments.map((p) => [p.key, p.payments]));
  for (const c of calc.clients) {
    const paid = (payFor.get(c.key) ?? []).reduce((a, p) => a + p.amount, 0);
    const total = round2(c.amount + (heatPressFee ?? 0) * c.pieces);
    if (paid > total + 0.005) return res.status(400).json({ error: `${c.client || 'Walk-in'}: the amount paid cannot exceed their order total of ${total}` });
  }
  const sheetId = randomUUID();
  try {
    const made = await prisma.$transaction(async (tx) => {
      const service = await dtfService(tx, 'artwork', product);
      const out: { order: Awaited<ReturnType<typeof createDtfOrder>>; key: string }[] = [];
      for (const c of calc.clients) {
        const lines = c.rows.map((r) => ({ qty: r.qty, unitPrice: r.price, description: r.label.trim(), heatPressFee }));
        const [first, ...rest] = lines;
        const order = await createDtfOrder(tx, {
          product,
          priceList: label,
          customerName: c.client.trim() || WALK_IN_CLIENT,
          phone: c.phone.trim(),
          staffId: cap.staffId,
          capturedById: cap.capturedById,
          capturedByName: cap.capturedByName,
          serviceLine: { itemType: 'service', serviceId: service.id, ...first! },
          moreServiceLines: rest,
          materialLines: [],
          payments: payFor.get(c.key) ?? [],
          sourcedBy: d.sourcedBy,
          freelanceAgentId: null,
          serviceBase: calc.recommendedPerPiece, // the recommended price of every artwork on the sheet is the same
        });
        const avg = round2(c.amount / c.pieces);
        await tx.dtfArtworkJob.create({
          data: {
            rollId: d.rollId,
            jobOn: d.jobOn ?? todayStr(),
            client: c.client.trim() || WALK_IN_CLIENT,
            runningMetres: c.metres,
            pieces: c.pieces,
            fixedChargePerMetreAtJob: chargeToSnapshot(d.runningMetres, { finalPerPiece: calc.recommendedPerPiece, jobTotal: calc.recommendedTotal }, settings.fixedChargePerMetre, sheetSmallShare),
            minPricePerPieceAtJob: 0, // nothing is added per piece: the price is the artwork's share of the running metres
            chargedPerPiece: Math.abs(avg - calc.recommendedPerPiece) > 0.005 ? avg : null,
            chargedTotal: c.amount,
            sheetId,
            approvalStatus: 'Approved',
            capturedByName: req.user!.name,
            orderId: order.id,
          },
        });
        out.push({ order, key: c.key });
      }
      return out;
    });
    res.status(201).json({
      sheetId,
      recommendedTotal: calc.recommendedTotal,
      enteredTotal: calc.enteredTotal,
      surplus: calc.surplus,
      orders: made.map((m) => serializeDetail(m.order)),
    });
  } catch (err) {
    res.status(400).json({ error: orderCreationErrorMessage(err, 'Failed to record the sheet') });
  }
});

// ── Artwork prints: the artworks arranged on a length of film, measured and priced by the sales person ──────────────────
// The sales person enters the length of film used (the only film figure tracked) and the rows — client, an optional description, how many, the price of ONE artwork (the print only), and for DTF the heat press and the garment. There is no recommended
// price: those prices are the prices (see pricedBySales on the job: nothing to earn above, nothing to approve). Each client's rows become that client's own order, one line a size, with their own
// payment; the film comes off the roll once, as the length entered, each order carrying its share by its number of artworks.
const printSchema = z.object({
  rollId: z.string().min(1),
  jobOn: dateStr.optional(),
  /** The client for rows that name none. */
  client: z.string().max(200).default(''),
  phone: z.string().max(40).default(''),
  runningMetres: z.number().positive('Enter the length of film used (m)'),
  rows: z
    .array(
      z.object({
        client: z.string().max(200).default(''),
        phone: z.string().max(40).default(''),
        /** What the artworks are ("left chest"): optional, for the order line. */
        label: z.string().trim().max(80).default(''),
        qty: z.number().int('Enter a whole number of artworks').positive('Enter how many artworks'),
        /** Ksh for ONE artwork: the print only. */
        price: z.number().positive('Enter the price of one artwork'),
        /** DTF: the heat press, Ksh for ONE artwork (every artwork is pressed); UV DTF is applied cold, so none. */
        press: z.number().min(0).default(0),
        /** DTF: the stock item the artworks are pressed on when WE supply it (one for each artwork); blank = the client brought their own. Its price is the stock price list's, never the screen's. */
        garmentMaterialId: z.number().int().positive().nullable().optional(),
      }),
    )
    .min(1, 'Add at least one row of artworks')
    .max(80),
  clientPayments: z.array(z.object({ key: z.string(), payments: z.array(paymentLineSchema).max(6) })).default([]),
  sourcedBy: z.number().int().nullable().optional(),
  staffId: z.number().int().nullable().optional(),
});

dtfRouter.post('/prints', async (req, res) => {
  const parsed = printSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const found = await openRoll(d.rollId);
  if ('error' in found) return res.status(400).json({ error: found.error });
  const product = productOf(found.roll.product);
  const cap = await resolveCapture(req.user!, d.staffId, d.sourcedBy);
  if (!cap.ok) return res.status(cap.status).json({ error: cap.error });
  const label = await labelFor(cap.staffId);
  const settings = await getSettings(product);
  const withPress = product === 'dtf'; // UV DTF stickers are applied cold: no heat press, no garment
  const garmentIds = [...new Set(d.rows.map((r) => r.garmentMaterialId).filter((x): x is number => !!x))];
  const garments = garmentIds.length ? await prisma.material.findMany({ where: { id: { in: garmentIds } } }) : [];
  if (garments.length !== garmentIds.length) return res.status(400).json({ error: 'A stock item you chose is no longer on the stock price list' });
  const garmentOf = new Map(garments.map((g) => [g.id, g]));
  const priced = d.rows.map((r) => ({ client: r.client, phone: r.phone, label: r.label, qty: r.qty, price: r.price, press: withPress ? r.press : 0, garmentId: r.garmentMaterialId ?? null, garmentPrice: r.garmentMaterialId ? (garmentOf.get(r.garmentMaterialId)?.price ?? 0) : 0 }));
  const calc = artworkListCalc(priced, d.runningMetres, d.client, d.phone, withPress);
  if (!calc.ok) return res.status(400).json({ error: calc.problems[0] ?? 'The print cannot be recorded' });
  for (const c of calc.clients) {
    const claim = await claimProblem(req.user!, { phone: c.phone, name: c.client, sourcedBy: d.sourcedBy });
    if (claim) return res.status(400).json({ error: claim });
  }
  const payFor = new Map(d.clientPayments.map((p) => [p.key, p.payments]));
  for (const c of calc.clients) {
    const paid = (payFor.get(c.key) ?? []).reduce((a, p) => a + p.amount, 0);
    if (paid > c.amount + 0.005) return res.status(400).json({ error: `${c.client || 'Walk-in'}: the amount paid cannot exceed their order total of ${c.amount}` });
  }
  const sheetId = randomUUID();
  try {
    const made = await prisma.$transaction(async (tx) => {
      const service = await dtfService(tx, 'artwork', product);
      const pressService = withPress ? await dtfService(tx, 'press', product) : null;
      const out: Awaited<ReturnType<typeof createDtfOrder>>[] = [];
      for (const c of calc.clients) {
        // each row in turn: the artwork (the print), the heat press, and the garment when WE supply it — so the print and the press are separate lines with their own prices
        const ordered: NonNullable<Parameters<typeof createDtfOrder>[1]['orderedLines']> = [];
        for (const r of c.rows) {
          const what = r.label.trim();
          ordered.push({ itemType: 'service', serviceId: service.id, qty: r.qty, unitPrice: r.price, description: what });
          if (pressService) {
            const g = r.garmentId ? garmentOf.get(r.garmentId) : null;
            ordered.push({ itemType: 'service', serviceId: pressService.id, qty: r.qty, unitPrice: r.press, description: [what, g ? `on our ${g.name}` : 'on the client’s own garment'].filter(Boolean).join(' ') });
            if (g) ordered.push({ itemType: 'material', materialId: g.id, qty: r.qty, unitPrice: r.garmentPrice, description: what });
          }
        }
        const lines = c.rows.map((r) => ({ qty: r.qty, unitPrice: r.price, description: r.label.trim(), heatPressFee: null }));
        const [first, ...rest] = lines;
        const order = await createDtfOrder(tx, {
          product,
          priceList: label,
          customerName: c.client.trim() || WALK_IN_CLIENT,
          phone: c.phone.trim(),
          staffId: cap.staffId,
          capturedById: cap.capturedById,
          capturedByName: cap.capturedByName,
          serviceLine: { itemType: 'service', serviceId: service.id, ...first! },
          moreServiceLines: rest,
          materialLines: [],
          orderedLines: ordered,
          payments: payFor.get(c.key) ?? [],
          sourcedBy: d.sourcedBy,
          freelanceAgentId: null,
          serviceBase: first!.unitPrice, // sold at the price the sales person set: nothing above it to earn a premium on
        });
        await tx.dtfArtworkJob.create({
          data: {
            rollId: d.rollId,
            jobOn: d.jobOn ?? todayStr(),
            client: c.client.trim() || WALK_IN_CLIENT,
            runningMetres: c.metres,
            pieces: c.pieces,
            fixedChargePerMetreAtJob: 0, // no recommended price: the price is what the sales person charged
            minPricePerPieceAtJob: 0,
            chargedPerPiece: null,
            chargedTotal: c.artworkAmount, // the film's own revenue is the artworks (the print) only: the heat press and any garment are other lines of the order
            pricedBySales: true,
            sheetId,
            approvalStatus: 'Approved',
            capturedByName: req.user!.name,
            orderId: order.id,
          },
        });
        out.push(order);
      }
      return out;
    });
    res.status(201).json({
      sheetId,
      enteredTotal: calc.enteredTotal,
      film: { metres: calc.metres },
      orders: made.map((m) => serializeDetail(m)),
    });
  } catch (err) {
    res.status(400).json({ error: orderCreationErrorMessage(err, 'Failed to record the print') });
  }
});

// A day at a time. For each date: the number of artwork jobs (or film sales), what was printed or sold, the average prices, and the money —
// total, paid and balance, taken from the orders those jobs generated (so a payment taken later through the order counts). Each day lists the
// individual orders behind it. Jobs waiting for a price approval are listed but kept out of the day's figures until they are approved.
const orderMoney = (o: { lineItems: { itemType: string; serviceId: number | null; materialId: number | null; qty: number; unitPrice: number; discountPct: number; discountAmt: number; heatPressFee: number | null }[]; orderDiscountPct: number; orderDiscountAmt: number; payments: { date: string; amount: number; method: string }[] }) => {
  const t = computeOrderTotals(
    { lineItems: o.lineItems.map((li) => ({ itemType: li.itemType as LineItemInput['itemType'], serviceId: li.serviceId, materialId: li.materialId, qty: li.qty, unitPrice: li.unitPrice, discountPct: li.discountPct, discountAmt: li.discountAmt, heatPressFee: li.heatPressFee })), orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt },
    o.payments.map((p) => ({ date: p.date, amount: p.amount, method: p.method as PaymentMethod })),
  );
  return { total: round2(t.grandTotal), paid: round2(t.paidTotal), balance: round2(t.balanceDue) };
};
const orderForDaily = { include: { lineItems: true, payments: true } } as const;

dtfRouter.get('/daily', manageOnly, async (req, res) => {
  const product = productOf(req.query.product);
  const kind = req.query.kind === 'sales' ? 'sales' : 'jobs';
  const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
  const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
  const dateRange = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

  if (kind === 'sales') {
    const sales = await prisma.dtfFilmSale.findMany({ where: { roll: { product }, ...(dateRange ? { soldOn: dateRange } : {}) }, include: { order: orderForDaily }, orderBy: [{ soldOn: 'desc' }, { id: 'desc' }] });
    const byDay = new Map<string, typeof sales>();
    for (const s of sales) byDay.set(s.soldOn, [...(byDay.get(s.soldOn) ?? []), s]);
    const days = [...byDay.entries()].map(([date, list]) => {
      const orders = list.map((s) => {
        const money = s.order ? orderMoney(s.order) : { total: round2(s.metres * s.pricePerM), paid: round2(s.amountPaid), balance: round2(s.metres * s.pricePerM - s.amountPaid) };
        return { saleId: s.id, orderId: s.orderId, orderNo: s.order?.orderNo ?? null, client: s.client || WALK_IN_CLIENT, rollId: s.rollId, metres: s.metres, pricePerM: s.pricePerM, stdPricePerM: s.stdPriceAtSale, capturedByName: s.capturedByName, ...money };
      });
      const metres = round2(list.reduce((a, s) => a + s.metres, 0));
      return {
        date,
        count: list.length,
        metres,
        avgPricePerM: metres > 0 ? round2(list.reduce((a, s) => a + s.metres * s.pricePerM, 0) / metres) : null,
        total: round2(orders.reduce((a, o) => a + o.total, 0)),
        paid: round2(orders.reduce((a, o) => a + o.paid, 0)),
        balance: round2(orders.reduce((a, o) => a + o.balance, 0)),
        orders,
      };
    });
    return res.json({ kind, days });
  }

  const jobs = await prisma.dtfArtworkJob.findMany({ where: { roll: { product }, ...(dateRange ? { jobOn: dateRange } : {}) }, include: { order: orderForDaily }, orderBy: [{ jobOn: 'desc' }, { id: 'desc' }] });
  const byDay = new Map<string, typeof jobs>();
  for (const j of jobs) byDay.set(j.jobOn, [...(byDay.get(j.jobOn) ?? []), j]);
  const days = [...byDay.entries()].map(([date, list]) => {
    const orders = list.map((j) => {
      const calc = { id: '', rollId: j.rollId, jobOn: j.jobOn, client: j.client, runningMetres: j.runningMetres, pieces: j.pieces, fixedChargePerMetreAtJob: j.fixedChargePerMetreAtJob, minPricePerPieceAtJob: j.minPricePerPieceAtJob, chargedPerPiece: j.chargedPerPiece, chargedTotal: j.chargedTotal, pricedBySales: j.pricedBySales };
      const recommended = j.pricedBySales ? jobTotals(calc).finalPerPiece : jobCalc(j.runningMetres, j.pieces, j.fixedChargePerMetreAtJob, j.minPricePerPieceAtJob).finalPerPiece;
      const final = jobTotals(calc).finalPerPiece;
      const money = j.order ? orderMoney(j.order) : { total: round2(final * j.pieces), paid: 0, balance: round2(final * j.pieces) };
      return { jobId: j.id, orderId: j.orderId, orderNo: j.order?.orderNo ?? null, client: j.client || WALK_IN_CLIENT, rollId: j.rollId, pieces: j.pieces, runningMetres: j.runningMetres, recommendedPerPiece: recommended, finalPerPiece: final, approval: j.approvalStatus, capturedByName: j.capturedByName, ...money };
    });
    const counted = orders.filter((o) => o.approval !== 'Pending');
    const pieces = counted.reduce((a, o) => a + o.pieces, 0);
    const total = round2(counted.reduce((a, o) => a + o.total, 0));
    return {
      date,
      count: counted.length,
      pendingApproval: orders.length - counted.length,
      pieces,
      metres: round2(counted.reduce((a, o) => a + o.runningMetres, 0)),
      avgPricePerJob: counted.length ? round2(total / counted.length) : null,
      avgRecommendedPerPiece: pieces > 0 ? round2(counted.reduce((a, o) => a + o.recommendedPerPiece * o.pieces, 0) / pieces) : null,
      avgFinalPerPiece: pieces > 0 ? round2(counted.reduce((a, o) => a + o.finalPerPiece * o.pieces, 0) / pieces) : null,
      total,
      paid: round2(counted.reduce((a, o) => a + o.paid, 0)),
      balance: round2(counted.reduce((a, o) => a + o.balance, 0)),
      orders,
    };
  });
  res.json({ kind, days });
});

// ── Price approvals — a job priced below the recommended price is held until a DTF manager decides ──
const approvalOut = (r: Awaited<ReturnType<typeof prisma.priceApproval.findMany>>[number]) => ({ ...r, requestedAt: r.requestedAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null, pctBelow: r.systemPerPiece > 0 ? Math.round(((r.systemPerPiece - r.chargedPerPiece) / r.systemPerPiece) * 1000) / 10 : 0 });
const approvalScope = async (product: DtfProduct) => {
  const uvIds = await uvRollIds();
  return product === 'uv' ? { rollId: { in: uvIds } } : { NOT: { rollId: { in: uvIds } } };
};
dtfRouter.get('/approvals', manageOnly, async (req, res) => {
  const scope = await approvalScope(productOf(req.query.product));
  // everything still waiting (never cut off), then the latest decided ones; the full record of approved prices is the report below
  const pending = await prisma.priceApproval.findMany({ where: { ...scope, status: 'Pending' }, orderBy: { id: 'desc' } });
  const decided = await prisma.priceApproval.findMany({ where: { ...scope, NOT: { status: 'Pending' } }, orderBy: { id: 'desc' }, take: 100 });
  res.json([...decided, ...pending].map(approvalOut));
});

// The report of every approved price change: when it was asked for, the price the system suggested (the recommended price), the price that was approved, and who asked and approved. Optional
// from / to (dates, on the day it was requested). Newest first; nothing is cut off.
dtfRouter.get('/approvals/report', manageOnly, async (req, res) => {
  const scope = await approvalScope(productOf(req.query.product));
  const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? new Date(`${req.query.from}T00:00:00`) : null;
  const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? new Date(`${req.query.to}T23:59:59.999`) : null;
  const rows = await prisma.priceApproval.findMany({
    where: { ...scope, status: 'Approved', ...(from || to ? { requestedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
  });
  const out = rows.map(approvalOut);
  res.json({ rows: out, count: out.length, totalDiscount: round2(out.reduce((a, r) => a + r.shortfall, 0)) });
});

// Approving releases the job: it can now be paid for and produced, and its revenue counts on the roll. Whoever captured it cannot approve it.
dtfRouter.post('/approvals/:id/approve', manageOnly, async (req, res) => {
  const a = await prisma.priceApproval.findUnique({ where: { id: Number(req.params.id) } });
  if (!a) return res.status(404).json({ error: 'Approval request not found' });
  if (a.status !== 'Pending') return res.status(400).json({ error: `This request has already been ${a.status.toLowerCase()}` });
  if (a.requestedById === req.user!.id) return res.status(400).json({ error: 'You cannot approve a price you captured yourself' });
  await prisma.$transaction(async (tx) => {
    if (a.orderId) {
      await tx.dtfArtworkJob.updateMany({ where: { orderId: a.orderId }, data: { approvalStatus: 'Approved' } });
      await tx.embroideryJob.updateMany({ where: { orderId: a.orderId }, data: { approvalStatus: 'Approved' } });
    }
    await tx.priceApproval.update({ where: { id: a.id }, data: { status: 'Approved', decidedByName: req.user!.name, decidedAt: new Date() } });
  });
  res.json({ ok: true });
});

// Rejecting removes the order and the job (nothing was paid or produced, and the film metres go back on the roll); the request stays as the record.
dtfRouter.post('/approvals/:id/reject', manageOnly, async (req, res) => {
  const parsed = z.object({ reason: z.string().trim().min(1, 'Give a reason for rejecting this price').max(300) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const a = await prisma.priceApproval.findUnique({ where: { id: Number(req.params.id) } });
  if (!a) return res.status(404).json({ error: 'Approval request not found' });
  if (a.status !== 'Pending') return res.status(400).json({ error: `This request has already been ${a.status.toLowerCase()}` });
  if (a.requestedById === req.user!.id) return res.status(400).json({ error: 'You cannot reject a price you captured yourself' });
  await prisma.$transaction(async (tx) => {
    if (a.orderId) {
      await returnOrderStock(tx, a.orderId);
      await tx.dtfArtworkJob.deleteMany({ where: { orderId: a.orderId } });
      await tx.embroideryJob.deleteMany({ where: { orderId: a.orderId } });
      await tx.orderLineItem.deleteMany({ where: { orderId: a.orderId } });
      await tx.payment.deleteMany({ where: { orderId: a.orderId } });
      await tx.order.delete({ where: { id: a.orderId } });
    }
    await tx.priceApproval.update({ where: { id: a.id }, data: { status: 'Rejected', orderId: null, reason: parsed.data.reason, decidedByName: req.user!.name, decidedAt: new Date() } });
  });
  res.json({ ok: true });
});

dtfRouter.delete('/jobs/:id', requireRole('Admin'), async (req, res) => {
  await prisma.dtfArtworkJob.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});
