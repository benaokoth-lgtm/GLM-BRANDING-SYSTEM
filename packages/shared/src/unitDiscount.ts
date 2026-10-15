// A discount on the unit price of a piece (UV Flatbed, UV Pen Costing): so many Ksh off each piece, or a percentage of its price. Whoever may give a discount (Finance Manager, General
// Manager or Admin) applies it straight away; anyone else asks, and it counts only once one of them has approved that request (see DiscountRequest, routes/dtf.ts).

export interface UnitDiscount {
  kind: 'amount' | 'pct';
  value: number;
}

/** Who may give a discount, and who decides requests for one. */
export const DISCOUNT_ROLES = ['Finance Manager', 'General Manager', 'Admin'] as const;
export const canGiveDiscount = (role: string) => (DISCOUNT_ROLES as readonly string[]).includes(role);

/** What a request for a discount is about. */
export const DISCOUNT_PRODUCTS = ['pens', 'flatbed'] as const;
export type DiscountProduct = (typeof DISCOUNT_PRODUCTS)[number];

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Ksh off one piece priced at `price`, and why the discount cannot be given when it cannot (negative, a nonsense percentage, or as much as the price). */
export function unitDiscountAmount(price: number, d: UnitDiscount | null | undefined): { amount: number; problem: string | null } {
  if (!d) return { amount: 0, problem: null };
  if (d.kind !== 'amount' && d.kind !== 'pct') return { amount: 0, problem: 'The unit price discount must be an amount or a percentage' };
  if (!(d.value >= 0) || !Number.isFinite(d.value)) return { amount: 0, problem: 'A discount cannot be negative' };
  if (d.kind === 'pct' && d.value >= 100) return { amount: 0, problem: 'A percentage discount must be under 100%' };
  const amount = r2(Math.min(price, d.kind === 'pct' ? (price * d.value) / 100 : d.value));
  if (d.value > 0 && amount >= price) return { amount: 0, problem: 'The discount is as much as the price of a piece' };
  return { amount, problem: null };
}
