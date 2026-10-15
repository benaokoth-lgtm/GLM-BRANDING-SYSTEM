import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { dateRange, dateSpanLabel, round2, todayStr, weekdayOf } from '@glm/shared';
import { notifyApprovers } from '../approvals';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import { permissionsForRole } from '../permissions';
import { buildStatements } from '../commission';
import { activeStaff, balancesFor, ensureHrDefaults, leaveTypes, onLeaveByDay, workCalendar, workingDaysOf } from '../hr';

// People (HR): leave requests and their approval, the off-day calendar, the leave policy, and performance reviews.
// Everyone with HR access asks for their own leave and sees the calendar; people who manage HR see and decide everyone's, and run reviews.
export const hrRouter = Router();
hrRouter.use(requireAuth, requirePermission('canAccessHr', 'canManageHr'), async (_req, _res, next) => {
  await ensureHrDefaults(); // the kinds of leave and the public holidays exist before anything reads them
  next();
});
const manage = requirePermission('canManageHr');

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date');
const canManageHr = async (role: string) => role === 'Admin' || (await permissionsForRole(role)).canManageHr;

// ── what the screen needs to start ──────────────────────────────────────────────────────────────
hrRouter.get('/config', async (req, res) => {
  const mayManage = await canManageHr(req.user!.role);
  const [types, cal, staff, offDays] = await Promise.all([leaveTypes(mayManage), workCalendar(), activeStaff(), prisma.offDay.findMany({ orderBy: { date: 'asc' } })]);
  res.json({
    canManage: mayManage,
    me: { id: req.user!.id, name: req.user!.name },
    leaveTypes: types,
    settings: { minCover: cal.minCover, offWeekdays: cal.offWeekdays },
    staff: (mayManage ? staff : staff.filter((s) => s.id === req.user!.id)).map((s) => ({ id: s.id, name: s.name, role: s.role, hireDate: s.hireDate })),
    offDays: offDays.map((o) => ({ id: o.id, date: o.date, name: o.name })),
  });
});

const targetStaff = async (req: Request, res: Response, wanted: unknown): Promise<number | null> => {
  const id = wanted == null || wanted === '' ? req.user!.id : Number(wanted);
  if (id !== req.user!.id && !(await canManageHr(req.user!.role))) {
    res.status(403).json({ error: 'You can only see your own leave' });
    return null;
  }
  return id;
};

hrRouter.get('/balances', async (req, res) => {
  const staffId = await targetStaff(req, res, req.query.staffId);
  if (staffId == null) return;
  const year = Number(req.query.year) || Number(todayStr().slice(0, 4));
  const asOf = year === Number(todayStr().slice(0, 4)) ? todayStr() : `${year}-12-31`;
  res.json({ staffId, year, balances: await balancesFor(staffId, year, asOf) });
});

// ── leave requests ───────────────────────────────────────────────────────────────────────────────
const shape = (r: Awaited<ReturnType<typeof prisma.leaveRequest.findMany>>[number], names: Map<number, { name: string; role: string }>, types: Map<number, string>) => ({
  id: r.id,
  staffId: r.staffId,
  staffName: names.get(r.staffId)?.name ?? `Staff #${r.staffId}`,
  role: names.get(r.staffId)?.role ?? '',
  leaveTypeId: r.leaveTypeId,
  type: types.get(r.leaveTypeId) ?? 'Leave',
  startDate: r.startDate,
  endDate: r.endDate,
  label: dateSpanLabel(r.startDate, r.endDate),
  days: r.days,
  status: r.status,
  reason: r.reason,
  certificate: r.certificate,
  decidedByName: r.decidedByName,
  decidedAt: r.decidedAt,
  decisionNote: r.decisionNote,
  capturedByName: r.capturedByName,
  createdAt: r.createdAt,
});

async function lookups() {
  const [users, types] = await Promise.all([prisma.user.findMany({ select: { id: true, name: true, role: true } }), prisma.leaveType.findMany()]);
  return { names: new Map(users.map((u) => [u.id, { name: u.name, role: u.role }])), types: new Map(types.map((t) => [t.id, t.name])) };
}

hrRouter.get('/requests', async (req, res) => {
  const mayManage = await canManageHr(req.user!.role);
  const status = typeof req.query.status === 'string' && ['Pending', 'Approved', 'Rejected', 'Cancelled'].includes(req.query.status) ? req.query.status : undefined;
  const year = req.query.year ? Number(req.query.year) : undefined;
  const staffFilter = req.query.staffId ? Number(req.query.staffId) : undefined;
  const where = {
    ...(mayManage ? (staffFilter ? { staffId: staffFilter } : {}) : { staffId: req.user!.id }),
    ...(status ? { status } : {}),
    ...(year ? { startDate: { lte: `${year}-12-31` }, endDate: { gte: `${year}-01-01` } } : {}),
  };
  const [rows, { names, types }] = await Promise.all([prisma.leaveRequest.findMany({ where, orderBy: [{ status: 'asc' }, { startDate: 'desc' }, { id: 'desc' }], take: 500 }), lookups()]);
  // Pending first, then the newest
  const order: Record<string, number> = { Pending: 0, Approved: 1, Rejected: 2, Cancelled: 3 };
  res.json(rows.map((r) => shape(r, names, types)).sort((a, b) => order[a.status]! - order[b.status]! || (a.startDate < b.startDate ? 1 : -1)));
});

const requestSchema = z.object({
  staffId: z.number().int().optional(),
  leaveTypeId: z.number().int(),
  startDate: dateStr,
  endDate: dateStr,
  reason: z.string().trim().max(300).default(''),
  certificate: z.boolean().default(false),
});

/** The problem with a request, or null. Used when it is made. */
async function requestProblem(staffId: number, type: Awaited<ReturnType<typeof leaveTypes>>[number], start: string, end: string, certificate: boolean, exceptId?: number) {
  const cal = await workCalendar();
  const days = workingDaysOf(cal, start, end);
  if (days.length === 0) return { error: 'Those dates are all days off (weekly days off, public holidays or company off days), so there is no leave to take', days };
  const overlap = await prisma.leaveRequest.findFirst({ where: { staffId, status: { in: ['Pending', 'Approved'] }, startDate: { lte: end }, endDate: { gte: start }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (overlap) return { error: `These dates overlap another leave request (${dateSpanLabel(overlap.startDate, overlap.endDate)}, ${overlap.status.toLowerCase()})`, days };
  if (type.certAfterDays > 0 && days.length > type.certAfterDays && !certificate) return { error: `${type.name} of more than ${type.certAfterDays} day${type.certAfterDays === 1 ? '' : 's'} needs a medical certificate — tick that it is provided`, days };
  if (type.daysPerYear > 0) {
    for (const year of [...new Set(days.map((d) => Number(d.slice(0, 4))))]) {
      const used = days.filter((d) => d.startsWith(String(year))).length;
      const asOf = days.filter((d) => d.startsWith(String(year))).slice(-1)[0]!;
      const bal = (await balancesFor(staffId, year, asOf, cal)).find((b) => b.typeId === type.id)!;
      if (used > bal.available + 0.001) return { error: `Only ${bal.available} day${bal.available === 1 ? '' : 's'} of ${type.name} ${bal.available === 1 ? 'is' : 'are'} available for ${year} (you asked for ${used})`, days };
    }
  }
  return { error: null as string | null, days };
}

hrRouter.post('/requests', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
  const d = parsed.data;
  const staffId = await targetStaff(req, res, d.staffId);
  if (staffId == null) return;
  if (d.endDate < d.startDate) return res.status(400).json({ error: 'The last day cannot be before the first day' });
  const person = await prisma.user.findUnique({ where: { id: staffId } });
  if (!person || !person.active) return res.status(400).json({ error: 'That person cannot be found' });
  const type = (await leaveTypes()).find((t) => t.id === d.leaveTypeId);
  if (!type) return res.status(400).json({ error: 'Choose a kind of leave' });
  const check = await requestProblem(staffId, type, d.startDate, d.endDate, d.certificate);
  if (check.error) return res.status(400).json({ error: check.error });
  const created = await prisma.leaveRequest.create({
    data: { staffId, leaveTypeId: type.id, startDate: d.startDate, endDate: d.endDate, days: check.days.length, reason: d.reason, certificate: d.certificate, capturedByName: req.user!.name },
  });
  notifyApprovers('leave', `${person.name} — ${type.name}`, `${person.name} has asked for ${check.days.length} working day(s) of ${type.name} leave, ${d.startDate} to ${d.endDate}.`, { id: staffId });
  const { names, types } = await lookups();
  res.status(201).json(shape(created, names, types));
});

// How many people are at work on each day if this leave is approved: below the minimum, the decider must confirm.
async function coverBreaches(requestId: number, days: string[]) {
  const [cal, staff, off] = await Promise.all([workCalendar(), activeStaff(), onLeaveByDay(days, requestId)]);
  if (cal.minCover <= 0) return [];
  return days
    .map((date) => ({ date, staffed: staff.length - (off.get(date)?.length ?? 0) - 1, min: cal.minCover }))
    .filter((x) => x.staffed < x.min);
}

hrRouter.post('/requests/:id/approve', manage, async (req, res) => {
  const r = await prisma.leaveRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'Pending') return res.status(400).json({ error: `This request is already ${r.status.toLowerCase()}` });
  if (r.staffId === req.user!.id && req.user!.role !== 'Admin') return res.status(400).json({ error: 'You cannot approve your own leave; another manager must' });
  const cal = await workCalendar();
  const breaches = await coverBreaches(r.id, workingDaysOf(cal, r.startDate, r.endDate));
  if (breaches.length && !(req.body as { confirm?: boolean }).confirm) {
    return res.status(409).json({ error: `Approving this leaves fewer than ${cal.minCover} people at work on ${breaches.length} day${breaches.length === 1 ? '' : 's'} (${breaches.slice(0, 3).map((b) => `${dateSpanLabel(b.date, b.date)}: ${b.staffed}`).join('; ')}${breaches.length > 3 ? '…' : ''}). Approve it anyway?`, needsConfirm: true, breaches });
  }
  const up = await prisma.leaveRequest.update({ where: { id: r.id }, data: { status: 'Approved', decidedByName: req.user!.name, decidedAt: new Date(), decisionNote: breaches.length ? 'Approved below the minimum cover' : '' } });
  const { names, types } = await lookups();
  res.json(shape(up, names, types));
});

hrRouter.post('/requests/:id/reject', manage, async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
  if (reason.length < 3) return res.status(400).json({ error: 'Give a reason for rejecting this request' });
  const r = await prisma.leaveRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'Pending') return res.status(400).json({ error: `This request is already ${r.status.toLowerCase()}` });
  const up = await prisma.leaveRequest.update({ where: { id: r.id }, data: { status: 'Rejected', decidedByName: req.user!.name, decidedAt: new Date(), decisionNote: reason } });
  const { names, types } = await lookups();
  res.json(shape(up, names, types));
});

// The person takes back a request still waiting; a manager can also cancel one that was approved (the days go back).
hrRouter.post('/requests/:id/cancel', async (req, res) => {
  const r = await prisma.leaveRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!r) return res.status(404).json({ error: 'Request not found' });
  const mayManage = await canManageHr(req.user!.role);
  if (r.staffId !== req.user!.id && !mayManage) return res.status(403).json({ error: 'That is not your request' });
  if (r.status === 'Rejected' || r.status === 'Cancelled') return res.status(400).json({ error: `This request is already ${r.status.toLowerCase()}` });
  if (r.status === 'Approved' && !mayManage) return res.status(400).json({ error: 'An approved leave can be cancelled by a manager only' });
  const up = await prisma.leaveRequest.update({ where: { id: r.id }, data: { status: 'Cancelled', decidedByName: req.user!.name, decidedAt: new Date() } });
  const { names, types } = await lookups();
  res.json(shape(up, names, types));
});

// ── the off-day calendar ─────────────────────────────────────────────────────────────────────────
hrRouter.get('/calendar', async (req, res) => {
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : todayStr().slice(0, 7);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const mayManage = await canManageHr(req.user!.role);
  const [cal, staff, reqs, { names, types }] = await Promise.all([
    workCalendar(),
    activeStaff(),
    prisma.leaveRequest.findMany({ where: { status: { in: ['Approved', 'Pending'] }, startDate: { lte: last }, endDate: { gte: first } } }),
    lookups(),
  ]);
  const days = dateRange(first, last).map((date) => {
    const weekend = cal.offWeekdays.includes(weekdayOf(date));
    const holiday = cal.offDates.get(date) ?? null;
    const working = !weekend && !holiday;
    const people = working
      ? reqs
          .filter((r) => date >= r.startDate && date <= r.endDate)
          .map((r) => ({ requestId: r.id, staffId: r.staffId, name: names.get(r.staffId)?.name ?? '', type: mayManage || r.staffId === req.user!.id ? types.get(r.leaveTypeId) ?? 'Leave' : 'Leave', status: r.status }))
      : [];
    const away = people.filter((p) => p.status === 'Approved').length;
    return { date, weekday: weekdayOf(date), off: holiday ? 'holiday' : weekend ? 'weekend' : null, name: holiday, people, away, atWork: working ? staff.length - away : 0, belowCover: working && cal.minCover > 0 && staff.length - away < cal.minCover };
  });
  res.json({ month, staffTotal: staff.length, minCover: cal.minCover, days });
});

// ── the manager's overview ───────────────────────────────────────────────────────────────────────
hrRouter.get('/overview', manage, async (_req, res) => {
  const today = todayStr();
  const [cal, staff, pending, { names, types }] = await Promise.all([workCalendar(), activeStaff(), prisma.leaveRequest.findMany({ where: { status: 'Pending' }, orderBy: { createdAt: 'asc' } }), lookups()]);
  const dow = weekdayOf(today);
  const monday = new Date(Date.parse(today + 'T00:00:00Z') - ((dow + 6) % 7) * 86400000).toISOString().slice(0, 10);
  const weekDays = dateRange(monday, new Date(Date.parse(monday + 'T00:00:00Z') + 6 * 86400000).toISOString().slice(0, 10)).filter((d) => !cal.offWeekdays.includes(weekdayOf(d)) && !cal.offDates.has(d));
  const off = await onLeaveByDay([...new Set([today, ...weekDays])].sort());
  const onToday = off.get(today)?.length ?? 0;
  const monthStart = today.slice(0, 7) + '-01';
  const taken = await prisma.leaveRequest.findMany({ where: { status: 'Approved', startDate: { lte: today.slice(0, 7) + '-31' }, endDate: { gte: monthStart } } });
  const daysThisMonth = taken.reduce((a, r) => a + workingDaysOf(cal, r.startDate, r.endDate).filter((d) => d.startsWith(today.slice(0, 7))).length, 0);

  // what the business owes in unused annual leave: the days left to each person at their daily pay (basic salary ÷ 30)
  const year = Number(today.slice(0, 4));
  let liabilityDays = 0;
  let liability = 0;
  let noSalary = 0;
  for (const s of staff) {
    const annual = (await balancesFor(s.id, year, today, cal)).find((b) => b.name === 'Annual leave');
    if (!annual || annual.unlimited || annual.remaining <= 0) continue;
    liabilityDays += annual.remaining;
    if (s.basicSalary && s.basicSalary > 0) liability += (annual.remaining * s.basicSalary) / 30;
    else noSalary++;
  }
  res.json({
    staff: { total: staff.length, onLeaveToday: onToday, working: staff.length - onToday, todayIsWorkingDay: !cal.offWeekdays.includes(dow) && !cal.offDates.has(today) },
    pending: {
      count: pending.length,
      oldestDays: pending[0] ? Math.max(0, Math.floor((Date.now() - pending[0].createdAt.getTime()) / 86400000)) : 0,
      list: pending.slice(0, 8).map((r) => shape(r, names, types)),
    },
    leaveThisMonth: { days: daysThisMonth },
    liability: { days: round2(liabilityDays), amount: Math.round(liability), staffWithoutSalary: noSalary },
    coverage: weekDays.map((date) => ({ date, staffed: staff.length - (off.get(date)?.length ?? 0), total: staff.length, min: cal.minCover })),
  });
});

// ── the policy (manager) ─────────────────────────────────────────────────────────────────────────
const typeSchema = z.object({
  name: z.string().trim().min(2, 'Give it a name').max(60),
  paid: z.boolean(),
  daysPerYear: z.number().min(0).max(366),
  accrual: z.enum(['monthly', 'upfront']),
  carryOverCap: z.number().min(0).max(366),
  certAfterDays: z.number().int().min(0).max(60),
  active: z.boolean().default(true),
});

hrRouter.post('/leave-types', manage, async (req, res) => {
  const parsed = typeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  await ensureHrDefaults();
  if (await prisma.leaveType.findUnique({ where: { name: parsed.data.name } })) return res.status(400).json({ error: 'There is already a kind of leave with that name' });
  const last = await prisma.leaveType.aggregate({ _max: { sortOrder: true } });
  res.status(201).json(await prisma.leaveType.create({ data: { ...parsed.data, sortOrder: (last._max.sortOrder ?? 0) + 10 } }));
});

hrRouter.put('/leave-types/:id', manage, async (req, res) => {
  const parsed = typeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const clash = await prisma.leaveType.findFirst({ where: { name: parsed.data.name, id: { not: Number(req.params.id) } } });
  if (clash) return res.status(400).json({ error: 'There is already a kind of leave with that name' });
  const up = await prisma.leaveType.update({ where: { id: Number(req.params.id) }, data: parsed.data }).catch(() => null);
  if (!up) return res.status(404).json({ error: 'Not found' });
  res.json(up);
});

hrRouter.put('/settings', manage, async (req, res) => {
  const parsed = z.object({ minCover: z.number().int().min(0).max(500), offWeekdays: z.array(z.number().int().min(0).max(6)).max(6) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the minimum and the weekly days off' });
  await ensureHrDefaults();
  const data = { minCover: parsed.data.minCover, offWeekdays: [...new Set(parsed.data.offWeekdays)].sort().join(',') };
  await prisma.hrSettings.update({ where: { id: 1 }, data });
  res.json({ minCover: data.minCover, offWeekdays: parsed.data.offWeekdays });
});

hrRouter.post('/off-days', manage, async (req, res) => {
  const parsed = z.object({ date: dateStr, name: z.string().trim().min(2).max(80) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Give the date and a name' });
  if (await prisma.offDay.findUnique({ where: { date: parsed.data.date } })) return res.status(400).json({ error: 'That date is already an off day' });
  res.status(201).json(await prisma.offDay.create({ data: parsed.data }));
});
hrRouter.delete('/off-days/:id', manage, async (req, res) => {
  await prisma.offDay.delete({ where: { id: Number(req.params.id) } }).catch(() => null);
  res.status(204).end();
});

hrRouter.put('/staff/:id/hire-date', manage, async (req, res) => {
  const parsed = z.object({ hireDate: dateStr.nullable() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter the day they started' });
  const up = await prisma.user.update({ where: { id: Number(req.params.id) }, data: { hireDate: parsed.data.hireDate } }).catch(() => null);
  if (!up) return res.status(404).json({ error: 'Person not found' });
  res.json({ id: up.id, hireDate: up.hireDate });
});

// ── performance ──────────────────────────────────────────────────────────────────────────────────
const quarterOf = (d: string) => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
const periodRe = /^\d{4}-Q[1-4]$/;
const monthsOfQuarter = (q: string) => {
  const y = q.slice(0, 4);
  const first = (Number(q.slice(6)) - 1) * 3 + 1;
  return [0, 1, 2].map((i) => `${y}-${String(first + i).padStart(2, '0')}`);
};

hrRouter.get('/performance', manage, async (req, res) => {
  const period = typeof req.query.period === 'string' && periodRe.test(req.query.period) ? req.query.period : quarterOf(todayStr());
  const months = monthsOfQuarter(period).filter((m) => m <= todayStr().slice(0, 7));
  const cal = await workCalendar();
  const [staff, reviews, statements, requests] = await Promise.all([
    activeStaff(),
    prisma.performanceReview.findMany({ where: { period } }),
    Promise.all(months.map((m) => buildStatements(m))),
    prisma.leaveRequest.findMany({ where: { status: 'Approved', startDate: { lte: `${monthsOfQuarter(period)[2]}-31` }, endDate: { gte: `${monthsOfQuarter(period)[0]}-01` } } }),
  ]);
  const first = `${monthsOfQuarter(period)[0]}-01`;
  const last = `${monthsOfQuarter(period)[2]}-31`;
  const rows = staff.map((s) => {
    let sales = 0;
    let target = 0;
    let orders = 0;
    let commission = 0;
    let sold = false;
    for (const b of statements) {
      const st = b.statements.find((x) => x.staffId === s.id);
      if (!st) continue;
      sold = true;
      sales += st.target.achieved;
      if (st.target.applies) target += st.target.required;
      orders += st.productivity.ordersCaptured;
      commission += st.pay.amount;
    }
    const leaveDays = requests.filter((r) => r.staffId === s.id).reduce((a, r) => a + workingDaysOf(cal, r.startDate < first ? first : r.startDate, r.endDate > last ? last : r.endDate).length, 0);
    const rv = reviews.find((x) => x.staffId === s.id);
    return {
      staffId: s.id,
      name: s.name,
      role: s.role,
      hireDate: s.hireDate,
      sales: sold ? round2(sales) : null,
      target: target > 0 ? round2(target) : null,
      salesVsTarget: target > 0 ? Math.round((sales / target) * 100) : null,
      orders: sold ? orders : null,
      commission: sold ? round2(commission) : null,
      leaveDays,
      review: rv ? { goalsMet: rv.goalsMet, goalsTotal: rv.goalsTotal, rating: rv.rating, note: rv.note, status: rv.status, reviewerName: rv.reviewerName } : null,
    };
  });
  res.json({ period, months, rows });
});

hrRouter.put('/performance/:staffId', manage, async (req, res) => {
  const parsed = z
    .object({
      period: z.string().regex(periodRe),
      goalsMet: z.number().int().min(0).max(100),
      goalsTotal: z.number().int().min(0).max(100),
      rating: z.number().min(0).max(100).nullable(),
      note: z.string().trim().max(1000).default(''),
      status: z.enum(['Draft', 'Done']),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Check the review: goals met cannot be more than the goals, and the rating is 0 to 100' });
  const d = parsed.data;
  if (d.goalsMet > d.goalsTotal) return res.status(400).json({ error: 'Goals met cannot be more than the goals set' });
  const staffId = Number(req.params.staffId);
  if (!(await prisma.user.findUnique({ where: { id: staffId } }))) return res.status(404).json({ error: 'Person not found' });
  const data = { goalsMet: d.goalsMet, goalsTotal: d.goalsTotal, rating: d.rating, note: d.note, status: d.status, reviewerName: req.user!.name };
  res.json(await prisma.performanceReview.upsert({ where: { staffId_period: { staffId, period: d.period } }, update: data, create: { staffId, period: d.period, ...data } }));
});

hrRouter.get('/notes', manage, async (req, res) => {
  const staffId = Number(req.query.staffId);
  if (!staffId) return res.status(400).json({ error: 'Choose a person' });
  res.json(await prisma.oneToOneNote.findMany({ where: { staffId }, orderBy: [{ date: 'desc' }, { id: 'desc' }], take: 30 }));
});
hrRouter.post('/notes', manage, async (req, res) => {
  const parsed = z.object({ staffId: z.number().int(), date: dateStr, note: z.string().trim().min(3, 'Write the note').max(1000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid note' });
  res.status(201).json(await prisma.oneToOneNote.create({ data: { ...parsed.data, authorName: req.user!.name } }));
});
