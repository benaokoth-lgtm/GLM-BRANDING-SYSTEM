// Outsourced (contracted-out) services: the supplier quotes one price that includes paper/material and the service, VAT included.
// We add a mark-up — a percentage of the cost, or a fixed amount per unit — and the result is the selling price, also VAT included.

export const MARKUP_TYPES = ['percent', 'amount'] as const;
export type MarkupType = (typeof MARKUP_TYPES)[number];

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Selling price per unit from the supplier's price per unit. Rounded UP to the next whole shilling, so rounding never eats into the
 * mark-up (and prices stay tidy for the customer).
 */
export function priceFromCost(cost: number, markupType: string, markupValue: number): number {
  const c = Math.max(0, Number(cost) || 0);
  const m = Math.max(0, Number(markupValue) || 0);
  const raw = markupType === 'amount' ? c + m : c * (1 + m / 100);
  return Math.ceil(round2(raw) - 1e-9) + 0; // + 0 turns -0 into 0
}

/** The mark-up a chosen selling price actually represents, in the same terms it was set (for showing next to an overridden price). */
export function markupOf(cost: number, price: number): { amount: number; percent: number | null } {
  const c = Number(cost) || 0;
  const p = Number(price) || 0;
  return { amount: round2(p - c), percent: c > 0 ? round2(((p - c) / c) * 100) : null };
}

export interface JobMargin {
  /** What the customer pays (VAT included) and what the supplier is paid (VAT included). */
  sale: number;
  cost: number;
  /** Mark-up on cost and margin on the sale, both on those VAT-inclusive figures. */
  markupPct: number | null;
  marginPct: number | null;
  /** Profit on the VAT-inclusive figures. */
  grossProfit: number;
  /** Sale with its VAT taken out — what reaches income in the books. */
  saleExVat: number;
  /** The supplier's bill with its VAT taken out (what the cost is once that VAT is claimed back). */
  costExVat: number;
  /**
   * Profit as the books see it: income ex-VAT less the supplier's bill. When the supplier's VAT is claimed back as input VAT (the standing
   * treatment of Outsourced Services) the cost is the bill without it; if it is not claimed, the VAT sits in the cost and the profit is lower.
   */
  bookProfit: number;
  bookMarginPct: number | null;
}

/** `vatRate` is the VAT rate included in sale prices and in the supplier's bill (VAT_RATE in tax.ts); `supplierVatClaimed` says whether the supplier's VAT is claimed back. */
export function jobMargin(sale: number, cost: number, vatRate: number, supplierVatClaimed = false): JobMargin {
  const s = round2(sale);
  const c = round2(cost);
  const saleExVat = round2(s / (1 + vatRate));
  const gross = round2(s - c);
  const costExVat = round2(c / (1 + vatRate));
  const book = round2(saleExVat - (supplierVatClaimed ? costExVat : c));
  return {
    sale: s,
    cost: c,
    markupPct: c > 0 ? round2((gross / c) * 100) : null,
    marginPct: s > 0 ? round2((gross / s) * 100) : null,
    grossProfit: gross,
    saleExVat,
    costExVat,
    bookProfit: book,
    bookMarginPct: saleExVat > 0 ? round2((book / saleExVat) * 100) : null,
  };
}

/** A line is outsourced AND still needs costing when the supplier's quote hasn't been entered. */
export function needsCosting(line: { outsourced: boolean; supplierCost: number | null | undefined }): boolean {
  return line.outsourced && !(Number(line.supplierCost) > 0);
}
