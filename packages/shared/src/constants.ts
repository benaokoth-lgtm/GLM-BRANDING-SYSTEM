import type { OrderStage, Role } from './types';

export const STAGES: OrderStage[] = [
  'Order Received',
  'In Production',
  'Quality Check',
  'Ready for Pickup/Delivery',
  'Completed',
];

export const PAYMENT_METHODS = ['Cash', 'M-Pesa', 'Bank Transfer', 'Card'] as const;

export const ROLES: Role[] = ['Staff', 'Supervisor', 'Admin'];

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
