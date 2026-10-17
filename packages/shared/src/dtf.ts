// DTF Sales & Roll Tracker — all formulas in one place, mirroring the
// reference workbook (docs/dtf/GLM_DTF_Printing_Tracker.xlsx). The forms'
// live previews and the roll/dashboard roll-ups both call these functions.

export interface DtfSettings {
  rollLengthM: number;
  rollWidthCm: number;
  stdPricePerM: number; // the standard film price — what a sale defaults to; staff may charge MORE (there is no ceiling)
  minPricePerM: number; // the floor, and the base that film commission is measured from
  wastageTolerancePct: number;
  // Artwork billing (see runningMetreCalc): the film is charged by the running metres it uses, and that charge — fixedChargePerMetre × running metres — is shared equally between the
  // artworks on the length, so the client bears the empty space; nothing is added per piece. minPricePerPiece is only the lowest price an artwork may be charged (0 = none).
  minPricePerPiece: number;
  fixedChargePerMetre: number;
  /** When an artwork's share of the film comes to less than this, its recommended price is smallSharePrice instead (0 = no such rule). DTF: under 30 → 40; UV DTF: under 40 → 40, a base price of 40. */
  smallShareBelow: number;
  smallSharePrice: number;
}

export const DEFAULT_DTF_SETTINGS: DtfSettings = {
  rollLengthM: 100,
  rollWidthCm: 60,
  stdPricePerM: 500,
  minPricePerM: 400,
  wastageTolerancePct: 5,
  minPricePerPiece: 30,
  fixedChargePerMetre: 3780, // 108 artworks on 2 m come to 70 each
  smallShareBelow: 30,
  smallSharePrice: 40,
};

/**
 * The two printing products the tracker runs: DTF film (rolls "ROLL-001") and UV DTF film (rolls "UV-001"). Each has its own rolls and its own settings (roll size, prices,
 * artwork charge); the formulas below are the same for both.
 */
export type DtfProduct = 'dtf' | 'uv';
export const DTF_PRODUCTS: DtfProduct[] = ['dtf', 'uv'];
export const DTF_PRODUCT_LABEL: Record<DtfProduct, string> = { dtf: 'DTF', uv: 'UV DTF' };
export const isDtfProduct = (v: unknown): v is DtfProduct => v === 'dtf' || v === 'uv';

/** The price-list services a film sale and an artwork job are recorded against, for each product. */
export const DTF_SERVICE_NAMES: Record<DtfProduct, { film: string; artwork: string }> = {
  dtf: { film: 'DTF Sheet (per metre)', artwork: 'DTF Printing' },
  uv: { film: 'UV DTF Sheet (per metre)', artwork: 'UV DTF Printing' },
};

/**
 * UV DTF starts from these: a 30 cm × 50 m roll, film sold at KES 1,500 a metre (VAT included) with a floor of 1,200, and artwork charged 4,280 for every running metre, shared across
 * the artworks on it — 107 artworks on a metre come to 40 each. Editable in DTF → UV DTF → Setup.
 */
export const UV_DTF_SETTINGS: DtfSettings = {
  rollLengthM: 50,
  rollWidthCm: 30,
  stdPricePerM: 1500,
  minPricePerM: 1200,
  wastageTolerancePct: 5,
  minPricePerPiece: 30,
  fixedChargePerMetre: 4280, // 107 artworks on a metre come to 40 each
  smallShareBelow: 40, // the recommended price of an artwork is never below 40
  smallSharePrice: 40,
};

export interface DtfRoll {
  id: string; // ROLL-001 (DTF) or UV-001 (UV DTF)
  /** Which product the roll is for; DTF when not said. */
  product?: DtfProduct;
  installedOn: string | null; // a roll is "started" only once this is set
  finishedOn: string | null;
  status: 'open' | 'closed';
  filmCost: number;
  inkPowderCost: number;
  /** Roll length snapshotted at install so later Setup changes don't rewrite history. */
  rollLengthM: number;
  /** "terminated" when the roll was physically finished and the balance the system still showed was written off as waste at the cut-off date. */
  closeKind?: string;
  closeNote?: string;
  closedByName?: string;
  writtenOffM?: number;
  /** Installed part-used: metres already used before the roll was recorded. The roll is tracked from the metres left (rollLengthM), and its costs are those metres' share. */
  carriedInUsedM?: number;
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
  /** A job priced below the recommended price waits for a manager's approval before it can be produced; its revenue counts once approved. */
  approvalStatus?: 'Pending' | 'Approved';
  /** The order this job generated. */
  orderId?: number | null;
  /** What the client was charged for the artworks in all (VAT included, before the heat press fee), set when the artworks of a sheet were priced row by row; then it is the price, and chargedPerPiece is only its average. */
  chargedTotal?: number | null;
  /** The jobs that came from one sheet (artworks of several sizes, perhaps several clients, on one length of film) share this. The recommended price is judged on the sheet as a whole, not on each client. */
  sheetId?: string | null;
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

/**
 * How ALL new artwork is priced: the film is charged by the running metres it uses, whether or not the artworks fill its width, and that charge is shared equally between the artworks on
 * the length — (charge per running metre × running metres) ÷ artworks, so the client bears the empty space. There is no per-piece amount added. (jobCalc above keeps the older
 * "minimum per piece + share" sum only so that jobs recorded under it, which carry their own snapshot, are read back as they were saved.)
 */
export function runningMetreCalc(runningMetres: number, pieces: number, chargePerMetre: number, belowPrice = 0, smallSharePrice = 0): JobCalc {
  const share = jobCalc(runningMetres, pieces, chargePerMetre, 0);
  // an artwork whose share of the film is below `belowPrice` is recommended at the small-share price instead (DTF: under 30 → 40; UV DTF: under 40 → 40)
  if (belowPrice > 0 && smallSharePrice > 0 && pieces > 0 && share.finalPerPiece < belowPrice - 0.005) return { finalPerPiece: r2(smallSharePrice), jobTotal: r2(smallSharePrice * pieces) };
  return share;
}

/** True when the artworks' share of the film came to less than the threshold, so the small-share price was recommended instead. */
export function usesSmallSharePrice(runningMetres: number, pieces: number, chargePerMetre: number, belowPrice = 0, smallSharePrice = 0): boolean {
  return runningMetreCalc(runningMetres, pieces, chargePerMetre, belowPrice, smallSharePrice).finalPerPiece !== jobCalc(runningMetres, pieces, chargePerMetre, 0).finalPerPiece;
}

/**
 * The charge per running metre to save with a job so that reading it back (systemJobCalc) gives the recommended price it was really priced at: the setting itself, or — when the small-share
 * price was used — the charge that makes the length come to exactly that total.
 */
export function chargeToSnapshot(runningMetres: number, calc: JobCalc, chargePerMetre: number, usedSmallShare: boolean): number {
  return usedSmallShare && runningMetres > 0 ? calc.jobTotal / runningMetres : chargePerMetre;
}

/** The lowest price an artwork may be charged: the minimum in Setup, unless the recommended price itself is lower (many artworks on a short length) — nobody is asked for more than that. */
export const lowestArtworkPrice = (minPricePerPiece: number, recommendedPerPiece: number): number => Math.min(minPricePerPiece, recommendedPerPiece);

/** The recommended price per piece the system works out for a job (before any extra the staff member charged). */
export function systemJobCalc(j: DtfArtworkJob): JobCalc {
  return jobCalc(j.runningMetres, j.pieces, j.fixedChargePerMetreAtJob, j.minPricePerPieceAtJob);
}

/** What the job really brings in: the price actually charged per piece (higher or lower than recommended), else the recommended price. */
export function jobTotals(j: DtfArtworkJob): JobCalc {
  const sys = systemJobCalc(j);
  if (j.chargedTotal != null && j.chargedTotal > 0 && j.pieces > 0) return { finalPerPiece: r2(j.chargedTotal / j.pieces), jobTotal: r2(j.chargedTotal) };
  if (j.chargedPerPiece != null && j.chargedPerPiece > 0 && Math.abs(j.chargedPerPiece - sys.finalPerPiece) > 0.004) {
    return { finalPerPiece: r2(j.chargedPerPiece), jobTotal: r2(j.chargedPerPiece * j.pieces) };
  }
  return sys;
}

/** Per-piece amount charged below the recommended price (0 when charged at or above it). */
export function jobDiscountPerPiece(j: DtfArtworkJob): number {
  return r2(Math.max(0, systemJobCalc(j).finalPerPiece - jobTotals(j).finalPerPiece));
}

/**
 * What each job earned above the recommended price, and what it gave away below it (Ksh). A job on its own is judged on its own price. The jobs of one sheet are judged together: a client
 * who paid less than their share is made up by another who paid more, so only what the SHEET brought in above (or, never, below) the recommended total counts, shared between its jobs by
 * what each was charged. Commission and the roll's figures use this, so moving a price from one client to another earns nothing.
 */
export function jobExtras(jobs: DtfArtworkJob[]): Map<string, { excess: number; short: number }> {
  const out = new Map<string, { excess: number; short: number }>();
  const sheets = new Map<string, DtfArtworkJob[]>();
  for (const j of jobs) {
    if (j.sheetId) {
      const g = sheets.get(j.sheetId) ?? [];
      g.push(j);
      sheets.set(j.sheetId, g);
    } else {
      out.set(j.id, { excess: r2(j.pieces * Math.max(0, jobTotals(j).finalPerPiece - systemJobCalc(j).finalPerPiece)), short: r2(j.pieces * jobDiscountPerPiece(j)) });
    }
  }
  for (const group of sheets.values()) {
    const charged = group.reduce((a, j) => a + jobTotals(j).jobTotal, 0);
    const system = group.reduce((a, j) => a + systemJobCalc(j).jobTotal, 0);
    const above = Math.max(0, charged - system);
    const below = Math.max(0, system - charged);
    for (const j of group) {
      const w = charged > 0 ? jobTotals(j).jobTotal / charged : 1 / group.length;
      out.set(j.id, { excess: r2(above * w), short: r2(below * w) });
    }
  }
  return out;
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
  /** Closed by "terminate roll": the balance still shown was written off as waste at the cut-off date. */
  terminated: boolean;
  filmRev: number;
  artRev: number;
  revenue: number;
  profit: number;
  filmRevPerM: number | null;
  artRevPerM: number | null;
  // The effect of ARTWORK discounts — a job charged below the recommended price — on this roll's profit. Film sales are not part of it.
  artworkDiscount: number;
  /** Everything given away by charging artwork below the recommended price (approved jobs only). */
  discountGiven: number;
  /** Extra earned by charging artwork above the recommended price. */
  premiumEarned: number;
  /** Metres of artwork printed at a discount, and how many jobs they were. */
  discountedM: number;
  discountedCount: number;
  revenueBeforeDiscounts: number;
  profitBeforeDiscounts: number;
  /** Discounts as a % of the revenue the same work would have brought in at full price. */
  discountPctOfRevenue: number | null;
  /** Share of the profit the roll would have made at full price that the discounts took away. */
  profitLostPct: number | null;
  /** Jobs held back for price approval (their metres are reserved, their revenue is not counted yet). */
  pendingJobs: number;
}

export function summariseRoll(
  s: DtfSettings,
  roll: DtfRoll,
  sales: DtfFilmSale[],
  jobs: DtfArtworkJob[],
): RollSummary {
  const mine = sales.filter((x) => x.rollId === roll.id);
  const myJobs = jobs.filter((x) => x.rollId === roll.id);
  // A job waiting for price approval keeps its metres reserved on the roll, but earns nothing until it is approved.
  const approvedJobs = myJobs.filter((x) => x.approvalStatus !== 'Pending');
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
  const artRev = approvedJobs.reduce((a, x) => a + jobTotals(x).jobTotal, 0);
  const revenue = filmRev + artRev;
  const extras = jobExtras(approvedJobs);
  const artworkDiscount = r2(approvedJobs.reduce((a, x) => a + (extras.get(x.id)?.short ?? 0), 0));
  const premiumEarned = r2(approvedJobs.reduce((a, x) => a + (extras.get(x.id)?.excess ?? 0), 0));
  const discountGiven = artworkDiscount;
  const discountedJobs = approvedJobs.filter((x) => (extras.get(x.id)?.short ?? 0) > 0);
  const profit = revenue - rollCost;
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
    terminated: closed && roll.closeKind === 'terminated',
    filmRev,
    artRev,
    revenue,
    // Wastage is already inside the full roll cost — never subtract it again.
    profit,
    filmRevPerM: filmM > 0 ? filmRev / filmM : null,
    artRevPerM: artM > 0 ? artRev / artM : null,
    artworkDiscount,
    discountGiven,
    premiumEarned,
    discountedM: discountedJobs.reduce((a, x) => a + x.runningMetres, 0),
    discountedCount: discountedJobs.length,
    revenueBeforeDiscounts: r2(revenue + discountGiven),
    profitBeforeDiscounts: r2(profit + discountGiven),
    discountPctOfRevenue: revenue + discountGiven > 0 ? r2((discountGiven / (revenue + discountGiven)) * 100) : null,
    profitLostPct: profit + discountGiven > 0 ? r2((discountGiven / (profit + discountGiven)) * 100) : null,
    pendingJobs: myJobs.length - approvedJobs.length,
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
  /** Of the wastage, the metres written off when rolls were terminated (physically finished, balance still on the system). */
  writtenOffM: number;
  terminatedCount: number;
  discountGiven: number;
  premiumEarned: number;
  profitBeforeDiscounts: number;
  profitLostPct: number | null;
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
    writtenOffM: closed.filter((r) => r.terminated).reduce((a, r) => a + r.wastageM, 0),
    terminatedCount: closed.filter((r) => r.terminated).length,
    discountGiven: r2(started.reduce((a, r) => a + r.discountGiven, 0)),
    premiumEarned: r2(started.reduce((a, r) => a + r.premiumEarned, 0)),
    profitBeforeDiscounts: r2(started.reduce((a, r) => a + r.profitBeforeDiscounts, 0)),
    profitLostPct: (() => {
      const before = started.reduce((a, r) => a + r.profitBeforeDiscounts, 0);
      return before > 0 ? r2((started.reduce((a, r) => a + r.discountGiven, 0) / before) * 100) : null;
    })(),
    orphanCount:
      sales.filter((x) => !startedIds.has(x.rollId)).length + jobs.filter((x) => !startedIds.has(x.rollId)).length,
  };
}

export function nextRollId(rolls: { id: string }[], product: DtfProduct = 'dtf'): string {
  const max = rolls.reduce((m, r) => Math.max(m, Number(/(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);
  return `${product === 'uv' ? 'UV' : 'ROLL'}-${String(max + 1).padStart(3, '0')}`;
}

/** "1,234.5" style number with up to `dp` decimals; "—" when null. */
export function fmtNum(n: number | null, dp = 0): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
