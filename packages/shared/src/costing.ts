// Job costing — what an outsourced branding job costs us and what to quote for it. Three kinds of job: business cards, indoor signage and outdoor signage.
// The supplier rates (materials and services) live in Sales → Job Costing → Rates; this file is only the arithmetic, kept as pure functions so the server and the tests share it.
//
// Margin is a MARKUP on cost: price = cost × (1 + margin%). The price is before VAT; VAT (16%) is added on top for the total the customer pays.

import { VAT_RATE } from './tax';

export const COSTING_JOB_TYPES = ['cards', 'indoor', 'outdoor'] as const;
export type CostingJobType = (typeof COSTING_JOB_TYPES)[number];
export const isCostingJobType = (v: unknown): v is CostingJobType => (COSTING_JOB_TYPES as readonly string[]).includes(v as string);

/** How a rate is charged: per A3 sheet (cards), per sqm with the wastage added, per sqm, per unit (card or sign) or once per job. */
export type CostingBasis = 'sheet' | 'sqm_waste' | 'sqm' | 'unit' | 'job';
export const COSTING_BASIS_LABEL: Record<CostingBasis, string> = { sheet: 'per A3 sheet', sqm_waste: 'per sqm (+ wastage)', sqm: 'per sqm', unit: 'per unit', job: 'per job' };
const SIGN_BASES: CostingBasis[] = ['sqm_waste', 'sqm', 'unit', 'job'];
/** The ways a rate may be charged for each kind of job. */
export const COSTING_BASES_FOR: Record<CostingJobType, CostingBasis[]> = { cards: ['sheet', 'unit', 'job'], indoor: SIGN_BASES, outdoor: SIGN_BASES };
/** The ways a rate may be charged when it is used on several kinds of job: those every one of them allows. */
export function costingBasesFor(types: CostingJobType[]): CostingBasis[] {
  if (types.length === 0) return [];
  return COSTING_BASES_FOR[types[0]!].filter((b) => types.every((t) => COSTING_BASES_FOR[t].includes(b)));
}

export const COSTING_KINDS = ['material', 'service'] as const;
export type CostingKind = (typeof COSTING_KINDS)[number];

/** Business cards come plain, laminated or frosted. */
export type CardFinish = 'plain' | 'lam' | 'frost';
export const CARD_FINISH_LABEL: Record<CardFinish, string> = { plain: 'Plain', lam: 'Laminated', frost: 'Frosted' };

/** What a card job is called on a quote and on the order: "1000cards-laminated". How many A3 sheets it takes is our production detail, so it is not on the client's paper. */
export const cardsSummary = (qty: number, finish: CardFinish) => `${qty}cards-${CARD_FINISH_LABEL[finish].toLowerCase()}`;

/** A card job's summary as it was written before: "1000 cards · Laminated · 49 A3 sheets" → "1000cards-laminated". Anything else is returned as it is. */
export function tidyCostingSummary(summary: string): string {
  const m = /^(\d+) cards · (Plain|Laminated|Frosted) · \d+ A3 sheets$/.exec(summary.trim());
  return m ? `${m[1]}cards-${m[2]!.toLowerCase()}` : summary;
}

export const COSTING_JOB_LABEL: Record<CostingJobType, string> = { cards: 'Business cards', indoor: 'Indoor signage', outdoor: 'Outdoor signage' };
/** Quantities shown side by side for business cards. */
export const COSTING_CARD_TIERS = [100, 250, 500, 1000, 2000];

export interface CostingRateRow {
  id: number;
  kind: CostingKind;
  name: string;
  basis: CostingBasis;
  /** What the supplier charges us for one of the basis (VAT not included). */
  cost: number;
  /** The kinds of job it is costed on. */
  jobTypes: CostingJobType[];
  /** Business cards only: '' = every finish, 'lam' = only when laminated, 'frost' = only when frosted. */
  onlyFor: '' | 'lam' | 'frost';
  /** Ticked in a new costing; an unticked one is an optional extra the salesperson can add. */
  defaultOn: boolean;
  active: boolean;
  sortOrder: number;
}

export interface CostingJobTypeRow {
  key: CostingJobType;
  label: string;
  /** Markup on cost, %. */
  marginPct: number;
  /** The lowest margin a salesperson may agree with a client without a manager's approval (markup on cost, %). */
  floorMarginPct: number;
  /** Signage: material added for waste, %. */
  wastagePct: number;
  /** Cards: how many fit on an A3 sheet, and the spare sheets added to every job. */
  cardsPerSheet: number;
  spareSheets: number;
}

export interface CostingInput {
  jobType: CostingJobType;
  qty: number;
  widthM?: number;
  heightM?: number;
  finish?: CardFinish;
  /** Rates ticked by default that are switched off for this costing, and optional ones switched on. */
  off?: number[];
  on?: number[];
  /** Overrides the job type's margin (people who may see costs only). */
  marginPct?: number;
}

export interface CostingLine {
  rateId: number;
  kind: CostingKind;
  name: string;
  basis: CostingBasis;
  /** "25 A3 × 120", "2.20 sqm × 800", "per job". */
  note: string;
  amount: number;
}

export interface CostingQuote {
  jobType: CostingJobType;
  qty: number;
  /** Cards: A3 sheets used. Signage: the area of one sign (sqm). */
  sheets: number;
  area: number;
  summary: string;
  lines: CostingLine[];
  /** What it costs us. */
  cost: number;
  marginPct: number;
  /** What we charge, before VAT. */
  price: number;
  vat: number;
  /** What the customer pays, VAT included. */
  total: number;
  profit: number;
  /** Profit as a share of the price. */
  profitOnPricePct: number;
  /** Per card or per sign. */
  unitPrice: number;
  unitTotal: number;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The rates that apply to a kind of job (and, for cards, a finish), in the order they are listed. */
export function ratesFor(rates: CostingRateRow[], jobType: CostingJobType, finish: CardFinish = 'plain'): CostingRateRow[] {
  return rates
    .filter((r) => r.active && r.jobTypes.includes(jobType) && (jobType !== 'cards' || !r.onlyFor || r.onlyFor === finish))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

/** Whether a rate is part of this costing: ticked by default and not switched off, or optional and switched on. */
export function isTicked(r: CostingRateRow, input: Pick<CostingInput, 'on' | 'off'>): boolean {
  return (input.on ?? []).includes(r.id) || (r.defaultOn && !(input.off ?? []).includes(r.id));
}

/** The cost and price of one job. */
export function costingQuote(types: CostingJobTypeRow[], rates: CostingRateRow[], input: CostingInput): CostingQuote {
  const t = types.find((x) => x.key === input.jobType);
  if (!t) throw new Error(`Unknown kind of job: ${input.jobType}`);
  const cards = input.jobType === 'cards';
  const finish = input.finish ?? 'plain';
  const qty = Math.floor(num(input.qty));
  const area = cards ? 0 : num(input.widthM) * num(input.heightM);
  const sheets = cards && qty > 0 ? Math.ceil(qty / Math.max(1, t.cardsPerSheet)) + Math.max(0, t.spareSheets) : 0;
  const materialSqm = area * (1 + t.wastagePct / 100) * qty;
  const printSqm = area * qty;

  const lines: CostingLine[] = [];
  for (const r of ratesFor(rates, input.jobType, finish)) {
    if (!isTicked(r, input) || !(r.cost > 0)) continue;
    let quantity = 0;
    let note = '';
    if (r.basis === 'sheet') {
      quantity = sheets;
      note = `${sheets} A3 × ${r.cost}`;
    } else if (r.basis === 'sqm_waste') {
      quantity = materialSqm;
      note = `${materialSqm.toFixed(2)} sqm incl. wastage × ${r.cost}`;
    } else if (r.basis === 'sqm') {
      quantity = printSqm;
      note = `${printSqm.toFixed(2)} sqm × ${r.cost}`;
    } else if (r.basis === 'unit') {
      quantity = qty;
      note = `${qty} × ${r.cost}`;
    } else {
      quantity = 1;
      note = 'per job';
    }
    lines.push({ rateId: r.id, kind: r.kind, name: r.name, basis: r.basis, note, amount: r2(quantity * r.cost) });
  }

  const cost = r2(lines.reduce((a, l) => a + l.amount, 0));
  const marginPct = input.marginPct != null && Number.isFinite(input.marginPct) && input.marginPct >= 0 ? input.marginPct : t.marginPct;
  const price = r2(cost * (1 + marginPct / 100));
  const vat = r2(price * VAT_RATE);
  const total = r2(price + vat);
  const profit = r2(price - cost);
  const summary = cards ? cardsSummary(qty, finish) : `${num(input.widthM)} × ${num(input.heightM)} m · ${qty} unit(s) · ${(area * qty).toFixed(2)} sqm`;
  return {
    jobType: input.jobType,
    qty,
    sheets,
    area: r2(area),
    summary,
    lines,
    cost,
    marginPct,
    price,
    vat,
    total,
    profit,
    profitOnPricePct: price > 0 ? r2((profit / price) * 100) : 0,
    unitPrice: qty > 0 ? r2(price / qty) : 0,
    unitTotal: qty > 0 ? r2(total / qty) : 0,
  };
}

// ── A quote that is accepted: the price agreed with the client, and whether it is low enough to need a manager's approval.

/** The lowest price (before VAT, and with it) that may be agreed without approval: the cost plus the floor margin. */
export function costingFloor(cost: number, floorMarginPct: number): { price: number; total: number } {
  const price = r2(cost * (1 + Math.max(0, floorMarginPct) / 100));
  return { price, total: r2(price * (1 + VAT_RATE)) };
}

/** What a price agreed with the client (the total they pay, VAT included) comes to: the price before VAT, our margin on cost, and whether it needs approval or is below cost. */
export function costingAgreement(cost: number, totalInclVat: number, floorMarginPct: number) {
  const total = r2(Math.max(0, totalInclVat));
  const price = r2(total / (1 + VAT_RATE));
  const marginPct = cost > 0 ? r2(((price - cost) / cost) * 100) : 0;
  return { total, price, vat: r2(total - price), marginPct, belowCost: price < cost - 0.005, needsApproval: price < costingFloor(cost, floorMarginPct).price - 0.005 };
}

/** Business cards at 100, 250, 500, 1,000 and 2,000, the same finish and rates. */
export function costingCardTiers(types: CostingJobTypeRow[], rates: CostingRateRow[], input: CostingInput): { qty: number; sheets: number; cost: number; price: number; total: number; each: number; eachTotal: number }[] {
  return COSTING_CARD_TIERS.map((qty) => {
    const q = costingQuote(types, rates, { ...input, jobType: 'cards', qty });
    return { qty, sheets: q.sheets, cost: q.cost, price: q.price, total: q.total, each: q.unitPrice, eachTotal: q.unitTotal };
  });
}

// ── What a new database starts with: the sample rates from the costing design, to be replaced with the real supplier rates (Sales → Job Costing → Rates).

export const COSTING_DEFAULT_JOB_TYPES: CostingJobTypeRow[] = [
  { key: 'cards', label: COSTING_JOB_LABEL.cards, marginPct: 40, floorMarginPct: 30, wastagePct: 0, cardsPerSheet: 21, spareSheets: 1 },
  { key: 'indoor', label: COSTING_JOB_LABEL.indoor, marginPct: 45, floorMarginPct: 30, wastagePct: 10, cardsPerSheet: 21, spareSheets: 1 },
  { key: 'outdoor', label: COSTING_JOB_LABEL.outdoor, marginPct: 45, floorMarginPct: 30, wastagePct: 10, cardsPerSheet: 21, spareSheets: 1 },
];

type DefaultRate = Omit<CostingRateRow, 'id' | 'active' | 'sortOrder'>;
const rate = (kind: CostingKind, name: string, basis: CostingBasis, cost: number, jobTypes: CostingJobType[], extra: Partial<DefaultRate> = {}): DefaultRate => ({ kind, name, basis, cost, jobTypes, onlyFor: '', defaultOn: true, ...extra });

export const COSTING_DEFAULT_RATES: DefaultRate[] = [
  // business cards (per A3 sheet)
  rate('service', 'Printing on A3 art paper', 'sheet', 120, ['cards']),
  rate('material', 'Lamination film', 'sheet', 60, ['cards'], { onlyFor: 'lam' }),
  rate('material', 'Frosting film', 'sheet', 90, ['cards'], { onlyFor: 'frost' }),
  rate('service', 'Cutting', 'sheet', 40, ['cards']),
  rate('service', 'Delivery', 'job', 0, ['cards'], { defaultOn: false }),
  // signage
  rate('material', 'Substrate / vinyl / board (indoor)', 'sqm_waste', 800, ['indoor']),
  rate('material', 'Substrate / banner / ACP (outdoor)', 'sqm_waste', 900, ['outdoor']),
  rate('service', 'Printing (indoor)', 'sqm', 700, ['indoor']),
  rate('service', 'Printing (outdoor)', 'sqm', 800, ['outdoor']),
  rate('material', 'Laminate (indoor)', 'sqm', 250, ['indoor']),
  rate('material', 'UV laminate (outdoor)', 'sqm', 300, ['outdoor']),
  rate('service', 'Mounting / backing', 'sqm', 600, ['indoor']),
  rate('material', 'Frame / structure / mounting', 'sqm', 1800, ['outdoor']),
  rate('service', 'Finishing (cut, edge, hang kit)', 'unit', 200, ['indoor']),
  rate('service', 'Finishing (eyelets, hems, caps)', 'unit', 500, ['outdoor']),
  rate('service', 'Installation (indoor)', 'unit', 1000, ['indoor']),
  rate('service', 'Installation (outdoor)', 'unit', 3000, ['outdoor']),
  rate('service', 'Transport & permits', 'job', 2000, ['outdoor']),
  // every kind of job
  rate('service', 'Design & setup', 'job', 500, ['cards', 'indoor']),
  rate('service', 'Design & setup (outdoor)', 'job', 800, ['outdoor']),
];
