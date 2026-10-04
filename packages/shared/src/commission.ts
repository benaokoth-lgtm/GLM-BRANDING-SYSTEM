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
