// Staff sales commission — the pure rules, with no database in them.
//
// What earns commission, and on what:
//   • General sales (any order that is not a DTF film sale or artwork job): a banded percentage of the NET sales (VAT out) that
//     were actually RECEIVED in the month, for the staff member the client is credited to. Bands are marginal, like income tax —
//     each rate applies only to the slice of the month's sales that falls inside its band.
//   • DTF film: the capturing staff member is rewarded for the price per metre ABOVE the base (the minimum price, 400). The price is
//     no longer capped at 500. The premium is split into slices (a ladder), each paid at its own percentage.
//   • DTF artwork: the system works out a recommended price per piece; commission is a percentage of what was charged ABOVE that
//     recommended price, and nothing on the recommended price itself.
//   • Film and artwork commission is earned as the money comes in: a payment of a third of the order earns a third of it.
//
// A client a staff member sources is credited to them for a fixed window (12 months) — see ownershipEnd / ownershipActive. Nobody
// shares a client: while the window runs, every order from that client is credited to its owner.

export interface Band {
  /** The amount (or premium) at which this band starts. The first band starts at 0. */
  from: number;
  /** Percentage paid on the slice from `from` up to the next band's `from` (the last band is open-ended). */
  rate: number;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Marginal banding: Σ (slice of `amount` inside each band) × that band's rate. With bands 0→0%, 150k→2%, 300k→3.5% an amount of
 * 200,000 gives 50,000 × 2% = 1,000.
 */
export function bandedAmount(bands: Band[], amount: number): number {
  if (!(amount > 0)) return 0;
  const sorted = [...bands].sort((a, b) => a.from - b.from);
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const lo = sorted[i]!.from;
    const hi = i + 1 < sorted.length ? sorted[i + 1]!.from : Infinity;
    if (amount <= lo) break;
    total += (Math.min(amount, hi) - lo) * (sorted[i]!.rate / 100);
  }
  return r2(total);
}

/** The band an amount currently sits in, and how much further it is to the next one — for "you are KES x from the next band". */
export function bandPosition(bands: Band[], amount: number): { rate: number; nextFrom: number | null; nextRate: number | null; toNext: number | null } {
  const sorted = [...bands].sort((a, b) => a.from - b.from);
  let idx = 0;
  for (let i = 0; i < sorted.length; i++) if (amount >= sorted[i]!.from) idx = i;
  const next = sorted[idx + 1];
  return {
    rate: sorted[idx]?.rate ?? 0,
    nextFrom: next ? next.from : null,
    nextRate: next ? next.rate : null,
    toNext: next ? r2(Math.max(0, next.from - amount)) : null,
  };
}

/** Returns an error message for a bad band list, or null when it is fine. */
export function bandsProblem(bands: Band[], what: string): string | null {
  if (!Array.isArray(bands) || bands.length === 0) return `${what}: add at least one band`;
  const sorted = [...bands].sort((a, b) => a.from - b.from);
  if (sorted[0]!.from !== 0) return `${what}: the first band must start at 0`;
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]!;
    if (!Number.isFinite(b.from) || b.from < 0) return `${what}: a band starts below 0`;
    if (!Number.isFinite(b.rate) || b.rate < 0 || b.rate > 100) return `${what}: a rate must be between 0 and 100`;
    if (i > 0 && b.from === sorted[i - 1]!.from) return `${what}: two bands start at the same amount`;
  }
  return null;
}

// ── Defaults (placeholders — GLM has no history of films sold per month yet, so every figure is editable) ──

/** General sales: monthly NET sales received, KES. */
export const DEFAULT_GENERAL_BANDS: Band[] = [
  { from: 0, rate: 0 },
  { from: 150000, rate: 2 },
  { from: 300000, rate: 3.5 },
  { from: 500000, rate: 5 },
];

/** Film: KES per metre charged above the base price → the % of that slice paid. Open-ended: there is no ceiling price any more. */
export const DEFAULT_FILM_BANDS: Band[] = [
  { from: 0, rate: 10 },
  { from: 25, rate: 25 },
  { from: 50, rate: 40 },
  { from: 75, rate: 50 },
];

/** Artwork: the % of the amount charged above the system-recommended price that the staff member keeps. */
export const DEFAULT_ARTWORK_RATE_PCT = 50;

/** How long a sourced client stays credited to the staff member who sourced them. */
export const DEFAULT_OWNERSHIP_MONTHS = 12;

// ── Film and artwork premiums ───────────────────────────────────────────────

/**
 * Commission on one film sale if it were paid in full: metres × the ladder applied to (price − base), with the VAT taken out
 * (prices include VAT, the company's revenue does not). Selling at or below the base earns nothing.
 */
export function filmPremiumCommission(metres: number, pricePerM: number, baseM: number, bands: Band[], vatRate: number): number {
  const premium = pricePerM - baseM;
  if (!(metres > 0) || !(premium > 0)) return 0;
  return r2((metres * bandedAmount(bands, premium)) / (1 + vatRate));
}

/** The premium over base per metre, never negative. */
export function filmPremiumPerM(pricePerM: number, baseM: number): number {
  return r2(Math.max(0, pricePerM - baseM));
}

/** Commission on one artwork job if it were paid in full: ratePct of what was charged above the recommended price, VAT out. */
export function artworkPremiumCommission(pieces: number, chargedPerPiece: number, systemPerPiece: number, ratePct: number, vatRate: number): number {
  const excess = chargedPerPiece - systemPerPiece;
  if (!(pieces > 0) || !(excess > 0)) return 0;
  return r2(((pieces * excess) / (1 + vatRate)) * (ratePct / 100));
}

/** The part of an order that has been paid, 0..1, so premium commission is earned as the money arrives. */
export function paidShare(paid: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(1, Math.max(0, paid / total));
}

// ── Client ownership ────────────────────────────────────────────────────────

/** The last day a client stays credited: `months` after `start` ('YYYY-MM-DD'). */
export function ownershipEnd(start: string, months: number): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const total = (m - 1) + months;
  const ny = y + Math.floor(total / 12);
  const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

/** True while `today` is on or before the end date of an unreleased ownership. */
export function ownershipActive(o: { endDate: string; status: string }, today: string): boolean {
  return o.status === 'Active' && o.endDate >= today;
}

/** What an order's client is called when nobody enters a name. */
export const WALK_IN_CLIENT = 'Walk-in';

/** True when a real name was given — blank, or "Walk-in" itself, is not a person anyone can be credited with. */
export function isNamedClient(name?: string | null): boolean {
  const n = (name ?? '').trim();
  return n.length > 0 && !/^walk[\s-]*in$/i.test(n);
}

/**
 * A stable identity for a client so the same person is recognised across orders: a corporate client by its id, a walk-in by phone
 * number (the last nine digits, so 0712 345 678 and +254 712 345 678 match), else by name. Anonymous walk-ins have no key and so
 * can never be owned.
 */
export function clientKeyFor(c: { corporateClientId?: number | null; phone?: string | null; name?: string | null }): string | null {
  if (c.corporateClientId) return `c:${c.corporateClientId}`;
  const digits = (c.phone ?? '').replace(/\D/g, '');
  if (digits.length >= 9) return `p:${digits.slice(-9)}`;
  if (!isNamedClient(c.name)) return null; // an anonymous walk-in can never be owned
  const name = (c.name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return name.length >= 3 ? `n:${name}` : null;
}

// ── The sales target ────────────────────────────────────────────────────────
// Before any commission is earned in a month, a person must sell at least `multiplier` × their basic monthly salary (3 × 40,000 = 120,000).
// "Sold" means NET sales (VAT out) whose money was received in the month, on everything credited to them: clients they sourced, and the film
// and artwork orders they captured. Prices are not touched by this — the minimum-price rules at order taking stay exactly as they are, so a
// target can never be met by under-pricing.
//   'above' — the bands start at the target: only the part of the month's sales ABOVE it earns general commission.
//   'all'   — once the target is met, the bands apply to all of the month's sales.
// Film premium commission (earned only by charging above the floor price) is paid in full once the target is met, nothing before. A month whose target
// is not met earns no sales-based commission and nothing rolls over to the next month. The exception is artwork: the extra charged above the recommended
// price is earned whether or not the target was met (the artwork sales still count towards the target).
// A person whose salary is not recorded cannot be measured against a target, so their commission is held until it is.

export const DEFAULT_TARGET_MULTIPLIER = 3;
export const TARGET_MODES = ['above', 'all'] as const;
export type TargetMode = (typeof TARGET_MODES)[number];
export const DEFAULT_TARGET_MODE: TargetMode = 'above';

export interface SalesTarget {
  /** False when the multiplier is 0: there is no target and everything works as it did before. */
  applies: boolean;
  multiplier: number;
  mode: TargetMode;
  /** Their basic monthly salary, or null when it has not been recorded. */
  salary: number | null;
  salaryKnown: boolean;
  /** multiplier × salary. */
  required: number;
  /** Net sales received this month that count towards it. */
  achieved: number;
  met: boolean;
  /** How much more must be sold to reach the target. */
  remaining: number;
  /** The part of the month's sales that the general bands apply to (see the modes above). */
  eligibleSales: number;
  /** Commission is not paid at all this month: the target is not met, or there is no salary to measure it against. */
  held: boolean;
}

export function salesTarget(o: { multiplier: number; mode: TargetMode; salary: number | null; achieved: number }): SalesTarget {
  const achieved = r2(Math.max(0, o.achieved));
  const applies = o.multiplier > 0;
  const salaryKnown = o.salary != null && o.salary > 0;
  const base = { applies, multiplier: o.multiplier, mode: o.mode, salary: salaryKnown ? o.salary : null, salaryKnown, achieved };
  if (!applies) return { ...base, required: 0, met: true, remaining: 0, eligibleSales: achieved, held: false };
  if (!salaryKnown) return { ...base, required: 0, met: false, remaining: 0, eligibleSales: 0, held: true };
  const required = r2(o.salary! * o.multiplier);
  const met = achieved >= required;
  return {
    ...base,
    required,
    met,
    remaining: r2(Math.max(0, required - achieved)),
    eligibleSales: !met ? 0 : o.mode === 'all' ? achieved : r2(achieved - required),
    held: !met,
  };
}

// ── Freelance sales persons ─────────────────────────────────────────────────
// People outside the staff who bring us work. An order is credited to EITHER a staff member OR a freelance sales person, never both: once an
// order is marked for a freelance account it can be neither sourced by nor credited to any staff member (no client ownership, no general,
// film or artwork commission, nothing towards a sales target).
//
// A freelance sales person is paid weekly (Monday to Sunday) on the sales they bring, in marginal bands — but only on sales at or above our
// base prices. A line sold below its base price (a discount, or a price typed in under the list price) earns them nothing. Like staff
// commission it is earned on money RECEIVED in the week, net of VAT.

/** Placeholders — weekly net sales received, Ksh. Editable in Commission → Rates. */
/**
 * Withholding tax on commission paid to freelance sales persons (not employees: no PAYE). The company deducts it from what it pays them and pays it
 * over to KRA. The standard rate is set under Commission → Rates (a placeholder to confirm with your accountant); a person can be given their own rate,
 * or 0 if they hold an exemption.
 */
export const DEFAULT_FREELANCE_WHT_RATE = 5;

/** The tax to withhold from a gross commission at this rate (percent), to the cent. Never negative. */
export function withholdingOn(gross: number, ratePct: number): number {
  if (!(gross > 0) || !(ratePct > 0)) return 0;
  return Math.round((gross * ratePct) / 100 * 100 + Number.EPSILON) / 100;
}

/**
 * A freelance sales person is paid in two parts, so commission never eats into our base prices:
 *   • a small banded % on the BASE-price part of what they sell (the price-list price: the part that already carries only our minimum margin);
 *   • a share of whatever was charged ABOVE base (the premium). The cost of the job does not change, so the premium is almost pure profit.
 * Contracted-out services and stock resale carry a thin mark-up, so the base part of those lines counts at a reduced weight towards the bands.
 */
export const DEFAULT_FREELANCE_BANDS: Band[] = [
  { from: 0, rate: 2 },
  { from: 50000, rate: 3 },
  { from: 150000, rate: 4 },
];
/** The % of the amount charged above base that the freelancer keeps. */
export const DEFAULT_FREELANCE_PREMIUM_PCT = 30;
/** The weight (%) at which the base part of contracted-out and stock lines counts towards the bands: 100 = same as any other line. */
export const DEFAULT_FREELANCE_LOW_MARGIN_PCT = 50;

const DAY_MS = 86_400_000;
const parseDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The Monday of the week this date ('YYYY-MM-DD') falls in. */
export function weekStart(date: string): string {
  const ms = parseDay(date);
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday
  return fmtDay(ms - ((dow + 6) % 7) * DAY_MS);
}

/** The Sunday that ends the week starting on this Monday. */
export function weekEnd(start: string): string {
  return fmtDay(parseDay(start) + 6 * DAY_MS);
}

export const isWeekStart = (date: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(date) && weekStart(date) === date;

/** Monday a number of weeks before (negative) or after this one. */
export function addWeeks(start: string, n: number): string {
  return fmtDay(parseDay(start) + n * 7 * DAY_MS);
}

export interface BaseCheckLine {
  qty: number;
  unitPrice: number;
  discountPct?: number;
  discountAmt?: number;
  heatPressFee?: number | null;
  /** The base price of one unit (VAT included, before any heat press fee): the list price, or the floor for film / artwork. */
  baseUnit: number;
  /** A thin-margin line (contracted-out service, stock resale): its base part counts at a reduced weight. */
  lowMargin?: boolean;
}

/** How an order's value divides, each as a share (0..1) of the order's total: the base part and the premium of the lines sold at or above base. */
export interface FreelanceSplit {
  /** base + premium: everything sold at or above base prices. */
  qualifying: number;
  /** The part of the qualifying lines that is the base price itself. */
  base: number;
  /** Of the whole order, the base part that belongs to thin-margin lines (a subset of base). */
  low: number;
  /** What was charged above base on the qualifying lines. */
  premium: number;
}

/**
 * The share (0..1) of an order's value that was sold at or above base prices, after the line's own discount AND its share of any order-level
 * discount. A line that falls short of its base price is left out whole. Paid commission is worked out on this share of the money received.
 */
export function qualifyingShare(lines: BaseCheckLine[], orderDiscountPct = 0, orderDiscountAmt = 0): number {
  return freelanceSplit(lines, orderDiscountPct, orderDiscountAmt).qualifying;
}

/** Splits an order's value into the base part, the premium above base, and the thin-margin part of the base (see FreelanceSplit). */
export function freelanceSplit(lines: BaseCheckLine[], orderDiscountPct = 0, orderDiscountAmt = 0): FreelanceSplit {
  const zero: FreelanceSplit = { qualifying: 0, base: 0, low: 0, premium: 0 };
  const total = (l: BaseCheckLine) => Math.max(0, (Number(l.qty) || 0) * ((Number(l.unitPrice) || 0) + (Number(l.heatPressFee) || 0)) * (1 - (Number(l.discountPct) || 0) / 100) - (Number(l.discountAmt) || 0));
  const subtotal = lines.reduce((a, l) => a + total(l), 0);
  const grand = Math.max(0, subtotal * (1 - (Number(orderDiscountPct) || 0) / 100) - (Number(orderDiscountAmt) || 0));
  if (!(grand > 0) || !(subtotal > 0)) return zero;
  const factor = grand / subtotal;
  let base = 0;
  let low = 0;
  let premium = 0;
  for (const l of lines) {
    const got = total(l) * factor;
    const need = (Number(l.qty) || 0) * (l.baseUnit + (Number(l.heatPressFee) || 0));
    if (got + 0.5 >= need) {
      const b = Math.min(got, need);
      base += b;
      if (l.lowMargin) low += b;
      premium += Math.max(0, got - need);
    }
  }
  const share = (v: number) => r2(Math.min(1, v / grand) * 1e6) / 1e6;
  const qualifying = share(base + premium);
  return { qualifying, base: Math.min(qualifying, share(base)), low: Math.min(share(low), share(base)), premium: Math.min(qualifying, share(premium)) };
}
