import type { ItemType, OrderStage, OrderStatus, PaymentMethod, PaymentTiming, ServiceUnit, OrderTotals } from '@glm/shared';

export interface StaffUser {
  id: number;
  name: string;
  role: 'Staff' | 'Supervisor' | 'Admin';
}

export interface CatalogService {
  id: number;
  name: string;
  unit: ServiceUnit;
  price: number;
}

export interface CatalogMaterial {
  id: number;
  name: string;
  price: number;
}

export interface CorporateClient {
  id: number;
  name: string;
  creditDays: number;
}

export interface OrderSummary {
  id: number;
  orderNo: string;
  kind: 'walkin' | 'corporate';
  customerName: string | null;
  phone: string | null;
  corporateClient: { id: number; name: string } | null;
  staff: { id: number; name: string };
  createdDate: string;
  status: OrderStatus;
  stage: OrderStage;
  dueDate: string | null;
  totals: OrderTotals;
  overdue: boolean;
}

export interface OrderLineItemView {
  id: number;
  itemType: ItemType;
  serviceId: number;
  serviceName: string;
  materialId: number | null;
  materialName: string | null;
  qty: number;
  unitPrice: number;
  discountPct: number;
  discountAmt: number;
  lineTotal: number;
}

export interface PaymentView {
  id: number;
  date: string;
  amount: number;
  method: PaymentMethod;
}

export interface OrderDetail extends OrderSummary {
  paymentTiming: PaymentTiming | null;
  orderDiscountPct: number;
  orderDiscountAmt: number;
  lineItems: OrderLineItemView[];
  payments: PaymentView[];
}

export interface DraftLineItem {
  itemType: ItemType;
  serviceId: number;
  materialId: number | null;
  qty: number | string;
  unitPrice: number | string;
  discountPct: number | string;
  discountAmt: number | string;
}
