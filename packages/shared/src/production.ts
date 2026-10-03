// Production & quality control: the stage an order is in, and how staff output and quality are measured.
//
// An order's life after it is captured (Order.stage):
//   Order Received  — waiting to be assigned to a staff member
//   In Production   — assigned; the worker starts it, then finishes it and reports what they produced
//   Quality Check   — production finished; waits for a QC inspection (never the person who made it)
//   Ready for Pickup/Delivery — QC passed
//   Completed       — handed over to the customer. This is the ONLY way an order becomes Completed: neither Production nor
//                     Quality can declare an order completed. A failed QC check sends the order back to In Production.

export const STAGE_WAITING = 'Order Received';
export const STAGE_IN_PRODUCTION = 'In Production';
export const STAGE_QUALITY = 'Quality Check';
export const STAGE_READY = 'Ready for Pickup/Delivery';
export const STAGE_COMPLETED = 'Completed';

export const TASK_STATUSES = ['Assigned', 'In Progress', 'Finished', 'Superseded'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** A task that is still being worked on. */
export const ACTIVE_TASK_STATUSES: string[] = ['Assigned', 'In Progress'];

export const QC_RESULTS = ['Passed', 'Failed'] as const;
export type QcResult = (typeof QC_RESULTS)[number];

/** What a job is worth in units: the pieces / metres / sqm across its lines. */
export function orderUnits(lines: { qty: number }[]): number {
  return Math.round(lines.reduce((a, l) => a + (Number(l.qty) || 0), 0) * 100) / 100;
}

export interface TaskFact {
  id: number;
  assigneeId: number;
  assignedAt: string; // ISO timestamp
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  isRework: boolean;
  unitsPlanned: number;
  unitsCompleted: number | null;
}

export interface CheckFact {
  taskId: number | null;
  result: string;
  unitsRejected: number;
}

export interface StaffProductivity {
  assigneeId: number;
  /** Jobs finished in the period. */
  jobsFinished: number;
  /** Units reported produced on those jobs. */
  unitsCompleted: number;
  /** Units the same jobs were planned for — output ÷ planned shows over/under-delivery. */
  unitsPlanned: number;
  /** Average hours from starting (or being assigned, if never started) to finishing. */
  avgHours: number | null;
  /** Quality checks on this person's first-time work (not rework) in the period… */
  checked: number;
  /** …and how many of them passed first time. */
  passedFirstTime: number;
  firstPassPct: number | null;
  /** Checks that failed and sent their work back. */
  failedChecks: number;
  rejectedUnits: number;
  /** Jobs they are working on right now. */
  active: number;
}

const ms = (iso: string) => new Date(iso).getTime();
const round1 = (n: number) => Math.round(n * 10) / 10;
/** 'YYYY-MM-DD' → the instant the day starts / ends, in the same (UTC) terms the timestamps are stored in. */
const dayStart = (d: string) => ms(`${d}T00:00:00.000Z`);
const dayEnd = (d: string) => ms(`${d}T23:59:59.999Z`);

/**
 * Per-staff output and quality over a period. A job counts in the period it was FINISHED. Quality is measured on the
 * worker's first-time work: a job that fails QC is reworked (a new task) and the failure stays against the first attempt,
 * so rework can't hide a problem — but the rework itself still counts as output when it is finished.
 */
export function staffProductivity(tasks: TaskFact[], checks: CheckFact[], from: string, to: string): StaffProductivity[] {
  const lo = dayStart(from);
  const hi = dayEnd(to);
  const byTask = new Map<number, CheckFact[]>();
  for (const c of checks) if (c.taskId != null) byTask.set(c.taskId, [...(byTask.get(c.taskId) ?? []), c]);

  const out = new Map<number, StaffProductivity & { _hours: number[] }>();
  const row = (id: number) => {
    let r = out.get(id);
    if (!r) {
      r = { assigneeId: id, jobsFinished: 0, unitsCompleted: 0, unitsPlanned: 0, avgHours: null, checked: 0, passedFirstTime: 0, firstPassPct: null, failedChecks: 0, rejectedUnits: 0, active: 0, _hours: [] };
      out.set(id, r);
    }
    return r;
  };

  for (const t of tasks) {
    const r = row(t.assigneeId);
    if (ACTIVE_TASK_STATUSES.includes(t.status)) r.active++;
    if (t.status !== 'Finished' || !t.finishedAt) continue;
    const finished = ms(t.finishedAt);
    if (finished < lo || finished > hi) continue;
    r.jobsFinished++;
    r.unitsCompleted += t.unitsCompleted ?? 0;
    r.unitsPlanned += t.unitsPlanned;
    r._hours.push((finished - ms(t.startedAt ?? t.assignedAt)) / 3_600_000);
    for (const c of byTask.get(t.id) ?? []) {
      r.rejectedUnits += c.unitsRejected;
      if (c.result === 'Failed') r.failedChecks++;
      if (!t.isRework) {
        r.checked++;
        if (c.result === 'Passed') r.passedFirstTime++;
      }
    }
  }

  return [...out.values()].map(({ _hours, ...r }) => ({
    ...r,
    unitsCompleted: round1(r.unitsCompleted),
    unitsPlanned: round1(r.unitsPlanned),
    rejectedUnits: round1(r.rejectedUnits),
    avgHours: _hours.length ? round1(_hours.reduce((a, h) => a + h, 0) / _hours.length) : null,
    firstPassPct: r.checked ? Math.round((r.passedFirstTime / r.checked) * 1000) / 10 : null,
  }));
}

/** Units finished per day across all staff — the daily output line of the productivity screen. */
export function dailyOutput(tasks: TaskFact[], from: string, to: string): { date: string; units: number; jobs: number }[] {
  const lo = dayStart(from);
  const hi = dayEnd(to);
  const days = new Map<string, { units: number; jobs: number }>();
  for (const t of tasks) {
    if (t.status !== 'Finished' || !t.finishedAt) continue;
    const f = ms(t.finishedAt);
    if (f < lo || f > hi) continue;
    const key = t.finishedAt.slice(0, 10);
    const d = days.get(key) ?? { units: 0, jobs: 0 };
    d.units += t.unitsCompleted ?? 0;
    d.jobs += 1;
    days.set(key, d);
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, v]) => ({ date, units: round1(v.units), jobs: v.jobs }));
}
