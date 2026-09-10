// Kenyan statutory tax/deduction constants and calculations, ported from
// Olerai Hotel System's packages/shared/src/tax.ts for consistency across
// both businesses' compliance numbers.

export const VAT_RATE = 0.16; // standard VAT rate, treated as inclusive in GLM's sale prices

export const NSSF_RATE = 0.12; // 6% employee + 6% employer, combined
export const SHIF_RATE = 0.0275; // Social Health Insurance, of gross pay (min Ksh 300)
export const HOUSING_LEVY_RATE = 0.03; // 1.5% employee + 1.5% employer, combined
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

export function nssfContribution(grossPay: number): number {
  return grossPay * NSSF_RATE;
}

export function shifContribution(grossPay: number): number {
  return Math.max(grossPay * SHIF_RATE, 300);
}

export function housingLevy(grossPay: number): number {
  return grossPay * HOUSING_LEVY_RATE;
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
  paye: number;
  nssf: number;
  shif: number;
  housingLevy: number;
  totalDeductions: number;
  netPay: number;
}

/** Full statutory computation for a pay-run's gross pay. Casuals are not subject to statutory deductions. */
export function computePay(grossPay: number, employeeType: 'Employee' | 'Casual'): PayComputation {
  if (employeeType === 'Casual') {
    return { grossPay, paye: 0, nssf: 0, shif: 0, housingLevy: 0, totalDeductions: 0, netPay: grossPay };
  }
  const paye = payeNet(grossPay);
  const nssf = nssfContribution(grossPay);
  const shif = shifContribution(grossPay);
  const housing = housingLevy(grossPay);
  const totalDeductions = paye + nssf + shif + housing;
  return { grossPay, paye, nssf, shif, housingLevy: housing, totalDeductions, netPay: grossPay - totalDeductions };
}
