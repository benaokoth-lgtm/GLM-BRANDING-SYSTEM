// People (HR): leave. The rules that decide how many days a request uses and how many days a person has, in one place so the screen, the server and the tests agree.
// A leave day is a WORKING day: a day the business is open (not one of its weekly days off, and not a public holiday or company off day).

export const LEAVE_STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export interface LeaveTypeRow {
  id: number;
  name: string;
  /** Paid leave is part of pay; unpaid leave is taken off it. */
  paid: boolean;
  /** Days a person may take in a calendar year; 0 = no limit. */
  daysPerYear: number;
  /** 'monthly': earned a month at a time (annual leave); 'upfront': the whole allowance from the start of the year. */
  accrual: 'monthly' | 'upfront';
  /** Unused days carried into the next year, up to this many (monthly-accrual types). */
  carryOverCap: number;
  /** A medical certificate is needed once a request is longer than this many days; 0 = never. */
  certAfterDays: number;
  active: boolean;
  sortOrder: number;
}

/** What a new database starts with, from the Employment Act's minimums; an Admin can change every figure (Master Data → HR policy). */
export const DEFAULT_LEAVE_TYPES: Omit<LeaveTypeRow, 'id'>[] = [
  { name: 'Annual leave', paid: true, daysPerYear: 21, accrual: 'monthly', carryOverCap: 5, certAfterDays: 0, active: true, sortOrder: 10 },
  { name: 'Sick leave', paid: true, daysPerYear: 7, accrual: 'upfront', carryOverCap: 0, certAfterDays: 2, active: true, sortOrder: 20 },
  { name: 'Off-in-lieu', paid: true, daysPerYear: 4, accrual: 'upfront', carryOverCap: 0, certAfterDays: 0, active: true, sortOrder: 30 },
  { name: 'Unpaid leave', paid: false, daysPerYear: 5, accrual: 'upfront', carryOverCap: 0, certAfterDays: 0, active: true, sortOrder: 40 },
  { name: 'Maternity leave', paid: true, daysPerYear: 90, accrual: 'upfront', carryOverCap: 0, certAfterDays: 0, active: true, sortOrder: 50 },
  { name: 'Paternity leave', paid: true, daysPerYear: 14, accrual: 'upfront', carryOverCap: 0, certAfterDays: 0, active: true, sortOrder: 60 },
];

const pad = (n: number) => String(n).padStart(2, '0');
const parse = (d: string) => new Date(d + 'T00:00:00Z');
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => fmt(new Date(parse(d).getTime() + n * 86400000));
export const weekdayOf = (d: string) => parse(d).getUTCDay(); // 0 = Sunday … 6 = Saturday

/** Every date from `start` to `end`, inclusive. */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The days a leave from `start` to `end` uses: the days in it that are not a weekly day off and not an off day. */
export function leaveWorkingDays(start: string, end: string, offWeekdays: number[], offDates: ReadonlySet<string>): string[] {
  return dateRange(start, end).filter((d) => !offWeekdays.includes(weekdayOf(d)) && !offDates.has(d));
}

/** The fixed-date public holidays in Kenya for a year. A holiday that falls on a Sunday moves to the Monday. Easter and the Islamic holidays move every year: an Admin adds them. */
export function kenyaFixedHolidays(year: number): { date: string; name: string }[] {
  const list: [string, string][] = [
    [`${year}-01-01`, "New Year's Day"],
    [`${year}-05-01`, 'Labour Day'],
    [`${year}-06-01`, 'Madaraka Day'],
    [`${year}-10-10`, 'Utamaduni Day'],
    [`${year}-10-20`, 'Mashujaa Day'],
    [`${year}-12-12`, 'Jamhuri Day'],
    [`${year}-12-25`, 'Christmas Day'],
    [`${year}-12-26`, 'Boxing Day'],
  ];
  const out = list.map(([date, name]) => ({ date, name }));
  // Sunday → Monday (a holiday on a Sunday is observed the next day, unless that day is itself a holiday)
  const taken = new Set(out.map((h) => h.date));
  return out.map((h) => {
    if (weekdayOf(h.date) !== 0) return h;
    let next = addDays(h.date, 1);
    while (taken.has(next)) next = addDays(next, 1);
    taken.add(next);
    return { date: next, name: `${h.name} (observed)` };
  });
}

/** Whole months of the year a person has been employed up to and including the month of `asOf` (0–12). */
export function monthsServedInYear(hireDate: string | null, year: number, asOf: string): number {
  const asOfYear = Number(asOf.slice(0, 4));
  const lastMonth = asOfYear > year ? 12 : asOfYear < year ? 0 : Number(asOf.slice(5, 7));
  if (!hireDate || hireDate.slice(0, 4) < String(year)) return lastMonth;
  if (hireDate.slice(0, 4) > String(year)) return 0;
  // hired this year: the hire month counts (a month started is a month earned)
  return Math.max(0, lastMonth - Number(hireDate.slice(5, 7)) + 1);
}

/** What a person has earned of a type of leave in `year`, as of `asOf`. */
export function leaveEntitled(type: Pick<LeaveTypeRow, 'daysPerYear' | 'accrual'>, hireDate: string | null, year: number, asOf: string): number {
  if (type.daysPerYear <= 0) return 0;
  if (type.accrual === 'upfront') return hireDate && hireDate.slice(0, 4) > String(year) ? 0 : type.daysPerYear;
  return Math.round(((type.daysPerYear * monthsServedInYear(hireDate, year, asOf)) / 12) * 100) / 100;
}

/** Unused days brought into a year from the one before, up to the cap (types that accrue monthly only). */
export function leaveCarriedOver(type: Pick<LeaveTypeRow, 'daysPerYear' | 'accrual' | 'carryOverCap'>, hireDate: string | null, year: number, takenLastYear: number): number {
  if (type.accrual !== 'monthly' || type.carryOverCap <= 0 || type.daysPerYear <= 0) return 0;
  const lastYearEarned = leaveEntitled(type, hireDate, year - 1, `${year - 1}-12-31`);
  return Math.max(0, Math.min(type.carryOverCap, Math.round((lastYearEarned - takenLastYear) * 100) / 100));
}

export const fmtDays = (n: number) => `${Math.round(n * 100) / 100}`;
export const monthKey = (d: string) => `${d.slice(0, 4)}-${d.slice(5, 7)}`;
export const hrPad = pad;

/** A request's days as a short label: "Mon 12 Oct – Wed 14 Oct" (or one day). */
export function dateSpanLabel(start: string, end: string): string {
  const f = (d: string) => parse(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return start === end ? f(start) : `${f(start)} – ${f(end)}`;
}
