// UV flatbed printing (diaries and other flat items) — a price picker. The artwork is priced by the AREA it prints (width × height), in bands: the artwork falls in the first band whose
// ceiling is not below its area, and each piece is charged that band's price — never less than the minimum price for a piece, which is what a tiny logo costs. A bigger run earns a
// volume discount (the whole run at the one discount for its quantity) — given only when Finance, the General Manager or an Admin applies it, as is a discount on the unit price — and a
// setup fee for the layout can be added to a job when it is wanted. The bands, the minimum, the discounts
// and the fee are data kept in the system and editable by a manager. Prices are what the customer pays, VAT included, as everywhere else in the system.

/** The price-list service a flatbed order is recorded against (created on the first order if the price list has none). */
export const UV_FLATBED_SERVICE = 'UV Flatbed Printing';

export interface FlatbedBand {
  /** The largest area (cm²) this band covers. */
  upToCm2: number;
  /** Ksh a piece. */
  price: number;
}

export interface FlatbedDiscount {
  /** The first quantity this discount applies to. */
  from: number;
  /** Percent off the printing. */
  pct: number;
}

export interface FlatbedSettings {
  /** The largest artwork the flatbed prints, the way it is quoted: 30 × 50 cm (either way round). */
  maxWidthCm: number;
  maxLengthCm: number;
  /** The least a piece is charged, whatever its size: what a tiny logo costs. */
  minPiecePrice: number;
  /** What a job pays for the layout when "setup" is ticked. */
  setupFee: number;
  bands: FlatbedBand[];
  /** Volume discounts: the whole run at the discount of the last tier whose quantity it reaches. */
  discounts: FlatbedDiscount[];
}

/** Every 150 cm² (about an A6) costs 50/=, up to 500/= for the full 30 × 50 cm; nothing under 100/= a piece. */
export const DEFAULT_FLATBED_SETTINGS: FlatbedSettings = {
  maxWidthCm: 30,
  maxLengthCm: 50,
  minPiecePrice: 100,
  setupFee: 200,
  bands: [
    { upToCm2: 300, price: 100 },
    { upToCm2: 450, price: 150 },
    { upToCm2: 600, price: 200 },
    { upToCm2: 750, price: 250 },
    { upToCm2: 900, price: 300 },
    { upToCm2: 1050, price: 350 },
    { upToCm2: 1200, price: 400 },
    { upToCm2: 1350, price: 450 },
    { upToCm2: 1500, price: 500 },
  ],
  discounts: [
    { from: 1, pct: 0 },
    { from: 20, pct: 5 },
    { from: 50, pct: 10 },
    { from: 100, pct: 15 },
  ],
};

/** Artwork sizes offered as one-tap buttons (cm). */
export const FLATBED_SIZE_PICKS: { label: string; w: number; h: number }[] = [
  { label: '5 × 5', w: 5, h: 5 },
  { label: '10 × 15', w: 10, h: 15 },
  { label: 'A5', w: 14.8, h: 21 },
  { label: 'A4', w: 21, h: 29.7 },
  { label: 'Full 30 × 50', w: 30, h: 50 },
];

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const sortedFlatbedBands = (bands: FlatbedBand[]): FlatbedBand[] => [...bands].sort((a, b) => a.upToCm2 - b.upToCm2);
export const sortedFlatbedDiscounts = (d: FlatbedDiscount[]): FlatbedDiscount[] => [...d].sort((a, b) => a.from - b.from);
export const flatbedMaxArea = (s: FlatbedSettings) => r2(s.maxWidthCm * s.maxLengthCm);

/** Why a set of settings cannot be saved, or null when they are fine. */
export function flatbedSettingsProblem(s: FlatbedSettings): string | null {
  for (const [name, v] of [['largest width', s.maxWidthCm], ['largest length', s.maxLengthCm]] as const) if (!(v > 0) || !Number.isFinite(v)) return `The ${name} must be more than 0`;
  for (const [name, v] of [['minimum price for a piece', s.minPiecePrice], ['setup fee', s.setupFee]] as const) if (!(v >= 0) || !Number.isFinite(v)) return `The ${name} cannot be negative`;
  if (s.bands.length === 0) return 'There must be at least one band';
  const b = sortedFlatbedBands(s.bands);
  for (const x of b) {
    if (!(x.upToCm2 > 0) || !Number.isFinite(x.upToCm2)) return 'Each band must cover an area of more than 0 cm²';
    if (!(x.price >= 0) || !Number.isFinite(x.price)) return 'A price cannot be negative';
  }
  for (let i = 1; i < b.length; i++) if (b[i]!.upToCm2 === b[i - 1]!.upToCm2) return `Two bands end at ${b[i]!.upToCm2} cm²`;
  if (b[b.length - 1]!.upToCm2 < flatbedMaxArea(s)) return `The last band must reach the largest artwork (${flatbedMaxArea(s)} cm²), or it has no price`;
  if (s.discounts.length === 0) return 'There must be at least one discount line (0% from 1 piece if you give none)';
  const d = sortedFlatbedDiscounts(s.discounts);
  for (const x of d) {
    if (!Number.isInteger(x.from) || x.from < 1) return 'Each discount must start at a whole number of pieces, 1 or more';
    if (!(x.pct >= 0 && x.pct < 100) || !Number.isFinite(x.pct)) return 'A discount must be from 0% to under 100%';
  }
  if (d[0]!.from !== 1) return 'The first discount line must start at 1 piece';
  for (let i = 1; i < d.length; i++) if (d[i]!.from === d[i - 1]!.from) return `Two discounts start at ${d[i]!.from} pieces`;
  return null;
}

/** The band an artwork of this area is priced in; null when it is bigger than every band. */
export function flatbedBandFor(bands: FlatbedBand[], areaCm2: number): { band: FlatbedBand; index: number } | null {
  const b = sortedFlatbedBands(bands);
  const index = b.findIndex((x) => areaCm2 <= x.upToCm2);
  return index < 0 ? null : { band: b[index]!, index };
}

/** "up to 300 cm²", "301–450 cm²", … */
export function flatbedRangeLabel(bands: FlatbedBand[], index: number): string {
  const b = sortedFlatbedBands(bands);
  const prev = b[index - 1];
  return prev ? `${Math.floor(prev.upToCm2) + 1}–${b[index]!.upToCm2} cm²` : `up to ${b[index]!.upToCm2} cm²`;
}

/** "1–19", "20–49", … and "100+" for the last. */
export function flatbedDiscountRangeLabel(discounts: FlatbedDiscount[], index: number): string {
  const d = sortedFlatbedDiscounts(discounts);
  const next = d[index + 1];
  return next ? `${d[index]!.from}–${next.from - 1}` : `${d[index]!.from}+`;
}

/** Whether an artwork of this size can be printed at all: it must fit inside the largest artwork, either way round. */
export const flatbedFitsArtwork = (s: FlatbedSettings, w: number, h: number) => (w <= s.maxWidthCm && h <= s.maxLengthCm) || (h <= s.maxWidthCm && w <= s.maxLengthCm);

/** Who may give a discount on a flatbed job: the volume discount and a discount on the unit price are applied by these roles only. */
export const FLATBED_DISCOUNT_ROLES = ['Finance Manager', 'General Manager', 'Admin'] as const;
export const canDiscountFlatbed = (role: string) => (FLATBED_DISCOUNT_ROLES as readonly string[]).includes(role);

/** A discount on the unit price of a piece: so many Ksh off each piece, or a percentage off its price. */
export interface FlatbedUnitDiscount {
  kind: 'amount' | 'pct';
  value: number;
}

export interface FlatbedOptions {
  /** The setup fee is added to the job. */
  setup?: boolean;
  /** The volume discount for the run's quantity is applied (it is not given unless somebody who may asks for it). */
  volume?: boolean;
  /** A discount on the unit price. */
  unitDiscount?: FlatbedUnitDiscount | null;
}

export interface FlatbedQuote {
  ok: boolean;
  /** Why there is no price, when there is none. */
  problem: string | null;
  pieces: number;
  areaCm2: number;
  band: FlatbedBand | null;
  bandIndex: number;
  /** What a piece is charged before any discount: its band's price, or the minimum when that is more. */
  unitPrice: number;
  /** The band's price was below the minimum for a piece, so the minimum is charged. */
  minApplied: boolean;
  /** Ksh taken off each piece by the unit-price discount (0 when there is none), and what a piece then costs. */
  unitDiscount: number;
  discountedUnit: number;
  /** The volume discount this run's quantity earns, in percent, and the line of the table it comes from — whether or not it has been applied. */
  volumePct: number;
  discountIndex: number;
  /** The volume discount was applied. */
  volumeApplied: boolean;
  /** Pieces × the discounted unit price, then what the volume discount takes off, then the printing that is left. */
  gross: number;
  discount: number;
  printTotal: number;
  /** The setup fee, when it was asked for. */
  setupFee: number;
  total: number;
  /** What each piece works out to, setup included. */
  perPiece: number;
  /** A bigger volume discount a few pieces away, and what taking it would save. */
  upsell: { qty: number; add: number; pct: number; saving: number } | null;
}

const none = (problem: string | null, pieces = 0, areaCm2 = 0): FlatbedQuote => ({
  ok: false, problem, pieces, areaCm2, band: null, bandIndex: -1, unitPrice: 0, minApplied: false, unitDiscount: 0, discountedUnit: 0, volumePct: 0, discountIndex: -1, volumeApplied: false, gross: 0, discount: 0, printTotal: 0, setupFee: 0, total: 0, perPiece: 0, upsell: null,
});

/** Why a unit-price discount cannot be given, or null when it is fine (or there is none). */
export function flatbedUnitDiscountProblem(d: FlatbedUnitDiscount | null | undefined): string | null {
  if (!d) return null;
  if (d.kind !== 'amount' && d.kind !== 'pct') return 'The unit price discount must be an amount or a percentage';
  if (!(d.value >= 0) || !Number.isFinite(d.value)) return 'A discount cannot be negative';
  if (d.kind === 'pct' && d.value >= 100) return 'A percentage discount must be under 100%';
  return null;
}

/** The price of a run of this many pieces of this artwork size: each at its band's price (at least the minimum), less the unit-price discount if one is given; then the volume discount off the printing if it is applied, and the setup fee when it is asked for. */
export function flatbedQuote(s: FlatbedSettings, widthCm: number, heightCm: number, pieces: number, opts: FlatbedOptions = {}): FlatbedQuote {
  const n = Number.isFinite(pieces) && pieces > 0 ? Math.floor(pieces) : 0;
  if (!(widthCm > 0) || !(heightCm > 0) || !Number.isFinite(widthCm) || !Number.isFinite(heightCm)) return none(null, n);
  const areaCm2 = r2(widthCm * heightCm);
  if (n === 0) return none(null, 0, areaCm2);
  if (!flatbedFitsArtwork(s, widthCm, heightCm)) return none(`${widthCm} × ${heightCm} cm is bigger than the largest artwork (${s.maxWidthCm} × ${s.maxLengthCm} cm)`, n, areaCm2);
  const found = flatbedBandFor(s.bands, areaCm2);
  if (!found) return none(`No band covers ${areaCm2} cm²`, n, areaCm2);
  const unitPrice = Math.max(found.band.price, s.minPiecePrice);
  const ud = opts.unitDiscount ?? null;
  const udProblem = flatbedUnitDiscountProblem(ud);
  if (udProblem) return none(udProblem, n, areaCm2);
  const unitDiscount = ud ? r2(Math.min(unitPrice, ud.kind === 'pct' ? (unitPrice * ud.value) / 100 : ud.value)) : 0;
  if (ud && unitDiscount >= unitPrice) return none('The discount is as much as the price of a piece', n, areaCm2);
  const discountedUnit = r2(unitPrice - unitDiscount);
  const ds = sortedFlatbedDiscounts(s.discounts);
  let discountIndex = 0;
  ds.forEach((d, i) => { if (n >= d.from) discountIndex = i; });
  const volumePct = ds[discountIndex]?.pct ?? 0;
  const volumeApplied = !!opts.volume && volumePct > 0;
  const gross = r2(n * discountedUnit);
  const discount = volumeApplied ? r2((gross * volumePct) / 100) : 0;
  const printTotal = r2(gross - discount);
  const setupFee = opts.setup ? s.setupFee : 0;
  const total = r2(printTotal + setupFee);
  // a bigger volume discount close by: what the same artwork in that quantity would cost, against what this run costs
  const next = ds.find((d) => d.from > n && d.pct > volumePct);
  const upsell = next ? { qty: next.from, add: next.from - n, pct: next.pct, saving: r2(printTotal - r2(next.from * discountedUnit * (1 - next.pct / 100))) } : null;
  return { ok: true, problem: null, pieces: n, areaCm2, band: found.band, bandIndex: found.index, unitPrice, minApplied: unitPrice > found.band.price, unitDiscount, discountedUnit, volumePct, discountIndex, volumeApplied, gross, discount, printTotal, setupFee, total, perPiece: r2(total / n), upsell };
}

/** What the order line says: "50 × 14.8 × 21 cm (301–450 cm² band) · 10 off each · 10% volume discount · setup". */
export function flatbedDescription(s: FlatbedSettings, widthCm: number, heightCm: number, pieces: number, opts: FlatbedOptions = {}, note = ''): string {
  const q = flatbedQuote(s, widthCm, heightCm, pieces, opts);
  const parts = [`${pieces} × ${widthCm} × ${heightCm} cm${q.band ? ` (${flatbedRangeLabel(s.bands, q.bandIndex)} band)` : ''}`];
  if (q.unitDiscount > 0) parts.push(`${q.unitDiscount}/= off each`);
  if (q.volumeApplied) parts.push(`${q.volumePct}% volume discount`);
  if (opts.setup) parts.push('setup');
  if (note.trim()) parts.push(note.trim());
  return parts.join(' · ').slice(0, 160);
}
