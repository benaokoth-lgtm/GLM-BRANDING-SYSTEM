// Embroidery pricing — stitch count first, with a quantity price beside it to compare.
//
//   price by stitches   = ceil( max( stitchRate × stitches ÷ 1000, stitchMin ) )         (whole KES; the same at any quantity)
//   price by quantity   = ceil( price by stitches × (1 − discount of the quantity band) ) (never above the price by stitches)
//   the staff apply either to a design; a price of their own below the price by quantity needs a manager's approval
//   setup       = waived ? 0 : setupFee      (own line, once per design; waived on a repeat of a saved design or from `waiveAtQty` pieces)
//   origination = clientSupplies ? 0 : originationFee     ("Design origination", own line, once per job — never divided across pieces)
//   order total = Σ designs ( piece × qty + setup ) + origination
//
// One place for the arithmetic so the order screen's preview and the server's real price are always the same.

export interface EmbroideryQtyTier {
  /** The quantity this band starts at. */
  min: number;
  /** The percentage taken off the price by stitches for this quantity (0 = none). */
  discountPct: number;
}

export interface EmbroiderySettingsValues {
  /** KES per 1,000 stitches: the price by stitches. */
  stitchRate: number;
  /** The least charged per piece by stitches (for a very small design). */
  stitchMin: number;
  /** Digitizing, per design (guidance: 1,000–1,500 by complexity). */
  setupFee: number;
  /** Creating the artwork, once per job, when the client has none. */
  originationFee: number;
  /** Setup is waived from this many pieces (0 = never). */
  waiveAtQty: number;
  /** The quantity discounts that give the price by quantity. */
  qtyTiers: EmbroideryQtyTier[];
}

export const DEFAULT_EMBROIDERY_SETTINGS: EmbroiderySettingsValues = {
  stitchRate: 16,
  stitchMin: 60,
  setupFee: 1200,
  originationFee: 1500,
  waiveAtQty: 100,
  qtyTiers: [
    { min: 1, discountPct: 0 },
    { min: 6, discountPct: 5 },
    { min: 12, discountPct: 10 },
    { min: 25, discountPct: 15 },
    { min: 50, discountPct: 20 },
    { min: 100, discountPct: 25 },
  ],
};

/** The names of the services the embroidery order puts on an order (created in the price list the first time they are needed). */
export const EMBROIDERY_PIECE_SERVICE = 'Embroidery per piece';
export const EMBROIDERY_SETUP_SERVICE = 'Embroidery digitizing setup';
export const EMBROIDERY_ORIGINATION_SERVICE = 'Design origination';

export const sortedQtyTiers = (tiers: EmbroideryQtyTier[]): EmbroideryQtyTier[] => [...tiers].sort((a, b) => a.min - b.min);

/** The quantity band that applies to this quantity. */
export function qtyTierFor(tiers: EmbroideryQtyTier[], qty: number): EmbroideryQtyTier {
  let hit = sortedQtyTiers(tiers)[0] ?? { min: 1, discountPct: 0 };
  for (const t of sortedQtyTiers(tiers)) if (qty >= t.min) hit = t;
  return hit;
}

/** The price per piece by stitch count — the same at any quantity. */
export function stitchPrice(stitches: number, s: EmbroiderySettingsValues): number {
  return Math.ceil(Math.max((s.stitchRate * (Number(stitches) || 0)) / 1000, s.stitchMin) - 1e-9);
}

/** The price per piece by quantity: the price by stitches less the quantity band's discount (never more than the price by stitches). */
export function quantityPrice(stitches: number, qty: number, s: EmbroiderySettingsValues): number {
  const base = stitchPrice(stitches, s);
  const d = qtyTierFor(s.qtyTiers, Math.max(1, Math.round(qty) || 1)).discountPct;
  return Math.min(base, Math.ceil(base * (1 - d / 100) - 1e-9));
}

export type EmbroideryBasis = 'stitch' | 'quantity';

export interface EmbroideryDesignInput {
  /** What it is, for the order: "Left chest logo". */
  name: string;
  stitches: number;
  /** A repeat of a saved, digitized design: no setup fee. */
  repeat?: boolean;
  /** Which standard price the staff apply (the price by stitches unless they choose the quantity price). */
  basis?: EmbroideryBasis;
  /** What is charged per piece, when it is neither standard price. */
  pricePerPiece?: number | null;
}

export interface EmbroideryDesignQuote {
  /** The stitch cost per piece before the minimum. */
  stitchCost: number;
  /** Whether the minimum, not the stitch cost, set the price by stitches. */
  minimumApplied: boolean;
  /** The price per piece by stitches. */
  stitchPrice: number;
  /** The quantity discount at this quantity, and the price per piece it gives. */
  discountPct: number;
  quantityPrice: number;
  /** Which price is charged: a standard one, or the staff's own. */
  basis: EmbroideryBasis | 'custom';
  /** The standard price the staff chose (the price by stitches or by quantity) — what the price is measured against. */
  recommended: number;
  /** The lowest standard price (the price by quantity): a price of their own below this needs a manager's approval. */
  lowest: number;
  /** What is charged per piece. */
  piece: number;
  pieces: number;
  setup: number;
  setupWaived: boolean;
  subtotal: number;
}

export function quoteDesign(d: EmbroideryDesignInput, qty: number, s: EmbroiderySettingsValues): EmbroideryDesignQuote {
  const q = Math.max(1, Math.round(qty) || 1);
  const stitches = Number(d.stitches) || 0;
  const stitchCost = (s.stitchRate * stitches) / 1000;
  const byStitch = stitchPrice(stitches, s);
  const byQty = quantityPrice(stitches, q, s);
  const recommended = d.basis === 'quantity' ? byQty : byStitch;
  const custom = d.pricePerPiece != null && d.pricePerPiece > 0;
  const piece = custom ? Math.round(d.pricePerPiece! * 100) / 100 : recommended;
  const setupWaived = !!d.repeat || (s.waiveAtQty > 0 && q >= s.waiveAtQty);
  const setup = setupWaived ? 0 : s.setupFee;
  return {
    stitchCost,
    minimumApplied: stitchCost < s.stitchMin,
    stitchPrice: byStitch,
    discountPct: qtyTierFor(s.qtyTiers, q).discountPct,
    quantityPrice: byQty,
    basis: custom ? 'custom' : d.basis === 'quantity' ? 'quantity' : 'stitch',
    recommended,
    lowest: byQty,
    piece,
    pieces: piece * q,
    setup,
    setupWaived,
    subtotal: piece * q + setup,
  };
}

export interface EmbroideryQuote {
  qty: number;
  designs: EmbroideryDesignQuote[];
  origination: number;
  /** Everything: the designs (pieces and setup) and the origination. */
  total: number;
}

export function quoteJob(designs: EmbroideryDesignInput[], qty: number, clientSupplies: boolean, s: EmbroiderySettingsValues): EmbroideryQuote {
  const q = Math.max(1, Math.round(qty) || 1);
  const ds = designs.map((d) => quoteDesign(d, q, s));
  const origination = clientSupplies ? 0 : s.originationFee;
  return { qty: q, designs: ds, origination, total: ds.reduce((a, d) => a + d.subtotal, 0) + origination };
}

/** What is wrong with a set of settings (null = fine). */
export function embroiderySettingsProblem(s: EmbroiderySettingsValues): string | null {
  if (!(s.stitchRate > 0)) return 'The rate per 1,000 stitches must be more than 0';
  if (!(s.stitchMin >= 0)) return 'The minimum price by stitches cannot be negative';
  if (!s.qtyTiers.length) return 'There must be at least one quantity band';
  const mins = s.qtyTiers.map((t) => t.min);
  if (mins.some((m) => !(m >= 1) || !Number.isFinite(m))) return 'Each quantity band must start at 1 piece or more';
  if (new Set(mins).size !== mins.length) return 'Two quantity bands start at the same quantity';
  if (!mins.includes(1)) return 'The first quantity band must start at 1 piece, so every quantity has a price';
  if (s.qtyTiers.some((t) => !(t.discountPct >= 0) || t.discountPct > 90)) return 'A quantity discount must be between 0% and 90%';
  const sorted = sortedQtyTiers(s.qtyTiers);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.discountPct < sorted[i - 1]!.discountPct) return 'A bigger quantity cannot have a smaller discount than a smaller one — the price by quantity must not go up with the quantity';
  if (!(s.setupFee >= 0) || !(s.originationFee >= 0) || !(s.waiveAtQty >= 0)) return 'Fees and the waiver quantity cannot be negative';
  return null;
}
