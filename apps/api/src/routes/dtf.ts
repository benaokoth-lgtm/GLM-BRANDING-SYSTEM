import { Router } from 'express';
import { z } from 'zod';
import { jobCalc, nextRollId, saleCalc, todayStr } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { permissionsForRole } from '../permissions';

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
  metres: z.number().positive('Metres must be greater than 0'),
  pricePerM: z.number().nullable().optional(), // blank ⇒ standard price
  amountPaid: z.number().min(0).default(0),
});

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
  const sale = await prisma.dtfFilmSale.create({
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
    },
  });
  res.status(201).json(sale);
});

dtfRouter.patch('/sales/:id/paid', manageOnly, async (req, res) => {
  const amountPaid = Number((req.body as { amountPaid?: number }).amountPaid);
  const sale = await prisma.dtfFilmSale.findUnique({ where: { id: Number(req.params.id) } });
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const total = Math.round(sale.metres * sale.pricePerM * 100) / 100;
  if (!Number.isFinite(amountPaid) || amountPaid < 0 || amountPaid > total) {
    return res.status(400).json({ error: `Amount paid must be between 0 and ${total}` });
  }
  res.json(await prisma.dtfFilmSale.update({ where: { id: sale.id }, data: { amountPaid } }));
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
  runningMetres: z.number().positive('Running metres must be greater than 0'),
  artworks: z.number().int().positive('Number of artworks must be at least 1'),
  pieces: z.number().int().positive('Pieces must be at least 1'),
  multiplier: z.number().positive().nullable().optional(), // blank ⇒ default multiplier
  discountPerPiece: z.number().default(0), // negative ⇒ price above the proposal
});

dtfRouter.post('/jobs', async (req, res) => {
  const parsed = jobSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const found = await openRoll(d.rollId);
  if ('error' in found) return res.status(400).json({ error: found.error });
  const settings = await getSettings();
  const c = jobCalc(settings, d.runningMetres, d.artworks, d.pieces, d.multiplier ?? null, d.discountPerPiece);
  const job = await prisma.dtfArtworkJob.create({
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
    },
  });
  res.status(201).json(job);
});

dtfRouter.delete('/jobs/:id', requireRole('Admin'), async (req, res) => {
  await prisma.dtfArtworkJob.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});
