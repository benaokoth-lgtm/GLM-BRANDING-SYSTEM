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
  'material-service': 'Material + Service',
  'service-only': "Service only (client's item)",
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

// Placeholder DTF film-roll spec shown as the default when installing a roll —
// GLM's actual roll length/cost varies by supplier order, so these are just a
// starting point staff should overwrite with the real figures off the invoice.
export const FILM_ROLL_DEFAULT_LENGTH_M = 100;
export const FILM_ROLL_DEFAULT_COST = 3500;
