// Chart of accounts and accounting constants shared by the API ledger and the web screens.
// Ported from the Olerai Hotel System's accounting module and adapted to a print / branding shop.

export type AccountType = 'Asset' | 'Liability' | 'Equity' | 'Income' | 'Expense';
export const ACCOUNT_TYPES: AccountType[] = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];

/** Assets and expenses grow with debits; everything else grows with credits. */
export function isDebitNormal(type: string): boolean {
  return type === 'Asset' || type === 'Expense';
}

/** Payment method that draws on the petty-cash float. Wages must use it; expenses may. */
export const PETTY_CASH_METHOD = 'Petty Cash';
/** What a customer can pay an order with. */
export const RECEIPT_METHODS = ['Cash', 'M-Pesa', 'Bank Transfer', 'Card'] as const;
/** What an expense can be paid with — the receipt methods plus the petty-cash float. */
export const EXPENSE_METHODS = [PETTY_CASH_METHOD, 'Cash', 'M-Pesa', 'Bank Transfer', 'Card'] as const;
/** What a supplier can be paid with, or a customer refunded with. */
export const PAYOUT_METHODS = ['Cash', 'M-Pesa', 'Bank Transfer', 'Card', PETTY_CASH_METHOD] as const;

/** Built-in accounts the ledger posts to. Codes are stable; names can be edited. */
export const ACCT = {
  pettyCash: '1010',
  cash: '1020',
  mpesa: '1030',
  card: '1040',
  bank: '1050',
  receivables: '1100',
  inventory: '1200',
  fixedAssets: '1500',
  accumDepreciation: '1590',
  payables: '2010',
  vatPayable: '2100',
  payePayable: '2200',
  nssfPayable: '2210',
  shifPayable: '2220',
  housingLevyPayable: '2230',
  customerCredits: '2300',
  unallocatedMpesa: '2310',
  loans: '2400',
  capital: '3010',
  drawings: '3020',
  retainedEarnings: '3030',
  printingIncome: '4010',
  merchandiseIncome: '4020',
  dtfIncome: '4030',
  embroideryIncome: '4040',
  otherIncome: '4100',
  salesReturns: '4900',
  salaries: '5010',
  depreciation: '6800',
  uncategorised: '6999',
} as const;

export interface ChartAccountDef {
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  description?: string;
}

const a = (code: string, name: string, type: AccountType, subtype = '', description = ''): ChartAccountDef => ({ code, name, type, subtype, description });

export const DEFAULT_CHART: ChartAccountDef[] = [
  // Assets
  a('1010', 'Petty Cash', 'Asset', 'PettyCash', 'The petty-cash float. Pays all wages and small expenses; topped up only by a bank withdrawal, a cash-sales allocation or an owner injection.'),
  a('1020', 'Cash on Hand (Tills)', 'Asset', 'Cash', 'Cash collected from customers, before it is banked.'),
  a('1030', 'M-Pesa', 'Asset', 'Mobile', 'M-Pesa receipts and payments.'),
  a('1040', 'Card Settlements', 'Asset', 'Card', 'Card payments awaiting settlement by the bank.'),
  a('1050', 'Bank Account', 'Asset', 'Bank', 'The business bank account.'),
  a('1100', 'Accounts Receivable', 'Asset', 'Receivable', 'What customers and corporate clients still owe on invoices.'),
  a('1200', 'Stock & Inventory', 'Asset', 'Inventory', 'Stock held in stores (opening balance and manual adjustments).'),
  a('1500', 'Machinery, Equipment & Vehicles (Cost)', 'Asset', 'FixedAsset', 'Cost of fixed assets from the Asset Register.'),
  a('1590', 'Accumulated Depreciation', 'Asset', 'FixedAsset', 'Contra-asset: the depreciation charged to date on the Asset Register.'),
  // Liabilities
  a('2010', 'Accounts Payable', 'Liability', 'Payable', 'Suppliers owed.'),
  a('2100', 'VAT Payable', 'Liability', 'Tax', 'Output VAT collected on sales, owed to KRA.'),
  a('2200', 'PAYE Payable', 'Liability', 'Tax', 'PAYE withheld from employees.'),
  a('2210', 'NSSF Payable', 'Liability', 'Tax'),
  a('2220', 'SHIF Payable', 'Liability', 'Tax'),
  a('2230', 'Housing Levy Payable', 'Liability', 'Tax'),
  a('2300', 'Customer Deposits & Credits', 'Liability', 'Deposit', 'Money received before an order is invoiced, or owed back to a customer after a credit note.'),
  a('2310', 'Unallocated M-Pesa Receipts', 'Liability', 'Suspense', 'M-Pesa money received that has not yet been matched to an order.'),
  a('2400', 'Loans Payable', 'Liability', 'Loan'),
  // Equity
  a('3010', "Owner's Capital", 'Equity', 'Capital', 'Money the owner has put into the business.'),
  a('3020', "Owner's Drawings", 'Equity', 'Drawings', 'Money the owner has taken out of the business.'),
  a('3030', 'Retained Earnings', 'Equity', 'RetainedEarnings', 'Profit kept from earlier periods (opening balance).'),
  // Income
  a('4010', 'Printing & Branding Services Income', 'Income', '', 'Default account for services with no account of their own.'),
  a('4020', 'Merchandise & Materials Sales', 'Income', '', 'Caps, shirts, canvas and other materials sold.'),
  a('4030', 'DTF Film & Printing Income', 'Income'),
  a('4040', 'Embroidery Income', 'Income'),
  a('4100', 'Other Income', 'Income'),
  a('4900', 'Sales Returns & Credit Notes', 'Income', '', 'Credit notes issued to customers (a debit balance that reduces income).'),
  // Expenses
  a('5010', 'Salaries & Wages', 'Expense', 'Payroll'),
  a('5100', 'Printing Materials & Consumables', 'Expense'),
  a('5110', 'Casual Labour', 'Expense', 'Payroll'),
  a('5120', 'Transport', 'Expense'),
  a('5130', 'Utilities', 'Expense'),
  a('5140', 'Equipment Maintenance', 'Expense'),
  a('5150', 'Office Supplies', 'Expense'),
  a('5160', 'Courier & Delivery', 'Expense'),
  a('5170', 'Refreshments', 'Expense'),
  a('5180', 'Airtime & Data', 'Expense'),
  a('5190', 'Cleaning', 'Expense'),
  a('5200', 'Bank Charges', 'Expense'),
  a('6800', 'Depreciation', 'Expense', '', 'Charged automatically each month from the Asset Register.'),
  a('6900', 'Miscellaneous Expenses', 'Expense'),
  a('6999', 'Uncategorised Expenses', 'Expense', '', 'Catch-all for an expense head that has no account yet.'),
];

/** Codes of accounts the ledger itself posts to — these can be renamed but not deleted or retyped. */
export const SYSTEM_ACCOUNT_CODES: string[] = [...Object.values(ACCT)];

/** Where the standard expense heads (the old EXPENSE_CATEGORIES) land. Heads added later get an account of their own. */
export const EXPENSE_HEAD_ACCOUNT_CODES: Record<string, string> = {
  'Printing Materials & Consumables': '5100',
  'Casual Labour': '5110',
  Transport: '5120',
  Utilities: '5130',
  'Equipment Maintenance': '5140',
  'Office Supplies': '5150',
  'Courier/Delivery': '5160',
  Refreshments: '5170',
  'Airtime/Data': '5180',
  Cleaning: '5190',
  'Bank Charges': '5200',
  Miscellaneous: '6900',
};

/** The default Income account for a service, picked by its name until someone links it explicitly. */
export function defaultServiceIncomeCode(serviceName: string): string {
  const n = serviceName.toLowerCase();
  if (n.includes('dtf')) return ACCT.dtfIncome;
  if (n.includes('embroid')) return ACCT.embroideryIncome;
  return ACCT.printingIncome;
}

/** Which cash-and-bank account a payment method settles into. Anything unrecognised counts as cash. */
export function methodAccountCode(method: string | null | undefined): string {
  switch ((method || '').trim().toLowerCase()) {
    case 'm-pesa':
    case 'mpesa':
      return ACCT.mpesa;
    case 'card':
      return ACCT.card;
    case 'bank transfer':
    case 'bank':
    case 'bank/cheque':
    case 'cheque':
      return ACCT.bank;
    case 'petty cash':
      return ACCT.pettyCash;
    default:
      return ACCT.cash;
  }
}

/** The cash accounts — what the cash-flow statement tracks. */
export const CASH_ACCOUNT_CODES: string[] = [ACCT.pettyCash, ACCT.cash, ACCT.mpesa, ACCT.card, ACCT.bank];

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Depreciation ─────────────────────────────────────────────────────────

export const DEPRECIATION_METHODS = ['None', 'Straight-line', 'Reducing balance'] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

/** Suggested useful lives (years) by asset category, used to pre-fill the Asset Register form. */
export const DEFAULT_USEFUL_LIFE_YEARS: Record<string, number> = {
  'Printing Equipment': 8,
  'Embroidery Machines': 8,
  'Heat Press & Curing': 6,
  'Computers & IT Equipment': 4,
  'Furniture & Fixtures': 8,
  Vehicles: 5,
  'Office Equipment': 5,
  Other: 5,
};

export interface DepreciableAsset {
  cost: number;
  salvage: number;
  method: string;
  lifeYears: number | null;
  ratePct: number | null;
}

/** 'YYYY-MM' of a 'YYYY-MM-DD' date. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** The month after `period` ('YYYY-MM' -> 'YYYY-MM'). */
export function nextMonth(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, '0')}`;
}

/** Last day of a 'YYYY-MM' month, as 'YYYY-MM-DD'. */
export function monthEnd(period: string): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m!, 0));
  return d.toISOString().slice(0, 10);
}

/** Every 'YYYY-MM' from `from` to `to` inclusive (empty if from > to). */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let p = from; p <= to; p = nextMonth(p)) out.push(p);
  return out;
}

/**
 * One month's depreciation charge.
 *  - Straight-line: (cost − salvage) ÷ (life × 12), never taking the book value below salvage.
 *  - Reducing balance: opening book value × (rate ÷ 12), never below salvage.
 * `accumulated` is what has been charged so far (before this month).
 */
export function monthlyDepreciation(asset: DepreciableAsset, accumulated: number): number {
  const cost = Math.max(0, asset.cost);
  const salvage = Math.min(Math.max(0, asset.salvage), cost);
  const bookValue = cost - accumulated;
  const room = bookValue - salvage;
  if (!(room > 0.004)) return 0;
  let charge = 0;
  if (asset.method === 'Straight-line' && asset.lifeYears && asset.lifeYears > 0) {
    charge = (cost - salvage) / (asset.lifeYears * 12);
  } else if (asset.method === 'Reducing balance' && asset.ratePct && asset.ratePct > 0) {
    charge = bookValue * (asset.ratePct / 100 / 12);
  } else {
    return 0;
  }
  return round2(Math.min(charge, room));
}

/**
 * Depreciation starts the month AFTER purchase (a month's use is not charged for the month the asset was bought)
 * and runs while the asset is in service. Returns the months still to charge, given those already charged.
 */
export function depreciationMonthsDue(purchaseDate: string, throughMonth: string, charged: Set<string>, retiredOn?: string | null): string[] {
  const first = nextMonth(monthOf(purchaseDate));
  const last = retiredOn && monthOf(retiredOn) < throughMonth ? monthOf(retiredOn) : throughMonth;
  return monthsBetween(first, last).filter((p) => !charged.has(p));
}

// ── M-Pesa matching ──────────────────────────────────────────────────────

/** Last nine digits — the same normalisation for any way a Kenyan number is written. */
export function phoneKey(phone: unknown): string {
  return String(phone ?? '').replace(/\D/g, '').slice(-9);
}

export interface OpenTarget {
  orderId: number;
  ref: string; // the order number, e.g. W-1004
  phone: string;
  party: string;
  balance: number;
  createdDate: string;
}

export interface IncomingPayment {
  amount: number;
  phone: string;
  /** What the payer typed as the account (Paybill) or we told them to expect (STK), plus any statement "Details" text. */
  accountReference?: string | null;
}

export type MatchResult = { matched: true; target: OpenTarget; reason: 'reference' | 'phone-and-amount' } | { matched: false; reason: string };

const TOLERANCE = 1; // M-Pesa amounts are whole shillings; a shilling either way is rounding

const fits = (p: IncomingPayment, t: OpenTarget) => p.amount <= t.balance + TOLERANCE;

/** An order number found in free text ("Payment for W-1004 thanks"), upper-cased. */
export function orderRefIn(text: string | null | undefined, targets: OpenTarget[]): OpenTarget | undefined {
  const hay = (text || '').toUpperCase();
  if (!hay) return undefined;
  return targets.find((t) => new RegExp(`(^|[^A-Z0-9])${t.ref.toUpperCase().replace(/[-]/g, '[- ]?')}([^A-Z0-9]|$)`).test(hay));
}

/**
 * Decides which open order an M-Pesa payment settles. The order number in the payer's reference/details is the
 * strongest signal. Failing that, a phone number with exactly one open order that the amount fits is accepted; two
 * candidates is treated as no match — guessing wrong would credit the wrong customer.
 */
export function matchPayment(payment: IncomingPayment, targets: OpenTarget[]): MatchResult {
  const byRef = orderRefIn(payment.accountReference, targets);
  if (byRef) {
    if (fits(payment, byRef)) return { matched: true, target: byRef, reason: 'reference' };
    return { matched: false, reason: `${byRef.ref} only owes KES ${Math.round(byRef.balance)}, less than the KES ${Math.round(payment.amount)} paid` };
  }
  const key = phoneKey(payment.phone);
  if (key.length >= 7) {
    const candidates = targets.filter((t) => phoneKey(t.phone) === key && fits(payment, t));
    const exact = candidates.filter((t) => Math.abs(t.balance - payment.amount) <= TOLERANCE);
    const pick = exact.length ? exact : candidates;
    if (pick.length === 1) return { matched: true, target: pick[0]!, reason: 'phone-and-amount' };
    if (pick.length > 1) return { matched: false, reason: `More than one open order for this number could take KES ${Math.round(payment.amount)} — choose which one` };
  }
  return { matched: false, reason: 'No open order matches this payment' };
}

/** For the matching screen: plausible open orders for an unmatched payment, best guess first. */
export function suggestionsFor(payment: IncomingPayment, targets: OpenTarget[]): OpenTarget[] {
  const key = phoneKey(payment.phone);
  const score = (t: OpenTarget) => (orderRefIn(payment.accountReference, [t]) ? 4 : 0) + (key && phoneKey(t.phone) === key ? 2 : 0) + (Math.abs(t.balance - payment.amount) <= TOLERANCE ? 1 : 0);
  return [...targets]
    .filter((t) => score(t) > 0 || fits(payment, t))
    .sort((x, y) => score(y) - score(x) || (x.createdDate < y.createdDate ? -1 : 1))
    .slice(0, 8);
}

// ── Credit / debit notes ─────────────────────────────────────────────────

export const NOTE_TYPES = ['Credit', 'Debit', 'SupplierDebit'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** A gross (VAT-inclusive) amount split so the parts add back to exactly what the customer sees. */
export function splitGross(gross: number, vatRate: number): { net: number; vat: number; total: number } {
  const total = round2(gross);
  const vat = round2(total - total / (1 + vatRate));
  return { net: round2(total - vat), vat, total };
}
