import { Router } from 'express';
import { z } from 'zod';
import { EXPENSE_METHODS, GENERAL_MODES, PETTY_CASH_METHOD, TARGET_MODES, bandsProblem, payStepsProblem, clientKeyFor, ownershipEnd, round2, todayStr } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { ensureChartOnce } from '../accounting/chart';
import { pettyCashShortfall } from '../accounting/ledger';
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
  freelanceBands: z.array(bandSchema).min(1).optional(),
  artworkRatePct: z.number().min(0).max(100),
  ownershipMonths: z.number().int().min(1).max(60),
  freelanceOwnershipMonths: z.number().int().min(1).max(60).optional(),
  // Withholding tax deducted from freelance commission (percent; 0 = none)
  freelanceWhtRate: z.number().min(0).max(100).optional(),
  freelancePremiumPct: z.number().min(0).max(100).optional(),
  freelanceLowMarginPct: z.number().min(0).max(100).optional(),
  // The sales target: times their gross monthly salary a person must sell before commission starts (0 = no target), and how the bands then apply.
  targetMultiplier: z.number().min(0).max(20).optional(),
  targetMode: z.enum(TARGET_MODES).optional(),
  // How general sales are paid, the fixed-payout pay bands, and the monthly sales below which performance improvement is required.
  generalMode: z.enum(GENERAL_MODES).optional(),
  payBands: z.array(payBandSchema).min(1).optional(),
  performanceFloor: z.number().min(0).max(1e9).optional(),
});

commissionRouter.put('/settings', manage, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const problem = bandsProblem(d.generalBands, 'General sales bands') ?? bandsProblem(d.filmBands, 'Film premium bands') ?? (d.freelanceBands ? bandsProblem(d.freelanceBands, 'Freelance bands') : null) ?? (d.payBands ? payStepsProblem(d.payBands, 'Pay bands') : null);
  if (problem) return res.status(400).json({ error: problem });
  const sort = (b: { from: number; rate: number }[]) => [...b].sort((x, y) => x.from - y.from);
  const data = {
    generalBandsJson: JSON.stringify(sort(d.generalBands)),
    filmBandsJson: JSON.stringify(sort(d.filmBands)),
    ...(d.freelanceBands ? { freelanceBandsJson: JSON.stringify(sort(d.freelanceBands)) } : {}),
    artworkRatePct: d.artworkRatePct,
    ownershipMonths: d.ownershipMonths,
    ...(d.freelanceOwnershipMonths !== undefined ? { freelanceOwnershipMonths: d.freelanceOwnershipMonths } : {}),
    ...(d.freelanceWhtRate !== undefined ? { freelanceWhtRate: d.freelanceWhtRate } : {}),
    ...(d.freelancePremiumPct !== undefined ? { freelancePremiumPct: d.freelancePremiumPct } : {}),
    ...(d.freelanceLowMarginPct !== undefined ? { freelanceLowMarginPct: d.freelanceLowMarginPct } : {}),
    ...(d.targetMultiplier !== undefined ? { targetMultiplier: d.targetMultiplier } : {}),
    ...(d.targetMode !== undefined ? { targetMode: d.targetMode } : {}),
    ...(d.generalMode !== undefined ? { generalMode: d.generalMode } : {}),
    ...(d.payBands ? { payBandsJson: JSON.stringify([...d.payBands].sort((x, y) => x.from - y.from)) } : {}),
    ...(d.performanceFloor !== undefined ? { performanceFloor: d.performanceFloor } : {}),
    updatedByName: req.user!.name,
  };
  await prisma.commissionSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  res.json(await getCommissionConfig());
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
    clients: clients.map((c) => ({ id: c.id, name: c.clientName, startDate: c.startDate, endDate: c.endDate })),
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
      return { ...s, payout: p ? { id: p.id, status: p.status, amount: p.amount, paidOn: p.paidOn, paidMethod: p.paidMethod } : null };
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
      const commission = round2(pay ? pay.amount : st?.total ?? 0);
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
    data: { clientKey, clientName: clientName || clientKey, staffId: d.staffId, startDate, endDate: ownershipEnd(startDate, cfg.ownershipMonths), note: d.note ?? '', createdByName: req.user!.name },
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
  const out: { staffId: number; staffName: string; amount: number; status: string }[] = [];
  for (const s of statements) {
    if (s.total <= 0) continue;
    const existing = await prisma.commissionPayout.findUnique({ where: { period_staffId: { period: period.data, staffId: s.staffId } } });
    if (existing?.status === 'Paid') {
      out.push({ staffId: s.staffId, staffName: s.staffName, amount: existing.amount, status: 'Paid' });
      continue;
    }
    const data = {
      generalAmount: s.general.commission,
      filmAmount: s.film.commission,
      artworkAmount: s.artwork.commission,
      amount: s.total,
      detailJson: JSON.stringify({ general: s.general, film: s.film, artwork: s.artwork, target: s.target }),
      status: 'Approved',
      approvedByName: req.user!.name,
      approvedAt: new Date(),
    };
    await prisma.commissionPayout.upsert({ where: { period_staffId: { period: period.data, staffId: s.staffId } }, update: data, create: { period: period.data, staffId: s.staffId, ...data } });
    out.push({ staffId: s.staffId, staffName: s.staffName, amount: s.total, status: 'Approved' });
  }
  res.json({ period: period.data, payouts: out });
});

commissionRouter.get('/payouts', manage, async (req, res) => {
  const where = typeof req.query.period === 'string' ? { period: req.query.period } : {};
  const rows = await prisma.commissionPayout.findMany({ where, include: { staff: { select: { name: true } } }, orderBy: [{ period: 'desc' }, { id: 'asc' }], take: 300 });
  res.json(rows.map((r) => ({ id: r.id, period: r.period, staffId: r.staffId, staffName: r.staff.name, amount: r.amount, generalAmount: r.generalAmount, filmAmount: r.filmAmount, artworkAmount: r.artworkAmount, status: r.status, approvedByName: r.approvedByName, paidOn: r.paidOn, paidMethod: r.paidMethod })));
});

const paySchema = z.object({ method: z.enum(EXPENSE_METHODS), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/** Paying records an expense under the Sales Commission head, so it reaches the books and, from petty cash, the float. */
commissionRouter.post('/payouts/:id/pay', manage, async (req, res) => {
  const parsed = paySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const payout = await prisma.commissionPayout.findUnique({ where: { id: Number(req.params.id) }, include: { staff: { select: { name: true } } } });
  if (!payout) return res.status(404).json({ error: 'Not found' });
  if (payout.status === 'Paid') return res.status(400).json({ error: 'Already paid' });
  const date = parsed.data.date ?? todayStr();
  if (parsed.data.method === PETTY_CASH_METHOD) {
    const check = await pettyCashShortfall(payout.amount, date);
    if (check.short) return res.status(400).json({ error: `Insufficient petty cash balance (Ksh ${Math.round(check.available).toLocaleString('en-KE')} available, Ksh ${Math.round(payout.amount).toLocaleString('en-KE')} needed)` });
  }
  await ensureChartOnce();
  const updated = await prisma.$transaction(async (tx) => {
    const expense = await tx.expense.create({
      data: { date, category: 'Sales Commission', amount: payout.amount, supplier: payout.staff.name, note: `Sales commission ${payout.period} — ${payout.staff.name}`, capturedByName: req.user!.name, paid: true, method: parsed.data.method },
    });
    return tx.commissionPayout.update({ where: { id: payout.id }, data: { status: 'Paid', paidOn: date, paidMethod: parsed.data.method, paidByName: req.user!.name, expenseId: expense.id } });
  });
  res.json(updated);
});

/** Takes an approval back (before it is paid) so the month can be recalculated and approved again. */
commissionRouter.delete('/payouts/:id', manage, async (req, res) => {
  const payout = await prisma.commissionPayout.findUnique({ where: { id: Number(req.params.id) } });
  if (!payout) return res.status(404).json({ error: 'Not found' });
  if (payout.status === 'Paid') return res.status(400).json({ error: 'A paid commission cannot be withdrawn' });
  await prisma.commissionPayout.delete({ where: { id: payout.id } });
  res.status(204).end();
});

export { canManageCommission };
