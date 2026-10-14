import { DEFAULT_LEAVE_TYPES, kenyaFixedHolidays, leaveCarriedOver, leaveEntitled, leaveWorkingDays, round2 } from '@glm/shared';
import type { LeaveTypeRow } from '@glm/shared';
import { prisma } from './db';

// People (HR): the working calendar, who is on leave, and what each person has left. The rules are in packages/shared/src/hr.ts; this reads the data they need.

const toType = (t: { id: number; name: string; paid: boolean; daysPerYear: number; accrual: string; carryOverCap: number; certAfterDays: number; active: boolean; sortOrder: number }): LeaveTypeRow => ({ ...t, accrual: t.accrual === 'monthly' ? 'monthly' : 'upfront' });

let seeding: Promise<void> | null = null;
/** Once: the kinds of leave, this year's and next year's fixed public holidays, the settings row, and the HR permissions for the roles that exist (everyone may ask for leave; the General Manager decides it). */
export function ensureHrDefaults(): Promise<void> {
  if (!seeding) {
    seeding = (async () => {
      if ((await prisma.leaveType.count()) === 0) await prisma.leaveType.createMany({ data: DEFAULT_LEAVE_TYPES });
      if ((await prisma.offDay.count()) === 0) {
        const y = new Date().getUTCFullYear();
        await prisma.offDay.createMany({ data: [...kenyaFixedHolidays(y), ...kenyaFixedHolidays(y + 1)] });
      }
      await prisma.hrSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
      const settings = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
      if (!settings.hrAccessSeeded) {
        await prisma.role.updateMany({ data: { canAccessHr: true } });
        await prisma.role.updateMany({ where: { name: 'General Manager' }, data: { canManageHr: true } });
        await prisma.setting.update({ where: { id: 1 }, data: { hrAccessSeeded: true } });
      }
    })()
      .catch((e) => console.error('HR set-up failed', e))
      .finally(() => (seeding = null));
  }
  return seeding;
}

export async function leaveTypes(all = false): Promise<LeaveTypeRow[]> {
  await ensureHrDefaults();
  return (await prisma.leaveType.findMany({ where: all ? {} : { active: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })).map(toType);
}

export interface WorkCalendar {
  offWeekdays: number[];
  offDates: Map<string, string>;
  minCover: number;
}
export async function workCalendar(): Promise<WorkCalendar> {
  await ensureHrDefaults();
  const [s, off] = await Promise.all([prisma.hrSettings.findUniqueOrThrow({ where: { id: 1 } }), prisma.offDay.findMany()]);
  return {
    offWeekdays: s.offWeekdays.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    offDates: new Map(off.map((o) => [o.date, o.name])),
    minCover: s.minCover,
  };
}

/** The working days a leave uses (dates, in order). */
export const workingDaysOf = (cal: WorkCalendar, start: string, end: string) => leaveWorkingDays(start, end, cal.offWeekdays, new Set(cal.offDates.keys()));

/** A person's days in a type of leave for a calendar year, from their requests: those approved, and those still waiting. */
async function daysIn(staffId: number, typeId: number, year: number, cal: WorkCalendar) {
  const reqs = await prisma.leaveRequest.findMany({ where: { staffId, leaveTypeId: typeId, status: { in: ['Approved', 'Pending'] }, startDate: { lte: `${year}-12-31` }, endDate: { gte: `${year}-01-01` } } });
  let approved = 0;
  let pending = 0;
  for (const r of reqs) {
    const n = workingDaysOf(cal, r.startDate, r.endDate).filter((d) => d.startsWith(String(year))).length;
    if (r.status === 'Approved') approved += n;
    else pending += n;
  }
  return { approved, pending };
}

export interface Balance {
  typeId: number;
  name: string;
  paid: boolean;
  unlimited: boolean;
  entitled: number;
  carried: number;
  taken: number;
  pending: number;
  /** What is left after the days already taken. */
  remaining: number;
  /** What can still be asked for: what is left less what is waiting for a decision. */
  available: number;
}

export async function balancesFor(staffId: number, year: number, asOf: string, cal?: WorkCalendar): Promise<Balance[]> {
  const calendar = cal ?? (await workCalendar());
  const [types, user] = await Promise.all([leaveTypes(), prisma.user.findUnique({ where: { id: staffId }, select: { hireDate: true } })]);
  const hire = user?.hireDate ?? null;
  const out: Balance[] = [];
  for (const t of types) {
    const unlimited = t.daysPerYear <= 0;
    const { approved, pending } = await daysIn(staffId, t.id, year, calendar);
    const entitled = leaveEntitled(t, hire, year, asOf);
    const carried = !unlimited && t.accrual === 'monthly' ? leaveCarriedOver(t, hire, year, (await daysIn(staffId, t.id, year - 1, calendar)).approved) : 0;
    const remaining = unlimited ? 0 : round2(entitled + carried - approved);
    out.push({ typeId: t.id, name: t.name, paid: t.paid, unlimited, entitled, carried, taken: approved, pending, remaining, available: unlimited ? 0 : round2(remaining - pending) });
  }
  return out;
}

/** Everyone who works here: active staff. */
export const activeStaff = () => prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, role: true, hireDate: true, basicSalary: true }, orderBy: { name: 'asc' } });

/** The approved leaves that cover each of the given days (ignoring leaves of `exceptRequestId`). */
export async function onLeaveByDay(days: string[], exceptRequestId?: number) {
  if (days.length === 0) return new Map<string, number[]>();
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const reqs = await prisma.leaveRequest.findMany({ where: { status: 'Approved', startDate: { lte: last }, endDate: { gte: first }, ...(exceptRequestId ? { id: { not: exceptRequestId } } : {}) } });
  const out = new Map<string, number[]>(days.map((d) => [d, []]));
  for (const r of reqs) for (const d of days) if (d >= r.startDate && d <= r.endDate) out.get(d)!.push(r.staffId);
  return out;
}
