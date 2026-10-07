// Freelance sales persons — people outside the staff who bring us work. They are credited on the orders marked for their account (never on an order
// that is credited to a staff member), paid weekly in marginal bands on the sales they bring at or above our base prices, and have an account showing what
// they have earned and been paid. Anyone who captures orders can pick or add one at order capture (a new one waits for a manager's approval before it is
// paid); managers (Commission permission) approve them, approve each week's commission and pay it.
import { Router } from 'express';
import { z } from 'zod';
import { EXPENSE_METHODS, FREELANCE_PAY_METHODS, PETTY_CASH_METHOD, addWeeks, cleanKraPin, cleanNationalId, round2, todayStr, weekEnd, weekStart, whatsappNumber } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requirePermission, userHasPermission } from '../middleware/auth';
import { ensureChartOnce } from '../accounting/chart';
import { settlePayout } from '../freelancePay';
import { sendPayoutToPhone } from '../mpesaB2c';
import { pettyCashShortfall } from '../accounting/ledger';
import { buildFreelanceStatements, commissionEnabled, getCommissionConfig } from '../commission';
import { isB2cReady, loadMpesaConfig } from '../mpesaConfig';
import { ownershipEnd } from '@glm/shared';

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
  // How they like to be paid — it only pre-selects the method when their commission is paid; any method can be used
  payMethod: z.enum(FREELANCE_PAY_METHODS).optional(),
  // Their own withholding tax rate in percent (0 = exempt); null/blank = the standard rate
  whtRate: z.number().min(0).max(100).nullable().optional(),
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
      payMethod: d.payMethod ?? 'M-Pesa',
      // a rate of their own is a manager's decision: staff adding someone at order capture cannot set it
      ...(isManager && d.whtRate !== undefined ? { whtRate: d.whtRate } : {}),
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
  for (const k of ['email', 'bankName', 'bankAccount', 'note', 'payMethod', 'whtRate'] as const) if (d[k] !== undefined) data[k] = d[k];
  if (d.status !== undefined && d.status !== current.status) {
    data.status = d.status;
    if (d.status === 'Active') {
      data.approvedByName = req.user!.name;
      data.approvedAt = new Date();
    }
  }
  res.json(await prisma.freelanceAgent.update({ where: { id }, data }));
});

// ── The clients they own ────────────────────────────────────────────────────
// A client stays a freelancer's for as long as they keep bringing orders (see FreelanceClient); a manager can also release one early.
freelanceRouter.get('/clients', manage, async (_req, res) => {
  const months = (await getCommissionConfig()).freelanceOwnershipMonths;
  const today = todayStr();
  const rows = await prisma.freelanceClient.findMany({ include: { agent: { select: { name: true, status: true } } }, orderBy: { id: 'desc' }, take: 500 });
  res.json({
    months,
    clients: rows.map((r) => {
      const until = ownershipEnd(r.lastOrderDate, months);
      const active = r.status === 'Active' && until >= today && r.agent.status !== 'Suspended';
      return { id: r.id, clientName: r.clientName, agentId: r.agentId, agentName: r.agent.name, startDate: r.startDate, lastOrderDate: r.lastOrderDate, until, active, status: r.status === 'Active' && !active ? 'Lapsed' : r.status };
    }),
  });
});

freelanceRouter.post('/clients/:id/release', manage, async (req, res) => {
  const row = await prisma.freelanceClient.findUnique({ where: { id: Number(req.params.id) } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.status !== 'Active') return res.status(400).json({ error: 'Already released' });
  res.json(await prisma.freelanceClient.update({ where: { id: row.id }, data: { status: 'Released', releasedOn: todayStr(), releasedBy: req.user!.name } }));
});

// ── The weekly statement and payouts ────────────────────────────────────────
freelanceRouter.get('/statement', manage, async (req, res) => {
  const week = weekOf(req.query.week);
  const { config, statements } = await buildFreelanceStatements(week);
  const payouts = await prisma.freelancePayout.findMany({ where: { weekStart: week } });
  const byAgent = new Map(payouts.map((p) => [p.agentId, p]));
  // the latest attempt to send each payout to the person's M-Pesa phone, if any
  const attempts = payouts.length ? await prisma.mpesaDisbursement.findMany({ where: { payoutId: { in: payouts.map((p) => p.id) } }, orderBy: { id: 'asc' } }) : [];
  const latest = new Map(attempts.map((a) => [a.payoutId, a]));
  res.json({
    weekStart: week,
    weekEnd: weekEnd(week),
    open: weekEnd(week) >= todayStr(), // the week is not over, so more money may still arrive
    bands: config.freelanceBands,
    // can money be sent straight to their phone from here? (otherwise M-Pesa is recorded by hand, like any other method)
    b2cReady: isB2cReady(await loadMpesaConfig()),
    statements: statements.map((s) => {
      const p = byAgent.get(s.agentId);
      const a = p ? latest.get(p.id) : undefined;
      return { ...s, payout: p ? { id: p.id, status: p.status, amount: p.amount, withholdingTax: p.withholdingTax, netPay: round2(p.amount - p.withholdingTax), paidOn: p.paidOn, paidMethod: p.paidMethod, receipt: p.receipt, mpesa: a ? { id: a.id, status: a.status, resultDesc: a.resultDesc, receipt: a.receipt, phone: a.phone, amount: a.amount } : null } : null };
    }),
    totals: {
      commission: round2(statements.reduce((a, s) => a + s.commission, 0)),
      withholdingTax: round2(statements.reduce((a, s) => a + s.withholdingTax, 0)),
      netPay: round2(statements.reduce((a, s) => a + s.netPay, 0)),
    },
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
    if (existing?.status === 'Paid' || existing?.status === 'Sending') {
      out.push({ agentId: s.agentId, agentName: s.agentName, amount: existing.amount, status: existing.status });
      continue;
    }
    const data = {
      qualifyingNet: s.qualifyingNet,
      amount: s.commission,
      withholdingRate: s.whtRate,
      withholdingTax: s.withholdingTax,
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

// Any method may be used — M-Pesa, cash, cheque, bank transfer, card or petty cash — with the reference of the payment (a cheque number, a bank or M-Pesa
// reference) if there is one.
const paySchema = z.object({ method: z.enum(EXPENSE_METHODS), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reference: z.string().trim().max(60).optional() });

/** Paying records an expense under 'Freelance Commission', so it reaches the books and, from petty cash, the float. */
freelanceRouter.post('/payouts/:id/pay', manage, async (req, res) => {
  const parsed = paySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const payout = await prisma.freelancePayout.findUnique({ where: { id: Number(req.params.id) }, include: { agent: true } });
  if (!payout) return res.status(404).json({ error: 'Not found' });
  if (payout.status === 'Paid') return res.status(400).json({ error: 'Already paid' });
  if (payout.status === 'Sending') return res.status(400).json({ error: 'A payment to their phone is on its way — wait for Safaricom’s answer, or settle it from the M-Pesa attempt' });
  if (payout.agent.status !== 'Active') return res.status(400).json({ error: `${payout.agent.name} is not an active freelance sales person, so this cannot be paid` });
  const date = parsed.data.date ?? todayStr();
  if (parsed.data.method === PETTY_CASH_METHOD) {
    // only what is paid out of the float: the commission less the tax withheld
    const pays = round2(payout.amount - payout.withholdingTax);
    const check = await pettyCashShortfall(pays, date);
    if (check.short) return res.status(400).json({ error: `Insufficient petty cash balance (Ksh ${Math.round(check.available).toLocaleString('en-KE')} available, Ksh ${Math.round(pays).toLocaleString('en-KE')} needed)` });
  }
  await ensureChartOnce();
  const updated = await prisma.$transaction((tx) => settlePayout(tx, payout.id, { method: parsed.data.method, date, byName: req.user!.name, receipt: parsed.data.reference || null }));
  res.json(updated);
});

/** Takes an approval back (before it is paid) so the week can be recalculated and approved again. */
freelanceRouter.delete('/payouts/:id', manage, async (req, res) => {
  const payout = await prisma.freelancePayout.findUnique({ where: { id: Number(req.params.id) } });
  if (!payout) return res.status(404).json({ error: 'Not found' });
  if (payout.status === 'Paid') return res.status(400).json({ error: 'A paid commission cannot be withdrawn' });
  if (payout.status === 'Sending') return res.status(400).json({ error: 'A payment to their phone is on its way, so this cannot be withdrawn yet' });
  await prisma.freelancePayout.delete({ where: { id: payout.id } });
  res.status(204).end();
});

// ── Sending the payout to their M-Pesa phone ────────────────────────────────
// An STK push asks a customer to pay US; to pay someone we ask Safaricom (Daraja B2C) to send money from our Paybill to their number. Safaricom
// accepts the request at once and reports the real outcome a moment later; only then is the payout marked Paid and the expense booked. A failed or
// timed-out attempt leaves the payout approved, ready to be sent again.
freelanceRouter.post('/payouts/:id/send-mpesa', manage, async (req, res) => {
  const r = await sendPayoutToPhone(Number(req.params.id), req.user!.name);
  if (!r.ok) return res.status(400).json({ error: r.error, disbursementId: r.disbursementId });
  res.status(202).json({ ok: true, disbursementId: r.disbursementId, message: 'Sent to M-Pesa — it is marked paid when Safaricom confirms it.' });
});

freelanceRouter.get('/payouts/:id/disbursements', manage, async (req, res) => {
  const rows = await prisma.mpesaDisbursement.findMany({ where: { payoutId: Number(req.params.id) }, orderBy: { id: 'desc' } });
  res.json(rows.map((d) => ({ id: d.id, status: d.status, amount: d.amount, phone: d.phone, resultDesc: d.resultDesc, receipt: d.receipt, requestedByName: d.requestedByName, createdAt: d.createdAt, completedAt: d.completedAt })));
});

// If Safaricom's answer never arrives (a callback that could not reach this server) a manager settles the attempt by hand, after checking the Paybill's own
// statement: it was NOT sent (so it can be tried again), or it WAS (with the M-Pesa receipt code, which must be new).
freelanceRouter.post('/disbursements/:id/resolve', manage, async (req, res) => {
  const parsed = z.object({ outcome: z.enum(['failed', 'sent']), receipt: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'Enter the M-Pesa receipt code (10 letters and numbers)').optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = await prisma.mpesaDisbursement.findUnique({ where: { id: Number(req.params.id) } });
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.status !== 'Pending') return res.status(400).json({ error: 'This attempt has already been settled' });
  if (parsed.data.outcome === 'failed') {
    await prisma.$transaction([
      prisma.mpesaDisbursement.update({ where: { id: d.id }, data: { status: 'Failed', resultDesc: `Marked as not sent by ${req.user!.name}`, completedAt: new Date() } }),
      prisma.freelancePayout.updateMany({ where: { id: d.payoutId, status: 'Sending' }, data: { status: 'Approved' } }),
    ]);
    return res.json({ ok: true });
  }
  const receipt = parsed.data.receipt;
  if (!receipt) return res.status(400).json({ error: 'Enter the M-Pesa receipt code from the Paybill statement' });
  if (await prisma.mpesaDisbursement.findUnique({ where: { receipt } })) return res.status(400).json({ error: `${receipt} is already on record against another payment` });
  await ensureChartOnce();
  await prisma.$transaction(async (tx) => {
    await tx.mpesaDisbursement.update({ where: { id: d.id }, data: { status: 'Success', receipt, resultDesc: `Confirmed by hand by ${req.user!.name}`, completedAt: new Date() } });
    await settlePayout(tx, d.payoutId, { method: 'M-Pesa', byName: req.user!.name, receipt, paidOut: d.amount });
  });
  res.json({ ok: true });
});

// ── Withholding tax report ──────────────────────────────────────────────────
// What was withheld from freelance commission paid in a month — the figures for KRA's withholding return and for paying the tax over (the money sits in
// Withholding Tax Payable until it is paid over; record that payment as a journal: debit Withholding Tax Payable, credit the bank).
freelanceRouter.get('/withholding', manage, async (req, res) => {
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : todayStr().slice(0, 7);
  const rows = await prisma.freelancePayout.findMany({
    where: { status: 'Paid', paidOn: { gte: `${month}-01`, lte: `${month}-31` } },
    include: { agent: { select: { name: true, kraPin: true, nationalId: true } } },
    orderBy: [{ paidOn: 'asc' }, { id: 'asc' }],
  });
  const out = rows.map((r) => ({
    id: r.id,
    paidOn: r.paidOn,
    weekStart: r.weekStart,
    agentName: r.agent.name,
    kraPin: r.agent.kraPin,
    nationalId: r.agent.nationalId,
    gross: r.amount,
    rate: r.withholdingRate,
    withheld: r.withholdingTax,
    net: round2(r.amount - r.withholdingTax),
    method: r.paidMethod,
    reference: r.receipt,
  }));
  res.json({
    month,
    rows: out,
    totals: { gross: round2(out.reduce((a, r) => a + r.gross, 0)), withheld: round2(out.reduce((a, r) => a + r.withheld, 0)), net: round2(out.reduce((a, r) => a + r.net, 0)) },
    missingPin: [...new Set(out.filter((r) => r.withheld > 0 && !r.kraPin).map((r) => r.agentName))],
  });
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
  const weeks: { weekStart: string; weekEnd: string; amount: number; withheld: number; status: string; paidOn: string | null; paidMethod: string | null }[] = [];
  let notApproved = 0;
  for (let i = 0; i < 12; i++) {
    const ws = addWeeks(thisWeek, -i);
    const p = have.get(ws);
    if (p) continue;
    const st = (await buildFreelanceStatements(ws, id)).statements[0];
    if (st && st.commission > 0) {
      notApproved = round2(notApproved + st.commission);
      weeks.push({ weekStart: ws, weekEnd: weekEnd(ws), amount: st.commission, withheld: st.withholdingTax, status: i === 0 ? 'This week so far' : 'Not yet approved', paidOn: null, paidMethod: null });
    }
  }
  for (const p of payouts) weeks.push({ weekStart: p.weekStart, weekEnd: weekEnd(p.weekStart), amount: p.amount, withheld: p.withholdingTax, status: p.status, paidOn: p.paidOn, paidMethod: p.paidMethod });
  weeks.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  const sum = (status: string) => round2(payouts.filter((p) => p.status === status).reduce((a, p) => a + p.amount, 0));
  res.json({
    agent,
    summary: {
      paid: sum('Paid'),
      approvedToPay: sum('Approved'),
      notYetApproved: notApproved,
      owed: round2(sum('Approved') + notApproved),
      taxWithheld: round2(payouts.filter((p) => p.status === 'Paid').reduce((a, p) => a + p.withholdingTax, 0)),
    },
    weeks,
    bands: (await getCommissionConfig()).freelanceBands,
  });
});
