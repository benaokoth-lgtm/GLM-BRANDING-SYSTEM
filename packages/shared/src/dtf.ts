// DTF Sales & Roll Tracker — all formulas in one place, mirroring the
// reference workbook (docs/dtf/GLM_DTF_Printing_Tracker.xlsx). The forms'
// live previews and the roll/dashboard roll-ups both call these functions.

export interface DtfSettings {
  rollLengthM: number;
  rollWidthCm: number;
  stdPricePerM: number; // also the ceiling for film price
  minPricePerM: number;
  defaultMultiplier: number;
  wastageTolerancePct: number;
  // Artwork-job billing (see jobCalc) — a job that only fills part of the
  // roll's width still ties up that whole run length until the rest of the
  // row fills with other work, so it's billed a premium proportional to how
  // empty the row is instead of at face-value running metres.
  unfilledWidthPremium: number; // 's' — 0.5 = up to +50% at zero fill, +0% at full width
  minBillableMetres: number; // billable metres is never less than this, however short the job
  minPricePerPiece: number; // final per-piece price is never less than this, however small the job
}

export const DEFAULT_DTF_SETTINGS: DtfSettings = {
  rollLengthM: 100,
  rollWidthCm: 60,
  stdPricePerM: 500,
  minPricePerM: 400,
  defaultMultiplier: 3,
  wastageTolerancePct: 5,
  unfilledWidthPremium: 0.5,
  minBillableMetres: 0.25,
  minPricePerPiece: 30,
};

export interface DtfRoll {
  id: string; // ROLL-001
  installedOn: string | null; // a roll is "started" only once this is set
  finishedOn: string | null;
  status: 'open' | 'closed';
  filmCost: number;
  inkPowderCost: number;
  /** Roll length snapshotted at install so later Setup changes don't rewrite history. */
  rollLengthM: number;
}

export interface DtfFilmSale {
  id: string;
  rollId: string;
  soldOn: string;
  client: string;
  metres: number;
  pricePerM: number; // resolved price actually charged
  stdPriceAtSale: number; // snapshot, for the discount/m column
  amountPaid: number;
}

export interface DtfArtworkJob {
  id: string;
  rollId: string;
  jobOn: string;
  client: string;
  runningMetres: number; // physical film consumed — what the roll's remaining balance is drawn down by
  widthUsedCm: number; // widest extent the artworks occupy across the roll's width — one eyeballed number per job
  billableMetres: number; // resolved MAX(runningMetres, minBillableMetres) × (1 + s × (1 − Fill)), snapshotted at capture
  artworks: number;
  pieces: number;
  multiplier: number; // resolved multiplier actually used
  stdPriceAtJob: number; // snapshot
  minPricePerPieceAtJob: number; // snapshot, same reasoning as stdPriceAtJob
  discountPerPiece: number; // negative = price up
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const div = (a: number, b: number) => (b > 0 ? a / b : 0);

// ---------- Film sale ----------

export interface SaleCalc {
  price: number;
  valid: boolean; // min <= price <= std
  discountPerM: number;
  total: number;
  balance: number;
}

export function saleCalc(
  s: DtfSettings,
  metres: number,
  pricePerM: number | null | undefined,
  amountPaid: number,
): SaleCalc {
  const price = pricePerM == null || Number.isNaN(pricePerM) ? s.stdPricePerM : pricePerM;
  const total = r2(metres * price);
  return {
    price,
    valid: price >= s.minPricePerM && price <= s.stdPricePerM,
    discountPerM: r2(s.stdPricePerM - price),
    total,
    balance: r2(total - amountPaid),
  };
}

export function saleTotals(sale: DtfFilmSale) {
  const total = r2(sale.metres * sale.pricePerM);
  return {
    discountPerM: r2(sale.stdPriceAtSale - sale.pricePerM),
    total,
    balance: r2(total - sale.amountPaid),
  };
}

// ---------- Artwork job ----------

// How much of the roll's width this job actually occupies — 1 at full width
// (60cm used of 60cm), less as the row gets emptier. Never above 1: a job
// can't use more width than the roll has.
export function computeFill(widthUsedCm: number, rollWidthCm: number): number {
  return rollWidthCm > 0 ? Math.min(1, widthUsedCm / rollWidthCm) : 1;
}

// A part-width job still ties up its whole run length until the rest of the
// row fills with other work — billed a premium proportional to how empty
// the row is (zero at full width, up to +unfilledWidthPremium at zero fill),
// on top of a floor so a tiny job never bills near-zero metres.
export function computeBillableMetres(s: DtfSettings, runningMetres: number, widthUsedCm: number): number {
  const fill = computeFill(widthUsedCm, s.rollWidthCm);
  return Math.max(runningMetres, s.minBillableMetres) * (1 + s.unfilledWidthPremium * (1 - fill));
}

export interface JobCalc {
  billableMetres: number;
  basePerArtwork: number;
  multiplier: number;
  proposed: number;
  finalPerPiece: number;
  jobTotal: number;
  belowBase: boolean;
}

export function jobCalc(
  s: DtfSettings,
  billableMetres: number,
  artworks: number,
  pieces: number,
  multiplier: number | null | undefined,
  discountPerPiece: number,
  stdPrice: number = s.stdPricePerM,
  minPricePerPiece: number = s.minPricePerPiece,
): JobCalc {
  const mult = multiplier == null || Number.isNaN(multiplier) ? s.defaultMultiplier : multiplier;
  const basePerArtwork = div(billableMetres * stdPrice, artworks);
  const proposed = basePerArtwork * mult;
  const finalPerPiece = Math.max(proposed, minPricePerPiece) - discountPerPiece;
  return {
    billableMetres: r2(billableMetres),
    basePerArtwork: r2(basePerArtwork),
    multiplier: mult,
    proposed: r2(proposed),
    finalPerPiece: r2(finalPerPiece),
    jobTotal: r2(finalPerPiece * pieces),
    belowBase: pieces > 0 && finalPerPiece < basePerArtwork,
  };
}

export function jobTotals(s: DtfSettings, j: DtfArtworkJob): JobCalc {
  return jobCalc(s, j.billableMetres, j.artworks, j.pieces, j.multiplier, j.discountPerPiece, j.stdPriceAtJob, j.minPricePerPieceAtJob);
}

// ---------- Roll roll-up (the workbook's Rolls sheet / roll_summary view) ----------

export interface RollSummary {
  roll: DtfRoll;
  started: boolean;
  closed: boolean;
  filmM: number;
  artM: number;
  usedM: number;
  remainingM: number;
  rollCost: number;
  wastageM: number;
  wastagePct: number;
  wastageKes: number;
  overTolerance: boolean;
  filmRev: number;
  artRev: number;
  revenue: number;
  profit: number;
  filmRevPerM: number | null;
  artRevPerM: number | null;
}

export function summariseRoll(
  s: DtfSettings,
  roll: DtfRoll,
  sales: DtfFilmSale[],
  jobs: DtfArtworkJob[],
): RollSummary {
  const mine = sales.filter((x) => x.rollId === roll.id);
  const myJobs = jobs.filter((x) => x.rollId === roll.id);
  const filmM = mine.reduce((a, x) => a + x.metres, 0);
  const artM = myJobs.reduce((a, x) => a + x.runningMetres, 0);
  const usedM = filmM + artM;
  const len = roll.rollLengthM || s.rollLengthM;
  const remainingM = Math.max(0, len - usedM);
  const rollCost = roll.filmCost + roll.inkPowderCost;
  const closed = roll.status === 'closed';
  const wastageM = closed ? remainingM : 0;
  const wastagePct = closed ? div(wastageM, len) * 100 : 0;
  const wastageKes = closed ? div(wastageM * rollCost, len) : 0;
  const filmRev = mine.reduce((a, x) => a + saleTotals(x).total, 0);
  const artRev = myJobs.reduce((a, x) => a + jobTotals(s, x).jobTotal, 0);
  const revenue = filmRev + artRev;
  return {
    roll,
    started: !!roll.installedOn,
    closed,
    filmM,
    artM,
    usedM,
    remainingM,
    rollCost,
    wastageM,
    wastagePct,
    wastageKes,
    overTolerance: closed && wastagePct > s.wastageTolerancePct,
    filmRev,
    artRev,
    revenue,
    // Wastage is already inside the full roll cost — never subtract it again.
    profit: revenue - rollCost,
    filmRevPerM: filmM > 0 ? filmRev / filmM : null,
    artRevPerM: artM > 0 ? artRev / artM : null,
  };
}

// ---------- Dashboard ----------

export interface DtfDashboard {
  rolls: RollSummary[];
  startedCount: number;
  closedCount: number;
  installedM: number;
  usedM: number;
  filmM: number;
  artM: number;
  filmRev: number;
  artRev: number;
  revenue: number;
  costPerM: number;
  filmMarginPerM: number | null;
  artMarginPerM: number | null;
  filmRevPerM: number | null;
  artRevPerM: number | null;
  filmShare: number;
  artShare: number;
  totalCost: number;
  netProfit: number;
  profitPerClosedRoll: number | null;
  wastageM: number;
  wastageKes: number;
  /** Sales/jobs pointing at a roll that hasn't started (or doesn't exist). */
  orphanCount: number;
}

export function dtfDashboard(
  s: DtfSettings,
  rolls: DtfRoll[],
  sales: DtfFilmSale[],
  jobs: DtfArtworkJob[],
): DtfDashboard {
  const all = rolls.map((r) => summariseRoll(s, r, sales, jobs));
  const started = all.filter((r) => r.started);
  const closed = started.filter((r) => r.closed);
  const startedIds = new Set(started.map((r) => r.roll.id));
  const installedM = started.reduce((a, r) => a + (r.roll.rollLengthM || s.rollLengthM), 0);
  const totalCost = started.reduce((a, r) => a + r.rollCost, 0);
  const costPerM = div(totalCost, installedM);
  const filmM = started.reduce((a, r) => a + r.filmM, 0);
  const artM = started.reduce((a, r) => a + r.artM, 0);
  const filmRev = started.reduce((a, r) => a + r.filmRev, 0);
  const artRev = started.reduce((a, r) => a + r.artRev, 0);
  const usedM = filmM + artM;
  const filmRevPerM = filmM > 0 ? filmRev / filmM : null;
  const artRevPerM = artM > 0 ? artRev / artM : null;
  return {
    rolls: all,
    startedCount: started.length,
    closedCount: closed.length,
    installedM,
    usedM,
    filmM,
    artM,
    filmRev,
    artRev,
    revenue: filmRev + artRev,
    costPerM,
    filmRevPerM,
    artRevPerM,
    filmMarginPerM: filmRevPerM == null ? null : filmRevPerM - costPerM,
    artMarginPerM: artRevPerM == null ? null : artRevPerM - costPerM,
    filmShare: div(filmM, usedM),
    artShare: div(artM, usedM),
    totalCost,
    netProfit: filmRev + artRev - totalCost,
    profitPerClosedRoll: closed.length ? closed.reduce((a, r) => a + r.profit, 0) / closed.length : null,
    wastageM: closed.reduce((a, r) => a + r.wastageM, 0),
    wastageKes: closed.reduce((a, r) => a + r.wastageKes, 0),
    orphanCount:
      sales.filter((x) => !startedIds.has(x.rollId)).length + jobs.filter((x) => !startedIds.has(x.rollId)).length,
  };
}

export function nextRollId(rolls: { id: string }[]): string {
  const max = rolls.reduce((m, r) => Math.max(m, Number(/(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);
  return `ROLL-${String(max + 1).padStart(3, '0')}`;
}

/** "1,234.5" style number with up to `dp` decimals; "—" when null. */
export function fmtNum(n: number | null, dp = 0): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
