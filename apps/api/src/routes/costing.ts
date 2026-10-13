import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  COSTING_DEFAULT_JOB_TYPES,
  COSTING_DEFAULT_RATES,
  COSTING_JOB_TYPES,
  COSTING_BASIS_LABEL,
  DEFAULT_PRINT_SETTINGS,
  PRINT_BOOKLET_QTYS,
  PRINT_BROCHURE_QTYS,
  PRINT_PAGE_OPTIONS,
  PRINT_PRODUCTS,
  PRINT_UPS,
  VAT_RATE,
  costingAgreement,
  costingBasesFor,
  costingCardTiers,
  costingFloor,
  costingQuote,
  costingJobLabel,
  isCostingJobType,
  printCalc,
  printSettingsProblem,
  printSpec,
  todayStr,
} from '@glm/shared';
import type { PrintJob, PrintSettings } from '@glm/shared';
import type { CostingBasis, CostingJobType, CostingJobTypeRow, CostingKind, CostingRateRow } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { canSeeCosts } from '../costs';
import { permissionsForRole } from '../permissions';
import { captureWalkin, paymentLineSchema, walkinSchema } from './orders';

// Job costing: what an outsourced branding job (business cards, indoor or outdoor signage) costs and what to quote for it. Anyone who takes orders can cost a job; what the
// supplier charges us, the cost lines and the cost are shown to everyone who costs a job; our margin and profit only to people who may see costs (Finance, the General Manager, Admin).
// The supplier rates are kept by an Admin under Sales → Job Costing → Rates, as two lists: materials and services.
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
const toType = (t: { key: string; label: string; marginPct: number; floorMarginPct: number; wastagePct: number; cardsPerSheet: number; spareSheets: number }): CostingJobTypeRow => ({ ...t, key: t.key as CostingJobType });

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
    jobTypes: types.map((t) => ({ key: t.key, label: t.label, wastagePct: t.wastagePct, cardsPerSheet: t.cardsPerSheet, spareSheets: t.spareSheets, ...(sees ? { marginPct: t.marginPct, floorMarginPct: t.floorMarginPct } : {}) })),
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

// ── Job Costing → Rates (Admin) ─────────────────────────────────────
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
  floorMarginPct: z.number().min(0, 'The lowest margin cannot be negative').max(1000),
  wastagePct: z.number().min(0).max(100, 'Wastage cannot be more than 100%'),
  cardsPerSheet: z.number().int().min(1, 'At least one card fits an A3 sheet'),
  spareSheets: z.number().int().min(0).max(1000),
});

costingRouter.put('/job-types/:key', admin, async (req, res) => {
  if (!isCostingJobType(req.params.key)) return res.status(404).json({ error: 'Unknown kind of job' });
  const parsed = typeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  if (parsed.data.floorMarginPct > parsed.data.marginPct) return res.status(400).json({ error: 'The lowest margin cannot be above the usual margin' });
  await ensureCostingDefaults();
  const row = await prisma.costingJobType.update({ where: { key: req.params.key }, data: parsed.data });
  res.json(toType(row));
});

// ── Brochures & Eulogies: eulogy booklets, company profiles and brochures printed by a supplier ───────────────────────────────────────────────────────────────────────────────
// The printer's rates (paper per A3 sheet, the fees, the mark-up tiers) are kept by an Admin as one row of settings. Everyone who costs a job sees the cost lines and the price; the mark-up
// (its percentage and the profit) is for people who may see costs, and so is the choice between a mark-up by quantity and a flat one.
export async function printSettings(): Promise<PrintSettings> {
  const row = await prisma.printCostSetting.findUnique({ where: { id: 1 } });
  if (!row) return DEFAULT_PRINT_SETTINGS;
  try {
    const d = JSON.parse(row.data) as PrintSettings;
    return { papers: d.papers, fees: { ...DEFAULT_PRINT_SETTINGS.fees, ...d.fees }, tiers: d.tiers, floorMarginPct: d.floorMarginPct ?? DEFAULT_PRINT_SETTINGS.floorMarginPct };
  } catch {
    return DEFAULT_PRINT_SETTINGS;
  }
}

const printJobSchema = z.object({
  product: z.enum(PRINT_PRODUCTS),
  pages: z.number().int().refine((n) => (PRINT_PAGE_OPTIONS as readonly number[]).includes(n), 'Pages are 4, 8, 12 … 32').default(8),
  paper: z.number().int().min(0).default(0),
  cover: z.number().int().min(0).default(0),
  coverSep: z.boolean().default(false),
  lam: z.boolean().default(false),
  fold: z.boolean().default(true),
  size: z.enum(['A4', 'B5']).default('A4'),
  sides: z.union([z.literal(1), z.literal(2)]).default(2),
  qty: z.number().int().min(1, 'Enter at least 1').max(1_000_000),
  mode: z.enum(['tier', 'flat']).default('tier'),
});

costingRouter.get('/print/config', mayCost, async (req, res) => {
  const [sees, s] = await Promise.all([canSeeCosts(req.user!.role), printSettings()]);
  res.json({ canSeeCosts: sees, papers: s.papers.map((p) => p.name), pageOptions: PRINT_PAGE_OPTIONS, ups: PRINT_UPS, bookletQtys: PRINT_BOOKLET_QTYS, brochureQtys: PRINT_BROCHURE_QTYS });
});

function printView(job: PrintJob, s: PrintSettings, sees: boolean) {
  const r = printCalc(job, s);
  const base = { canSeeCosts: sees, spec: printSpec(job, s), qty: r.qty, sheets: r.sheets, lines: r.lines, cost: r.cost, priceExVat: r.priceExVat, vat: r.vat, total: r.total, unitExVat: r.unitExVat, unitTotal: r.unitTotal };
  return sees ? { ...base, markupPct: r.markupPct, markup: r.markup, profit: r.profit } : base;
}

costingRouter.post('/print/quote', mayCost, async (req, res) => {
  const parsed = printJobSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const [sees, s] = await Promise.all([canSeeCosts(req.user!.role), printSettings()]);
  const job: PrintJob = { ...parsed.data, mode: sees ? parsed.data.mode : 'tier' };
  if (job.paper >= s.papers.length || job.cover >= s.papers.length) return res.status(400).json({ error: 'That paper is not on the list' });
  res.json(printView(job, s, sees));
});

// the price list: the VAT-inclusive price of one copy (booklets) or piece (brochures) at the usual quantities, for the paper and finishing chosen
costingRouter.post('/print/pricelist', mayCost, async (req, res) => {
  const parsed = printJobSchema.omit({ qty: true, product: true, pages: true, size: true, sides: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const [sees, s] = await Promise.all([canSeeCosts(req.user!.role), printSettings()]);
  const o = { ...parsed.data, mode: sees ? parsed.data.mode : ('tier' as const) };
  if (o.paper >= s.papers.length || o.cover >= s.papers.length) return res.status(400).json({ error: 'That paper is not on the list' });
  const unit = (job: Pick<PrintJob, 'product' | 'pages' | 'size' | 'sides' | 'qty'>) => r2(printCalc({ ...o, ...job }, s).unitTotal);
  res.json({
    bookletQtys: PRINT_BOOKLET_QTYS,
    brochureQtys: PRINT_BROCHURE_QTYS,
    booklets: PRINT_PAGE_OPTIONS.map((pages) => ({ pages, sheets: pages / 4, cells: PRINT_BOOKLET_QTYS.map((qty) => unit({ product: 'eulogy', pages, size: 'A4', sides: 2, qty })) })),
    brochures: (['A4', 'B5'] as const).flatMap((size) =>
      ([1, 2] as const).map((sides) => ({ name: size + (sides === 1 ? ' single side' : ' double side'), ups: PRINT_UPS[size], cells: PRINT_BROCHURE_QTYS.map((qty) => unit({ product: 'brochure', pages: 8, size, sides, qty })) })),
    ),
  });
});

// Saved as a quote, a print costing goes through the same steps as any other: the price agreed with the client, a manager's approval below the floor, and capture as an order.
const printSaveSchema = printJobSchema.extend({
  clientName: z.string().trim().min(2, 'Enter the client’s name').max(120),
  phone: z.string().trim().max(40).default(''),
  note: z.string().trim().max(300).default(''),
  validDays: z.number().int().min(1).max(90).default(14),
});

costingRouter.post('/print/quotes', mayCost, async (req, res) => {
  const parsed = printSaveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const [sees, s] = await Promise.all([canSeeCosts(req.user!.role), printSettings()]);
  const { clientName, phone, note, validDays, ...rest } = parsed.data;
  const job: PrintJob = { ...rest, mode: sees ? rest.mode : 'tier' };
  if (job.paper >= s.papers.length || job.cover >= s.papers.length) return res.status(400).json({ error: 'That paper is not on the list' });
  const r = printCalc(job, s);
  if (r.cost <= 0) return res.status(400).json({ error: 'There is nothing to cost' });
  const created = await prisma.$transaction(async (tx) => {
    const settings = await tx.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    await tx.setting.update({ where: { id: 1 }, data: { nextCostingQuoteNo: settings.nextCostingQuoteNo + 1 } });
    const until = new Date(todayStr() + 'T00:00:00Z');
    until.setUTCDate(until.getUTCDate() + validDays);
    return tx.costingQuote.create({
      data: {
        quoteNo: 'CQ-' + settings.nextCostingQuoteNo,
        createdDate: todayStr(),
        validUntil: until.toISOString().slice(0, 10),
        clientName,
        phone,
        note,
        staffId: req.user!.id,
        staffName: req.user!.name,
        jobType: job.product,
        inputJson: JSON.stringify(job),
        summary: printSpec(job, s) + ' — ' + r.qty + (job.product === 'brochure' ? ' pieces' : ' copies'),
        linesJson: JSON.stringify(r.lines.map((l, i) => ({ rateId: i + 1, kind: 'service', name: l.label, note: l.note, amount: l.amount }))),
        cost: r.cost,
        marginPct: r.markupPct,
        floorMarginPct: Math.min(s.floorMarginPct, r.markupPct),
        price: r.priceExVat,
      },
    });
  });
  res.status(201).json(viewOf(created, sees));
});

// the rates (Admin)
const money = z.number().min(0).max(100_000_000);
const printSettingsSchema = z.object({
  papers: z.array(z.object({ name: z.string().trim().min(1).max(60), one: money, two: money })).min(1).max(20),
  fees: z.object({ staple: money, trim: money, fold: money, lam: money, designEu: money, designPr: money, designBr: money, proof: money, deliver: money, waste: z.number().min(0).max(100) }),
  tiers: z.array(z.object({ min: z.number().int(), pct: z.number().min(0).max(1000) })).min(1).max(12),
  floorMarginPct: z.number().min(0).max(1000),
});

costingRouter.get('/print/settings', admin, async (_req, res) => {
  res.json(await printSettings());
});

costingRouter.put('/print/settings', admin, async (req, res) => {
  const parsed = printSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const next: PrintSettings = { ...parsed.data, tiers: [...parsed.data.tiers].sort((a, b) => a.min - b.min) };
  const problem = printSettingsProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  const data = JSON.stringify(next);
  await prisma.printCostSetting.upsert({ where: { id: 1 }, update: { data }, create: { id: 1, data } });
  res.json(next);
});

// ── Costing quotes: a costing saved for a client, the price agreed with them, and the order it becomes ─────────────────────────────────────────────────────────────────────────
// The salesperson saves a costing as a quote (the cost lines are frozen as they were), and after talking to the client records the price AGREED. A price at or above the floor
// margin goes straight through; a lower one waits for a manager who may see costs (Finance, the General Manager, Admin) — never the person who quoted it. A price below cost is
// refused. Once accepted, the quote is captured as an ordinary order at the agreed price, credited to the salesperson, with the cost kept on its line so Finance sees the job's profit.
// The salesperson's commission is then the usual rule on that order — money received, net of VAT — nothing special.
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type QuoteRow = NonNullable<Awaited<ReturnType<typeof prisma.costingQuote.findUnique>>>;

function viewOf(q: QuoteRow, sees: boolean) {
  const vat = r2(q.price * VAT_RATE);
  const floor = costingFloor(q.cost, q.floorMarginPct);
  const agreed = q.agreedPrice != null ? costingAgreement(q.cost, r2(q.agreedPrice * (1 + VAT_RATE)), q.floorMarginPct) : null;
  return {
    id: q.id,
    quoteNo: q.quoteNo,
    status: q.status,
    createdDate: q.createdDate,
    validUntil: q.validUntil,
    expired: (q.status === 'Draft' || q.status === 'Sent') && q.validUntil < todayStr(),
    clientName: q.clientName,
    phone: q.phone,
    note: q.note,
    staffId: q.staffId,
    staffName: q.staffName,
    jobType: q.jobType,
    summary: q.summary,
    input: JSON.parse(q.inputJson),
    // everyone sees the cost lines and the cost
    lines: JSON.parse(q.linesJson),
    cost: q.cost,
    price: q.price,
    vat,
    total: r2(q.price + vat),
    // the lowest the price may be agreed at without approval (a price, not a margin)
    lowestPrice: floor.price,
    lowestTotal: floor.total,
    agreed: agreed ? { price: agreed.price, vat: agreed.vat, total: agreed.total, needsApproval: agreed.needsApproval, ...(sees ? { marginPct: agreed.marginPct } : {}) } : null,
    approval: q.approval,
    approvalNote: q.approvalNote,
    approvedByName: q.approvedByName,
    lostReason: q.lostReason,
    orderId: q.orderId,
    orderNo: q.orderNo,
    ...(sees ? { marginPct: q.marginPct, floorMarginPct: q.floorMarginPct, profit: r2(q.price - q.cost) } : {}),
  };
}

/** Everyone sees their own quotes; people who see costs or view every order see all of them. */
async function seesAllQuotes(user: { role: string }): Promise<boolean> {
  if (user.role === 'Admin') return true;
  const perms = await permissionsForRole(user.role);
  return !!(perms.canSeeCosts || perms.canViewAllOrders);
}

async function openQuote(req: Request, res: Response) {
  const q = await prisma.costingQuote.findUnique({ where: { id: Number(req.params.id) } });
  if (!q) {
    res.status(404).json({ error: 'Quote not found' });
    return null;
  }
  if (q.staffId !== req.user!.id && !(await seesAllQuotes(req.user!))) {
    res.status(403).json({ error: 'That quote is another salesperson’s' });
    return null;
  }
  return q;
}

const saveSchema = quoteSchema.extend({
  clientName: z.string().trim().min(2, 'Enter the client’s name').max(120),
  phone: z.string().trim().max(40).default(''),
  note: z.string().trim().max(300).default(''),
  validDays: z.number().int().min(1).max(90).default(14),
});

costingRouter.post('/quotes', mayCost, async (req, res) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const sees = await canSeeCosts(req.user!.role);
  const { clientName, phone, note, validDays, ...rest } = parsed.data;
  const input = { ...rest, marginPct: sees ? rest.marginPct : undefined };
  const { types, rates } = await load();
  const q = costingQuote(types, rates, input);
  if (q.cost <= 0) return res.status(400).json({ error: 'There is nothing to cost — tick at least one line with a rate' });
  const floor = types.find((t) => t.key === input.jobType)!.floorMarginPct;
  const created = await prisma.$transaction(async (tx) => {
    const settings = await tx.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    await tx.setting.update({ where: { id: 1 }, data: { nextCostingQuoteNo: settings.nextCostingQuoteNo + 1 } });
    const until = new Date(todayStr() + 'T00:00:00Z');
    until.setUTCDate(until.getUTCDate() + validDays);
    return tx.costingQuote.create({
      data: {
        quoteNo: 'CQ-' + settings.nextCostingQuoteNo,
        createdDate: todayStr(),
        validUntil: until.toISOString().slice(0, 10),
        clientName,
        phone,
        note,
        staffId: req.user!.id,
        staffName: req.user!.name,
        jobType: input.jobType,
        inputJson: JSON.stringify(input),
        summary: q.summary,
        linesJson: JSON.stringify(q.lines),
        cost: q.cost,
        marginPct: q.marginPct,
        floorMarginPct: Math.min(floor, q.marginPct),
        price: q.price,
      },
    });
  });
  res.status(201).json(viewOf(created, sees));
});

costingRouter.get('/quotes', mayCost, async (req, res) => {
  const sees = await canSeeCosts(req.user!.role);
  const all = await seesAllQuotes(req.user!);
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const rows = await prisma.costingQuote.findMany({
    where: { ...(all ? {} : { staffId: req.user!.id }), ...(['Draft', 'Sent', 'Lost', 'Ordered'].includes(status) ? { status } : {}) },
    orderBy: [{ id: 'desc' }],
    take: 300,
  });
  res.json({ canSeeCosts: sees, quotes: rows.map((q) => viewOf(q, sees)) });
});

costingRouter.get('/quotes/:id', mayCost, async (req, res) => {
  const q = await openQuote(req, res);
  if (q) res.json(viewOf(q, await canSeeCosts(req.user!.role)));
});

// the client has agreed a price: the total they will pay, VAT included
costingRouter.post('/quotes/:id/agree', mayCost, async (req, res) => {
  const parsed = z.object({ total: z.number().positive('Enter the price agreed with the client').max(1_000_000_000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const q = await openQuote(req, res);
  if (!q) return;
  if (q.status === 'Ordered') return res.status(400).json({ error: 'This quote has already been captured as an order' });
  if (q.status === 'Lost') return res.status(400).json({ error: 'This quote was marked lost' });
  const a = costingAgreement(q.cost, parsed.data.total, q.floorMarginPct);
  if (a.belowCost) return res.status(400).json({ error: 'That price is below what the job costs us' });
  const sees = await canSeeCosts(req.user!.role);
  const updated = await prisma.costingQuote.update({
    where: { id: q.id },
    data: { agreedPrice: a.price, approval: a.needsApproval ? 'Pending' : '', approvalNote: '', approvedByName: '', approvedAt: null, status: q.status === 'Draft' ? 'Sent' : q.status },
  });
  res.json(viewOf(updated, sees));
});

// a manager who may see costs decides a price under the floor — never the person who quoted it
async function decide(req: Request, res: Response, approve: boolean) {
  if (!(await canSeeCosts(req.user!.role))) return res.status(403).json({ error: 'A price under the floor is decided by Finance, the General Manager or Admin' });
  const q = await prisma.costingQuote.findUnique({ where: { id: Number(req.params.id) } });
  if (!q) return res.status(404).json({ error: 'Quote not found' });
  if (q.approval !== 'Pending') return res.status(400).json({ error: 'This quote is not waiting for approval' });
  if (q.staffId === req.user!.id) return res.status(400).json({ error: 'You cannot decide a price you quoted yourself' });
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
  if (!approve && reason.length < 3) return res.status(400).json({ error: 'Give a reason for rejecting this price' });
  const updated = await prisma.costingQuote.update({ where: { id: q.id }, data: { approval: approve ? 'Approved' : 'Rejected', approvalNote: reason, approvedByName: req.user!.name, approvedAt: new Date() } });
  res.json(viewOf(updated, true));
}
costingRouter.post('/quotes/:id/approve', mayCost, (req, res) => decide(req, res, true));
costingRouter.post('/quotes/:id/reject', mayCost, (req, res) => decide(req, res, false));

costingRouter.post('/quotes/:id/status', mayCost, async (req, res) => {
  const parsed = z.object({ status: z.enum(['Draft', 'Sent', 'Lost']), reason: z.string().trim().max(300).default('') }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const q = await openQuote(req, res);
  if (!q) return;
  if (q.status === 'Ordered') return res.status(400).json({ error: 'This quote has already been captured as an order' });
  if (parsed.data.status === 'Lost' && parsed.data.reason.length < 3) return res.status(400).json({ error: 'Say why the quote was lost' });
  const updated = await prisma.costingQuote.update({ where: { id: q.id }, data: { status: parsed.data.status, lostReason: parsed.data.status === 'Lost' ? parsed.data.reason : '' } });
  res.json(viewOf(updated, await canSeeCosts(req.user!.role)));
});

// ── the costed job's service on the price list (found by name, or made the first time it is needed)
async function costedService(jobType: string) {
  const name = 'Costed job — ' + costingJobLabel(jobType);
  const found = await prisma.service.findFirst({ where: { name } });
  if (found) return found;
  const head = await prisma.businessHead.findFirst({ where: { name: jobType === 'indoor' || jobType === 'outdoor' ? 'Large Format Printing' : 'General Order' } });
  // contracted out, and kept off the General Order picker (it is only ever used here, at the agreed price)
  return prisma.service.create({ data: { name, item: name, unit: 'piece', price: 0, outsourced: true, soldViaDtfModule: true, businessHeadId: head?.id ?? null } });
}

const captureSchema = z.object({
  customerName: z.string().optional(),
  phone: z.string().optional(),
  staffId: z.number().int().nullable().optional(),
  sourcedBy: z.number().int().nullable().optional(),
  paymentTiming: z.enum(['onAcceptance', 'onCompletion']),
  payments: z.array(paymentLineSchema).max(6).optional(),
});

// the client has accepted: the quote becomes an order at the agreed price
costingRouter.post('/quotes/:id/capture', mayCost, async (req, res) => {
  const body = captureSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid input' });
  const q = await openQuote(req, res);
  if (!q) return;
  if (q.status === 'Ordered') return res.status(400).json({ error: 'This quote is already order ' + q.orderNo });
  if (q.status === 'Lost') return res.status(400).json({ error: 'This quote was marked lost' });
  if (q.agreedPrice == null) return res.status(400).json({ error: 'Record the price agreed with the client first' });
  if (q.approval === 'Pending') return res.status(400).json({ error: 'The agreed price is under the floor and is waiting for a manager’s approval' });
  if (q.approval === 'Rejected') return res.status(400).json({ error: 'The agreed price was not approved — agree another price' });
  const service = await costedService(q.jobType);
  const total = r2(q.agreedPrice * (1 + VAT_RATE));
  const form = walkinSchema.safeParse({
    customerName: body.data.customerName?.trim() || q.clientName,
    phone: body.data.phone ?? q.phone,
    staffId: body.data.staffId ?? q.staffId,
    sourcedBy: body.data.sourcedBy ?? null,
    freelanceAgentId: null, // a freelancer is paid on list prices; a costed job has none, so it is not credited to one
    paymentTiming: body.data.paymentTiming,
    payments: body.data.paymentTiming === 'onAcceptance' ? body.data.payments : undefined,
    // one line for the whole job at the price agreed (VAT included), with what the job costs us (VAT included, as a supplier bills it) kept on it for Finance
    lineItems: [{ itemType: 'service', serviceId: service.id, qty: 1, unitPrice: total, description: q.summary, supplierCost: r2(q.cost * (1 + VAT_RATE)) }],
  });
  if (!form.success) return res.status(400).json({ error: form.error.issues[0]?.message ?? 'Invalid input' });
  const quoteId = q.id;
  return captureWalkin(req, res, form.data, {
    keepCosts: true,
    after: async (tx, order) => {
      const done = await tx.costingQuote.updateMany({ where: { id: quoteId, status: { not: 'Ordered' } }, data: { status: 'Ordered', orderId: order.id, orderNo: order.orderNo } });
      if (done.count !== 1) throw new Error('This quote was captured as an order a moment ago');
    },
  });
});
