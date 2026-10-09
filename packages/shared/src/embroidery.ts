// Embroidery pricing — from the "Embroidery Pricing Calculator" handoff, with the setup fee on its own order line and a minimum price per piece that can differ
// by quantity band. One place for the arithmetic so the order screen's preview and the server's real price are always the same.
//
//   rate        = stitch rate of the highest tier whose "from qty" is <= qty         (KES per 1,000 stitches)
//   floor       = minimum price per piece of that same tier
//   stitchCost  = rate × stitches ÷ 1000
//   piece       = ceil( max(stitchCost, floor) )                                      (whole KES, rounded up)
//   setup       = waived ? 0 : setupFee      (own line, once per design; waived on a repeat of a saved design or from `waiveAtQty` pieces)
//   origination = clientSupplies ? 0 : originationFee     ("Design origination", own line, once per job — never divided across pieces)
//   order total = Σ designs ( piece × qty + setup ) + origination

export interface EmbroideryTier {
  /** The quantity this tier starts at. */
  min: number;
  /** KES per 1,000 stitches. */
  rate: number;
  /** The least charged per piece in this tier (for a single placement). */
  floor: number;
}

export interface EmbroiderySettingsValues {
  /** Digitizing, per design (guidance: 1,000–1,500 by complexity). */
  setupFee: number;
  /** Creating the artwork, once per job, when the client has none. */
  originationFee: number;
  /** Setup is waived from this many pieces (0 = never). */
  waiveAtQty: number;
  tiers: EmbroideryTier[];
}

export const DEFAULT_EMBROIDERY_SETTINGS: EmbroiderySettingsValues = {
  setupFee: 1200,
  originationFee: 1500,
  waiveAtQty: 100,
  tiers: [
    { min: 1, rate: 14, floor: 150 },
    { min: 6, rate: 12, floor: 150 },
    { min: 12, rate: 10, floor: 120 },
    { min: 25, rate: 9, floor: 120 },
    { min: 50, rate: 8, floor: 100 },
    { min: 100, rate: 7, floor: 100 },
  ],
};

/** The names of the services the embroidery order puts on an order (created in the price list the first time they are needed). */
export const EMBROIDERY_PIECE_SERVICE = 'Embroidery per piece';
export const EMBROIDERY_SETUP_SERVICE = 'Embroidery digitizing setup';
export const EMBROIDERY_ORIGINATION_SERVICE = 'Design origination';

export const sortedTiers = (tiers: EmbroideryTier[]): EmbroideryTier[] => [...tiers].sort((a, b) => a.min - b.min);

/** The tier that applies to this quantity. */
export function tierFor(tiers: EmbroideryTier[], qty: number): EmbroideryTier {
  const ts = sortedTiers(tiers);
  let hit = ts[0] ?? { min: 1, rate: 0, floor: 0 };
  for (const t of ts) if (qty >= t.min) hit = t;
  return hit;
}

/** Up to how many stitches the tier's minimum price per piece is what is charged (above it the stitch rate takes over). Infinity when the rate is 0. */
export const floorCoversStitches = (t: EmbroideryTier): number => (t.rate > 0 ? Math.floor((t.floor * 1000) / t.rate) : Infinity);

export interface EmbroideryDesignInput {
  /** What it is, for the order: "Left chest logo". */
  name: string;
  stitches: number;
  /** A repeat of a saved, digitized design: no setup fee. */
  repeat?: boolean;
  /** What is charged per piece, when it is not the recommended price. */
  pricePerPiece?: number | null;
}

export interface EmbroideryDesignQuote {
  rate: number;
  floor: number;
  stitchCost: number;
  /** Whether the minimum, not the stitch cost, set the price. */
  floored: boolean;
  /** The recommended price per piece (whole KES). */
  recommended: number;
  /** What is actually charged per piece. */
  piece: number;
  pieces: number;
  setup: number;
  setupWaived: boolean;
  subtotal: number;
}

export function quoteDesign(d: EmbroideryDesignInput, qty: number, s: EmbroiderySettingsValues): EmbroideryDesignQuote {
  const q = Math.max(1, Math.round(qty) || 1);
  const tier = tierFor(s.tiers, q);
  const stitchCost = (tier.rate * (Number(d.stitches) || 0)) / 1000;
  const recommended = Math.ceil(Math.max(stitchCost, tier.floor) - 1e-9);
  const piece = d.pricePerPiece != null && d.pricePerPiece > 0 ? Math.round(d.pricePerPiece * 100) / 100 : recommended;
  const setupWaived = !!d.repeat || (s.waiveAtQty > 0 && q >= s.waiveAtQty);
  const setup = setupWaived ? 0 : s.setupFee;
  return { rate: tier.rate, floor: tier.floor, stitchCost, floored: stitchCost < tier.floor, recommended, piece, pieces: piece * q, setup, setupWaived, subtotal: piece * q + setup };
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
  if (!s.tiers.length) return 'There must be at least one stitch-rate tier';
  const mins = s.tiers.map((t) => t.min);
  if (mins.some((m) => !(m >= 1) || !Number.isFinite(m))) return 'Each tier must start at a quantity of 1 or more';
  if (new Set(mins).size !== mins.length) return 'Two tiers start at the same quantity';
  if (!mins.includes(1) && Math.min(...mins) > 1) return 'The first tier must start at quantity 1, so every quantity has a rate';
  if (s.tiers.some((t) => !(t.rate >= 0) || !(t.floor >= 0))) return 'Rates and minimum prices cannot be negative';
  if (!(s.setupFee >= 0) || !(s.originationFee >= 0) || !(s.waiveAtQty >= 0)) return 'Fees and the waiver quantity cannot be negative';
  return null;
}
