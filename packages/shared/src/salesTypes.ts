import { UV_PEN_SERVICE } from './pens';

// The kinds of sale under Sales in the side navigation, as the Commission page tells them apart: where a salesperson sells more and where they are behind. A sale is one of these by how it was
// captured — the screen it came through — not by the business head its lines are booked under (that is Reports → Sales by Business Head).

export const SALES_TYPES = ['general', 'dtf_film', 'dtf_artwork', 'uv_film', 'uv_artwork', 'embroidery', 'uv_pens', 'costing'] as const;
export type SalesType = (typeof SALES_TYPES)[number];

export const SALES_TYPE_LABEL: Record<SalesType, string> = {
  general: 'General Order',
  dtf_film: 'DTF Film Order',
  dtf_artwork: 'DTF Artwork Order',
  uv_film: 'UV DTF Film Order',
  uv_artwork: 'UV DTF Artwork Order',
  embroidery: 'Embroidery Order',
  uv_pens: 'UV Pens',
  costing: 'Job Costing (cards, signage, brochures, eulogies)',
};

/** How a type of sale earns commission: a premium on film or artwork charged above the base price, or as part of the sourced-client sales the bands pay on. */
export const SALES_TYPE_PAID_AS: Record<SalesType, 'film' | 'artwork' | 'general'> = {
  general: 'general',
  dtf_film: 'film',
  dtf_artwork: 'artwork',
  uv_film: 'film',
  uv_artwork: 'artwork',
  embroidery: 'general',
  uv_pens: 'general',
  costing: 'general',
};

/** Which screen an order was captured through. */
export function salesTypeOf(o: {
  orderNo: string;
  dtfFilmSale?: unknown;
  dtfArtworkJob?: unknown;
  embroideryJob?: unknown;
  lineItems: { service?: { name: string } | null }[];
}): SalesType {
  // UV DTF orders are numbered U-, DTF ones F-
  const uv = o.orderNo.startsWith('U-');
  if (o.dtfFilmSale) return uv ? 'uv_film' : 'dtf_film';
  if (o.dtfArtworkJob) return uv ? 'uv_artwork' : 'dtf_artwork';
  if (o.embroideryJob) return 'embroidery';
  const names = o.lineItems.map((li) => li.service?.name ?? '');
  if (names.some((n) => n.startsWith('Costed job'))) return 'costing';
  if (names.some((n) => n === UV_PEN_SERVICE)) return 'uv_pens';
  return 'general';
}

/** One row of "where my sales come from": a salesperson's month in one kind of sale. */
export interface SalesTypeRow {
  type: SalesType;
  label: string;
  /** Orders raised this month (by the day raised, paid or not). */
  orders: number;
  /** What they were worth, VAT taken out. */
  sold: number;
  /** The same last month. */
  soldBefore: number;
  /** Money received this month on the orders that earn this person commission, VAT taken out. */
  received: number;
  /** The commission earned from this kind of sale (the pay bands' commission is shared between the kinds of sale in proportion to the money received on each). */
  commission: number;
  /** What each person on the team sold of this kind, on average. */
  teamAvgSold: number;
}

export function blankSalesTypeRows(): SalesTypeRow[] {
  return SALES_TYPES.map((type) => ({ type, label: SALES_TYPE_LABEL[type], orders: 0, sold: 0, soldBefore: 0, received: 0, commission: 0, teamAvgSold: 0 }));
}
