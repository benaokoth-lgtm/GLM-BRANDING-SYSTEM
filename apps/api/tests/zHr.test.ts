// (Named to run late: it adds people and leave, which would otherwise show in other tests' staff lists.)
// People (HR): the leave rules, requests and their approval, the calendar, the overview and performance reviews.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_LEAVE_TYPES, kenyaFixedHolidays, leaveCarriedOver, leaveEntitled, leaveWorkingDays, monthsServedInYear } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('leave rules', () => {
  it('counts working days: not the weekly day off, not public holidays or company off days', () => {
    // Mon 1 – Mon 8 March 2027, Sunday off: Mon–Sat is 6, plus the Monday 8th = 7; a company off day on Wed 3rd takes one away
    assert.equal(leaveWorkingDays('2027-03-01', '2027-03-08', [0], new Set()).length, 7);
    assert.deepEqual(leaveWorkingDays('2027-03-01', '2027-03-08', [0], new Set(['2027-03-03'])).includes('2027-03-03'), false);
    assert.equal(leaveWorkingDays('2027-03-01', '2027-03-08', [0, 6], new Set()).length, 6); // Saturday and Sunday off: Mon–Fri and the Monday after
    assert.equal(leaveWorkingDays('2027-03-07', '2027-03-07', [0], new Set()).length, 0); // a Sunday alone is nothing
  });

  it('knows the fixed public holidays, and moves one that falls on a Sunday to the Monday', () => {
    const y26 = kenyaFixedHolidays(2026);
    assert.equal(y26.length, 8);
    assert.ok(y26.some((h) => h.date === '2026-06-01' && h.name === 'Madaraka Day'));
    assert.ok(y26.some((h) => h.date === '2026-10-20'));
    // 10 October 2027 is a Sunday
    const y27 = kenyaFixedHolidays(2027);
    assert.ok(y27.some((h) => h.date === '2027-10-11' && /observed/.test(h.name)));
    assert.ok(!y27.some((h) => h.date === '2027-10-10'));
  });

  it('earns annual leave a month at a time, from the month a person starts, and carries a few days over', () => {
    const annual = DEFAULT_LEAVE_TYPES[0]!;
    assert.equal(leaveEntitled(annual, null, 2026, '2026-06-30'), 10.5); // 21 × 6/12
    assert.equal(monthsServedInYear('2026-04-15', 2026, '2026-06-30'), 3);
    assert.equal(leaveEntitled(annual, '2026-04-15', 2026, '2026-06-30'), 5.25);
    assert.equal(leaveEntitled(annual, '2027-02-01', 2026, '2026-12-31'), 0); // not yet employed
    // 21 earned last year, 10 taken: 11 left, but only 5 may be carried
    assert.equal(leaveCarriedOver(annual, null, 2027, 10), 5);
    assert.equal(leaveCarriedOver(annual, null, 2027, 18), 3);
    const sick = DEFAULT_LEAVE_TYPES[1]!; // the whole allowance from the start of the year
    assert.equal(leaveEntitled(sick, null, 2026, '2026-01-31'), 7);
    assert.equal(leaveCarriedOver(sick, null, 2027, 0), 0);
  });
});

describe('People (HR)', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'HR Staff', canAccessHr: true, canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'HR Manager', canAccessHr: true, canManageHr: true } });
    await prisma.role.create({ data: { name: 'No HR', canCaptureOrders: true } });
    for (const [key, role] of [['ann', 'HR Staff'], ['ben', 'HR Staff'], ['mgr', 'HR Manager'], ['outsider', 'No HR']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (hr test)`, role, pinHash: 'x', basicSalary: key === 'ann' ? 30000 : null } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await prisma.hrSettings.update({ where: { id: 1 }, data: { minCover: 0 } }).catch(() => null);
    server.close();
    await prisma.$disconnect();
  });

  const annual = async () => (await call('ann', 'GET', '/hr/config')).body.leaveTypes.find((t: any) => t.name === 'Annual leave').id;
  const sickId = async () => (await call('ann', 'GET', '/hr/config')).body.leaveTypes.find((t: any) => t.name === 'Sick leave').id;

  it('starts with the kinds of leave and the public holidays, and is for people with HR access', async () => {
    assert.equal((await call('outsider', 'GET', '/hr/config')).status, 403);
    const c = await call('ann', 'GET', '/hr/config');
    assert.equal(c.status, 200);
    assert.equal(c.body.canManage, false);
    assert.deepEqual(c.body.leaveTypes.slice(0, 3).map((t: any) => t.name), ['Annual leave', 'Sick leave', 'Off-in-lieu']);
    assert.deepEqual(c.body.settings.offWeekdays, [0]);
    assert.ok(c.body.offDays.length >= 8);
    assert.deepEqual(c.body.staff.map((s: any) => s.id), [ids.ann]); // a person sees only themselves in the staff list
    assert.equal((await call('mgr', 'GET', '/hr/config')).body.canManage, true);
  });

  it('works out the days, checks the balance, refuses overlaps, and wants a certificate for a longer sick leave', async () => {
    const type = await annual();
    // Mon 1 – Wed 3 March 2027: 3 working days; 5.25 days have been earned by then
    const ok = await call('ann', 'POST', '/hr/requests', { leaveTypeId: type, startDate: '2027-03-01', endDate: '2027-03-03', reason: 'Family' });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.days, ok.body.status, ok.body.type], [3, 'Pending', 'Annual leave']);
    // more than is left: 5.25 earned by March and 5 carried over from last year, less the 3 asked for, is 7.25; Thu 4 – Sat 13 March is 9 working days
    const tooMany = await call('ann', 'POST', '/hr/requests', { leaveTypeId: type, startDate: '2027-03-04', endDate: '2027-03-13' });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /Only 7.25 days/);
    assert.match((await call('ann', 'POST', '/hr/requests', { leaveTypeId: type, startDate: '2027-03-03', endDate: '2027-03-04' })).body.error, /overlap/);
    assert.equal((await call('ann', 'POST', '/hr/requests', { leaveTypeId: type, startDate: '2027-03-09', endDate: '2027-03-08' })).status, 400); // ends before it starts
    assert.match((await call('ann', 'POST', '/hr/requests', { leaveTypeId: type, startDate: '2027-03-07', endDate: '2027-03-07' })).body.error, /days off/); // a Sunday
    // nobody else's leave
    assert.equal((await call('ann', 'POST', '/hr/requests', { staffId: ids.ben, leaveTypeId: type, startDate: '2027-04-05', endDate: '2027-04-06' })).status, 403);
    // sick leave over two days needs a certificate
    const sick = await sickId();
    const noCert = await call('ann', 'POST', '/hr/requests', { leaveTypeId: sick, startDate: '2027-03-15', endDate: '2027-03-17' });
    assert.equal(noCert.status, 400);
    assert.match(noCert.body.error, /medical certificate/);
    assert.equal((await call('ann', 'POST', '/hr/requests', { leaveTypeId: sick, startDate: '2027-03-15', endDate: '2027-03-17', certificate: true })).status, 201);

    const bal = (await call('ann', 'GET', '/hr/balances?year=2027')).body.balances.find((b: any) => b.name === 'Annual leave');
    assert.deepEqual([bal.pending, bal.taken], [3, 0]);
    // a manager asks for someone for them (the front desk keys it), and the person's own list is theirs
    assert.equal((await call('mgr', 'POST', '/hr/requests', { staffId: ids.ben, leaveTypeId: type, startDate: '2027-04-05', endDate: '2027-04-06' })).status, 201);
    assert.ok((await call('ben', 'GET', '/hr/requests')).body.every((r: any) => r.staffId === ids.ben));
    assert.ok((await call('mgr', 'GET', '/hr/requests?status=Pending')).body.length >= 3);
  });

  it('is decided by a manager: approved or rejected with a reason, never by the person or a manager for themselves', async () => {
    const mine = (await call('ann', 'GET', '/hr/requests')).body.find((r: any) => r.type === 'Annual leave');
    assert.equal((await call('ann', 'POST', `/hr/requests/${mine.id}/approve`, {})).status, 403);
    assert.equal((await call('mgr', 'POST', `/hr/requests/${mine.id}/reject`, {})).status, 400); // a reason is needed
    const ok = await call('mgr', 'POST', `/hr/requests/${mine.id}/approve`, {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.status, ok.body.decidedByName], ['Approved', 'mgr (hr test)']);
    assert.equal((await call('mgr', 'POST', `/hr/requests/${mine.id}/approve`, {})).status, 400); // already decided
    const bal = (await call('ann', 'GET', '/hr/balances?year=2027')).body.balances.find((b: any) => b.name === 'Annual leave');
    assert.deepEqual([bal.taken, bal.pending], [3, 0]);

    // a manager cannot approve their own
    const own = await call('mgr', 'POST', '/hr/requests', { leaveTypeId: await annual(), startDate: '2027-05-03', endDate: '2027-05-04' });
    assert.equal(own.status, 201);
    assert.match((await call('mgr', 'POST', `/hr/requests/${own.body.id}/approve`, {})).body.error, /own leave/);

    const benReq = (await call('ben', 'GET', '/hr/requests')).body[0];
    const rej = await call('mgr', 'POST', `/hr/requests/${benReq.id}/reject`, { reason: 'Month-end stocktake' });
    assert.deepEqual([rej.body.status, rej.body.decisionNote], ['Rejected', 'Month-end stocktake']);
    // taking back a request: your own while it waits; an approved one only by a manager
    const again = await call('ben', 'POST', '/hr/requests', { leaveTypeId: await annual(), startDate: '2027-04-12', endDate: '2027-04-13' });
    assert.equal((await call('ben', 'POST', `/hr/requests/${again.body.id}/cancel`)).body.status, 'Cancelled');
    assert.equal((await call('ben', 'POST', `/hr/requests/${mine.id}/cancel`)).status, 403);
    assert.equal((await call('ann', 'POST', `/hr/requests/${mine.id}/cancel`)).status, 400); // approved: not by the person
    assert.equal((await call('mgr', 'POST', `/hr/requests/${mine.id}/cancel`)).body.status, 'Cancelled');
    assert.equal((await call('ann', 'GET', '/hr/balances?year=2027')).body.balances.find((b: any) => b.name === 'Annual leave').taken, 0); // the days are back
  });

  it('asks for confirmation when approving would leave fewer people at work than the minimum', async () => {
    const staffCount = (await prisma.user.count({ where: { active: true } }));
    assert.equal((await call('ann', 'PUT', '/hr/settings', { minCover: 1, offWeekdays: [0] })).status, 403);
    assert.equal((await call('mgr', 'PUT', '/hr/settings', { minCover: staffCount + 5, offWeekdays: [0] })).status, 200);
    const r = await call('ben', 'POST', '/hr/requests', { leaveTypeId: await annual(), startDate: '2027-06-07', endDate: '2027-06-08' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const first = await call('mgr', 'POST', `/hr/requests/${r.body.id}/approve`, {});
    assert.equal(first.status, 409);
    assert.equal(first.body.needsConfirm, true);
    assert.match(first.body.error, /fewer than/);
    const second = await call('mgr', 'POST', `/hr/requests/${r.body.id}/approve`, { confirm: true });
    assert.equal(second.status, 200);
    assert.equal(second.body.decisionNote, 'Approved below the minimum cover');
    // the calendar shows the days below the minimum
    const cal = (await call('mgr', 'GET', '/hr/calendar?month=2027-06')).body;
    assert.equal(cal.days.find((d: any) => d.date === '2027-06-07').belowCover, true);
    assert.equal((await call('mgr', 'PUT', '/hr/settings', { minCover: 0, offWeekdays: [0] })).status, 200);
  });

  it('shows who is off on a calendar: days off marked, others’ kind of leave kept private', async () => {
    const approved = await call('mgr', 'POST', '/hr/requests', { staffId: ids.ann, leaveTypeId: await annual(), startDate: '2027-02-22', endDate: '2027-02-23' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal((await call('mgr', 'POST', `/hr/requests/${approved.body.id}/approve`, {})).status, 200);
    const asBen = (await call('ben', 'GET', '/hr/calendar?month=2027-02')).body;
    const day = asBen.days.find((d: any) => d.date === '2027-02-22');
    assert.deepEqual(day.people.map((p: any) => [p.name, p.type, p.status]), [['ann (hr test)', 'Leave', 'Approved']]); // not Ben's business what kind
    const asAnn = (await call('ann', 'GET', '/hr/calendar?month=2027-02')).body;
    assert.equal(asAnn.days.find((d: any) => d.date === '2027-02-22').people[0].type, 'Annual leave');
    assert.equal(asAnn.days.find((d: any) => d.date === '2027-02-21').off, 'weekend'); // a Sunday
    assert.equal(asAnn.days.find((d: any) => d.date === '2027-02-21').people.length, 0);
    // an off day an Admin adds is not a working day
    const off = await call('mgr', 'POST', '/hr/off-days', { date: '2027-02-24', name: 'Company retreat' });
    assert.equal(off.status, 201);
    assert.equal((await call('mgr', 'POST', '/hr/off-days', { date: '2027-02-24', name: 'Again' })).status, 400);
    assert.equal((await call('ben', 'GET', '/hr/calendar?month=2027-02')).body.days.find((d: any) => d.date === '2027-02-24').off, 'holiday');
    assert.equal((await call('mgr', 'DELETE', `/hr/off-days/${off.body.id}`)).status, 204);
  });

  it('gives a manager the overview, including what unused annual leave is worth', async () => {
    assert.equal((await call('ann', 'GET', '/hr/overview')).status, 403);
    const o = (await call('mgr', 'GET', '/hr/overview')).body;
    assert.ok(o.staff.total >= 4);
    assert.ok(o.pending.count >= 1);
    assert.ok(Array.isArray(o.pending.list) && Array.isArray(o.coverage));
    // Ann earns 30,000 a month: her unused annual leave is worth her daily pay (÷ 30) for each day left
    assert.ok(o.liability.days > 0);
    assert.ok(o.liability.amount >= 1000);
    assert.ok(o.liability.staffWithoutSalary >= 1);
  });

  it('runs reviews: sales against target from the books, goals met, a rating and one-to-one notes', async () => {
    assert.equal((await call('ann', 'GET', '/hr/performance')).status, 403);
    const p = (await call('mgr', 'GET', '/hr/performance?period=2026-Q4')).body;
    assert.equal(p.period, '2026-Q4');
    const row = p.rows.find((r: any) => r.staffId === ids.ann);
    assert.ok(row);
    assert.equal(row.review, null);
    assert.equal((await call('mgr', 'PUT', `/hr/performance/${ids.ann}`, { period: '2026-Q4', goalsMet: 5, goalsTotal: 3, rating: 80, note: '', status: 'Done' })).status, 400);
    const saved = await call('mgr', 'PUT', `/hr/performance/${ids.ann}`, { period: '2026-Q4', goalsMet: 3, goalsTotal: 4, rating: 82, note: 'Reliable; more upselling', status: 'Done' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const again = (await call('mgr', 'GET', '/hr/performance?period=2026-Q4')).body.rows.find((r: any) => r.staffId === ids.ann);
    assert.deepEqual([again.review.goalsMet, again.review.goalsTotal, again.review.rating, again.review.status], [3, 4, 82, 'Done']);
    assert.equal((await call('mgr', 'POST', '/hr/notes', { staffId: ids.ann, date: '2026-10-14', note: 'Talked through the target' })).status, 201);
    assert.equal((await call('mgr', 'GET', `/hr/notes?staffId=${ids.ann}`)).body[0].note, 'Talked through the target');
    assert.equal((await call('ann', 'GET', `/hr/notes?staffId=${ids.ann}`)).status, 403);
    // a start date: leave is earned from it
    assert.equal((await call('mgr', 'PUT', `/hr/staff/${ids.ben}/hire-date`, { hireDate: '2027-01-01' })).status, 200);
    assert.equal((await call('ann', 'PUT', `/hr/staff/${ids.ben}/hire-date`, { hireDate: '2020-01-01' })).status, 403);
  });
});
