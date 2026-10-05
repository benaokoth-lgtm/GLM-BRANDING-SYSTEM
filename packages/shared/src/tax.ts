// Kenyan statutory tax/deduction constants and calculations, ported from
// Olerai Hotel System's packages/shared/src/tax.ts for consistency across
// both businesses' compliance numbers.

export const VAT_RATE = 0.16; // standard VAT rate, treated as inclusive in GLM's sale prices

/**
 * Does spending on this expense head normally carry 16% VAT that can be claimed back (input VAT)? The standing answer, by head name, until an
 * Admin sets it for a head (Compliance → VAT). Wages, bank charges, refreshments/entertainment (not claimable), staff commission and anything
 * unrecognised are no; materials, stock, transport, utilities, repairs, supplies, courier, airtime/data, cleaning and outsourced services
 * (the supplier's bill carries VAT, claimed back) are yes.
 */
export function defaultExpenseVatApplicable(head: string): boolean {
  const h = head.trim().toLowerCase();
  if (/labou?r|wage|salar|payroll|commission|bank|refreshment|entertain|tea\b|lunch|miscellaneous|tax|licen[cs]e|insurance|interest|depreciation/.test(h)) return false;
  return /material|consumable|stock|transport|fuel|utilit|electric|maintenance|repair|office|stationer|courier|delivery|airtime|data|internet|cleaning|outsourc|rent|advert|marketing|professional|software|equipment|packag/.test(h);
}

// Statutory payroll rates (Kenya). Each of NSSF and the Affordable Housing Levy is paid in equal parts by the employee (taken from their pay) and
// the employer (an extra cost to the business); SHIF is the employee's alone. NSSF, SHIF and the employee's housing levy are all deducted from
// pay BEFORE PAYE is worked out (see computePay). Check these against the current NSSF / KRA / SHA notices — they are the only place to change.
export const NSSF_RATE = 0.06; // employee's share of pensionable pay; the employer pays the same again (NSSF_EMPLOYER_RATE)
export const NSSF_EMPLOYER_RATE = 0.06;
export const SHIF_RATE = 0.0275; // Social Health Insurance Fund, of gross pay (min Ksh 300) — the employee's alone
export const SHIF_MIN = 300;
export const HOUSING_LEVY_RATE = 0.015; // Affordable Housing Levy: employee's share of gross pay; the employer pays the same again
export const HOUSING_LEVY_EMPLOYER_RATE = 0.015;

/**
 * NSSF's Upper Earnings Limit by the date of the pay (NSSF Act 2013, phased in each February): contributions are 6% of pay up to this limit, so
 * the most an employee pays is 6% of it. Dates before February 2023 are treated as the first year's limit.
 */
export const NSSF_UPPER_LIMITS: [from: string, limit: number][] = [
  ['2026-02-01', 108000],
  ['2025-02-01', 72000],
  ['2024-02-01', 36000],
  ['2023-02-01', 18000],
];
export function nssfUpperLimit(date?: string): number {
  if (!date) return NSSF_UPPER_LIMITS[0]![1];
  for (const [from, limit] of NSSF_UPPER_LIMITS) if (date >= from) return limit;
  return NSSF_UPPER_LIMITS[NSSF_UPPER_LIMITS.length - 1]![1];
}
export const PAYE_MONTHLY_RELIEF = 2400; // personal relief per employee per month

// Graduated monthly PAYE bands: [bandWidth, rate]. Cumulative, in ascending order.
// 0-24,000 @10%; next 8,333 @25%; next 467,667 @30%; next 300,000 @32.5%; remainder @35%.
export const PAYE_BANDS: [number, number][] = [
  [24000, 0.1],
  [8333, 0.25],
  [467667, 0.3],
  [300000, 0.325],
  [Infinity, 0.35],
];

/** Gross PAYE due on a monthly taxable pay amount, before personal relief. */
export function payeBand(monthlyPay: number): number {
  let tax = 0;
  let remaining = monthlyPay;
  for (const [width, rate] of PAYE_BANDS) {
    if (remaining <= 0) break;
    const x = Math.min(remaining, width);
    tax += x * rate;
    remaining -= x;
  }
  return tax;
}

/** Net PAYE payable after personal relief (never negative). */
export function payeNet(monthlyPay: number): number {
  return Math.max(0, payeBand(monthlyPay) - PAYE_MONTHLY_RELIEF);
}

/** The employee's NSSF contribution: 6% of pay up to the Upper Earnings Limit for the date. */
export function nssfContribution(grossPay: number, date?: string): number {
  return Math.min(Math.max(grossPay, 0), nssfUpperLimit(date)) * NSSF_RATE;
}

/** The employer's matching NSSF contribution (not taken from the employee). */
export function nssfEmployerContribution(grossPay: number, date?: string): number {
  return Math.min(Math.max(grossPay, 0), nssfUpperLimit(date)) * NSSF_EMPLOYER_RATE;
}

export function shifContribution(grossPay: number): number {
  return Math.max(grossPay * SHIF_RATE, SHIF_MIN);
}

/** The employee's Affordable Housing Levy: 1.5% of gross pay. */
export function housingLevy(grossPay: number): number {
  return grossPay * HOUSING_LEVY_RATE;
}

/** The employer's matching housing levy (not taken from the employee). */
export function housingLevyEmployer(grossPay: number): number {
  return grossPay * HOUSING_LEVY_EMPLOYER_RATE;
}

export function vatOnAmount(amount: number): number {
  return amount * VAT_RATE;
}

/** Splits a VAT-inclusive price into its net (ex-VAT) and VAT components. */
export function splitVatInclusive(inclusiveAmount: number): { net: number; vat: number } {
  const net = inclusiveAmount / (1 + VAT_RATE);
  return { net, vat: inclusiveAmount - net };
}

export interface PayComputation {
  grossPay: number;
  /** PAYE after personal relief. */
  paye: number;
  /** The employee's share, taken from their pay. */
  nssf: number;
  shif: number;
  /** The employee's share, taken from their pay. */
  housingLevy: number;
  /** Everything taken from the employee's pay: PAYE + NSSF + SHIF + housing levy. */
  totalDeductions: number;
  netPay: number;
  /** What PAYE is worked out on: gross pay less NSSF, SHIF and the housing levy. */
  taxablePay: number;
  /** Tax by the monthly bands, before relief. */
  taxCharged: number;
  /** The personal relief actually used (never more than the tax charged). */
  personalRelief: number;
  /** The employer's matching shares — a cost to the business, not taken from the employee. */
  nssfEmployer: number;
  housingLevyEmployer: number;
}

/**
 * Full statutory computation for a pay-run's gross pay (`date` is the pay date, for NSSF's limit). Casuals are not subject to statutory deductions.
 * For an employee: NSSF (6% up to the Upper Earnings Limit), SHIF (2.75%, min 300) and the housing levy (1.5%) are deducted first; PAYE is then
 * charged on what is left by the monthly bands, less the KES 2,400 personal relief. The employer matches NSSF and the housing levy on top.
 */
export function computePay(grossPay: number, employeeType: 'Employee' | 'Casual', date?: string): PayComputation {
  if (employeeType === 'Casual') {
    return { grossPay, paye: 0, nssf: 0, shif: 0, housingLevy: 0, totalDeductions: 0, netPay: grossPay, taxablePay: grossPay, taxCharged: 0, personalRelief: 0, nssfEmployer: 0, housingLevyEmployer: 0 };
  }
  const nssf = nssfContribution(grossPay, date);
  const shif = shifContribution(grossPay);
  const housing = housingLevy(grossPay);
  const taxablePay = Math.max(0, grossPay - nssf - shif - housing);
  const taxCharged = payeBand(taxablePay);
  const personalRelief = Math.min(PAYE_MONTHLY_RELIEF, taxCharged);
  const paye = taxCharged - personalRelief;
  const totalDeductions = paye + nssf + shif + housing;
  return {
    grossPay,
    paye,
    nssf,
    shif,
    housingLevy: housing,
    totalDeductions,
    netPay: grossPay - totalDeductions,
    taxablePay,
    taxCharged,
    personalRelief,
    nssfEmployer: nssfEmployerContribution(grossPay, date),
    housingLevyEmployer: housingLevyEmployer(grossPay),
  };
}
