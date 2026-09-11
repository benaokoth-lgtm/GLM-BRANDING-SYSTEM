// Roles are now dynamic (Master Data → Roles & Access can add/rename them),
// so a role is just a name — validated against the Role table at write time,
// not a fixed union. 'Admin' is the one name the system treats specially
// (see PermissionKey/Role model docs in schema.prisma).
export type Role = string;

// One flag per gated nav area/action. A user's access is the union of their
// Role row's flags (or, for the literal 'Admin' role, always every flag) —
// see requirePermission() in apps/api/src/middleware/auth.ts and
// buildTabs() in apps/web/src/layouts/AppLayout.tsx.
export const PERMISSION_KEYS = [
  'canCaptureOrders',
  'canViewAllOrders',
  'canManagePayments',
  'canAccessPnl',
  'canAccessFinance',
  'canAccessStock',
  'canApproveStock',
  'canAccessFilm',
  'canAccessReports',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type Permissions = Record<PermissionKey, boolean>;

export interface RoleRow {
  id: number;
  name: string;
  permissions: Permissions;
}

export type OrderKind = 'walkin' | 'corporate';
export type OrderStatus = 'Quote' | 'Invoice' | 'Order';
export type OrderStage =
  | 'Order Received'
  | 'In Production'
  | 'Quality Check'
  | 'Ready for Pickup/Delivery'
  | 'Completed';

// A line item is either a standalone material sale ('material') or a
// standalone service fee ('service' / 'per-metre') — never both. Selling
// and servicing the same physical item is two separate line items instead
// of one combined row.
export type ItemType = 'material' | 'service' | 'per-metre';
export type ServiceUnit = 'piece' | 'metre' | 'sqm';
export type PaymentMethod = 'Cash' | 'M-Pesa' | 'Bank Transfer' | 'Card';
export type PaymentTiming = 'onAcceptance' | 'onCompletion';

export interface LineItemInput {
  itemType: ItemType;
  serviceId?: number | null;
  materialId?: number | null;
  qty: number;
  unitPrice: number;
  discountPct: number;
  discountAmt: number;
  filmLengthM?: number | null;
  heatPressFee?: number | null;
}

export interface OrderTotalsInput {
  lineItems: LineItemInput[];
  orderDiscountPct: number;
  orderDiscountAmt: number;
}

export interface PaymentRecord {
  date: string;
  amount: number;
  method: PaymentMethod;
}

export interface OrderTotals {
  subtotal: number;
  grandTotal: number;
  orderDiscount: number;
  paidTotal: number;
  balanceDue: number;
  paidPct: number;
}
