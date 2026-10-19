import { round2 } from './accounting';
import { COSTING_JOB_LABEL } from './costing';
import { VAT_RATE } from './tax';

// Job Costing → Brochures & Eulogies: what an outsourced print job costs and what to quote. Eulogy booklets and company profiles are folded A3 sheets (4 pages to a sheet, always
// printed both sides); a brochure is cut from A3 (A4 two to a sheet, B5 four), single or double sided. The A3 sheet is priced per paper and per side; stapling, trimming, folding,
// lamination, design, proofing and delivery are added; then the mark-up (by quantity, or flat) and VAT. Every price shown to a customer is VAT inclusive.
//
// The arithmetic lives here, once, so the screen, the price list and the quote all agree. Money is rounded to the cent at each line, so a quote's lines add up to its total.

export const PRINT_PRODUCTS = ['eulogy', 'profile', 'brochure'] as const;
export type PrintProduct = (typeof PRINT_PRODUCTS)[number];
export const PRINT_PRODUCT_LABEL: Record<PrintProduct, string> = { eulogy: 'Eulogy', profile: 'Company profile', brochure: 'Brochure' };
export const PRINT_PAGE_OPTIONS = [4, 8, 12, 16, 20, 24, 28, 32] as const;
export type PrintSize = 'A4' | 'B5';
/** Eulogy / company-profile booklets: an A4 booklet is folded from A3 sheets (4 pages to a sheet); an A5 booklet is folded from A4 sheets, two of which are cut from one A3 sheet. */
export const PRINT_BOOKLETS = ['A4', 'A5'] as const;
export type PrintBooklet = (typeof PRINT_BOOKLETS)[number];
/** How many of a size come out of one A3 sheet. */
export const PRINT_UPS: Record<PrintSize, number> = { A4: 2, B5: 4 };
/** The quantities the price list shows. */
export const PRINT_BOOKLET_QTYS = [25, 50, 100, 250, 500] as const;
export const PRINT_BROCHURE_QTYS = [100, 250, 500, 1000, 5000] as const;

export interface PrintPaper {
  name: string;
  /** What one A3 sheet costs printed on one side. */
  one: number;
  /** …and on both sides. */
  two: number;
}
export interface PrintFees {
  /** Per set (a booklet of 2 or more sheets). */
  staple: number;
  /** Per set. */
  trim: number;
  /** Folding / creasing, per set. */
  fold: number;
  /** Lamination, per A3 sheet. */
  lam: number;
  /** A5 booklets: cutting each A3 sheet into two A4 sheets, per A3 sheet (0 = included in the printer's rate). */
  cut: number;
  /** Design / layout, a flat fee for the job. */
  designEu: number;
  designPr: number;
  designBr: number;
  /** Per job. */
  proof: number;
  deliver: number;
  /** Brochures only: extra sheets printed to cover spoilage, % of the sheets. */
  waste: number;
}
export interface PrintTier {
  /** From this quantity (copies or pieces)… */
  min: number;
  /** …the mark-up on cost is this %. */
  pct: number;
}
export interface PrintSettings {
  papers: PrintPaper[];
  fees: PrintFees;
  tiers: PrintTier[];
  /** The lowest margin (markup on cost, %) a price agreed with a client may fall to without a manager's approval (a saved quote). */
  floorMarginPct: number;
}

/** Placeholders from the design: to be replaced by the printer's real quotes (Job Costing → Brochures & Eulogies → Rates). */
export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  papers: [
    { name: '130gsm gloss', one: 35, two: 60 },
    { name: '150gsm gloss', one: 40, two: 68 },
    { name: '170gsm gloss', one: 45, two: 78 },
    { name: '200gsm gloss', one: 55, two: 92 },
    { name: '250gsm matt cover', one: 70, two: 115 },
  ],
  fees: { staple: 8, trim: 6, fold: 10, lam: 60, cut: 0, designEu: 3000, designPr: 3000, designBr: 1500, proof: 300, deliver: 500, waste: 5 },
  tiers: [
    { min: 1, pct: 50 },
    { min: 100, pct: 35 },
    { min: 500, pct: 25 },
  ],
  floorMarginPct: 30,
};

export const PRINT_FEE_LABELS: { key: keyof PrintFees; label: string; unit: string }[] = [
  { key: 'designEu', label: 'Design/layout, eulogy', unit: 'KES / job' },
  { key: 'designPr', label: 'Design/layout, company profile', unit: 'KES / job' },
  { key: 'designBr', label: 'Design/layout, brochure', unit: 'KES / job' },
  { key: 'proof', label: 'Proofing', unit: 'KES / job' },
  { key: 'deliver', label: 'Delivery', unit: 'KES / job' },
  { key: 'staple', label: 'Stapling', unit: 'KES / set (2+ sheets)' },
  { key: 'trim', label: 'Trimming', unit: 'KES / set' },
  { key: 'fold', label: 'Folding / creasing', unit: 'KES / set' },
  { key: 'lam', label: 'Lamination', unit: 'KES / A3 sheet' },
  { key: 'cut', label: 'Cutting A3 into A4 (A5 booklets)', unit: 'KES / A3 sheet' },
  { key: 'waste', label: 'Brochure wastage', unit: '% of sheets' },
];

/** What is wrong with a set of rates, or null. */
export function printSettingsProblem(s: PrintSettings): string | null {
  if (s.papers.length < 1) return 'There must be at least one paper';
  for (const p of s.papers) {
    if (!p.name.trim()) return 'Every paper needs a name';
    if (s.papers.filter((x) => x.name.trim().toLowerCase() === p.name.trim().toLowerCase()).length > 1) return `${p.name.trim()} is on the list twice`;
    if (!(p.one >= 0) || !(p.two >= 0)) return `${p.name}: the sheet rates cannot be negative`;
  }
  for (const { key, label } of PRINT_FEE_LABELS) if (!(s.fees[key] >= 0)) return `${label} cannot be negative`;
  if (s.fees.waste > 100) return 'Wastage cannot be more than 100%';
  if (!(s.floorMarginPct >= 0) || s.floorMarginPct > 1000) return 'The lowest margin is between 0% and 1000%';
  if (s.tiers.length < 1) return 'There must be at least one mark-up tier';
  const sorted = [...s.tiers].sort((a, b) => a.min - b.min);
  if (sorted[0]!.min !== 1) return 'The first mark-up tier must start at 1';
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    if (!Number.isInteger(t.min) || t.min < 1) return 'A tier starts at a whole number of copies, 1 or more';
    if (i > 0 && t.min === sorted[i - 1]!.min) return 'Two mark-up tiers start at the same quantity';
    if (!(t.pct >= 0) || t.pct > 1000) return 'A mark-up is between 0% and 1000%';
  }
  return null;
}

/** The name of a costed job's kind for a saved quote: Business cards, Indoor signage, … or Eulogy, Company profile, Brochure. */
export function costingJobLabel(jobType: string): string {
  return (COSTING_JOB_LABEL as Record<string, string>)[jobType] ?? (PRINT_PRODUCT_LABEL as Record<string, string>)[jobType] ?? jobType;
}

export interface PrintJob {
  product: PrintProduct;
  /** Eulogy / company profile: 4, 8 … 32. */
  pages: number;
  /** Index into `papers`: the inside paper (booklets) or the paper (brochures). */
  paper: number;
  /** Booklets: a separate cover paper (index), used when `coverSep`. */
  cover: number;
  coverSep: boolean;
  /** Booklets: laminate the cover. Brochures: laminate the sheets. */
  lam: boolean;
  /** Booklets: folding / creasing. */
  fold: boolean;
  /** Eulogies and company profiles: 'A4' (A3 sheets folded — the usual) or 'A5' (A4 sheets folded, two cut from each A3 sheet). Left out = A4, as every earlier quote. */
  booklet?: PrintBooklet;
  /** Brochures. */
  size: PrintSize;
  sides: 1 | 2;
  qty: number;
  /** 'tier' = the mark-up for the quantity; 'flat' = the first tier whatever the quantity. */
  mode: 'tier' | 'flat';
}

export interface PrintLine {
  label: string;
  note: string;
  amount: number;
}
export interface PrintResult {
  qty: number;
  lines: PrintLine[];
  /** A3 sheets in the job. */
  sheets: number;
  cost: number;
  markupPct: number;
  markup: number;
  /** Cost plus mark-up: the price before VAT. */
  priceExVat: number;
  vat: number;
  total: number;
  unitExVat: number;
  unitTotal: number;
  /** What the job earns: the mark-up. */
  profit: number;
}

/** The mark-up % for a quantity: the highest tier whose `min` the quantity reaches (the first tier in flat mode). */
export function printMarkupPct(tiers: PrintTier[], qty: number, mode: 'tier' | 'flat'): number {
  const sorted = [...tiers].sort((a, b) => a.min - b.min);
  if (mode === 'flat') return sorted[0]!.pct;
  let pct = sorted[0]!.pct;
  for (const t of sorted) if (qty >= t.min) pct = t.pct;
  return pct;
}

export function printCalc(job: PrintJob, s: PrintSettings): PrintResult {
  const qty = Math.max(1, Math.floor(job.qty) || 1);
  const f = s.fees;
  const paper = s.papers[job.paper] ?? s.papers[0]!;
  const lines: PrintLine[] = [];
  const add = (label: string, amount: number, note = '') => lines.push({ label, note, amount: round2(amount) });
  let sheets = 0;
  if (job.product === 'brochure') {
    const base = Math.ceil(qty / PRINT_UPS[job.size]);
    const total = Math.ceil(base * (1 + f.waste / 100));
    const rate = job.sides === 2 ? paper.two : paper.one;
    sheets = total;
    add('A3 printing', total * rate, `${total} sheets × ${rate} (${base} + ${total - base} waste)`);
    if (job.lam) add('Lamination', total * f.lam, `${total} sheets`);
    add('Design/layout', f.designBr, 'per job');
  } else if (job.booklet === 'A5') {
    // An A5 booklet is folded A4 sheets, and the printer's rate is per A3 sheet: two A4 sheets are cut from each (an odd number leaves half an A3 sheet unused)
    const n = Math.max(1, Math.round(job.pages / 4)); // A4 sheets in a booklet
    const insideA4 = (job.coverSep ? n - 1 : n) * qty;
    const coverA4 = job.coverSep ? qty : 0;
    const a3Inside = Math.ceil(insideA4 / 2);
    const a3Cover = Math.ceil(coverA4 / 2);
    sheets = a3Inside + a3Cover;
    if (insideA4 > 0) add('Inside sheets', a3Inside * paper.two, `${insideA4} A4 sheets = ${a3Inside} A3 × ${paper.two}`);
    if (job.coverSep) {
      const cover = s.papers[job.cover] ?? paper;
      add('Cover sheet', a3Cover * cover.two, `${cover.name}: ${coverA4} A4 covers = ${a3Cover} A3 × ${cover.two}`);
    }
    if (job.lam) add('Cover lamination', f.lam * Math.ceil(qty / 2), `${qty} A4 covers = ${Math.ceil(qty / 2)} A3 sheets`);
    if (f.cut > 0) add('Cutting A3 into A4', f.cut * sheets, `${sheets} A3 sheets`);
    if (n > 1) add('Stapling', f.staple * qty, `${qty} sets`);
    add('Trimming', f.trim * qty, `${qty} sets`);
    if (job.fold) add('Folding / creasing', f.fold * qty, `${qty} sets`);
    add('Design/layout', job.product === 'eulogy' ? f.designEu : f.designPr, 'per job');
  } else {
    const n = Math.max(1, Math.round(job.pages / 4));
    sheets = n * qty;
    // a separate cover takes the place of one inside sheet: the number of sheets in the booklet does not change
    const inside = job.coverSep ? n - 1 : n;
    if (inside > 0) add('Inside sheets', inside * paper.two * qty, `${inside} × ${paper.two} × ${qty} copies`);
    if (job.coverSep) {
      const cover = s.papers[job.cover] ?? paper;
      add('Cover sheet', cover.two * qty, `${cover.name} × ${qty}`);
    }
    if (job.lam) add('Cover lamination', f.lam * qty, `${qty} covers`);
    if (n > 1) add('Stapling', f.staple * qty, `${qty} sets`);
    add('Trimming', f.trim * qty, `${qty} sets`);
    if (job.fold) add('Folding / creasing', f.fold * qty, `${qty} sets`);
    add('Design/layout', job.product === 'eulogy' ? f.designEu : f.designPr, 'per job');
  }
  add('Proofing', f.proof, 'per job');
  add('Delivery', f.deliver, 'per job');
  const cost = round2(lines.reduce((a, l) => a + l.amount, 0));
  const markupPct = printMarkupPct(s.tiers, qty, job.mode);
  const markup = round2((cost * markupPct) / 100);
  const priceExVat = round2(cost + markup);
  const vat = round2(priceExVat * VAT_RATE);
  const total = round2(priceExVat + vat);
  return { qty, lines, sheets, cost, markupPct, markup, priceExVat, vat, total, unitExVat: priceExVat / qty, unitTotal: total / qty, profit: markup };
}

/** The job in words, for a quote: "Eulogy, 8 pages / 130gsm gloss, stapled and trimmed". */
export function printSpec(job: PrintJob, s: PrintSettings): string {
  const paper = s.papers[job.paper] ?? s.papers[0]!;
  if (job.product === 'brochure') return `Brochure, ${job.size} ${job.sides === 2 ? 'double' : 'single'} side / ${paper.name}${job.lam ? ', laminated' : ''}`;
  const n = Math.max(1, Math.round(job.pages / 4));
  const cover = job.coverSep ? ` with a ${(s.papers[job.cover] ?? paper).name} cover${job.lam ? ', laminated' : ''}` : job.lam ? ', laminated cover' : '';
  const finish = [n > 1 ? 'stapled' : null, 'trimmed', job.fold ? 'folded' : null].filter(Boolean);
  return `${PRINT_PRODUCT_LABEL[job.product]}${job.booklet === 'A5' ? ' (A5 booklet)' : ''}, ${job.pages} pages / ${paper.name}${cover}, ${finish.slice(0, -1).length ? finish.slice(0, -1).join(', ') + ' and ' + finish[finish.length - 1] : finish[0]}`;
}
