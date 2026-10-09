import { prisma } from './db';
import { ACCT, round2, todayStr } from '@glm/shared';
import { buildProfitLoss } from './accounting/reports';

// Income tax, worked out from the books under the Kenyan Income Tax Act (as KRA applies it). Two ways a business can be taxed — the Admin chooses in Compliance → Corporation tax:
//
//   Corporation tax (a resident company): 30% of TAXABLE profit. Taxable profit is the profit in the books, plus what the Act does not let a business deduct (depreciation, which is
//   replaced by capital allowances; entertainment; fines and penalties; donations; anything else added by hand), less the capital allowances claimed and any tax losses brought forward.
//   It is paid in four instalments on the 20th of the 4th, 6th, 9th and 12th months of the accounting year (each a quarter of the estimated tax for the year — the lower of this year's
//   estimate and 110% of last year's tax — less tax already deducted at source), and the balance by the last day of the 4th month after the year ends. Tax losses are carried forward for 5 years.
//
//   Turnover tax (a small business with turnover of KES 1M–25M that has not opted out): 3% of gross sales, paid by the 20th of the following month.
//
// This is a computation and a payment schedule. It is kept apart from the ledger: the books show the profit before income tax.

export interface TaxConfig {
  regime: 'corporation' | 'turnover';
  corporationRate: number;
  turnoverRate: number;
  yearEndMonth: number;
}

export const TURNOVER_TAX_MIN = 1_000_000;
export const TURNOVER_TAX_MAX = 25_000_000;
/** Expenses the Income Tax Act does not allow, found in the books by name (depreciation is handled by its account). */
export const NOT_DEDUCTIBLE = /entertain|\bfines?\b|penalt|donation/i;

export async function loadTaxConfig(): Promise<TaxConfig> {
  const r = await prisma.taxSettings.findUnique({ where: { id: 1 } });
  return {
    regime: r?.regime === 'turnover' ? 'turnover' : 'corporation',
    corporationRate: r?.corporationRate ?? 30,
    turnoverRate: r?.turnoverRate ?? 3,
    yearEndMonth: r && r.yearEndMonth >= 1 && r.yearEndMonth <= 12 ? r.yearEndMonth : 12,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1–12

/** The accounting year that ENDS in `year`: from the first day after the previous year-end to the last day of the year-end month. */
export function yearPeriod(year: number, yearEndMonth: number) {
  const startMonth = (yearEndMonth % 12) + 1;
  const startYear = yearEndMonth === 12 ? year : year - 1;
  return { start: `${startYear}-${pad(startMonth)}-01`, end: `${year}-${pad(yearEndMonth)}-${lastDay(year, yearEndMonth)}`, startYear, startMonth };
}

export interface TaxItem {
  key: string;
  label: string;
  dueDate: string;
  amount: number;
  paid: number;
  outstanding: number;
}

export interface TurnoverMonth {
  month: string;
  turnover: number;
  tax: number;
  dueDate: string;
  paid: number;
  outstanding: number;
}

export async function computeYear(year: number, cfg: TaxConfig, withPrior = true) {
  const per = yearPeriod(year, cfg.yearEndMonth);
  const [pl, adj, payments] = await Promise.all([
    buildProfitLoss(per.start, per.end),
    prisma.taxYear.findUnique({ where: { year } }),
    prisma.taxPayment.findMany({ where: { taxYear: year }, orderBy: [{ date: 'asc' }, { id: 'asc' }] }),
  ]);
  const rate = cfg.corporationRate;
  const paidFor = (period: string) => round2(payments.filter((p) => p.period === period).reduce((a, p) => a + p.amount, 0));

  // ── Corporation tax: from the profit in the books to the tax
  const profit = pl.netProfit;
  const autoAddBacks = pl.expenses.rows
    .filter((r) => r.amount > 0.004 && (r.code === ACCT.depreciation || NOT_DEDUCTIBLE.test(r.name)))
    .map((r) => ({ label: r.code === ACCT.depreciation ? `${r.name} (replaced by capital allowances)` : `Not deductible: ${r.name}`, amount: round2(r.amount) }));
  const manualAddBacks = adj?.addBacks ?? 0;
  const adjusted = round2(profit + autoAddBacks.reduce((a, b) => a + b.amount, 0) + manualAddBacks);
  const capitalAllowances = adj?.capitalAllowances ?? 0;
  const beforeLosses = round2(adjusted - capitalAllowances);
  const taxLoss = beforeLosses < 0 ? round2(-beforeLosses) : 0; // a loss for the year: carried forward for 5 years, no tax
  const lossesUsed = beforeLosses > 0 ? round2(Math.min(adj?.lossesUsed ?? 0, beforeLosses)) : 0;
  const taxable = round2(Math.max(0, beforeLosses - lossesUsed));
  const tax = round2((taxable * rate) / 100);
  const credits = adj?.whtCredits ?? 0;
  const taxAfterCredits = round2(Math.max(0, tax - credits));

  // ── The estimate the instalments are based on
  const today = todayStr();
  let currentEstimate = tax;
  if (today >= per.start && today < per.end) {
    const elapsed = (Number(today.slice(0, 4)) - per.startYear) * 12 + (Number(today.slice(5, 7)) - per.startMonth) + 1;
    currentEstimate = round2((tax * 12) / Math.max(1, elapsed)); // the year so far, spread over the whole year
  }
  const priorTax = withPrior ? await taxOfYear(year - 1, cfg) : 0;
  const suggestedEstimate = priorTax > 0 ? round2(Math.min(currentEstimate, priorTax * 1.1)) : currentEstimate;
  const estimate = adj?.estimateTax ?? suggestedEstimate;

  // ── The instalments and the balance
  const each = round2(Math.max(0, estimate - credits) / 4);
  const items: TaxItem[] = [4, 6, 9, 12].map((k, i) => {
    const m0 = per.startMonth + k - 1;
    const y = per.startYear + Math.floor((m0 - 1) / 12);
    const m = ((m0 - 1) % 12) + 1;
    const paid = paidFor(`I${i + 1}`);
    return { key: `I${i + 1}`, label: `Instalment ${i + 1} (month ${k})`, dueDate: `${y}-${pad(m)}-20`, amount: each, paid, outstanding: round2(Math.max(0, each - paid)) };
  });
  // the balance assumes every scheduled instalment is paid (one paid above its schedule reduces it), so what is owed adds up without counting an instalment twice
  const scheduled = items.reduce((a, i) => a + Math.max(i.amount, i.paid), 0);
  const finalAmount = round2(Math.max(0, taxAfterCredits - scheduled));
  const finalPaid = paidFor('FINAL');
  const fm0 = cfg.yearEndMonth + 4;
  const fy = year + Math.floor((fm0 - 1) / 12);
  const fm = ((fm0 - 1) % 12) + 1;
  items.push({ key: 'FINAL', label: 'Balance of the tax', dueDate: `${fy}-${pad(fm)}-${lastDay(fy, fm)}`, amount: finalAmount, paid: finalPaid, outstanding: round2(Math.max(0, finalAmount - finalPaid)) });
  const totalPaid = round2(payments.filter((p) => !/^\d{4}-\d{2}$/.test(p.period)).reduce((a, p) => a + p.amount, 0));

  // ── Turnover tax: each month's gross sales (VAT out)
  const turnoverRows: TurnoverMonth[] = pl.months.map((month, i) => {
    const turnover = pl.income.byMonth[i] ?? 0;
    const t = round2((turnover * cfg.turnoverRate) / 100);
    const m = Number(month.slice(5, 7));
    const y = Number(month.slice(0, 4)) + (m === 12 ? 1 : 0);
    const nm = (m % 12) + 1;
    const paid = paidFor(month);
    return { month, turnover: round2(turnover), tax: t, dueDate: `${y}-${pad(nm)}-20`, paid, outstanding: round2(Math.max(0, t - paid)) };
  });
  const annualTurnover = round2(pl.income.total);

  return {
    year,
    period: { start: per.start, end: per.end },
    regime: cfg.regime,
    rate,
    profit,
    autoAddBacks,
    manualAddBacks,
    adjusted,
    capitalAllowances,
    taxLoss,
    lossesUsed,
    taxable,
    tax,
    credits,
    taxAfterCredits,
    estimate: round2(estimate),
    suggestedEstimate,
    estimateIsManual: adj?.estimateTax != null,
    priorTax,
    items,
    totalPaid,
    overpaid: round2(Math.max(0, totalPaid - taxAfterCredits)),
    outstanding: round2(items.reduce((a, i) => a + i.outstanding, 0)),
    turnover: { rate: cfg.turnoverRate, annual: annualTurnover, eligible: annualTurnover >= TURNOVER_TAX_MIN && annualTurnover <= TURNOVER_TAX_MAX, months: turnoverRows, tax: round2(turnoverRows.reduce((a, r) => a + r.tax, 0)), outstanding: round2(turnoverRows.reduce((a, r) => a + r.outstanding, 0)) },
    adjustments: { addBacks: adj?.addBacks ?? 0, capitalAllowances, lossesUsed: adj?.lossesUsed ?? 0, whtCredits: credits, estimateTax: adj?.estimateTax ?? null, note: adj?.note ?? '' },
    payments: payments.map((p) => ({ id: p.id, period: p.period, date: p.date, amount: p.amount, reference: p.reference, note: p.note, capturedByName: p.capturedByName })),
  };
}

/**
 * What income tax is still to be paid, placed against the month it is paid FOR in Compliance → Payments due (a row's own month; the payment itself falls in the following month):
 * an instalment due on the 20th of a month sits in the row for the month before; turnover tax for a month sits in that month's row.
 */
export async function incomeTaxByMonth(months: string[], cfg: TaxConfig): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (months.length === 0) return out;
  const wanted = new Set(months);
  const add = (month: string, amount: number) => {
    if (wanted.has(month) && amount > 0.004) out.set(month, round2((out.get(month) ?? 0) + amount));
  };
  const first = Number(months[0]!.slice(0, 4)) - 1;
  const last = Number(months[months.length - 1]!.slice(0, 4)) + 1;
  for (let year = first; year <= last; year++) {
    const c = await computeYear(year, cfg);
    if (cfg.regime === 'turnover') {
      for (const r of c.turnover.months) add(r.month, r.outstanding);
    } else {
      for (const it of c.items) {
        let y = Number(it.dueDate.slice(0, 4));
        let m = Number(it.dueDate.slice(5, 7)) - 1;
        if (m === 0) {
          m = 12;
          y -= 1;
        }
        add(`${y}-${pad(m)}`, it.outstanding);
      }
    }
  }
  return out;
}

/** Just the tax for a year (the base for the next year's instalment estimate). */
async function taxOfYear(year: number, cfg: TaxConfig): Promise<number> {
  return (await computeYear(year, cfg, false)).tax;
}
