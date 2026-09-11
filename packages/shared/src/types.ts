export type Role = 'Staff' | 'Supervisor' | 'Finance Manager' | 'General Manager' | 'Admin';

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
