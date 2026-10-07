// Freelance sales persons — people outside the staff who bring us work. They are credited on the orders marked for their account (never on an order
// that is credited to a staff member), paid weekly in marginal bands on the sales they bring at or above our base prices, and have an account showing what
// they have earned and been paid. Anyone who captures orders can pick or add one at order capture (a new one waits for a manager's approval before it is
// paid); managers (Commission permission) approve them, approve each week's commission and pay it.
import { Router } from 'express';
import { z } from 'zod';
import { EXPENSE_METHODS, PETTY_CASH_METHOD, addWeeks, cleanKraPin, cleanNationalId, round2, todayStr, weekEnd, weekStart, whatsappNumber } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requirePermission, userHasPermission } from '../middleware/auth';
import { ensureChartOnce } from '../accounting/chart';
import { pettyCashShortfall } from '../accounting/ledger';
import { buildFreelanceStatements, commissionEnabled, getCommissionConfig } from '../commission';

export const freelanceRouter = Router();
freelanceRouter.use(requireAuth, async (_req, res, next) => {
  if (!(await commissionEnabled())) return res.status(403).json({ error: 'Commission is switched off. An Admin can switch it on in Master Data → Company Info.', commissionOff: true });
  next();
});

const capture = requirePermission('canCaptureOrders', 'canAccessDtf', 'canManageCommission');
const manage = requirePermission('canManageCommission');
const STATUSES = ['Pending', 'Active', 'Suspended'] as const;

const kePhone = (raw: string): string | null => {
  const n = whatsappNumber(raw);
  return n && /^254[17]\d{8}$/.test(n) ? n : null;
};
const weekOf = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? weekStart(v) : weekStart(todayStr()));

/** What someone capturing an order may see of an agent: enough to pick them, not their pay details. */
const pickable = (a: { id: number; name: string; phone: string; status: string }) => ({ id: a.id, name: a.name, phoneTail: a.phone.slice(-3), status: a.status });

freelanceRouter.get('/pickable', capture, async (_req, res) => {
  const agents = await prisma.freelanceAgent.findMany({ where: { status: { not: 'Suspended' } }, orderBy: { name: 'asc' } });
  res.json(agents.map(pickable));
});

// ── Agents ──────────────────────────────────────────────────────────────────
const agentFields = {
  name: z.string().trim().min(2, 'Enter their name').max(120),
  phone: z.string().trim().min(1, 'Enter their phone number'),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  nationalId: z.string().trim().max(40).optional(),
  kraPin: z.string().trim().max(40).optional(),
  mpesaNumber: z.string().trim().max(40).optional(),
  bankName: z.string().trim().max(120).optional(),
  bankAccount: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional(),
};

/** Tidies the optional identity and payment details; returns an error message or the values. */
function tidy(d: { nationalId?: string; kraPin?: string; mpesaNumber?: string }): { error: string } | { nationalId: string; kraPin: string; mpesa: string | null } {
  const nid = cleanNationalId(d.nationalId ?? '');
  const kra = cleanKraPin(d.kraPin ?? '');
  const problem = nid.error ?? kra.error;
  if (problem) return { error: problem };
  const mpesa = d.mpesaNumber ? kePhone(d.mpesaNumber) : null;
  if (d.mpesaNumber && !mpesa) return { error: 'The M-Pesa number is not a valid Kenyan phone number' };
  return { nationalId: nid.value ?? '', kraPin: kra.value ?? '', mpesa };
}

// Added at order capture (by anyone who captures orders) or by a manager. Anyone's new entry waits for a manager's approval before it is paid;
// a manager's own entry is Active at once. Their phone number is their account: adding a number that already has one returns that account.
freelanceRouter.post('/agents', capture, async (req, res) => {
  const parsed = z.object(agentFields).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const phone = kePhone(d.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan phone number (e.g. 0712 345 678)' });
  const t = tidy(d);
  if ('error' in t) return res.status(400).json({ error: t.error });

  const existing = await prisma.freelanceAgent.findUnique({ where: { phone } });
  if (existing) {
    if (existing.status === 'Suspended') return res.status(400).json({ error: `${existing.name} is suspended, so orders cannot be credited to them` });
    return res.json({ ...pickable(existing), existing: true });
  }
  const isManager = await userHasPermission(req.user!.role, 'canManageCommission');
  const agent = await prisma.freelanceAgent.create({
    data: {
      name: d.name,
      phone,
      email: d.email ?? '',
      nationalId: t.nationalId,
      kraPin: t.kraPin,
      mpesaNumber: t.mpesa ?? phone,
      bankName: d.bankName ?? '',
      bankAccount: d.bankAccount ?? '',
      note: d.note ?? '',
      status: isManager ? 'Active' : 'Pending',
      createdByName: req.user!.name,
      ...(isManager ? { approvedByName: req.user!.name, approvedAt: new Date() } : {}),
    },
  });
  res.status(201).json({ ...pickable(agent), existing: false });
});

freelanceRouter.get('/agents', manage, async (_req, res) => {
  const agents = await prisma.freelanceAgent.findMany({ orderBy: [{ status: 'asc' }, { name: 'asc' }], include: { _count: { select: { orders: true } } } });
  res.json(agents.map((a) => ({ ...a, orders: a._count.orders, _count: undefined })));
});

freelanceRouter.put('/agents/:id', manage, async (req, res) => {
  const parsed = z.object({ ...agentFields, status: z.enum(STATUSES) }).partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const id = Number(req.params.id);
  const current = await prisma.freelanceAgent.findUnique({ where: { id } });
  if (!current) return res.status(404).json({ error: 'Freelance sales person not found' });
  const d = parsed.data;
  const data: Record<string, unknown> = {};
  if (d.name !== undefined) data.name = d.name;
  if (d.phone !== undefined) {
    const phone = kePhone(d.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan phone number (e.g. 0712 345 678)' });
    const other = await prisma.freelanceAgent.findUnique({ where: { phone } });
    if (other && other.id !== id) return res.status(400).json({ error: `That number already belongs to ${other.name}` });
    data.phone = phone;
  }
  if (d.nationalId !== undefined || d.kraPin !== undefined || d.mpesaNumber !== undefined) {
    const t = tidy({ nationalId: d.nationalId ?? current.nationalId, kraPin: d.kraPin ?? current.kraPin, mpesaNumber: d.mpesaNumber });
    if ('error' in t) return res.status(400).json({ error: t.error });
    if (d.nationalId !== undefined) data.nationalId = t.nationalId;
    if (d.kraPin !== undefined) data.kraPin = t.kraPin;
    if (d.mpesaNumber !== undefined) data.mpesaNumber = t.mpesa ?? (data.phone as string | undefined) ?? current.phone;
  }
  for (const k of ['email', 'bankName', 'bankAccount', 'note'] as const) if (d[k] !== undefined) data[k] = d[k];
  if (d.status !== undefined && d.status !== current.status) {
    data.status = d.status;
    if (d.status === 'Active') {
      data.approvedByName = req.user!.name;
      data.approvedAt = new Date();
    }
  }
  res.json(await prisma.freelanceAgent.update({ where: { id }, data }));
});

// ── The weekly statement and payouts ────────────────────────────────────────
freelanceRouter.get('/statement', manage, async (req, res) => {
  const week = weekOf(req.query.week);
  const { config, statements } = await buildFreelanceStatements(week);
  const payouts = await prisma.freelancePayout.findMany({ where: { weekStart: week } });
  const byAgent = new Map(payouts.map((p) => [p.agentId, p]));
  res.json({
    weekStart: week,
    weekEnd: weekEnd(week),
    open: weekEnd(week) >= todayStr(), // the week is not over, so more money may still arrive
    bands: config.freelanceBands,
    statements: statements.map((s) => {
      const p = byAgent.get(s.agentId);
      return { ...s, payout: p ? { id: p.id, status: p.status, amount: p.amount, paidOn: p.paidOn, paidMethod: p.paidMethod } : null };
    }),
    totals: { commission: round2(statements.reduce((a, s) => a + s.commission, 0)) },
  });
});

freelanceRouter.post('/payouts/approve', manage, async (req, res) => {
  const body = z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Choose the week' });
  const week = weekStart(body.data.weekStart);
  const { statements } = await buildFreelanceStatements(week);
  const out: { agentId: number; agentName: string; amount: number; status: string }[] = [];
  const skipped: { agentName: string; amount: number; reason: string }[] = [];
  for (const s of statements) {
    if (s.commission <= 0) continue;
    // Only an approved (Active) freelance sales person is paid: a new or suspended one is left for a manager to deal with first.
    if (s.status !== 'Active') {
      skipped.push({ agentName: s.agentName, amount: s.commission, reason: s.status === 'Pending' ? 'not approved yet — approve them under Freelancers first' : 'suspended' });
      continue;
    }
    const existing = await prisma.freelancePayout.findUnique({ where: { weekStart_agentId: { weekStart: week, agentId: s.agentId } } });
    if (existing?.status === 'Paid') {
      out.push({ agentId: s.agentId, agentName: s.agentName, amount: existing.amount, status: 'Paid' });
      continue;
    }
    const data = {
      qualifyingNet: s.qualifyingNet,
      amount: s.commission,
      detailJson: JSON.stringify({ received: s.received, qualifyingNet: s.qualifyingNet, belowBaseNet: s.belowBaseNet, orders: s.orders }),
      status: 'Approved',
      approvedByName: req.user!.name,
      approvedAt: new Date(),
    };
    await prisma.freelancePayout.upsert({ where: { weekStart_agentId: { weekStart: week, agentId: s.agentId } }, update: data, create: { weekStart: week, agentId: s.agentId, ...data } });
    out.push({ agentId: s.agentId, agentName: s.agentName, amount: s.commission, status: 'Approved' });
  }
  res.json({ weekStart: week, payouts: out, skipped });
});

freelanceRouter.get('/payouts', manage, async (req, res) => {
  const where: Record<string, unknown> = {};
  if (typeof req.query.week === 'string') where.weekStart = weekOf(req.query.week);
  if (typeof req.query.agentId === 'string') where.agentId = Number(req.query.agentId);
  const rows = await prisma.freelancePayout.findMany({ where, include: { agent: { select: { name: true, mpesaNumber: true, phone: true } } }, orderBy: [{ weekStart: 'desc' }, { id: 'asc' }], take: 300 });
  res.json(rows.map((r) => ({ id: r.id, weekStart: r.weekStart, agentId: r.agentId, agentName: r.agent.name, payTo: r.agent.mpesaNumber || r.agent.phone, amount: r.amount, status: r.status, approvedByName: r.approvedByName, paidOn: r.paidOn, paidMethod: r.paidMethod })));
});

const paySchema = z.object({ method: z.enum(EXPENSE_METHODS), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/** Paying records an expense under 'Freelance Commission', so it reaches the books and, from petty cash, the float. */
freelanceRouter.post('/payouts/:id/pay', manage, async (req, res) => {
  const parsed = paySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const payout = await prisma.freelancePayout.findUnique({ where: { id: Number(req.params.id) }, include: { agent: true } });
  if (!payout) return res.status(404).json({ error: 'Not found' });
  if (payout.status === 'Paid') return res.status(400).json({ error: 'Already paid' });
  if (payout.agent.status !== 'Active') return res.status(400).json({ error: `${payout.agent.name} is not an active freelance sales person, so this cannot be paid` });
  const date = parsed.data.date ?? todayStr();
  if (parsed.data.method === PETTY_CASH_METHOD) {
    const check = await pettyCashShortfall(payout.amount, date);
    if (check.short) return res.status(400).json({ error: `Insufficient petty cash balance (Ksh ${Math.round(check.available).toLocaleString('en-KE')} available, Ksh ${Math.round(payout.amount).toLocaleString('en-KE')} needed)` });
  }
  await ensureChartOnce();
  const updated = await prisma.$transaction(async (tx) => {
    const expense = await tx.expense.create({
      data: { date, category: 'Freelance Commission', amount: payout.amount, supplier: payout.agent.name, note: `Freelance commission, week of ${payout.weekStart} — ${payout.agent.name}`, capturedByName: req.user!.name, paid: true, method: parsed.data.method },
    });
    return tx.freelancePayout.update({ where: { id: payout.id }, data: { status: 'Paid', paidOn: date, paidMethod: parsed.data.method, paidByName: req.user!.name, expenseId: expense.id } });
  });
  res.json(updated);
});

/** Takes an approval back (before it is paid) so the week can be recalculated and approved again. */
freelanceRouter.delete('/payouts/:id', manage, async (req, res) => {
  const payout = await prisma.freelancePayout.findUnique({ where: { id: Number(req.params.id) } });
  if (!payout) return res.status(404).json({ error: 'Not found' });
  if (payout.status === 'Paid') return res.status(400).json({ error: 'A paid commission cannot be withdrawn' });
  await prisma.freelancePayout.delete({ where: { id: payout.id } });
  res.status(204).end();
});

// ── One person's account ────────────────────────────────────────────────────
// What they have earned week by week, what has been paid, and what is still to pay: paid weeks, weeks approved and waiting to be paid, and the
// recent weeks not yet approved (worked out live from the money received).
freelanceRouter.get('/agents/:id/account', manage, async (req, res) => {
  const id = Number(req.params.id);
  const agent = await prisma.freelanceAgent.findUnique({ where: { id } });
  if (!agent) return res.status(404).json({ error: 'Freelance sales person not found' });
  const payouts = await prisma.freelancePayout.findMany({ where: { agentId: id }, orderBy: { weekStart: 'desc' }, take: 104 });
  const have = new Map(payouts.map((p) => [p.weekStart, p]));
  const thisWeek = weekStart(todayStr());
  const weeks: { weekStart: string; weekEnd: string; amount: number; status: string; paidOn: string | null; paidMethod: string | null }[] = [];
  let notApproved = 0;
  for (let i = 0; i < 12; i++) {
    const ws = addWeeks(thisWeek, -i);
    const p = have.get(ws);
    if (p) continue;
    const st = (await buildFreelanceStatements(ws, id)).statements[0];
    if (st && st.commission > 0) {
      notApproved = round2(notApproved + st.commission);
      weeks.push({ weekStart: ws, weekEnd: weekEnd(ws), amount: st.commission, status: i === 0 ? 'This week so far' : 'Not yet approved', paidOn: null, paidMethod: null });
    }
  }
  for (const p of payouts) weeks.push({ weekStart: p.weekStart, weekEnd: weekEnd(p.weekStart), amount: p.amount, status: p.status, paidOn: p.paidOn, paidMethod: p.paidMethod });
  weeks.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  const sum = (status: string) => round2(payouts.filter((p) => p.status === status).reduce((a, p) => a + p.amount, 0));
  res.json({
    agent,
    summary: { paid: sum('Paid'), approvedToPay: sum('Approved'), notYetApproved: notApproved, owed: round2(sum('Approved') + notApproved) },
    weeks,
    bands: (await getCommissionConfig()).freelanceBands,
  });
});
