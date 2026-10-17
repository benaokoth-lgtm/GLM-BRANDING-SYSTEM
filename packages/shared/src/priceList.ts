import type { Permissions } from './types';

// The two price lists: GLM Sales (our own staff selling at GLM's prices) and Freelancer Sales (sales persons selling at lower prices to win work). Every order is captured under one of them
// — the menu it was keyed from — and records it. The Freelancer list is the GLM list less one default percentage (rounded), with any single price typed by hand winning over it.

export type PriceList = 'glm' | 'freelancer';
export const PRICE_LISTS: PriceList[] = ['glm', 'freelancer'];
export const PRICE_LIST_LABEL: Record<PriceList, string> = { glm: 'GLM Sales', freelancer: 'Freelancer Sales' };
export const isPriceList = (v: unknown): v is PriceList => v === 'glm' || v === 'freelancer';
/** An unknown or missing value is the GLM list (every order before the two lists existed was a GLM order). */
export const asPriceList = (v: unknown): PriceList => (v === 'freelancer' ? 'freelancer' : 'glm');

/** Round to the nearest `step` shillings (0 = to the cent). */
export function roundToStep(n: number, step: number): number {
  return step > 0 ? Math.round(n / step) * step : Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * The Freelancer price of an item: the price typed by hand when there is one, otherwise the GLM price less `discountPct`, rounded to `step`. It is never above the GLM price (a small price
 * rounded up to the step would be), and never nothing.
 */
export function freelancerPrice(glmPrice: number, discountPct: number, step: number, override?: number | null): number {
  if (override != null && Number.isFinite(override) && override > 0) return override;
  if (!(glmPrice > 0)) return glmPrice;
  if (!(discountPct > 0)) return glmPrice; // no percentage set: the Freelancer list is the GLM list, untouched (no rounding either)
  const exact = glmPrice * (1 - Math.min(Math.max(discountPct, 0), 100) / 100);
  const rounded = roundToStep(exact, step);
  if (!(rounded > 0)) return Math.round((exact + Number.EPSILON) * 100) / 100;
  return Math.min(glmPrice, rounded);
}

/**
 * Which price lists a person may capture under, from their role: a sales person (a role "can be assigned orders") captures under Freelancer Sales only; the front office and Admin under both;
 * a manager of DTF or of commission under both; everyone else who takes orders (GLM's own staff) under GLM Sales.
 */
export function priceListsFor(role: string, p: Permissions): PriceList[] {
  if (role === 'Admin' || p.canCaptureForOthers) return ['glm', 'freelancer'];
  const freelancer = p.canBeAssignedOrders || p.canManageCommission || p.canManageDtf;
  const glm = !p.canBeAssignedOrders && (p.canCaptureOrders || p.canAccessDtf || p.canManageDtf || p.canAccessFinance);
  return [...(glm ? (['glm'] as PriceList[]) : []), ...(freelancer ? (['freelancer'] as PriceList[]) : [])];
}
