// DTF Sales & Roll Tracker — all formulas in one place, mirroring the
// reference workbook (docs/dtf/GLM_DTF_Printing_Tracker.xlsx). The forms'
// live previews and the roll/dashboard roll-ups both call these functions.

export interface DtfSettings {
  rollLengthM: number;
  rollWidthCm: number;
  stdPricePerM: number; // the standard film price — what a sale defaults to; staff may charge MORE (there is no ceiling)
  minPricePerM: number; // the floor, and the base that film commission is measured from
  wastageTolerancePct: number;
  // Artwork-job billing (see jobCalc): every piece pays this per-piece floor
  // plus a share of a fixed per-running-metre charge, split across however
  // many pieces that metre covers. The fixed charge is billed against the
  // whole running length regardless of how much of the roll's width it
  // actually used — a half-empty strip just has fewer pieces to share it
  // with, so the client bears that wastage automatically, with no separate
  // width measurement needed.
  minPricePerPiece: number;
  fixedChargePerMetre: number;
}

export const DEFAULT_DTF_SETTINGS: DtfSettings = {
  rollLengthM: 100,
  rollWidthCm: 60,
  stdPricePerM: 500,
  minPricePerM: 400,
  wastageTolerancePct: 5,
  minPricePerPiece: 30,
  fixedChargePerMetre: 2160,
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
  runningMetres: number; // physical film consumed — what the roll's remaining balance is drawn down by, and what the fixed charge is billed against
  pieces: number;
  fixedChargePerMetreAtJob: number; // Setup snapshot, so a later Setup change never re-prices history
  minPricePerPieceAtJob: number; // Setup snapshot, same reasoning
  /** What was actually charged per piece, when staff charged more than the system-recommended price. Null/absent = the recommended price. */
  chargedPerPiece?: number | null;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const div = (a: number, b: number) => (b > 0 ? a / b : 0);

// ---------- Film sale ----------

export interface SaleCalc {
  price: number;
  valid: boolean; // price >= min (no ceiling — a higher price is rewarded, not blocked)
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
    valid: price >= s.minPricePerM,
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
//
// Price per piece = minPricePerPiece + fixedChargePerMetre × runningMetres ÷ pieces
//
// Every piece pays the floor, plus its share of a fixed per-running-metre
// charge — billed against the metre regardless of how much of the roll's
// width it filled. More pieces sharing that metre means a cheaper price
// each (falling toward, but never below, the floor); fewer pieces means a
// dearer one. A half-empty strip has fewer pieces to share the charge, so
// the client bears that wastage automatically — no separate width
// measurement is needed for this.

export interface JobCalc {
  finalPerPiece: number;
  jobTotal: number;
}

export function jobCalc(
  runningMetres: number,
  pieces: number,
  fixedChargePerMetre: number,
  minPricePerPiece: number,
): JobCalc {
  const finalPerPiece = minPricePerPiece + div(fixedChargePerMetre * runningMetres, pieces);
  return {
    finalPerPiece: r2(finalPerPiece),
    jobTotal: r2(finalPerPiece * pieces),
  };
}

/** The recommended price per piece the system works out for a job (before any extra the staff member charged). */
export function systemJobCalc(j: DtfArtworkJob): JobCalc {
  return jobCalc(j.runningMetres, j.pieces, j.fixedChargePerMetreAtJob, j.minPricePerPieceAtJob);
}

/** What the job really brings in: the recommended price, or the higher price the staff member charged. */
export function jobTotals(j: DtfArtworkJob): JobCalc {
  const sys = systemJobCalc(j);
  if (j.chargedPerPiece != null && j.chargedPerPiece > sys.finalPerPiece) {
    return { finalPerPiece: r2(j.chargedPerPiece), jobTotal: r2(j.chargedPerPiece * j.pieces) };
  }
  return sys;
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
  const artRev = myJobs.reduce((a, x) => a + jobTotals(x).jobTotal, 0);
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
