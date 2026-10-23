// Day close (Finance → Day close): the daily reconciliation, with a cash-up for each till.
//  • Received: every payment dated that day, by method, person and till.
//  • Cash-up (per till): expected cash = the float carried from that till's last close + cash received there − cash refunded; the cashier counts, the difference is the variance, the float left for
//    tomorrow is chosen and the rest is banked. A manager approves (not the person who counted, unless they are the Admin). An approved cash-up is locked (the Admin can reopen it); a payment added to
//    a closed day afterwards shows up as "changed since the close".
//  • Outstanding, and the NCBA tie-out: what customers owe (aged), and what NCBA says it took against what is on orders.
//  • A reminder for days not closed, the Admin's set-up of tills, and the evening WhatsApp summary.
import { Router } from 'express';
import { z } from 'zod';
import { todayStr } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requireRole, requirePermission } from '../middleware/auth';
import { AMBER_UP_TO, DENOMINATIONS, ensureTills, liveDay, reminder, round2, summaryFor } from '../dayClose';
import type { LiveDay } from '../dayClose';
import { SUMMARY_TEMPLATE_BODY, getSummarySettings, nairobiNow, parseNumbers, sendSummary } from '../daySummary';

export const dayCloseRouter = Router();
dayCloseRouter.use(requireAuth);

const mayClose = requirePermission('canManagePayments', 'canAccessFinance');
const mayApprove = requirePermission('canAccessFinance');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date');

type CloseRow = NonNullable<Awaited<ReturnType<typeof prisma.dayClose.findFirst>>>;
const serializeClose = (c: CloseRow, live: LiveDay) => {
  const till = live.tills.find((t) => t.id === c.tillId);
  return {
    id: c.id,
    tillId: c.tillId,
    status: c.status,
    openingFloat: c.openingFloat,
    expectedCash: c.expectedCash,
    countedCash: c.countedCash,
    variance: c.variance,
    floatCarried: c.floatCarried,
    banked: c.banked,
    denominations: c.denominations ? (JSON.parse(c.denominations) as Record<string, number>) : null,
    note: c.note,
    submittedByName: c.submittedByName,
    submittedAt: c.submittedAt.toISOString(),
    approvedByName: c.approvedByName,
    approvedAt: c.approvedAt?.toISOString() ?? null,
    // payments dated that day were added or removed after the close
    changedSince: !!till && (Math.abs(till.received - c.cashReceived) > 0.009 || Math.abs(till.refunds - c.cashRefunds) > 0.009),
  };
};

/** Which till a request is about: ?till=ID, ?till=all (every till together), or the main till when it is not given. */
async function tillFrom(raw: unknown): Promise<{ tillId: number | null } | { error: string }> {
  const tills = await ensureTills();
  if (raw === 'all') return { tillId: null };
  if (raw === undefined || raw === '' || raw === null) return { tillId: tills.find((t) => t.isMain)!.id };
  const id = Number(raw);
  const t = tills.find((x) => x.id === id && x.active);
  return t ? { tillId: t.id } : { error: 'That till cannot be found' };
}

dayCloseRouter.get('/', mayClose, async (req, res) => {
  const date = dateSchema.safeParse(req.query.date ?? todayStr());
  if (!date.success) return res.status(400).json({ error: date.error.issues[0]?.message });
  const till = await tillFrom(req.query.till);
  if ('error' in till) return res.status(400).json({ error: till.error });
  const live = await liveDay(date.data, till.tillId);
  const close = till.tillId == null ? null : await prisma.dayClose.findUnique({ where: { date_tillId: { date: date.data, tillId: till.tillId } } });
  res.json({ ...live, amberUpTo: AMBER_UP_TO, denominations: DENOMINATIONS, close: close ? serializeClose(close, live) : null, today: todayStr() });
});

const submitSchema = z.object({
  date: dateSchema,
  tillId: z.number().int().positive().optional(),
  counted: z.number().min(0).max(100_000_000),
  floatCarried: z.number().min(0).max(100_000_000).default(0),
  openingFloat: z.number().min(0).max(100_000_000).optional(), // only to correct the very first close of a till; afterwards it is the last close's carried float
  denominations: z.record(z.string(), z.number().int().min(0).max(100000)).optional(),
  note: z.string().trim().max(500).default(''),
});

dayCloseRouter.post('/', mayClose, async (req, res) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const till = await tillFrom(d.tillId);
  if ('error' in till || till.tillId == null) return res.status(400).json({ error: 'Choose the till to close' });
  const tillId = till.tillId;
  if (d.date > todayStr()) return res.status(400).json({ error: 'A day cannot be closed before it has happened' });
  const existing = await prisma.dayClose.findUnique({ where: { date_tillId: { date: d.date, tillId } } });
  if (existing?.status === 'Approved') return res.status(409).json({ error: 'That day is already approved and locked. An Admin can reopen it.' });
  if (d.denominations) {
    const sum = Object.entries(d.denominations).reduce((a, [k, n]) => a + Number(k) * n, 0);
    if (Math.abs(sum - d.counted) > 0.009) return res.status(400).json({ error: `The notes and coins add up to Ksh ${sum.toLocaleString('en-KE')}, not Ksh ${d.counted.toLocaleString('en-KE')}` });
  }
  if (d.floatCarried > d.counted + 0.009) return res.status(400).json({ error: 'The float left in the drawer cannot be more than the cash counted' });
  const live = await liveDay(d.date, tillId);
  const t = live.tills.find((x) => x.id === tillId)!;
  // the opening float is the till's last close's carried float; it can be corrected by hand only when that till has no earlier close at all
  const hasEarlier = !!(await prisma.dayClose.findFirst({ where: { tillId, date: { lt: d.date } }, select: { id: true } }));
  const openingFloat = hasEarlier || d.openingFloat === undefined ? t.openingFloat : d.openingFloat;
  const expected = round2(openingFloat + t.received - t.refunds);
  const data = {
    openingFloat,
    cashReceived: t.received,
    cashRefunds: t.refunds,
    expectedCash: expected,
    countedCash: round2(d.counted),
    variance: round2(d.counted - expected),
    floatCarried: round2(d.floatCarried),
    banked: round2(d.counted - d.floatCarried),
    denominations: d.denominations ? JSON.stringify(d.denominations) : '',
    note: d.note,
    methodsJson: JSON.stringify(live.byMethod),
    outstanding: live.outstanding.closing,
    status: 'Submitted',
    submittedByName: req.user!.name,
    submittedAt: new Date(),
    approvedByName: null,
    approvedAt: null,
  };
  const saved = await prisma.dayClose.upsert({ where: { date_tillId: { date: d.date, tillId } }, update: data, create: { date: d.date, tillId, ...data } });
  res.status(201).json(serializeClose(saved, live));
});

const tillBody = z.object({ tillId: z.number().int().positive().optional() });

dayCloseRouter.post('/:date/approve', mayApprove, async (req, res) => {
  const date = dateSchema.safeParse(req.params.date);
  const body = tillBody.safeParse(req.body ?? {});
  if (!date.success || !body.success) return res.status(400).json({ error: 'Choose a date' });
  const till = await tillFrom(body.data.tillId);
  if ('error' in till || till.tillId == null) return res.status(400).json({ error: 'Choose the till' });
  const close = await prisma.dayClose.findUnique({ where: { date_tillId: { date: date.data, tillId: till.tillId } } });
  if (!close) return res.status(404).json({ error: 'That day has not been closed yet' });
  if (close.status === 'Approved') return res.status(409).json({ error: 'Already approved' });
  if (close.submittedByName === req.user!.name && req.user!.role !== 'Admin') return res.status(403).json({ error: 'Someone other than the person who counted the cash approves the day' });
  const saved = await prisma.dayClose.update({ where: { id: close.id }, data: { status: 'Approved', approvedByName: req.user!.name, approvedAt: new Date() } });
  res.json(serializeClose(saved, await liveDay(date.data, till.tillId)));
});

dayCloseRouter.post('/:date/reopen', requireRole('Admin'), async (req, res) => {
  const date = dateSchema.safeParse(req.params.date);
  const body = tillBody.safeParse(req.body ?? {});
  if (!date.success || !body.success) return res.status(400).json({ error: 'Choose a date' });
  const till = await tillFrom(body.data.tillId);
  if ('error' in till || till.tillId == null) return res.status(400).json({ error: 'Choose the till' });
  const close = await prisma.dayClose.findUnique({ where: { date_tillId: { date: date.data, tillId: till.tillId } } });
  if (!close) return res.status(404).json({ error: 'That day has not been closed yet' });
  const saved = await prisma.dayClose.update({ where: { id: close.id }, data: { status: 'Submitted', approvedByName: null, approvedAt: null } });
  res.json(serializeClose(saved, await liveDay(date.data, till.tillId)));
});

// The month at a glance: each day's receipts, whether every till that took cash was closed and approved, and the variance. A past day on which a till took cash and was not closed is the exception to chase.
dayCloseRouter.get('/month', mayClose, async (req, res) => {
  const month = z.string().regex(/^\d{4}-\d{2}$/).safeParse(req.query.month ?? todayStr().slice(0, 7));
  if (!month.success) return res.status(400).json({ error: 'Choose a month' });
  const from = `${month.data}-01`;
  const to = `${month.data}-31`;
  const tills = await ensureTills();
  const main = tills.find((t) => t.isMain)!;
  const active = new Map(tills.filter((t) => t.active).map((t) => [t.id, t.name]));
  const users = await prisma.user.findMany({ where: { tillId: { not: null } }, select: { id: true, tillId: true } });
  const tillOf = new Map(users.map((u) => [u.id, active.has(u.tillId!) ? u.tillId! : main.id]));
  const [closes, payments] = await Promise.all([
    prisma.dayClose.findMany({ where: { date: { gte: from, lte: to } } }),
    prisma.payment.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true, method: true, amount: true, staffId: true } }),
  ]);
  const days = new Map<string, { date: string; received: number; cash: number; payments: number; cashByTill: Map<number, number> }>();
  for (const p of payments) {
    const r = days.get(p.date) ?? { date: p.date, received: 0, cash: 0, payments: 0, cashByTill: new Map<number, number>() };
    r.received = round2(r.received + p.amount);
    if (p.method === 'Cash') {
      r.cash = round2(r.cash + p.amount);
      const t = p.staffId != null ? tillOf.get(p.staffId) ?? main.id : main.id;
      r.cashByTill.set(t, round2((r.cashByTill.get(t) ?? 0) + p.amount));
    }
    r.payments++;
    days.set(p.date, r);
  }
  const closesOn = new Map<string, typeof closes>();
  for (const c of closes) closesOn.set(c.date, [...(closesOn.get(c.date) ?? []), c]);
  const dates = new Set([...days.keys(), ...closesOn.keys()]);
  const today = todayStr();
  const out = [...dates].sort().map((date) => {
    const cs = closesOn.get(date) ?? [];
    const r = days.get(date) ?? { received: 0, cash: 0, payments: 0, cashByTill: new Map<number, number>() };
    const closedTills = new Set(cs.map((c) => c.tillId));
    const missing = [...r.cashByTill.entries()].filter(([t, cash]) => cash > 0 && !closedTills.has(t)).map(([t]) => active.get(t) ?? 'Till');
    let status: string;
    if (date >= today && missing.length > 0) status = 'Open';
    else if (missing.length > 0) status = 'Not closed';
    else if (cs.length > 0) status = cs.every((c) => c.status === 'Approved') ? 'Approved' : 'Submitted';
    else status = date >= today ? 'Open' : 'No cash';
    return {
      date,
      received: r.received,
      cash: r.cash,
      payments: r.payments,
      status,
      notClosedTills: date < today ? missing : [],
      variance: cs.length ? round2(cs.reduce((a, c) => a + c.variance, 0)) : null,
      counted: cs.length ? round2(cs.reduce((a, c) => a + c.countedCash, 0)) : null,
      banked: cs.length ? round2(cs.reduce((a, c) => a + c.banked, 0)) : null,
    };
  });
  res.json({
    month: month.data,
    amberUpTo: AMBER_UP_TO,
    days: out,
    notClosed: out.filter((d) => d.status === 'Not closed').length,
    totalVariance: round2(out.reduce((a, d) => a + (d.variance ?? 0), 0)),
    totalBanked: round2(out.reduce((a, d) => a + (d.banked ?? 0), 0)),
  });
});

// The reminder: past days a till took cash and was not closed, and cash-ups waiting for approval.
dayCloseRouter.get('/reminder', mayClose, async (_req, res) => {
  res.json(await reminder());
});

// ── Tills (Admin sets them up) ──────────────────────────────────────────────
dayCloseRouter.get('/tills', mayClose, async (req, res) => {
  const tills = await ensureTills();
  const people = req.user!.role === 'Admin' ? await prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, role: true, tillId: true }, orderBy: { name: 'asc' } }) : [];
  res.json({ tills: tills.map((t) => ({ id: t.id, name: t.name, isMain: t.isMain, active: t.active, people: people.filter((p) => p.tillId === t.id).length })), people });
});

dayCloseRouter.post('/tills', requireRole('Admin'), async (req, res) => {
  const p = z.object({ name: z.string().trim().min(1, 'Name the till').max(40) }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0]?.message ?? 'Invalid input' });
  await ensureTills();
  const t = await prisma.till.create({ data: { name: p.data.name } }).catch(() => null);
  if (!t) return res.status(400).json({ error: 'A till with that name already exists' });
  res.status(201).json({ id: t.id, name: t.name });
});

dayCloseRouter.put('/tills/assign', requireRole('Admin'), async (req, res) => {
  const p = z.object({ userId: z.number().int().positive(), tillId: z.number().int().positive().nullable() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Choose the person and the till' });
  const tills = await ensureTills();
  if (p.data.tillId != null && !tills.some((t) => t.id === p.data.tillId && t.active)) return res.status(400).json({ error: 'That till cannot be found' });
  const u = await prisma.user.findUnique({ where: { id: p.data.userId }, select: { id: true } });
  if (!u) return res.status(404).json({ error: 'Person not found' });
  // the main till is where people with none are; assigning to it is the same as clearing
  const main = tills.find((t) => t.isMain)!;
  await prisma.user.update({ where: { id: u.id }, data: { tillId: p.data.tillId === main.id ? null : p.data.tillId } });
  res.json({ ok: true });
});

dayCloseRouter.put('/tills/:id', requireRole('Admin'), async (req, res) => {
  const p = z.object({ name: z.string().trim().min(1).max(40).optional(), active: z.boolean().optional() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Invalid input' });
  const tills = await ensureTills();
  const t = tills.find((x) => x.id === Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Till not found' });
  if (p.data.active === false) {
    if (t.isMain) return res.status(400).json({ error: 'The main till cannot be switched off' });
    if ((await prisma.user.count({ where: { tillId: t.id } })) > 0) return res.status(400).json({ error: 'Move the people at this till to another till first' });
  }
  const saved = await prisma.till.update({ where: { id: t.id }, data: { name: p.data.name ?? t.name, active: p.data.active ?? t.active } }).catch(() => null);
  if (!saved) return res.status(400).json({ error: 'A till with that name already exists' });
  res.json({ id: saved.id, name: saved.name, active: saved.active });
});

// ── The evening summary (Admin) ─────────────────────────────────────────────
const publicSettings = async () => {
  const s = await getSummarySettings();
  return { readyBeforeFinalPayment: s.readyBeforeFinalPayment, warnDuplicateOrders: s.warnDuplicateOrders, enabled: s.summaryEnabled, time: s.summaryTime, numbers: s.summaryNumbers, template: s.summaryTemplate, lastDate: s.summaryLastDate, lastStatus: s.summaryLastStatus, templateBody: SUMMARY_TEMPLATE_BODY, recipients: parseNumbers(s.summaryNumbers), nowNairobi: nairobiNow() };
};

dayCloseRouter.get('/settings', requireRole('Admin'), async (_req, res) => {
  res.json(await publicSettings());
});

dayCloseRouter.put('/settings', requireRole('Admin'), async (req, res) => {
  const p = z
    .object({
      enabled: z.boolean().optional(),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'The time looks like 18:30').optional(),
      numbers: z.string().max(400).optional(),
      template: z.string().trim().regex(/^[a-z0-9_]{0,512}$/, 'A template name has only lowercase letters, numbers and underscores').optional(),
      readyBeforeFinalPayment: z.boolean().optional(),
      warnDuplicateOrders: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0]?.message ?? 'Invalid input' });
  const cur = await getSummarySettings();
  const numbers = p.data.numbers ?? cur.summaryNumbers;
  if (p.data.numbers !== undefined && numbers.trim() && parseNumbers(numbers).length === 0) return res.status(400).json({ error: 'Enter WhatsApp numbers like 0797 785 033, separated by commas' });
  if ((p.data.enabled ?? cur.summaryEnabled) && parseNumbers(numbers).length === 0) return res.status(400).json({ error: 'Enter at least one WhatsApp number before switching the summary on' });
  await prisma.dayCloseSettings.update({ where: { id: 1 }, data: { summaryEnabled: p.data.enabled ?? cur.summaryEnabled, summaryTime: p.data.time ?? cur.summaryTime, summaryNumbers: numbers.trim(), summaryTemplate: p.data.template ?? cur.summaryTemplate, readyBeforeFinalPayment: p.data.readyBeforeFinalPayment ?? cur.readyBeforeFinalPayment, warnDuplicateOrders: p.data.warnDuplicateOrders ?? cur.warnDuplicateOrders } });
  res.json(await publicSettings());
});

dayCloseRouter.get('/summary/preview', requireRole('Admin'), async (req, res) => {
  const date = dateSchema.safeParse(req.query.date ?? todayStr());
  if (!date.success) return res.status(400).json({ error: 'Choose a date' });
  res.json(await summaryFor(date.data));
});

dayCloseRouter.post('/summary/send', requireRole('Admin'), async (req, res) => {
  const date = dateSchema.safeParse(req.body?.date ?? todayStr());
  if (!date.success) return res.status(400).json({ error: 'Choose a date' });
  const r = await sendSummary(date.data, req.user!.name);
  if (!r.ok && r.sent.length === 0) return res.status(502).json({ error: r.failed[0]?.error ?? 'Could not send the summary', ...r });
  res.json(r);
});
