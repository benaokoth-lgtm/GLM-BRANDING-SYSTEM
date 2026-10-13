import { Router } from 'express';
import { z } from 'zod';
import {
  COSTING_DEFAULT_JOB_TYPES,
  COSTING_DEFAULT_RATES,
  COSTING_JOB_TYPES,
  COSTING_BASIS_LABEL,
  costingBasesFor,
  costingCardTiers,
  costingQuote,
  isCostingJobType,
} from '@glm/shared';
import type { CostingBasis, CostingJobType, CostingJobTypeRow, CostingKind, CostingRateRow } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { canSeeCosts } from '../costs';

// Job costing: what an outsourced branding job (business cards, indoor or outdoor signage) costs and what to quote for it. Anyone who takes orders can cost a job; what the
// supplier charges us, the cost lines and the cost are shown to everyone who costs a job; our margin and profit only to people who may see costs (Finance, the General Manager, Admin).
// The supplier rates are kept by an Admin in Master Data → Costing Rates, as two lists: materials and services.
export const costingRouter = Router();
costingRouter.use(requireAuth);

const mayCost = requirePermission('canCaptureOrders', 'canAccessFinance');
const admin = requireRole('Admin');

// ── what a new database starts with: the sample rates from the costing design, to be replaced with the real supplier rates
let seeding: Promise<void> | null = null;
export function ensureCostingDefaults(): Promise<void> {
  if (!seeding) {
    seeding = (async () => {
      if ((await prisma.costingJobType.count()) === 0) await prisma.costingJobType.createMany({ data: COSTING_DEFAULT_JOB_TYPES });
      if ((await prisma.costingRate.count()) === 0) {
        await prisma.costingRate.createMany({ data: COSTING_DEFAULT_RATES.map((r, i) => ({ kind: r.kind, name: r.name, basis: r.basis, cost: r.cost, jobTypes: r.jobTypes.join(','), onlyFor: r.onlyFor, defaultOn: r.defaultOn, sortOrder: (i + 1) * 10 })) });
      }
    })().finally(() => (seeding = null));
  }
  return seeding;
}

const toRate = (r: { id: number; kind: string; name: string; basis: string; cost: number; jobTypes: string; onlyFor: string; defaultOn: boolean; active: boolean; sortOrder: number }): CostingRateRow => ({
  id: r.id,
  kind: r.kind as CostingKind,
  name: r.name,
  basis: r.basis as CostingBasis,
  cost: r.cost,
  jobTypes: r.jobTypes.split(',').filter(isCostingJobType),
  onlyFor: r.onlyFor === 'lam' || r.onlyFor === 'frost' ? r.onlyFor : '',
  defaultOn: r.defaultOn,
  active: r.active,
  sortOrder: r.sortOrder,
});
const toType = (t: { key: string; label: string; marginPct: number; wastagePct: number; cardsPerSheet: number; spareSheets: number }): CostingJobTypeRow => ({ ...t, key: t.key as CostingJobType });

async function load() {
  await ensureCostingDefaults();
  const [types, rates] = await Promise.all([prisma.costingJobType.findMany(), prisma.costingRate.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })]);
  const order = new Map(COSTING_JOB_TYPES.map((k, i) => [k as string, i]));
  return { types: types.map(toType).sort((a, b) => order.get(a.key)! - order.get(b.key)!), rates: rates.map(toRate) };
}

// ── the costing screen ──────────────────────────────────────────────────────
costingRouter.get('/config', mayCost, async (req, res) => {
  const sees = await canSeeCosts(req.user!.role);
  const { types, rates } = await load();
  res.json({
    canSeeCosts: sees,
    jobTypes: types.map((t) => ({ key: t.key, label: t.label, wastagePct: t.wastagePct, cardsPerSheet: t.cardsPerSheet, spareSheets: t.spareSheets, ...(sees ? { marginPct: t.marginPct } : {}) })),
    // what is ticked in a costing: each rate, what it costs and where it applies
    rates: rates.filter((r) => r.active).map((r) => ({ id: r.id, kind: r.kind, name: r.name, basis: r.basis, jobTypes: r.jobTypes, onlyFor: r.onlyFor, defaultOn: r.defaultOn, sortOrder: r.sortOrder, cost: r.cost })),
  });
});

const quoteSchema = z.object({
  jobType: z.enum(COSTING_JOB_TYPES),
  qty: z.number().min(0).max(1_000_000).default(0),
  widthM: z.number().min(0).max(1000).optional(),
  heightM: z.number().min(0).max(1000).optional(),
  finish: z.enum(['plain', 'lam', 'frost']).default('plain'),
  on: z.array(z.number().int()).max(200).default([]),
  off: z.array(z.number().int()).max(200).default([]),
  marginPct: z.number().min(0).max(1000).optional(),
});

costingRouter.post('/quote', mayCost, async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const sees = await canSeeCosts(req.user!.role);
  const { types, rates } = await load();
  // only people who see costs may change the margin
  const input = { ...parsed.data, marginPct: sees ? parsed.data.marginPct : undefined };
  const q = costingQuote(types, rates, input);
  const tiers = input.jobType === 'cards' ? costingCardTiers(types, rates, input) : [];
  // everyone gets the cost lines and the cost; the margin and the profit are for people who may see costs
  if (!sees) {
    const { qty, summary, sheets, area, lines, cost, price, vat, total, unitPrice, unitTotal } = q;
    res.json({ canSeeCosts: false, jobType: q.jobType, qty, summary, sheets, area, lines, cost, price, vat, total, unitPrice, unitTotal, tiers });
    return;
  }
  res.json({ canSeeCosts: true, ...q, tiers });
});

// ── Master Data → Costing Rates (Admin) ─────────────────────────────────────
costingRouter.get('/rates', admin, async (_req, res) => {
  const { types, rates } = await load();
  res.json({ jobTypes: types, rates });
});

const rateSchema = z.object({
  kind: z.enum(['material', 'service']),
  name: z.string().trim().min(2, 'Give it a name').max(80),
  basis: z.enum(Object.keys(COSTING_BASIS_LABEL) as [CostingBasis, ...CostingBasis[]]),
  cost: z.number().min(0, 'The cost cannot be negative').max(100_000_000),
  jobTypes: z.array(z.enum(COSTING_JOB_TYPES)).min(1, 'Choose at least one kind of job'),
  onlyFor: z.enum(['', 'lam', 'frost']).default(''),
  defaultOn: z.boolean().default(true),
  active: z.boolean().default(true),
});

/** The rate as it would be stored, or what is wrong with it. */
function checkRate(d: z.infer<typeof rateSchema>): string | null {
  const types = [...new Set(d.jobTypes)];
  if (!costingBasesFor(types).includes(d.basis)) {
    const allowed = costingBasesFor(types).map((b) => COSTING_BASIS_LABEL[b]);
    return `"${COSTING_BASIS_LABEL[d.basis]}" cannot be used on every kind of job you chose${allowed.length ? ` — choose ${allowed.join(', ')}` : ' — they have no way of being charged in common'}`;
  }
  if (d.onlyFor && !types.includes('cards')) return 'Laminated-only and frosted-only apply to business cards';
  return null;
}

costingRouter.post('/rates', admin, async (req, res) => {
  const parsed = rateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const bad = checkRate(parsed.data);
  if (bad) return res.status(400).json({ error: bad });
  await ensureCostingDefaults();
  const last = await prisma.costingRate.aggregate({ _max: { sortOrder: true } });
  const d = parsed.data;
  const row = await prisma.costingRate.create({ data: { kind: d.kind, name: d.name, basis: d.basis, cost: d.cost, jobTypes: [...new Set(d.jobTypes)].join(','), onlyFor: d.onlyFor, defaultOn: d.defaultOn, active: d.active, sortOrder: (last._max.sortOrder ?? 0) + 10 } });
  res.status(201).json(toRate(row));
});

costingRouter.put('/rates/:id', admin, async (req, res) => {
  const parsed = rateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const bad = checkRate(parsed.data);
  if (bad) return res.status(400).json({ error: bad });
  const d = parsed.data;
  const row = await prisma.costingRate
    .update({ where: { id: Number(req.params.id) }, data: { kind: d.kind, name: d.name, basis: d.basis, cost: d.cost, jobTypes: [...new Set(d.jobTypes)].join(','), onlyFor: d.onlyFor, defaultOn: d.defaultOn, active: d.active } })
    .catch(() => null);
  if (!row) return res.status(404).json({ error: 'Rate not found' });
  res.json(toRate(row));
});

costingRouter.delete('/rates/:id', admin, async (req, res) => {
  await prisma.costingRate.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});

const typeSchema = z.object({
  marginPct: z.number().min(0, 'The margin cannot be negative').max(1000),
  wastagePct: z.number().min(0).max(100, 'Wastage cannot be more than 100%'),
  cardsPerSheet: z.number().int().min(1, 'At least one card fits an A3 sheet'),
  spareSheets: z.number().int().min(0).max(1000),
});

costingRouter.put('/job-types/:key', admin, async (req, res) => {
  if (!isCostingJobType(req.params.key)) return res.status(404).json({ error: 'Unknown kind of job' });
  const parsed = typeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  await ensureCostingDefaults();
  const row = await prisma.costingJobType.update({ where: { key: req.params.key }, data: parsed.data });
  res.json(toType(row));
});
