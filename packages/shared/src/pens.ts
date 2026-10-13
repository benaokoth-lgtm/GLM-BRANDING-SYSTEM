// UV pen branding — a price picker. The rate for a pen depends on how many pens are in the order, and the WHOLE order is charged at that one rate (not stepped): 1–99 pens at 20/=,
// 100–499 at 15/=, 500–1000 at 12/=, 1001 and over at 10/=. The tiers are data (a list of "from this many pens, this rate"), kept in the system and editable by a manager; the rate for
// an order is the last tier whose "from" is not above the quantity. Prices are what the customer pays, VAT included, as everywhere else in the system.

export interface PenTier {
  /** The first quantity this rate applies to. */
  from: number;
  /** Ksh a pen. */
  rate: number;
}

/** The rates the owner gave: under 100 → 20/=, 100 → 15/=, 500 → 12/=, over 1000 → 10/=. */
export const DEFAULT_PEN_TIERS: PenTier[] = [
  { from: 1, rate: 20 },
  { from: 100, rate: 15 },
  { from: 500, rate: 12 },
  { from: 1001, rate: 10 },
];
/** Quantities offered as one-tap buttons. */
export const PEN_QUICK_PICKS = [10, 20, 50, 100, 250, 500, 1000, 1500];

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The tiers in order of quantity. */
export const sortedPenTiers = (tiers: PenTier[]): PenTier[] => [...tiers].sort((a, b) => a.from - b.from);

/** Why a set of tiers cannot be saved, or null when they are fine. */
export function penTiersProblem(tiers: PenTier[]): string | null {
  if (tiers.length === 0) return 'There must be at least one rate';
  const s = sortedPenTiers(tiers);
  for (const t of s) {
    if (!Number.isInteger(t.from) || t.from < 1) return 'Each tier must start at a whole number of pens, 1 or more';
    if (!(t.rate >= 0) || !Number.isFinite(t.rate)) return 'A rate cannot be negative';
  }
  if (s[0]!.from !== 1) return 'The first tier must start at 1 pen';
  for (let i = 1; i < s.length; i++) if (s[i]!.from === s[i - 1]!.from) return `Two tiers start at ${s[i]!.from} pens`;
  return null;
}

/** The tier an order of this many pens is charged at; null for no pens. */
export function penTierFor(tiers: PenTier[], qty: number): PenTier | null {
  let found: PenTier | null = null;
  for (const t of sortedPenTiers(tiers)) if (qty >= t.from) found = t;
  return found;
}

/** "1–99", "100–499", … and "1001+" for the last. */
export function penRangeLabel(tiers: PenTier[], index: number): string {
  const s = sortedPenTiers(tiers);
  const t = s[index]!;
  const next = s[index + 1];
  return next ? `${t.from}–${next.from - 1}` : `${t.from}+`;
}

export interface PenQuote {
  qty: number;
  tier: PenTier | null;
  rate: number;
  total: number;
  /** A cheaper tier a few pens away, and what taking it would mean. */
  upsell: { qty: number; add: number; rate: number; newTotal: number; saving: number } | null;
}

/** The rate and the total for an order of this many pens, and the nearest cheaper tier if the customer is close to it. */
export function penQuote(tiers: PenTier[], qty: number): PenQuote {
  const q = Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 0;
  const s = sortedPenTiers(tiers);
  const tier = penTierFor(s, q);
  const rate = tier?.rate ?? 0;
  const total = r2(q * rate);
  const cur = rate || s[0]?.rate || 0;
  const next = q > 0 ? s.find((t) => t.from > q && t.rate < cur) : undefined;
  const upsell = next ? { qty: next.from, add: next.from - q, rate: next.rate, newTotal: r2(next.rate * next.from), saving: r2(total - next.rate * next.from) } : null;
  return { qty: q, tier, rate, total, upsell };
}
