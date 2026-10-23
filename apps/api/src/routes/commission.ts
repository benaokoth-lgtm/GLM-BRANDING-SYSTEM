import { Router } from 'express';
import { registerPhone } from './staffClients';
import { cleanKraPin } from '@glm/shared';
import { payPhone, settleCommissionPayout } from '../contractorPay';
import { backToApproved, sendCommissionPayoutToPhone } from '../mpesaB2c';
import { z } from 'zod';
import { EXPENSE_METHODS, GENERAL_MODES, VAT_RATE, artworkPremiumCommission, computePay, filmPremiumCommission, PETTY_CASH_METHOD, TARGET_MODES, bandsProblem, payStepsProblem, clientKeyFor, ownershipEnd, round2, todayStr } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import { ensureChartOnce } from '../accounting/chart';
import { pettyCashShortfall } from '../accounting/ledger';
import type { StaffStatement } from '../commission';
import { activeFreelanceOwner, activeOwner, blankStatement, buildStatements, canManageCommission, commissionEnabled, ensureCommissionAccessOnce, getCommissionConfig, targetFor } from '../commission';

// Staff sales commission. Everyone who captures orders can see their own statement and the scheme they are paid under;
// managers (canManageCommission) see everyone's, set the rates, manage who owns which client, and approve and pay.
export const commissionRouter = Router();
commissionRouter.use(requireAuth, async (_req, _res, next) => {
  await ensureCommissionAccessOnce();
  next();
});

// While the scheme is switched off nothing here is available (an Admin switches it on in Master Data → Company Info).
commissionRouter.use(async (_req, res, next) => {
  if (!(await commissionEnabled())) return res.status(403).json({ error: 'Commission is switched off. An Admin can switch it on in Master Data → Company Info.', commissionOff: true });
  next();
});

const manage = requirePermission('canManageCommission');
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Period must be YYYY-MM');
const thisMonth = () => todayStr().slice(0, 7);

// ── Settings ────────────────────────────────────────────────────────────────
commissionRouter.get('/settings', async (_req, res) => {
  res.json(await getCommissionConfig());
});

const bandSchema = z.object({ from: z.number().min(0), rate: z.number().min(0).max(100) });
const payBandSchema = z.object({ from: z.number().min(0), payout: z.number().min(0).max(1e9) });
const settingsSchema = z.object({
  generalBands: z.array(bandSchema).min(1),
  filmBands: z.array(bandSchema).min(1),
  // Freelance sales persons — weekly net sales received at or above base prices → rate
  artworkRatePct: z.number().min(0).max(100),
  ownershipMonths: z.number().int().min(1).max(60),
  freelanceOwnershipMonths: z.number().int().min(1).max(60).optional(),
  // Withholding tax deducted from freelance commission (percent; 0 = none)
  freelanceWhtRate: z.number().min(0).max(100).optional(),
  freelanceRatePct: z.number().min(0).max(30).optional(),
  freelanceLowRatePct: z.number().min(0).max(30).optional(),
  // The sales target: times their gross monthly salary a person must sell before commission starts (0 = no target), and how the bands then apply.
  targetMultiplier: z.number().min(0).max(20).optional(),
  targetMode: z.enum(TARGET_MODES).optional(),
  // How general sales are paid, the fixed-payout pay bands, and the monthly sales below which performance improvement is required.
  generalMode: z.enum(GENERAL_MODES).optional(),
  payBands: z.array(payBandSchema).min(1).optional(),
  performanceFloor: z.number().min(0).max(1e9).optional(),
  // The least a person on the pay bands is paid for a month (a band payout below it is topped up to it).
  minimumWage: z.number().min(0).max(1e9).optional(),
  // The day of the month people on the pay bands are paid, for the month before (1–28 so it exists in every month).
  payday: z.number().int().min(1).max(28).optional(),
  // The first month sales persons are paid as contractors (withholding tax on the month's total, outside payroll); blank = not switched on.
  contractorFrom: z.union([z.literal(''), z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'The month must be YYYY-MM')]).optional(),
});

// The rates — the pay bands, minimum wage, percentages, ownership periods — are set by an Admin only. Managers and staff can read them (everyone sees the scheme they are paid under).
commissionRouter.put('/settings', requireRole('Admin'), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const problem = bandsProblem(d.generalBands, 'General sales bands') ?? bandsProblem(d.filmBands, 'Film premium bands') ?? (d.payBands ? payStepsProblem(d.payBands, 'Pay bands') : null);
  if (problem) return res.status(400).json({ error: problem });
  const sort = (b: { from: number; rate: number }[]) => [...b].sort((x, y) => x.from - y.from);
  const data = {
    generalBandsJson: JSON.stringify(sort(d.generalBands)),
    filmBandsJson: JSON.stringify(sort(d.filmBands)),
    artworkRatePct: d.artworkRatePct,
    ownershipMonths: d.ownershipMonths,
    ...(d.freelanceOwnershipMonths !== undefined ? { freelanceOwnershipMonths: d.freelanceOwnershipMonths } : {}),
    ...(d.freelanceWhtRate !== undefined ? { freelanceWhtRate: d.freelanceWhtRate } : {}),
    ...(d.freelanceRatePct !== undefined ? { freelanceRatePct: d.freelanceRatePct } : {}),
    ...(d.freelanceLowRatePct !== undefined ? { freelanceLowRatePct: d.freelanceLowRatePct } : {}),
    ...(d.targetMultiplier !== undefined ? { targetMultiplier: d.targetMultiplier } : {}),
    ...(d.targetMode !== undefined ? { targetMode: d.targetMode } : {}),
    ...(d.generalMode !== undefined ? { generalMode: d.generalMode } : {}),
    ...(d.payBands ? { payBandsJson: JSON.stringify([...d.payBands].sort((x, y) => x.from - y.from)) } : {}),
    ...(d.performanceFloor !== undefined ? { performanceFloor: d.performanceFloor } : {}),
    ...(d.minimumWage !== undefined ? { minimumWage: d.minimumWage } : {}),
    ...(d.payday !== undefined ? { payday: d.payday } : {}),
    ...(d.contractorFrom !== undefined ? { contractorFrom: d.contractorFrom } : {}),
    updatedByName: req.user!.name,
  };
  await prisma.commissionSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  res.json(await getCommissionConfig());
});

// The freelance sales persons' commission on its own (Commission → Freelancers → Rates): the flat rate (% of net sales received, VAT out), the lower rate on thin-margin lines, how long a client stays
// theirs, and the tax withheld. A change applies from the moment it is saved: a week is worked out at the rates in force when it is approved, so an approved or paid week keeps its amount. Admin only;
// managers and staff can read the rates. Every change is in the audit trail (Master Data → Security).
const freelanceRatesSchema = z
  .object({
    freelanceRatePct: z.number().min(0, 'The rate cannot be below 0').max(30, 'The rate cannot be above 30%'),
    freelanceLowRatePct: z.number().min(0, 'The low rate cannot be below 0').max(30, 'The low rate cannot be above 30%'),
    freelanceOwnershipMonths: z.number().int().min(1).max(60),
    freelanceWhtRate: z.number().min(0).max(100),
  })
  .refine((d) => d.freelanceLowRatePct <= d.freelanceRatePct, { message: 'The low rate (thin-margin lines) cannot be more than the standard rate' });
commissionRouter.put('/freelance-settings', requireRole('Admin'), async (req, res) => {
  const parsed = freelanceRatesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const data = {
    freelanceRatePct: d.freelanceRatePct,
    freelanceLowRatePct: d.freelanceLowRatePct,
    freelanceOwnershipMonths: d.freelanceOwnershipMonths,
    freelanceWhtRate: d.freelanceWhtRate,
    updatedByName: req.user!.name,
  };
  await prisma.commissionSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  res.json(await getCommissionConfig());
});

// ── The pay guide ───────────────────────────────────────────────────────────
// Everything the employee pay guide needs, built from the CURRENT settings — the bands, floor, minimum wage and payday — so changing the bands in Rates changes the guide
// (and every screen that shows them) with nothing else to update. The take-home examples are worked out by the payroll's own rules for each pay level.
commissionRouter.get('/pay-guide', async (_req, res) => {
  const config = await getCommissionConfig();
  const dtf = await prisma.dtfSetting.findUnique({ where: { id: 1 } });
  const filmBase = dtf?.minPricePerM ?? 400;
  const today = todayStr();
  const sorted = [...config.payBands].sort((a, b) => a.from - b.from);
  const levels: { gross: number; label: string }[] = [{ gross: config.minimumWage, label: 'Minimum wage' }];
  sorted.forEach((b, i) => {
    if (b.payout > config.minimumWage && !levels.some((l) => Math.abs(l.gross - b.payout) < 0.005)) levels.push({ gross: b.payout, label: `Band ${i}` });
  });
  const examples = levels.map((l) => {
    const c = computePay(l.gross, 'Employee', today);
    return { gross: round2(l.gross), label: l.label, nssf: round2(c.nssf), shif: round2(c.shif), housingLevy: round2(c.housingLevy), paye: round2(c.paye), net: round2(c.netPay) };
  });
  const filmMetres = 10;
  const film = {
    base: filmBase,
    metres: filmMetres,
    highPrice: filmBase + 200,
    highEarns: filmPremiumCommission(filmMetres, filmBase + 200, filmBase, config.filmBands, VAT_RATE),
    lowPrice: filmBase + 50,
    lowEarns: filmPremiumCommission(filmMetres, filmBase + 50, filmBase, config.filmBands, VAT_RATE),
  };
  const artwork = { pieces: 100, recommended: 40, charged: 45, earns: artworkPremiumCommission(100, 45, 40, config.artworkRatePct, VAT_RATE) };
  res.json({ config, vatRate: VAT_RATE, examples, film, artwork });
});

// ── Statements ──────────────────────────────────────────────────────────────
commissionRouter.get('/my', async (req, res) => {
  const period = periodSchema.safeParse(req.query.period ?? thisMonth());
  if (!period.success) return res.status(400).json({ error: period.error.issues[0]?.message });
  const { config, statements } = await buildStatements(period.data, req.user!.id);
  const mine = statements[0] ?? blankStatement(req.user!.id, req.user!.name, await targetFor(req.user!.id, period.data, config));
  const payout = await prisma.commissionPayout.findUnique({ where: { period_staffId: { period: period.data, staffId: req.user!.id } } });
  const clients = await prisma.clientOwner.findMany({ where: { staffId: req.user!.id, status: 'Active', endDate: { gte: todayStr() } }, orderBy: { endDate: 'asc' } });
  res.json({
    period: period.data,
    config,
    statement: mine,
    payout: payout ? { status: payout.status, amount: payout.amount, paidOn: payout.paidOn } : null,
    clients: clients.map((c) => ({ id: c.id, name: c.clientName, phone: registerPhone(c), startDate: c.startDate, endDate: c.endDate })),
  });
});

commissionRouter.get('/statement', manage, async (req, res) => {
  const period = periodSchema.safeParse(req.query.period ?? thisMonth());
  if (!period.success) return res.status(400).json({ error: period.error.issues[0]?.message });
  const { config, statements } = await buildStatements(period.data);
  const payouts = await prisma.commissionPayout.findMany({ where: { period: period.data } });
  const byStaff = new Map(payouts.map((p) => [p.staffId, p]));
  res.json({
    period: period.data,
    open: period.data >= thisMonth(), // the month is not over, so more money may still arrive
    config,
    statements: statements.map((s) => {
      const p = byStaff.get(s.staffId);
      return { ...s, payout: p ? { id: p.id, status: p.status, amount: p.amount, paidOn: p.paidOn, paidMethod: p.paidMethod, contractor: p.contractor, withholdingTax: p.withholdingTax, net: round2(p.amount - p.withholdingTax), receipt: p.receipt } : null };
    }),
    totals: { commission: round2(statements.reduce((a, s) => a + s.total, 0)) },
  });
});

// ── Month by month ──────────────────────────────────────────────────────────
// For a year: each month, each person's sales (net of VAT, money received this month on what counts towards the target), the target they had, what they earned in commission,
// what has been paid and what is still to pay. A month that has been approved or paid shows the amount approved (the figure that is actually owed); an earlier month nobody has
// approved yet, and the current month, show what has been earned so far (provisional). Staff only: freelance sales persons are paid weekly from their own accounts.
commissionRouter.get('/monthly', manage, async (req, res) => {
  const year = String(req.query.year ?? todayStr().slice(0, 4));
  if (!/^[0-9]{4}$/.test(year)) return res.status(400).json({ error: 'Year must be YYYY' });
  const current = thisMonth();
  const periods = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).filter((p) => p <= current);
  const [built, payouts] = await Promise.all([
    Promise.all(periods.map((p) => buildStatements(p))),
    prisma.commissionPayout.findMany({ where: { period: { startsWith: `${year}-` } }, include: { staff: { select: { name: true } } } }),
  ]);

  type Row = { staffId: number; staffName: string; sales: number; target: { applies: boolean; required: number; met: boolean; salaryKnown: boolean }; belowFloor: boolean; band: number | null; commission: number; provisional: boolean; paid: number; outstanding: number; status: 'Paid' | 'Approved' | 'Not approved' | '—'; paidOn: string | null };
  const months = periods.map((period, i) => {
    const statements = built[i]!.statements;
    const pays = payouts.filter((x) => x.period === period);
    const ids = new Set([...statements.map((x) => x.staffId), ...pays.map((x) => x.staffId)]);
    const rows: Row[] = [...ids].map((staffId) => {
      const st = statements.find((x) => x.staffId === staffId);
      const pay = pays.find((x) => x.staffId === staffId);
      const commission = round2(pay ? pay.amount : st?.pay.amount ?? 0);
      const paid = pay?.status === 'Paid' ? round2(pay.amount) : 0;
      return {
        staffId,
        staffName: st?.staffName ?? pay?.staff.name ?? `Staff #${staffId}`,
        sales: round2(st?.target.achieved ?? 0),
        target: { applies: !!st?.target.applies, required: round2(st?.target.required ?? 0), met: !!st?.target.met, salaryKnown: st?.target.salaryKnown ?? true },
        belowFloor: !!st?.scheme.belowFloor,
        band: st?.scheme.step ? st.scheme.step.index : null,
        commission,
        provisional: !pay,
        paid,
        outstanding: round2(Math.max(0, commission - paid)),
        status: pay ? (pay.status === 'Paid' ? 'Paid' : 'Approved') : commission > 0 ? 'Not approved' : '—',
        paidOn: pay?.paidOn ?? null,
      };
    });
    rows.sort((a, b) => b.commission - a.commission || b.sales - a.sales || a.staffName.localeCompare(b.staffName));
    const sum = (f: (r: Row) => number) => round2(rows.reduce((a, r) => a + f(r), 0));
    return { period, open: period >= current, rows, totals: { sales: sum((r) => r.sales), commission: sum((r) => r.commission), paid: sum((r) => r.paid), outstanding: sum((r) => r.outstanding) } };
  });

  // each person over the year
  const byStaff = new Map<number, { staffId: number; staffName: string; sales: number; commission: number; paid: number; outstanding: number; monthsTargetMet: number; monthsWithTarget: number }>();
  for (const m of months) {
    for (const r of m.rows) {
      const y = byStaff.get(r.staffId) ?? { staffId: r.staffId, staffName: r.staffName, sales: 0, commission: 0, paid: 0, outstanding: 0, monthsTargetMet: 0, monthsWithTarget: 0 };
      y.sales = round2(y.sales + r.sales);
      y.commission = round2(y.commission + r.commission);
      y.paid = round2(y.paid + r.paid);
      y.outstanding = round2(y.outstanding + r.outstanding);
      if (r.target.applies) y.monthsWithTarget++;
      if (r.target.applies && r.target.met) y.monthsTargetMet++;
      byStaff.set(r.staffId, y);
    }
  }
  const staff = [...byStaff.values()].sort((a, b) => b.commission - a.commission || b.sales - a.sales || a.staffName.localeCompare(b.staffName));
  const total = (f: (m: (typeof months)[number]['totals']) => number) => round2(months.reduce((a, m) => a + f(m.totals), 0));
  res.json({ year, months, staff, totals: { sales: total((t) => t.sales), commission: total((t) => t.commission), paid: total((t) => t.paid), outstanding: total((t) => t.outstanding) } });
});

// ── Client ownership ────────────────────────────────────────────────────────
const lookupSchema = z.object({
  corporateClientId: z.coerce.number().int().optional(),
  phone: z.string().optional(),
  name: z.string().optional(),
});

/** At order capture: is this client already credited to someone? (Used to show who, and to explain why a claim won't take.) */
commissionRouter.get('/owner-lookup', async (req, res) => {
  const q = lookupSchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'Invalid input' });
  const clientKey = clientKeyFor({ corporateClientId: q.data.corporateClientId, phone: q.data.phone, name: q.data.name });
  const months = (await getCommissionConfig()).ownershipMonths;
  if (!clientKey) return res.json({ clientKey: null, months, owner: null, freelanceOwner: null });
  const owner = await activeOwner(prisma, clientKey);
  const fo = owner ? null : await activeFreelanceOwner(prisma, clientKey);
  res.json({
    clientKey,
    months,
    owner: owner ? { staffId: owner.staffId, staffName: owner.staffName, endDate: owner.endDate, mine: owner.staffId === req.user!.id } : null,
    // a freelance sales person who keeps bringing this client: the order is credited to them whoever captures it
    freelanceOwner: fo ? { agentId: fo.agentId, agentName: fo.agentName, until: fo.until } : null,
  });
});

commissionRouter.get('/clients', manage, async (req, res) => {
  const all = req.query.status === 'all';
  const today = todayStr();
  const rows = await prisma.clientOwner.findMany({
    where: all ? {} : { status: 'Active', endDate: { gte: today } },
    include: { staff: { select: { name: true } } },
    orderBy: [{ endDate: 'asc' }, { id: 'desc' }],
    take: 500,
  });
  res.json(
    rows.map((r) => ({
      id: r.id,
      clientKey: r.clientKey,
      clientName: r.clientName,
      phone: registerPhone(r),
      staffId: r.staffId,
      staffName: r.staff.name,
      startDate: r.startDate,
      endDate: r.endDate,
      status: r.status === 'Active' && r.endDate < today ? 'Expired' : r.status,
      note: r.note,
      createdByName: r.createdByName,
    })),
  );
});

const assignSchema = z.object({
  staffId: z.number().int(),
  corporateClientId: z.number().int().optional(),
  name: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(200).optional(),
});

/** A manager credits a client to a staff member by hand — for clients someone brought in before this was tracked. */
commissionRouter.post('/clients', manage, async (req, res) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const clientKey = clientKeyFor({ corporateClientId: d.corporateClientId, phone: d.phone, name: d.name });
  if (!clientKey) return res.status(400).json({ error: 'Pick a corporate client, or give the client’s phone number or full name' });
  const staff = await prisma.user.findUnique({ where: { id: d.staffId } });
  if (!staff) return res.status(400).json({ error: 'Staff member not found' });
  const owner = await activeOwner(prisma, clientKey);
  if (owner) return res.status(409).json({ error: `This client is already credited to ${owner.staffName} until ${owner.endDate}. Clients are not shared — release them first.` });
  let clientName = d.name?.trim() || '';
  if (d.corporateClientId) {
    const c = await prisma.corporateClient.findUnique({ where: { id: d.corporateClientId } });
    if (!c) return res.status(400).json({ error: 'Corporate client not found' });
    clientName = c.name;
  }
  const cfg = await getCommissionConfig();
  const startDate = d.startDate ?? todayStr();
  const row = await prisma.clientOwner.create({
    data: { clientKey, clientName: clientName || clientKey, phone: d.phone ?? '', staffId: d.staffId, startDate, endDate: ownershipEnd(startDate, cfg.ownershipMonths), note: d.note ?? '', createdByName: req.user!.name },
  });
  res.status(201).json(row);
});

commissionRouter.post('/clients/:id/release', manage, async (req, res) => {
  const row = await prisma.clientOwner.findUnique({ where: { id: Number(req.params.id) } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'Active') return res.status(400).json({ error: 'Already released' });
  res.json(await prisma.clientOwner.update({ where: { id: row.id }, data: { status: 'Released', releasedOn: todayStr(), releasedBy: req.user!.name } }));
});

// ── Payouts: approve a month, then pay it ───────────────────────────────────
commissionRouter.post('/payouts/approve', manage, async (req, res) => {
  const period = periodSchema.safeParse((req.body as { period?: string }).period);
  if (!period.success) return res.status(400).json({ error: period.error.issues[0]?.message });
  const { statements } = await buildStatements(period.data);
  const out: { staffId: number; staffName: string; amount: number; status: string; inPayroll?: boolean; topUp?: number; note?: string }[] = [];
  for (const s of statements) {
    // Someone paid on the pay bands: their pay (never below the minimum wage) goes into payroll, which is how they are paid — no separate commission payment.
    if (s.pay.onBands) {
      out.push(await putInPayroll(s, period.data, req.user!.name));
      continue;
    }
    const contractor = !!s.pay.contractor;
    const gross = contractor ? s.pay.amount : s.total;
    if (gross <= 0) continue;
    const existing = await prisma.commissionPayout.findUnique({ where: { period_staffId: { period: period.data, staffId: s.staffId } } });
    if (existing?.status === 'Paid' || existing?.status === 'Sending') {
      out.push({ staffId: s.staffId, staffName: s.staffName, amount: existing.amount, status: existing.status });
      continue;
    }
    // A contractor's month is approved once it is over (the pay, and the tax withheld from it, are for the whole month).
    if (contractor && period.data >= thisMonth()) {
      out.push({ staffId: s.staffId, staffName: s.staffName, amount: gross, status: 'Waiting', note: 'the month is not over yet' });
      continue;
    }
    const data = {
      generalAmount: s.general.commission,
      filmAmount: s.film.commission,
      artworkAmount: s.artwork.commission,
      amount: gross,
      detailJson: JSON.stringify({ general: s.general, film: s.film, artwork: s.artwork, target: s.target, ...(contractor ? { scheme: s.scheme, pay: s.pay } : {}) }),
      status: 'Approved',
      approvedByName: req.user!.name,
      approvedAt: new Date(),
      contractor,
      withholdingRate: contractor ? s.pay.whtRate ?? 0 : 0,
      withholdingTax: contractor ? s.pay.withholdingTax ?? 0 : 0,
    };
    await prisma.commissionPayout.upsert({ where: { period_staffId: { period: period.data, staffId: s.staffId } }, update: data, create: { period: period.data, staffId: s.staffId, ...data } });
    out.push({ staffId: s.staffId, staffName: s.staffName, amount: gross, status: 'Approved' });
  }
  res.json({ period: period.data, payouts: out });
});

/** Last day of a 'YYYY-MM' month. */
const monthEnd = (period: string) => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/**
 * Puts a month's pay for someone on the pay bands into payroll, once the month is over: one payroll entry dated the last day of the sales month (so its PAYE, NSSF, SHIF
 * and housing levy fall in that month's Payments due), for what they earned or the minimum wage if that is more. Wages leave petty cash like every payroll entry, so
 * the float has to cover the net pay. The commission payout is recorded as paid through payroll. Safe to repeat: a month already in payroll is left alone.
 */
async function putInPayroll(s: StaffStatement, period: string, byName: string) {
  const base = { staffId: s.staffId, staffName: s.staffName, amount: s.pay.amount, inPayroll: true, topUp: s.pay.topUp };
  const existing = await prisma.commissionPayout.findUnique({ where: { period_staffId: { period, staffId: s.staffId } } });
  if (existing?.status === 'Paid') return { ...base, amount: existing.amount, status: 'Paid' };
  if (period >= thisMonth()) return { ...base, status: 'Waiting', note: 'the month is not over yet' };
  if (!(s.pay.amount > 0)) return { ...base, status: 'Nothing to pay', note: 'no minimum wage is set' };
  const date = monthEnd(period);
  const net = computePay(s.pay.amount, 'Employee', date).netPay;
  const check = await pettyCashShortfall(net, date);
  if (check.short) return { ...base, status: 'Petty cash short', note: `petty cash cannot cover the net pay of Ksh ${Math.round(net).toLocaleString('en-KE')} (Ksh ${Math.round(check.available).toLocaleString('en-KE')} available)` };
  const today = todayStr();
  const data = {
    generalAmount: s.general.commission,
    filmAmount: s.film.commission,
    artworkAmount: s.artwork.commission,
    amount: s.pay.amount,
    detailJson: JSON.stringify({ general: s.general, film: s.film, artwork: s.artwork, scheme: s.scheme, pay: s.pay }),
    status: 'Paid',
    approvedByName: byName,
    approvedAt: new Date(),
    paidOn: today,
    paidMethod: 'Payroll',
    paidByName: byName,
  };
  await prisma.$transaction(async (tx) => {
    const entry = await tx.payrollEntry.findFirst({ where: { staffId: s.staffId, salesPeriod: period } });
    if (entry) await tx.payrollEntry.update({ where: { id: entry.id }, data: { grossPay: s.pay.amount } });
    else await tx.payrollEntry.create({ data: { date, staffId: s.staffId, employeeType: 'Employee', department: '', grossPay: s.pay.amount, paymentSource: PETTY_CASH_METHOD, capturedByName: byName, salesPeriod: period } });
    await tx.commissionPayout.upsert({ where: { period_staffId: { period, staffId: s.staffId } }, update: data, create: { period, staffId: s.staffId, ...data } });
  });
  return { ...base, status: 'Paid' };
}

commissionRouter.get('/payouts', manage, async (req, res) => {
  const where = typeof req.query.period === 'string' ? { period: req.query.period } : {};
  const rows = await prisma.commissionPayout.findMany({ where, include: { staff: { select: { name: true } } }, orderBy: [{ period: 'desc' }, { id: 'asc' }], take: 300 });
  res.json(rows.map((r) => ({ id: r.id, period: r.period, staffId: r.staffId, staffName: r.staff.name, amount: r.amount, generalAmount: r.generalAmount, filmAmount: r.filmAmount, artworkAmount: r.artworkAmount, status: r.status, approvedByName: r.approvedByName, paidOn: r.paidOn, paidMethod: r.paidMethod, contractor: r.contractor, withholdingRate: r.withholdingRate, withholdingTax: r.withholdingTax, net: round2(r.amount - r.withholdingTax), receipt: r.receipt })));
});

const paySchema = z.object({ method: z.enum(EXPENSE_METHODS), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reference: z.string().trim().max(60).optional() });

/** Paying records an expense under the Sales Commission head, so it reaches the books and, from petty cash, the float. */
commissionRouter.post('/payouts/:id/pay', manage, async (req, res) => {
  const parsed = paySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const payout = await prisma.commissionPayout.findUnique({ where: { id: Number(req.params.id) }, include: { staff: { select: { name: true } } } });
  if (!payout) return res.status(404).json({ error: 'Not found' });
  if (payout.status === 'Paid') return res.status(400).json({ error: 'Already paid' });
  if (payout.status === 'Sending') return res.status(400).json({ error: 'A payment to their phone is already on its way — wait for Safaricom’s answer, or settle that attempt first' });
  const date = parsed.data.date ?? todayStr();
  // only what is paid out of the float: the commission less the tax withheld
  const pays = round2(payout.amount - payout.withholdingTax);
  if (parsed.data.method === PETTY_CASH_METHOD) {
    const check = await pettyCashShortfall(pays, date);
    if (check.short) return res.status(400).json({ error: `Insufficient petty cash balance (Ksh ${Math.round(check.available).toLocaleString('en-KE')} available, Ksh ${Math.round(payout.amount).toLocaleString('en-KE')} needed)` });
  }
  await ensureChartOnce();
  // one place settles a payout (the expense with the tax withheld, and the payout marked Paid) — the same for a payment by hand and one sent to their phone
  const updated = await prisma.$transaction((tx) => settleCommissionPayout(tx, payout.id, { method: parsed.data.method, date, byName: req.user!.name, receipt: parsed.data.reference ?? null }));
  res.json(updated);
});

// ── Sending a sales person's pay to their M-Pesa phone ───────────────────────
// An STK push asks a customer to pay US; to pay someone we ask Safaricom (Daraja B2C) to send money from our Paybill to their number. Safaricom accepts the request at once and reports the real
// outcome a moment later; only then is the payout marked Paid and the expense booked. A failed or timed-out attempt leaves the payout approved, ready to be sent again.
commissionRouter.post('/payouts/:id/send-mpesa', manage, async (req, res) => {
  const r = await sendCommissionPayoutToPhone(Number(req.params.id), req.user!.name);
  if (!r.ok) return res.status(400).json({ error: r.error, disbursementId: r.disbursementId });
  res.status(202).json({ ok: true, disbursementId: r.disbursementId, message: 'Sent to M-Pesa — it is marked paid when Safaricom confirms it.' });
});

commissionRouter.get('/payouts/:id/disbursements', manage, async (req, res) => {
  const rows = await prisma.mpesaDisbursement.findMany({ where: { commissionPayoutId: Number(req.params.id) }, orderBy: { id: 'desc' } });
  res.json(rows.map((d) => ({ id: d.id, status: d.status, amount: d.amount, phone: d.phone, resultDesc: d.resultDesc, receipt: d.receipt, requestedByName: d.requestedByName, createdAt: d.createdAt, completedAt: d.completedAt })));
});

// If Safaricom's answer never arrives a manager settles the attempt by hand, after checking the Paybill's own statement: it was NOT sent (so it can be tried again), or it WAS (with the M-Pesa receipt code).
commissionRouter.post('/disbursements/:id/resolve', manage, async (req, res) => {
  const parsed = z.object({ outcome: z.enum(['failed', 'sent']), receipt: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'Enter the M-Pesa receipt code (10 letters and numbers)').optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = await prisma.mpesaDisbursement.findUnique({ where: { id: Number(req.params.id) } });
  if (!d || !d.commissionPayoutId) return res.status(404).json({ error: 'Not found' });
  if (d.status !== 'Pending') return res.status(400).json({ error: 'This attempt has already been settled' });
  if (parsed.data.outcome === 'failed') {
    await prisma.$transaction([
      prisma.mpesaDisbursement.update({ where: { id: d.id }, data: { status: 'Failed', resultDesc: `Marked as not sent by ${req.user!.name}`, completedAt: new Date() } }),
      backToApproved(d),
    ]);
    return res.json({ ok: true });
  }
  const receipt = parsed.data.receipt;
  if (!receipt) return res.status(400).json({ error: 'Enter the M-Pesa receipt code from the Paybill statement' });
  if (await prisma.mpesaDisbursement.findUnique({ where: { receipt } })) return res.status(400).json({ error: `${receipt} is already on record against another payment` });
  await ensureChartOnce();
  await prisma.$transaction(async (tx) => {
    await tx.mpesaDisbursement.update({ where: { id: d.id }, data: { status: 'Success', receipt, resultDesc: `Confirmed by hand by ${req.user!.name}`, completedAt: new Date() } });
    await settleCommissionPayout(tx, d.commissionPayoutId!, { method: 'M-Pesa', byName: req.user!.name, receipt, paidOut: d.amount });
  });
  res.json({ ok: true });
});

// ── Pay details of the sales persons (Commission → Pay details) ───────────────
// Who is paid as a contractor, where their money goes, the withholding tax rate that applies to them and whether a month below the minimum wage is topped up (off unless switched on for the
// person). Their KRA PIN and National ID are the ones on their staff record, set here too. Managers see and change them; the standard rate and the month it starts are in the settings (Admin).
async function salesPersonRows() {
  const roles = await prisma.role.findMany({ where: { canBeAssignedOrders: true }, select: { name: true } });
  if (roles.length === 0) return [];
  return prisma.user.findMany({ where: { active: true, role: { in: roles.map((r) => r.name) } }, include: { contractorProfile: true }, orderBy: { name: 'asc' } });
}

commissionRouter.get('/contractors', manage, async (_req, res) => {
  const [people, cfg] = await Promise.all([salesPersonRows(), getCommissionConfig()]);
  res.json({
    standardWhtRate: cfg.freelanceWhtRate,
    contractorFrom: cfg.contractorFrom,
    people: people.map((u) => {
      const p = u.contractorProfile;
      const missing = [!u.kraPin && 'KRA PIN', !u.nationalId && 'National ID', !payPhone(p) && 'M-Pesa number'].filter(Boolean);
      return {
        staffId: u.id,
        name: u.name,
        role: u.role,
        kraPin: u.kraPin ?? '',
        nationalId: u.nationalId ?? '',
        phone: p?.phone ?? '',
        mpesaNumber: p?.mpesaNumber ?? '',
        payMethod: p?.payMethod ?? 'M-Pesa',
        bankName: p?.bankName ?? '',
        bankAccount: p?.bankAccount ?? '',
        whtRate: p?.whtRate ?? null,
        effectiveWhtRate: p?.whtRate ?? cfg.freelanceWhtRate,
        minWageFloor: p?.minWageFloor ?? false,
        // Captures their own orders (and the front office may capture for them too); switched off, only the front office captures for them (Master Data → Staff & Users has the same switch).
        capturesOwn: !u.orderTakingOff,
        note: p?.note ?? '',
        missing,
      };
    }),
  });
});

const contractorSchema = z.object({
  kraPin: z.string().trim().max(40).optional(),
  nationalId: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(20).optional(),
  mpesaNumber: z.string().trim().max(20).optional(),
  payMethod: z.enum(EXPENSE_METHODS).optional(),
  bankName: z.string().trim().max(80).optional(),
  bankAccount: z.string().trim().max(60).optional(),
  whtRate: z.number().min(0).max(100).nullable().optional(), // null = the standard rate; 0 = exempt
  minWageFloor: z.boolean().optional(),
  capturesOwn: z.boolean().optional(),
  note: z.string().trim().max(300).optional(),
});

commissionRouter.put('/contractors/:staffId', manage, async (req, res) => {
  const parsed = contractorSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const staffId = Number(req.params.staffId);
  const user = (await salesPersonRows()).find((u) => u.id === staffId);
  if (!user) return res.status(404).json({ error: 'That is not a sales person' });
  const { kraPin, nationalId, capturesOwn, ...profile } = parsed.data;
  for (const k of ['phone', 'mpesaNumber'] as const) {
    const v = profile[k];
    if (v && !payPhone({ [k]: v })) return res.status(400).json({ error: `${k === 'phone' ? 'The phone' : 'The M-Pesa number'} must be a Kenyan mobile number (07… or 2547…)` });
  }
  // KRA PIN and National ID live on the staff record (unique among staff)
  const userData: { kraPin?: string | null; nationalId?: string | null; orderTakingOff?: boolean } = {};
  if (capturesOwn !== undefined) userData.orderTakingOff = !capturesOwn;
  if (kraPin !== undefined) {
    const c = cleanKraPin(kraPin);
    if (c.error) return res.status(400).json({ error: c.error });
    if (c.value && (await prisma.user.findFirst({ where: { kraPin: c.value, id: { not: staffId } } }))) return res.status(400).json({ error: 'That KRA PIN is already on another staff member' });
    userData.kraPin = c.value ?? null;
  }
  if (nationalId !== undefined) {
    if (nationalId && !/^\d{7,8}$/.test(nationalId)) return res.status(400).json({ error: 'A National ID is 7 or 8 digits' });
    if (nationalId && (await prisma.user.findFirst({ where: { nationalId, id: { not: staffId } } }))) return res.status(400).json({ error: 'That National ID is already on another staff member' });
    userData.nationalId = nationalId || null;
  }
  const norm = (v?: string) => (v ? payPhone({ phone: v }) ?? v : v);
  const data = { ...profile, ...(profile.phone !== undefined ? { phone: norm(profile.phone) ?? '' } : {}), ...(profile.mpesaNumber !== undefined ? { mpesaNumber: norm(profile.mpesaNumber) ?? '' } : {}), updatedByName: req.user!.name };
  await prisma.$transaction(async (tx) => {
    if (Object.keys(userData).length) await tx.user.update({ where: { id: staffId }, data: userData });
    await tx.contractorProfile.upsert({ where: { staffId }, create: { staffId, ...data }, update: data });
  });
  res.json({ ok: true });
});

/** Takes an approval back (before it is paid) so the month can be recalculated and approved again. */
commissionRouter.delete('/payouts/:id', manage, async (req, res) => {
  const payout = await prisma.commissionPayout.findUnique({ where: { id: Number(req.params.id) } });
  if (!payout) return res.status(404).json({ error: 'Not found' });
  if (payout.status === 'Paid') return res.status(400).json({ error: 'A paid commission cannot be withdrawn' });
  if (payout.status === 'Sending') return res.status(400).json({ error: 'A payment to their phone is on its way — it cannot be withdrawn now' });
  await prisma.commissionPayout.delete({ where: { id: payout.id } });
  res.status(204).end();
});

export { canManageCommission };
