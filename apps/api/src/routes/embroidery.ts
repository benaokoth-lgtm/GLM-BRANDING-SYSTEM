import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole, userHasPermission } from '../middleware/auth';
import {
  DEFAULT_EMBROIDERY_SETTINGS,
  EMBROIDERY_ORIGINATION_SERVICE,
  EMBROIDERY_PIECE_SERVICE,
  EMBROIDERY_SETUP_SERVICE,
  embroiderySettingsProblem,
  quoteJob,
  todayStr,
} from '@glm/shared';
import type { EmbroiderySettingsValues } from '@glm/shared';
import type { CreditLine } from '../commission';
import { captureWalkin, walkinSchema } from './orders';

// Embroidery orders, priced by stitch count (the "Embroidery Pricing Calculator" handoff): the settings an Admin keeps (Master Data → Embroidery Pricing),
// the saved designs a repeat order picks from, and the order itself — a General Order underneath, so payments, receipts, invoices, front-office capture,
// the order-taking switch and commission work exactly as for the other order types. The server works the price out itself; the screen only previews it.

export const embroideryRouter = Router();
embroideryRouter.use(requireAuth);

export async function loadEmbroiderySettings(): Promise<EmbroiderySettingsValues> {
  const row = await prisma.embroiderySettings.findUnique({ where: { id: 1 } });
  if (!row) return DEFAULT_EMBROIDERY_SETTINGS;
  let tiers = DEFAULT_EMBROIDERY_SETTINGS.tiers;
  try {
    const parsed = JSON.parse(row.tiers);
    if (Array.isArray(parsed) && parsed.length) tiers = parsed.map((t) => ({ min: Number(t.min), rate: Number(t.rate), floor: Number(t.floor) }));
  } catch {
    /* an unreadable value falls back to the standing tiers */
  }
  return { setupFee: row.setupFee, originationFee: row.originationFee, waiveAtQty: row.waiveAtQty, tiers };
}

/** Whoever may capture orders sees the numbers (they are the price list); changing them is the Admin's. */
const mayQuote = requirePermission('canCaptureOrders');
/** Charging less than the recommended price per piece is for a manager (the Admin, or a role that handles payments). */
const canBelow = async (role: string) => role === 'Admin' || (await userHasPermission(role, 'canManagePayments'));

embroideryRouter.get('/config', mayQuote, async (req, res) => {
  res.json({ settings: await loadEmbroiderySettings(), canChargeBelowRecommended: await canBelow(req.user!.role) });
});

const settingsSchema = z.object({
  setupFee: z.number().min(0),
  originationFee: z.number().min(0),
  waiveAtQty: z.number().int().min(0),
  tiers: z.array(z.object({ min: z.number().min(1), rate: z.number().min(0), floor: z.number().min(0) })).min(1).max(12),
});

embroideryRouter.put('/settings', requireRole('Admin'), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const s = { ...parsed.data, tiers: [...parsed.data.tiers].sort((a, b) => a.min - b.min) };
  const problem = embroiderySettingsProblem(s);
  if (problem) return res.status(400).json({ error: problem });
  const data = { setupFee: s.setupFee, originationFee: s.originationFee, waiveAtQty: s.waiveAtQty, tiers: JSON.stringify(s.tiers), updatedByName: req.user!.name };
  await prisma.embroiderySettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  res.json(await loadEmbroiderySettings());
});

// ── Saved designs ───────────────────────────────────────────────────────────
embroideryRouter.get('/designs', mayQuote, async (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const rows = await prisma.embroideryDesign.findMany({ orderBy: [{ id: 'desc' }], take: 500 });
  const hit = rows.filter((d) => !q || d.name.toLowerCase().includes(q) || d.clientName.toLowerCase().includes(q) || d.phone.includes(q));
  hit.sort((a, b) => (b.lastUsedOn ?? '').localeCompare(a.lastUsedOn ?? '') || b.id - a.id);
  res.json(hit.slice(0, 30));
});

// ── The order ───────────────────────────────────────────────────────────────
const designSchema = z.object({
  /** A saved design: its stitch count is the saved one, and it can be a repeat (no setup fee). */
  designId: z.number().int().optional(),
  name: z.string().trim().min(1, 'Name each design (for example "Left chest logo")').max(60),
  stitches: z.number().int().min(1, 'Enter the stitch count').max(2_000_000),
  repeat: z.boolean().default(false),
  /** Only to charge something other than the recommended price per piece. */
  pricePerPiece: z.number().positive().nullable().optional(),
  /** Keep this design for repeat orders. */
  save: z.boolean().optional(),
});

const orderSchema = walkinSchema
  .omit({ lineItems: true, orderDiscountPct: true, orderDiscountAmt: true, paymentAmount: true, paymentMethod: true })
  .extend({
    qty: z.number().int().min(1, 'Quantity must be at least 1').max(100_000),
    clientSupplies: z.boolean(),
    designs: z.array(designSchema).min(1, 'Add at least one design').max(6),
    /** Blank garments and the like sold with the job, at the price list. */
    garments: z.array(z.object({ materialId: z.number().int(), qty: z.number().positive() })).max(10).default([]),
  });

/** The three services an embroidery order puts on an order, created the first time they are needed. They are sold only through this screen. */
async function ensureServices() {
  const head = await prisma.businessHead.findUnique({ where: { name: 'Embroidery' } });
  const get = async (name: string, price: number) =>
    (await prisma.service.findFirst({ where: { name } })) ??
    prisma.service.create({ data: { name, item: name, unit: 'piece', price, businessHeadId: head?.id ?? null, soldViaDtfModule: true } });
  const s = await loadEmbroiderySettings();
  return { piece: await get(EMBROIDERY_PIECE_SERVICE, 150), setup: await get(EMBROIDERY_SETUP_SERVICE, s.setupFee), origination: await get(EMBROIDERY_ORIGINATION_SERVICE, s.originationFee) };
}

embroideryRouter.post('/orders', mayQuote, async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const { qty, clientSupplies, designs: asked, garments, ...form } = parsed.data;
  const settings = await loadEmbroiderySettings();

  // A saved design supplies its own stitch count; "repeat" only means something for a saved design (it waives the setup fee).
  const saved = new Map((await prisma.embroideryDesign.findMany({ where: { id: { in: asked.map((d) => d.designId).filter((v): v is number => !!v) } } })).map((d) => [d.id, d]));
  const designs: z.infer<typeof designSchema>[] = [];
  for (const d of asked) {
    const keep = d.designId ? saved.get(d.designId) : undefined;
    if (d.designId && !keep) return res.status(400).json({ error: `The saved design for "${d.name}" no longer exists` });
    if (d.repeat && !keep) return res.status(400).json({ error: `"${d.name}" is marked as a repeat but is not a saved design — pick it from the saved designs, or untick repeat` });
    designs.push({ ...d, stitches: keep ? keep.stitches : d.stitches });
  }

  const below = await canBelow(req.user!.role);
  const quote = quoteJob(designs, qty, clientSupplies, settings);
  let belowRecommended = false;
  for (const [i, d] of designs.entries()) {
    const q = quote.designs[i]!;
    if (d.pricePerPiece != null && d.pricePerPiece < q.recommended - 0.005) {
      if (!below) return res.status(403).json({ error: `Only a manager can charge less than the recommended KES ${q.recommended} per piece for "${d.name}"` });
      belowRecommended = true;
    }
  }

  const svc = await ensureServices();
  const stitchesText = (n: number) => n.toLocaleString('en-KE');
  const lineItems: { itemType: 'service' | 'material'; serviceId: number | null; materialId: number | null; qty: number; unitPrice: number; discountPct: number; discountAmt: number; description?: string }[] = [];
  const creditLines: CreditLine[] = [];
  const add = (li: (typeof lineItems)[number], baseUnit?: number) => {
    lineItems.push(li);
    creditLines.push({ ...li, baseUnit });
  };
  for (const [i, d] of designs.entries()) {
    const q = quote.designs[i]!;
    // the piece line: priced per piece, with the design and its stitch count after the name
    add({ itemType: 'service', serviceId: svc.piece.id, materialId: null, qty, unitPrice: q.piece, discountPct: 0, discountAmt: 0, description: `${d.name} · ${stitchesText(d.stitches)} stitches` }, q.recommended);
    // the setup (digitizing) fee, on its own line, unless waived
    if (q.setup > 0) add({ itemType: 'service', serviceId: svc.setup.id, materialId: null, qty: 1, unitPrice: q.setup, discountPct: 0, discountAmt: 0, description: d.name }, q.setup);
  }
  if (quote.origination > 0) add({ itemType: 'service', serviceId: svc.origination.id, materialId: null, qty: 1, unitPrice: quote.origination, discountPct: 0, discountAmt: 0 }, quote.origination);
  for (const g of garments) {
    const m = await prisma.material.findUnique({ where: { id: g.materialId } });
    if (!m) return res.status(400).json({ error: 'A garment on the order is not in the stock list any more' });
    add({ itemType: 'material', serviceId: null, materialId: m.id, qty: g.qty, unitPrice: m.price, discountPct: 0, discountAmt: 0 });
  }

  const walkin = { ...form, lineItems, orderDiscountPct: 0, orderDiscountAmt: 0 };
  return captureWalkin(req, res, walkin as never, {
    prefix: 'E-',
    counter: 'nextEmbroideryNo',
    creditLines,
    after: async (tx, order) => {
      await tx.embroideryJob.create({
        data: {
          orderId: order.id,
          qty,
          clientSupplied: clientSupplies,
          designsJson: JSON.stringify(designs.map((d, i) => ({ name: d.name, stitches: d.stitches, repeat: !!d.repeat, ...quote.designs[i]! }))),
          settingsJson: JSON.stringify(settings),
          belowRecommended,
          createdByName: req.user!.name,
        },
      });
      for (const d of designs) {
        if (d.designId) await tx.embroideryDesign.update({ where: { id: d.designId }, data: { lastUsedOn: todayStr(), timesUsed: { increment: 1 } } });
        else if (d.save) await tx.embroideryDesign.create({ data: { name: d.name, stitches: d.stitches, clientName: (form.customerName ?? '').trim(), phone: (form.phone ?? '').trim(), createdByName: req.user!.name, lastUsedOn: todayStr(), timesUsed: 1 } });
      }
    },
  });
});
