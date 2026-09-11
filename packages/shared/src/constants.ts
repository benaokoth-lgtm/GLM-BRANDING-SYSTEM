import type { OrderStage, Role } from './types';

export const STAGES: OrderStage[] = [
  'Order Received',
  'In Production',
  'Quality Check',
  'Ready for Pickup/Delivery',
  'Completed',
];

export const PAYMENT_METHODS = ['Cash', 'M-Pesa', 'Bank Transfer', 'Card'] as const;

export const ROLES = ['Staff', 'Supervisor', 'Finance Manager', 'General Manager', 'Admin'] as const satisfies readonly Role[];

// Who can access/capture P&L, Finance (VAT/NSSF/SHIF/Payroll/Expenses/Petty Cash) records.
export const FINANCE_ROLES: Role[] = ['Finance Manager', 'General Manager', 'Admin'];

// Everyone above Staff — order/payment oversight (All Orders, Payments) and
// Stock visibility. Stock requisitions can be raised by any of these, but
// approval is still finance-gated (FINANCE_ROLES only).
export const MANAGEMENT_ROLES: Role[] = ['Supervisor', 'Finance Manager', 'General Manager', 'Admin'];

export const ITEM_TYPE_LABELS: Record<string, string> = {
  material: 'Material',
  service: 'Service',
  'per-metre': 'Per-metre service',
};

// Matches GLM's own Petty Cash Tracker spreadsheet, plus Salaries & wages
// which sits outside petty cash. Used by the P&L expense ledger.
export const EXPENSE_CATEGORIES = [
  'Salaries & wages',
  'Printing Materials & Consumables',
  'Casual Labour',
  'Transport',
  'Utilities',
  'Equipment Maintenance',
  'Office Supplies',
  'Courier/Delivery',
  'Refreshments',
  'Miscellaneous',
  'Airtime/Data',
  'Cleaning',
  'Bank Charges',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EMPLOYEE_TYPES = ['Employee', 'Casual'] as const;
export type EmployeeType = (typeof EMPLOYEE_TYPES)[number];

export const PETTY_CASH_SOURCES = ['Bank Withdrawal', 'Cash Sales Allocation'] as const;
export type PettyCashSource = (typeof PETTY_CASH_SOURCES)[number];

// Default DTF film-roll spec shown when installing a roll — a 60cm x 100m
// roll at Ksh 7,000 (Ksh 70/linear metre, Ksh 116.67/sqm), GLM's real invoice
// figure as of Sep 2026. Still just a starting point: cost varies by supplier
// order, so staff should overwrite it with the actual figure off each invoice.
export const FILM_ROLL_DEFAULT_LENGTH_M = 100;
export const FILM_ROLL_DEFAULT_COST = 7000;
export const FILM_ROLL_WIDTH_M = 0.6;

// Heat press fee (Ksh, per piece) — a staff-picked value, not typed freely,
// so pricing stays within GLM's approved band. Only applies to jobs where
// GLM prints AND presses (e.g. DTF Printing) — never on a pure film sale.
export const HEAT_PRESS_FEE_OPTIONS = [20, 25, 30, 35, 40, 45, 50] as const;

// Default per-sqm rate for artwork-based DTF Printing — the midpoint of the
// Ksh 667-833/sqm band implied by GLM's existing 400-500/linear-metre film
// sale (400-500 ÷ FILM_ROLL_WIDTH_M), so the per-artwork service starts from
// the same economics as the per-metre film sale. Editable in Master Data.
export const DTF_PRINT_DEFAULT_RATE_PER_SQM = 750;
