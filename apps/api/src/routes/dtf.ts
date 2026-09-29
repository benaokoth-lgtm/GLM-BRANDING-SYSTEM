import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { computeOrderTotals, jobCalc, nextRollId, saleCalc, todayStr } from '@glm/shared';
import type { LineItemInput, PaymentMethod } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { permissionsForRole } from '../permissions';
import { orderInclude, resolveWalkinStatus, serializeDetail } from './orders';

// DTF Sales & Roll Tracker. Two access levels (see Role model):
//   canAccessDtf — record film sales / artwork jobs (roll costs are never sent)
//   canManageDtf — roll costs, Setup, closing rolls, profit & wastage
// Deleting a sale or job is Admin-only, same as other destructive actions here.
export const dtfRouter = Router();
dtfRouter.use(requireAuth, requirePermission('canAccessDtf', 'canManageDtf'));

const manageOnly = requirePermission('canManageDtf');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

async function getSettings() {
  return prisma.dtfSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
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
    staffId: number;
    serviceLine: { itemType: string; serviceId: number; qty: number; unitPrice: number; heatPressFee?: number | null };
    materialLines: { materialId: number; qty: number; unitPrice?: number }[];
    amountPaid: number;
    paymentMethod: PaymentMethod;
  },
) {
  const materialItems = await materialLineItems(tx, opts.materialLines);
  const lineItemInputs: LineItemInput[] = [
    { itemType: opts.serviceLine.itemType as LineItemInput['itemType'], serviceId: opts.serviceLine.serviceId, materialId: null, qty: opts.serviceLine.qty, unitPrice: opts.serviceLine.unitPrice, discountPct: 0, discountAmt: 0, heatPressFee: opts.serviceLine.heatPressFee ?? null },
    ...materialItems.map((li) => ({ itemType: li.itemType as LineItemInput['itemType'], serviceId: null, materialId: li.materialId, qty: li.qty, unitPrice: li.unitPrice, discountPct: 0, discountAmt: 0 })),
  ];
  const totals = computeOrderTotals(
    { lineItems: lineItemInputs, orderDiscountPct: 0, orderDiscountAmt: 0 },
    opts.amountPaid > 0 ? [{ date: todayStr(), amount: opts.amountPaid, method: opts.paymentMethod }] : [],
  );
  const { status, dueDate } = resolveWalkinStatus(totals.balanceDue);

  const settings = await tx.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  const orderNo = 'F-' + settings.nextDtfNo;
  await tx.setting.update({ where: { id: 1 }, data: { nextDtfNo: settings.nextDtfNo + 1 } });

  const order = await tx.order.create({
    data: {
      orderNo,
      kind: 'walkin',
      channel: 'dtf',
      customerName: opts.customerName || null,
      phone: opts.phone || null,
      staffId: opts.staffId,
      createdDate: todayStr(),
      status,
      dueDate,
      stage: 'Order Received',
      lineItems: {
        create: [
          { itemType: opts.serviceLine.itemType, serviceId: opts.serviceLine.serviceId, qty: opts.serviceLine.qty, unitPrice: opts.serviceLine.unitPrice, heatPressFee: opts.serviceLine.heatPressFee ?? null },
          ...materialItems,
        ],
      },
      payments: opts.amountPaid > 0 ? { create: [{ date: todayStr(), amount: opts.amountPaid, method: opts.paymentMethod, staffId: opts.staffId }] } : undefined,
    },
    include: orderInclude,
  });

  return order;
}

// The full data set the tracker's calculations run on. Users without
// canManageDtf only get open rolls with their costs zeroed out — profit is
// derivable from roll cost, so cost never leaves the server for them.
dtfRouter.get('/data', async (req, res) => {
  const perms = await permissionsForRole(req.user!.role);
  const canManage = perms.canManageDtf;
  const [settings, rolls, sales, jobs] = await Promise.all([
    getSettings(),
    prisma.dtfRoll.findMany({ where: canManage ? {} : { status: 'open' }, orderBy: { id: 'asc' } }),
    prisma.dtfFilmSale.findMany({ orderBy: [{ soldOn: 'desc' }, { id: 'desc' }] }),
    prisma.dtfArtworkJob.findMany({ orderBy: [{ jobOn: 'desc' }, { id: 'desc' }] }),
  ]);
  res.json({
    canManage,
    settings: {
      rollLengthM: settings.rollLengthM,
      rollWidthCm: settings.rollWidthCm,
      stdPricePerM: settings.stdPricePerM,
      minPricePerM: settings.minPricePerM,
      defaultMultiplier: settings.defaultMultiplier,
      wastageTolerancePct: settings.wastageTolerancePct,
    },
    rolls: rolls.map((r) => ({
      id: r.id,
      installedOn: r.installedOn,
      finishedOn: r.finishedOn,
      status: r.status,
      filmCost: canManage ? r.filmCost : 0,
      inkPowderCost: canManage ? r.inkPowderCost : 0,
      rollLengthM: r.rollLengthM,
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
      artworks: j.artworks,
      pieces: j.pieces,
      multiplier: j.multiplier,
      stdPriceAtJob: j.stdPriceAtJob,
      discountPerPiece: j.discountPerPiece,
    })),
  });
});

// ── Setup ────────────────────────────────────────────────────────────────
const settingsSchema = z
  .object({
    rollLengthM: z.number().positive(),
    rollWidthCm: z.number().positive(),
    stdPricePerM: z.number().positive(),
    minPricePerM: z.number().positive(),
    defaultMultiplier: z.number().positive(),
    wastageTolerancePct: z.number().min(0).max(100),
  })
  .refine((s) => s.minPricePerM <= s.stdPricePerM, { message: 'Minimum price cannot be above the standard price' });

dtfRouter.put('/settings', manageOnly, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  await getSettings();
  await prisma.dtfSetting.update({ where: { id: 1 }, data: parsed.data });
  res.json(parsed.data);
});

// ── Rolls ────────────────────────────────────────────────────────────────
const rollSchema = z.object({
  installedOn: dateStr.optional(),
  filmCost: z.number().min(0).default(0),
  inkPowderCost: z.number().min(0).default(0),
});

dtfRouter.post('/rolls', manageOnly, async (req, res) => {
  const parsed = rollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const settings = await getSettings();
  const existing = await prisma.dtfRoll.findMany({ select: { id: true } });
  const roll = await prisma.dtfRoll
    .create({
      data: {
        id: nextRollId(existing),
        installedOn: parsed.data.installedOn ?? todayStr(),
        filmCost: parsed.data.filmCost,
        inkPowderCost: parsed.data.inkPowderCost,
        rollLengthM: settings.rollLengthM,
        createdByName: req.user!.name,
      },
    })
    .catch(() => null);
  if (!roll) return res.status(409).json({ error: 'Another roll was just installed — try again' });
  res.status(201).json(roll);
});

const rollUpdateSchema = z
  .object({ installedOn: dateStr, filmCost: z.number().min(0), inkPowderCost: z.number().min(0) })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' });

dtfRouter.put('/rolls/:id', manageOnly, async (req, res) => {
  const parsed = rollUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const roll = await prisma.dtfRoll.update({ where: { id: String(req.params.id) }, data: parsed.data }).catch(() => null);
  if (!roll) return res.status(404).json({ error: 'Roll not found' });
  res.json(roll);
});

dtfRouter.post('/rolls/:id/close', manageOnly, async (req, res) => {
  const roll = await prisma.dtfRoll.findUnique({ where: { id: String(req.params.id) } });
  if (!roll) return res.status(404).json({ error: 'Roll not found' });
  if (roll.status === 'closed') return res.status(400).json({ error: 'Roll is already closed' });
  res.json(await prisma.dtfRoll.update({ where: { id: roll.id }, data: { status: 'closed', finishedOn: todayStr() } }));
});

dtfRouter.post('/rolls/:id/reopen', manageOnly, async (req, res) => {
  const roll = await prisma.dtfRoll.findUnique({ where: { id: String(req.params.id) } });
  if (!roll) return res.status(404).json({ error: 'Roll not found' });
  if (roll.status === 'open') return res.status(400).json({ error: 'Roll is already open' });
  res.json(await prisma.dtfRoll.update({ where: { id: roll.id }, data: { status: 'open', finishedOn: null } }));
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
  materialLines: z.array(materialLineSchema).default([]),
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
  const settings = await getSettings();
  // The price band is enforced here, not just in the form.
  const c = saleCalc(settings, d.metres, d.pricePerM ?? null, d.amountPaid);
  if (!c.valid) {
    return res.status(400).json({ error: `Price must be between ${settings.minPricePerM} and ${settings.stdPricePerM} KES/m` });
  }
  if (d.amountPaid > c.total) return res.status(400).json({ error: 'Amount paid cannot exceed the sale total' });

  try {
    const { sale, order } = await prisma.$transaction(async (tx) => {
      const service = await tx.service.findFirst({ where: { name: 'DTF Sheet (per metre)' } });
      if (!service) throw new Error('The "DTF Sheet (per metre)" service is missing from Master Data — cannot generate an order for this sale.');
      const order = await createDtfOrder(tx, {
        customerName: d.client.trim(),
        phone: d.phone.trim(),
        staffId: req.user!.id,
        serviceLine: { itemType: 'per-metre', serviceId: service.id, qty: d.metres, unitPrice: c.price },
        materialLines: d.materialLines,
        amountPaid: d.amountPaid,
        paymentMethod: d.paymentMethod,
      });
      const sale = await tx.dtfFilmSale.create({
        data: {
          rollId: d.rollId,
          soldOn: d.soldOn ?? todayStr(),
          client: d.client.trim(),
          metres: d.metres,
          pricePerM: c.price,
          stdPriceAtSale: settings.stdPricePerM,
          minPriceAtSale: settings.minPricePerM,
          amountPaid: d.amountPaid,
          capturedByName: req.user!.name,
          orderId: order.id,
        },
      });
      return { sale, order };
    });
    res.status(201).json({ sale, order: serializeDetail(order) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to record sale' });
  }
});

// Keeps the linked Order's Payment/status in sync when a sale's amountPaid
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
  const lineItems: LineItemInput[] = order.lineItems.map((li) => ({
    itemType: li.itemType as LineItemInput['itemType'],
    serviceId: li.serviceId,
    materialId: li.materialId,
    qty: li.qty,
    unitPrice: li.unitPrice,
    discountPct: li.discountPct,
    discountAmt: li.discountAmt,
    heatPressFee: li.heatPressFee,
  }));
  const payments = [...order.payments.map((p) => ({ date: p.date, amount: p.amount, method: p.method as PaymentMethod })), { date: todayStr(), amount: topUp, method: 'Cash' as PaymentMethod }];
  const totals = computeOrderTotals({ lineItems, orderDiscountPct: order.orderDiscountPct, orderDiscountAmt: order.orderDiscountAmt }, payments);
  if (totals.balanceDue <= 0 && order.status === 'Invoice') {
    await tx.order.update({ where: { id: orderId }, data: { status: 'Order', dueDate: null } });
  }
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
const jobSchema = z.object({
  rollId: z.string().min(1),
  jobOn: dateStr.optional(),
  client: z.string().max(200).default(''),
  phone: z.string().max(40).default(''),
  runningMetres: z.number().positive('Running metres must be greater than 0'),
  artworks: z.number().int().positive('Number of artworks must be at least 1'),
  pieces: z.number().int().positive('Pieces must be at least 1'),
  multiplier: z.number().positive().nullable().optional(), // blank ⇒ default multiplier
  discountPerPiece: z.number().default(0), // negative ⇒ price above the proposal
  heatPressFee: z.number().positive().nullable().optional(), // Ksh/piece, staff-picked — see HEAT_PRESS_FEE_OPTIONS
  amountPaid: z.number().min(0).default(0),
  paymentMethod: z.enum(['Cash', 'M-Pesa', 'Bank Transfer', 'Card']).default('Cash'),
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
  const settings = await getSettings();
  const c = jobCalc(settings, d.runningMetres, d.artworks, d.pieces, d.multiplier ?? null, d.discountPerPiece);
  const jobTotal = c.finalPerPiece * d.pieces + (d.heatPressFee ?? 0) * d.pieces;
  if (d.amountPaid > jobTotal) return res.status(400).json({ error: 'Amount paid cannot exceed the job total' });

  try {
    const { job, order } = await prisma.$transaction(async (tx) => {
      const service = await tx.service.findFirst({ where: { name: 'DTF Printing' } });
      if (!service) throw new Error('The "DTF Printing" service is missing from Master Data — cannot generate an order for this job.');
      const order = await createDtfOrder(tx, {
        customerName: d.client.trim(),
        phone: d.phone.trim(),
        staffId: req.user!.id,
        serviceLine: { itemType: 'service', serviceId: service.id, qty: d.pieces, unitPrice: c.finalPerPiece, heatPressFee: d.heatPressFee ?? null },
        materialLines: d.materialLines,
        amountPaid: d.amountPaid,
        paymentMethod: d.paymentMethod,
      });
      const job = await tx.dtfArtworkJob.create({
        data: {
          rollId: d.rollId,
          jobOn: d.jobOn ?? todayStr(),
          client: d.client.trim(),
          runningMetres: d.runningMetres,
          artworks: d.artworks,
          pieces: d.pieces,
          multiplier: c.multiplier,
          stdPriceAtJob: settings.stdPricePerM,
          discountPerPiece: d.discountPerPiece,
          capturedByName: req.user!.name,
          orderId: order.id,
        },
      });
      return { job, order };
    });
    res.status(201).json({ job, order: serializeDetail(order) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to record job' });
  }
});

dtfRouter.delete('/jobs/:id', requireRole('Admin'), async (req, res) => {
  await prisma.dtfArtworkJob.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});
