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

export interface CompanySettings {
  maxDiscountPct: number;
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  logoDataUrl: string | null;
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

export interface ExpenseRow {
  id: number;
  date: string;
  category: string;
  note: string;
  amount: number;
}

export interface PnlTrendPoint {
  label: string;
  revenue: number;
  netProfit: number;
}

export interface PnlData {
  fromDate: string;
  toDate: string;
  cogsPct: number;
  revAccrualWalkin: number;
  revAccrualCorp: number;
  revAccrual: number;
  revCash: number;
  cogs: number;
  grossProfit: number;
  byCategory: Record<string, number>;
  totalExpenses: number;
  netProfit: number;
  netMarginPct: number;
  revChangePct: number | null;
  profitChangePct: number | null;
  priorFrom: string;
  priorTo: string;
  trend: PnlTrendPoint[];
  expenseRows: ExpenseRow[];
  expenseCategories: readonly string[];
}

export interface PayrollRow {
  id: number;
  date: string;
  name: string;
  employeeType: 'Employee' | 'Casual';
  department: string;
  daysWorked: number;
  rate: number;
  paymentMethod: PaymentMethod;
  grossPay: number;
  paye: number;
  nssf: number;
  shif: number;
  housingLevy: number;
  totalDeductions: number;
  netPay: number;
}

export interface PayrollData {
  fromDate: string;
  toDate: string;
  rows: PayrollRow[];
  grossPayroll: number;
  totalStatutory: number;
  netPayroll: number;
  totalPaye: number;
  totalNssf: number;
  totalShif: number;
  totalHousingLevy: number;
}

export interface VatData {
  fromDate: string;
  toDate: string;
  walkinSales: number;
  corporateSales: number;
  totalSales: number;
  netSales: number;
  outputVat: number;
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
