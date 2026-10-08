import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { computeOrderTotals, jobCalc, jobTotals, nextRollId, round2, saleCalc, todayStr } from '@glm/shared';
import type { LineItemInput, PaymentMethod } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { permissionsForRole } from '../permissions';
import { claimProblem, resolveSourcing } from '../commission';
import { resolveCapture } from '../frontOffice';
import { WALK_IN_CLIENT } from '@glm/shared';
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

async function getSettings() {
  return prisma.dtfSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
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
    serviceLine: { itemType: string; serviceId: number; qty: number; unitPrice: number; heatPressFee?: number | null };
    materialLines: { materialId: number; qty: number; unitPrice?: number }[];
    payments: PaymentLine[];
    // Set to the capturing staff member's own id when they sourced this client (credited to them for 12 months)
    sourcedBy?: number | null;
    // Brought by a freelance sales person instead: credited to their account, and to no staff member.
    freelanceAgentId?: number | null;
    // What one unit of the main line must reach to count as sold at base price (film's floor, an artwork job's recommended price)
    serviceBase?: number;
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
  const lineItemInputs: LineItemInput[] = [
    { itemType: opts.serviceLine.itemType as LineItemInput['itemType'], serviceId: opts.serviceLine.serviceId, materialId: null, qty: opts.serviceLine.qty, unitPrice: opts.serviceLine.unitPrice, discountPct: 0, discountAmt: 0, heatPressFee: opts.serviceLine.heatPressFee ?? null },
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
      capturedById: opts.capturedById,
      capturedByName: opts.capturedByName,
      ...sourcing,
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
    },
    include: orderInclude,
  });
  if (opts.payments.length) {
    await recordOrderPayments(tx, { id: order.id, kind: 'walkin', status, corporateClient: null }, opts.payments, opts.capturedById); // the money is the cashier's
    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  }

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
      wastageTolerancePct: settings.wastageTolerancePct,
      minPricePerPiece: settings.minPricePerPiece,
      fixedChargePerMetre: settings.fixedChargePerMetre,
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
      pieces: j.pieces,
      fixedChargePerMetreAtJob: j.fixedChargePerMetreAtJob,
      minPricePerPieceAtJob: j.minPricePerPieceAtJob,
      chargedPerPiece: j.chargedPerPiece,
      approvalStatus: j.approvalStatus,
      orderId: j.orderId,
    })),
    pendingApprovals: canManage ? await prisma.priceApproval.count({ where: { status: 'Pending' } }) : 0,
  });
});

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
  const settings = await getSettings();
  const { lines: paymentLines, paid } = resolvePaymentLines(d);
  // The floor is enforced here, not just in the form. There is no ceiling: charging more is rewarded (see Sales Commission).
  const c = saleCalc(settings, d.metres, d.pricePerM ?? null, paid);
  if (!c.valid) {
    return res.status(400).json({ error: `Price cannot be below ${settings.minPricePerM} KES/m` });
  }
  const cap = await resolveCapture(req.user!, d.staffId, d.sourcedBy);
  if (!cap.ok) return res.status(cap.status).json({ error: cap.error });
  const claim = await claimProblem(req.user!, { phone: d.phone, name: d.client, sourcedBy: d.sourcedBy, freelanceAgentId: d.freelanceAgentId });
  if (claim) return res.status(400).json({ error: claim });
  if (paid > c.total) return res.status(400).json({ error: 'Amount paid cannot exceed the sale total' });

  try {
    const { sale, order } = await prisma.$transaction(async (tx) => {
      const service = await tx.service.findFirst({ where: { name: 'DTF Sheet (per metre)' } });
      if (!service) throw new Error('The "DTF Sheet (per metre)" service is missing from Master Data — cannot generate an order for this sale.');
      const order = await createDtfOrder(tx, {
        customerName: d.client.trim() || WALK_IN_CLIENT,
        phone: d.phone.trim(),
        staffId: cap.staffId,
        capturedById: cap.capturedById,
        capturedByName: cap.capturedByName,
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
// Price per piece = minPricePerPiece + fixedChargePerMetre × runningMetres ÷
// pieces — see jobCalc in packages/shared/src/dtf.ts. One physical film
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
  heatPressFee: z.number({ required_error: 'Choose the heat press fee — a job cannot be processed without it', invalid_type_error: 'Choose the heat press fee — a job cannot be processed without it' }).positive('Choose the heat press fee — a job cannot be processed without it'),
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
  const settings = await getSettings();
  const sys = jobCalc(d.runningMetres, d.pieces, settings.fixedChargePerMetre, settings.minPricePerPiece);
  if (d.pricePerPiece != null && d.pricePerPiece < settings.minPricePerPiece - 0.005) {
    return res.status(400).json({ error: `The price per piece cannot be below the minimum of ${settings.minPricePerPiece} KES` });
  }
  const chargedPerPiece = d.pricePerPiece != null && Math.abs(d.pricePerPiece - sys.finalPerPiece) > 0.005 ? Math.round(d.pricePerPiece * 100) / 100 : null;
  const needsApproval = chargedPerPiece != null && chargedPerPiece < sys.finalPerPiece - 0.005;
  const c = { ...sys, finalPerPiece: chargedPerPiece ?? sys.finalPerPiece };
  const jobTotal = c.finalPerPiece * d.pieces + (d.heatPressFee ?? 0) * d.pieces;
  const cap = await resolveCapture(req.user!, d.staffId, d.sourcedBy);
  if (!cap.ok) return res.status(cap.status).json({ error: cap.error });
  const claim = await claimProblem(req.user!, { phone: d.phone, name: d.client, sourcedBy: d.sourcedBy, freelanceAgentId: d.freelanceAgentId });
  if (claim) return res.status(400).json({ error: claim });
  const { lines: paymentLines, paid } = resolvePaymentLines(d);
  if (paid > jobTotal) return res.status(400).json({ error: 'Amount paid cannot exceed the job total' });
  if (needsApproval && paid > 0) return res.status(400).json({ error: 'A price below the recommended price needs a manager’s approval first — take the payment once it is approved' });

  try {
    const { job, order } = await prisma.$transaction(async (tx) => {
      const service = await tx.service.findFirst({ where: { name: 'DTF Printing' } });
      if (!service) throw new Error('The "DTF Printing" service is missing from Master Data — cannot generate an order for this job.');
      const order = await createDtfOrder(tx, {
        customerName: d.client.trim() || WALK_IN_CLIENT,
        phone: d.phone.trim(),
        staffId: cap.staffId,
        capturedById: cap.capturedById,
        capturedByName: cap.capturedByName,
        serviceLine: { itemType: 'service', serviceId: service.id, qty: d.pieces, unitPrice: c.finalPerPiece, heatPressFee: d.heatPressFee ?? null },
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
          fixedChargePerMetreAtJob: settings.fixedChargePerMetre,
          minPricePerPieceAtJob: settings.minPricePerPiece,
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
  const kind = req.query.kind === 'sales' ? 'sales' : 'jobs';
  const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
  const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
  const dateRange = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

  if (kind === 'sales') {
    const sales = await prisma.dtfFilmSale.findMany({ where: dateRange ? { soldOn: dateRange } : undefined, include: { order: orderForDaily }, orderBy: [{ soldOn: 'desc' }, { id: 'desc' }] });
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

  const jobs = await prisma.dtfArtworkJob.findMany({ where: dateRange ? { jobOn: dateRange } : undefined, include: { order: orderForDaily }, orderBy: [{ jobOn: 'desc' }, { id: 'desc' }] });
  const byDay = new Map<string, typeof jobs>();
  for (const j of jobs) byDay.set(j.jobOn, [...(byDay.get(j.jobOn) ?? []), j]);
  const days = [...byDay.entries()].map(([date, list]) => {
    const orders = list.map((j) => {
      const calc = { id: '', rollId: j.rollId, jobOn: j.jobOn, client: j.client, runningMetres: j.runningMetres, pieces: j.pieces, fixedChargePerMetreAtJob: j.fixedChargePerMetreAtJob, minPricePerPieceAtJob: j.minPricePerPieceAtJob, chargedPerPiece: j.chargedPerPiece };
      const recommended = jobCalc(j.runningMetres, j.pieces, j.fixedChargePerMetreAtJob, j.minPricePerPieceAtJob).finalPerPiece;
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
dtfRouter.get('/approvals', manageOnly, async (_req, res) => {
  const rows = await prisma.priceApproval.findMany({ orderBy: [{ status: 'asc' }, { id: 'desc' }], take: 200 });
  res.json(rows.map((r) => ({ ...r, requestedAt: r.requestedAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null, pctBelow: r.systemPerPiece > 0 ? Math.round(((r.systemPerPiece - r.chargedPerPiece) / r.systemPerPiece) * 1000) / 10 : 0 })));
});

// Approving releases the job: it can now be paid for and produced, and its revenue counts on the roll. Whoever captured it cannot approve it.
dtfRouter.post('/approvals/:id/approve', manageOnly, async (req, res) => {
  const a = await prisma.priceApproval.findUnique({ where: { id: Number(req.params.id) } });
  if (!a) return res.status(404).json({ error: 'Approval request not found' });
  if (a.status !== 'Pending') return res.status(400).json({ error: `This request has already been ${a.status.toLowerCase()}` });
  if (a.requestedById === req.user!.id) return res.status(400).json({ error: 'You cannot approve a price you captured yourself' });
  await prisma.$transaction(async (tx) => {
    if (a.orderId) await tx.dtfArtworkJob.updateMany({ where: { orderId: a.orderId }, data: { approvalStatus: 'Approved' } });
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
      await tx.dtfArtworkJob.deleteMany({ where: { orderId: a.orderId } });
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
