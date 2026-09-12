import type { OrderStage, Permissions } from './types';
import { PERMISSION_KEYS } from './types';

export const STAGES: OrderStage[] = [
  'Order Received',
  'In Production',
  'Quality Check',
  'Ready for Pickup/Delivery',
  'Completed',
];

export const PAYMENT_METHODS = ['Cash', 'M-Pesa', 'Bank Transfer', 'Card'] as const;

// Default permission sets for the five roles this app ships seeded with —
// used by both the API's seed script (to create the matching Role rows) and
// Master Data's "Add role" form (a starting point, e.g. cloning "Staff").
// 'Admin' is the one row the server always treats as all-true regardless of
// what's stored (see Role model docs in schema.prisma) — its entry here is
// just for display consistency.
const ALL_FALSE: Permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])) as Permissions;
const ALL_TRUE: Permissions = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])) as Permissions;

export const DEFAULT_ROLE_PERMISSIONS: Record<string, Permissions> = {
  Staff: { ...ALL_FALSE, canCaptureOrders: true },
  Supervisor: { ...ALL_FALSE, canViewAllOrders: true, canManagePayments: true, canAccessStock: true, canAccessFilm: true },
  'Finance Manager': {
    ...ALL_FALSE,
    canViewAllOrders: true,
    canManagePayments: true,
    canAccessPnl: true,
    canAccessFinance: true,
    canAccessStock: true,
    canApproveStock: true,
    canAccessFilm: true,
    canAccessReports: true,
  },
  'General Manager': {
    ...ALL_FALSE,
    canViewAllOrders: true,
    canManagePayments: true,
    canAccessPnl: true,
    canAccessFinance: true,
    canAccessStock: true,
    canApproveStock: true,
    canAccessFilm: true,
    canAccessReports: true,
  },
  Admin: ALL_TRUE,
};

export const ITEM_TYPE_LABELS: Record<string, string> = {
  material: 'Material',
  service: 'Service',
  'per-metre': 'Per-metre service',
};

// Matches GLM's own Petty Cash Tracker spreadsheet. Used by the P&L expense
// ledger. "DTF Film Rolls" is its own category (not folded into Printing
// Materials & Consumables) so the Film → Install roll flow can filter
// cleanly for expenses eligible to link to a roll (see Expense.invoiceNumber
// and FilmRoll.expenseId). "Salaries & wages" is deliberately NOT a pickable
// category here — that cost is captured exactly once, in Finance →
// Compliance → Payroll, and the P&L's "Salaries & wages" line is derived
// from PayrollEntry.grossPay directly (see pnl.ts) rather than from this
// Expense table, so there's no way to double-capture it via Expenses or
// Petty Cash.
export const EXPENSE_CATEGORIES = [
  'DTF Film Rolls',
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

// Where a pay-run's cash actually comes from — distinct from PAYMENT_METHODS
// (customer-facing) since payroll only ever leaves the business two ways.
// 'Petty Cash' registers netPay as an outflow against the Petty Cash float
// (see finance.ts's computePettyCashBalance) and is rejected if the float
// can't cover it; 'Bank/Cheque' has no further bookkeeping here.
export const PAYROLL_PAYMENT_SOURCES = ['Petty Cash', 'Bank/Cheque'] as const;
export type PayrollPaymentSource = (typeof PAYROLL_PAYMENT_SOURCES)[number];

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

// Suggested minimum accumulated area (sqm) before running a batch of small
// DTF artworks through the press — roughly half the roll's 60cm width run
// out 50cm (60cm x 50cm), a starting point for machine-time efficiency, not
// a pricing floor (each job is already priced to cover its own cost). This
// is a guess pending GLM's real press cycle-time economics — adjust once
// known.
export const DTF_PRINT_QUEUE_BATCH_SQM = 0.3;

// Finance > Asset Register — fixed-asset categories for a print/branding
// business (machines, vehicles, computers, furniture), as opposed to
// Material's consumable stock sold to customers.
export const ASSET_CATEGORIES = [
  'Printing Equipment',
  'Embroidery Machines',
  'Heat Press & Curing',
  'Computers & IT Equipment',
  'Furniture & Fixtures',
  'Vehicles',
  'Office Equipment',
  'Other',
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const ASSET_CONDITIONS = ['Active', 'Under Repair', 'Retired'] as const;
export type AssetCondition = (typeof ASSET_CONDITIONS)[number];

// Reports > Embroidery Profitability — the Material rows treated as
// Embroidery's own consumables (as opposed to Printing Materials &
// Consumables generally), so their Purchase cost can be matched against
// Embroidery service revenue for a gross-profit view. Matched by exact
// Material.name since there's no per-service consumable-material link in
// the schema (Material lines are standalone, not "consumed by" a service
// line) — adding another embroidery consumable (e.g. stabilizer backing)
// means adding its exact Material name here.
export const EMBROIDERY_CONSUMABLE_MATERIAL_NAMES = ['Embroidery Thread', 'Embroidery Needles'] as const;
