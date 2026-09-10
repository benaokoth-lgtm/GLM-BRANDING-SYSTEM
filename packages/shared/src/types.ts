export type Role = 'Staff' | 'Supervisor' | 'Finance Manager' | 'General Manager' | 'Admin';

export type OrderKind = 'walkin' | 'corporate';
export type OrderStatus = 'Quote' | 'Invoice' | 'Order';
export type OrderStage =
  | 'Order Received'
  | 'In Production'
  | 'Quality Check'
  | 'Ready for Pickup/Delivery'
  | 'Completed';

export type ItemType = 'material-service' | 'service-only' | 'per-metre';
export type ServiceUnit = 'piece' | 'metre' | 'sqm';
export type PaymentMethod = 'Cash' | 'M-Pesa' | 'Bank Transfer' | 'Card';
export type PaymentTiming = 'onAcceptance' | 'onCompletion';

export interface LineItemInput {
  itemType: ItemType;
  serviceId: number;
  materialId?: number | null;
  qty: number;
  unitPrice: number;
  discountPct: number;
  discountAmt: number;
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
