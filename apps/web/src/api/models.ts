import type { ItemType, OrderStage, OrderStatus, PaymentMethod, PaymentTiming, Role, ServiceUnit, OrderTotals } from '@glm/shared';

export interface StaffUser {
  id: number;
  name: string;
  role: Role;
}

export interface CatalogService {
  id: number;
  name: string;
  unit: ServiceUnit;
  price: number;
  businessHeadId?: number | null;
  usesArtworkPricing: boolean;
  chargesPressingFee: boolean;
  soldViaDtfModule: boolean;
  // Contracted-out service. The supplier name is for everyone; the supplier price and mark-up arrive only for people who can see costs.
  outsourced: boolean;
  supplierName: string;
  markupType?: 'percent' | 'amount';
  markupValue?: number;
  defaultSupplierCost?: number | null;
}

export interface CatalogMaterial {
  id: number;
  name: string;
  price: number;
  stockQty: number;
  reorderLevel: number;
  businessHeadId?: number | null;
}

export interface CorporateClient {
  id: number;
  name: string;
  creditDays: number;
  email: string;
  phone: string;
}

export interface CompanySettings {
  maxDiscountPct: number;
  companyName: string;
  legalName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  logoDataUrl: string | null;
}

export interface OrderSummary {
  id: number;
  orderNo: string;
  kind: 'walkin' | 'corporate';
  channel: 'general' | 'dtf';
  customerName: string | null;
  phone: string | null;
  corporateClient: { id: number; name: string; email: string; phone: string } | null;
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
  serviceId: number | null;
  serviceName: string | null;
  materialId: number | null;
  materialName: string | null;
  qty: number;
  unitPrice: number;
  discountPct: number;
  discountAmt: number;
  heatPressFee: number | null;
  artworkAreaSqm: number | null;
  lineTotal: number;
  // Contracted-out service line; needsCosting = nobody has entered the supplier's quote yet. (The cost itself is never sent to staff.)
  outsourced?: boolean;
  needsCosting?: boolean;
}

export interface PaymentView {
  id: number;
  date: string;
  amount: number;
  method: PaymentMethod;
  reference?: string | null;
}

export interface OrderDetail extends OrderSummary {
  paymentTiming: PaymentTiming | null;
  // Sales commission: who the order is credited to (a staff member's own client), or the house
  salesSource?: 'sourced' | 'house';
  sourcedByStaffId?: number | null;
  sourcedByName?: string | null;
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
  invoiceNumber: string | null;
  capturedByName: string;
  businessHeadId?: number | null;
  method: string; // 'Petty Cash' | 'Cash' | 'M-Pesa' | 'Bank Transfer' | 'Card'
  paid: boolean; // false = bought on credit (sits in Accounts Payable)
  supplier: string;
  dueDate: string | null;
  paidAmount: number;
  credited: number; // supplier debit notes against it
  outstanding: number;
}

export interface ExpenseAmendment {
  id: number;
  expenseId: number;
  currentDate: string;
  currentCategory: string;
  currentNote: string;
  currentAmount: number;
  proposedDate: string;
  proposedCategory: string;
  proposedNote: string;
  proposedAmount: number;
  reason: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
}

export type DeletableRecordType = 'Expense' | 'PayrollEntry' | 'PettyCashTopUp';

export interface DeletionRequest {
  id: number;
  recordType: DeletableRecordType;
  recordId: number;
  summary: string;
  reason: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
}

export interface PnlTrendPoint {
  label: string;
  revenue: number;
  netProfit: number;
}

export interface PnlData {
  fromDate: string;
  toDate: string;
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
  expenseCategories: readonly string[];
  expenseMethods?: readonly string[];
}

export interface PayrollRow {
  id: number;
  date: string;
  staffId: number;
  name: string;
  employeeType: 'Employee' | 'Casual';
  department: string;
  daysWorked: number | null;
  rate: number | null;
  paymentSource: 'Petty Cash' | 'Bank/Cheque';
  grossPay: number;
  paye: number;
  nssf: number;
  shif: number;
  housingLevy: number;
  totalDeductions: number;
  netPay: number;
  capturedByName: string;
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

export interface ExpensesData {
  fromDate: string;
  toDate: string;
  rows: ExpenseRow[];
  totalExpenses: number;
  expenseCategories: readonly string[];
}

export interface PettyCashLedgerRow {
  id: string;
  date: string;
  type: 'topup' | 'expense';
  description: string;
  amountIn: number;
  amountOut: number;
  topUpId: number | null;
}

export interface PettyCashData {
  fromDate: string;
  toDate: string;
  balance: number;
  periodTopUpsTotal: number;
  periodExpensesTotal: number;
  cashSalesInPeriod: number;
  ledger: PettyCashLedgerRow[];
  pettyCashSources: readonly string[];
}

export interface StockRequisitionLineRow {
  id: number;
  materialId: number;
  materialName: string;
  qty: number;
  /** The unit price expected when the requisition was raised. */
  estUnitCost: number | null;
}

export interface StockRequisitionRow {
  id: number;
  ref: string | null; // REQ-0001
  lines: StockRequisitionLineRow[];
  note: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
}

export interface DraftLineItem {
  itemType: ItemType;
  serviceId: number | null;
  materialId: number | null;
  qty: number | string;
  unitPrice: number | string;
  discountPct: number | string;
  discountAmt: number | string;
  heatPressFee: number | string;
  artworkAreaSqm: number | string;
  // Outsourced services, for people who can see costs: the supplier's quote for this job (per unit, VAT included) and the mark-up.
  supplierName?: string;
  supplierCost?: number | string;
  markupType?: 'percent' | 'amount';
  markupValue?: number | string;
}

export interface StockTakeRow {
  id: number;
  materialId: number;
  materialName: string;
  date: string;
  systemQty: number;
  countedQty: number;
  varianceQty: number;
  note: string;
  countedByName: string;
  countedAt: string;
}

/** An approved requisition with lines still to be bought. */
export interface RequisitionAwaitingPurchase {
  id: number;
  ref: string | null;
  note: string;
  requestedByName: string;
  lines: { lineId: number; materialId: number; materialName: string; qty: number; estUnitCost: number | null }[];
}

export interface PurchaseExpenseOption {
  id: number;
  date: string;
  invoiceNumber: string | null;
  amount: number;
  note: string;
}

export interface AssetRow {
  id: number;
  tag: string;
  name: string;
  category: string;
  quantity: number;
  location: string;
  condition: 'Active' | 'Under Repair' | 'Retired';
  purchaseDate: string | null;
  value: number | null;
  notes: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  depreciationMethod: 'None' | 'Straight-line' | 'Reducing balance';
  usefulLifeYears: number | null;
  depreciationRatePct: number | null;
  salvageValue: number;
  fundedBy: string;
  accumulatedDepreciation: number;
  bookValue: number | null;
}

/** A purchase order: a PO reference and any number of lines. */
export interface PurchaseRow {
  id: number;
  poRef: string | null; // PO-0001
  requisitionId: number | null;
  requisitionRef: string | null;
  date: string;
  supplier: string;
  invoiceNumber: string | null;
  status: 'Held' | 'Accepted' | 'Rejected';
  totalCost: number;
  lines: { id: number; materialId: number; materialName: string; qty: number; unitCost: number; totalCost: number; receivedQty: number | null; requisitionedQty: number | null; businessHeadId: number | null; businessHeadName: string | null }[];
  acceptedByName: string | null;
  acceptedAt: string | null;
  rejectReason: string | null;
  receiveNote: string | null;
  capturedByName: string;
  createdAt: string;
}

export interface ReconLineRow {
  materialId: number;
  name: string;
  status: 'Not purchased' | 'Awaiting receipt' | 'Received' | 'Not requisitioned';
  requisitionedQty: number;
  expectedUnitCost: number | null;
  expectedTotal: number | null;
  purchasedQty: number;
  receivedQty: number;
  actualUnitCost: number | null;
  actualTotal: number;
  qtyVariance: number | null;
  shortDelivery: number;
  priceVarianceUnit: number | null;
  priceVarianceValue: number | null;
  qtyVarianceValue: number | null;
  totalVariance: number | null;
}

export interface ReconTotalsRow {
  expectedTotal: number;
  actualTotal: number;
  totalVariance: number;
  priceVarianceValue: number;
  qtyVarianceValue: number;
  unpricedLines: number;
  shortDeliveryValue: number;
  linesNotPurchased: number;
  linesAwaitingReceipt: number;
}

export interface ReconciliationData {
  requisitions: {
    id: number;
    ref: string | null;
    note: string;
    requestedByName: string;
    requestedAt: string;
    decidedByName: string | null;
    state: 'Not purchased' | 'Part purchased' | 'Awaiting receipt' | 'Received';
    purchaseOrders: { id: number; poRef: string | null; status: string; supplier: string; invoiceNumber: string | null; totalCost: number; date: string }[];
    lines: ReconLineRow[];
    totals: ReconTotalsRow;
  }[];
  summary: { requisitions: number; expectedTotal: number; actualTotal: number; totalVariance: number; priceVarianceValue: number; qtyVarianceValue: number; shortDeliveryValue: number };
  standalone: { id: number; poRef: string | null; date: string; supplier: string; invoiceNumber: string | null; status: string; totalCost: number; items: string }[];
}

export interface BusinessHeadRow {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
  services: number;
}

export interface SalesCategoryRow {
  name: string;
  qty: number;
  revenue: number;
}

export interface SalesByCategoryData {
  fromDate: string;
  toDate: string;
  categories: SalesCategoryRow[];
  materials: { qty: number; revenue: number };
}

export interface SalesByBusinessHeadData {
  fromDate: string;
  toDate: string;
  totalSales: number;
  totalCosts: number;
  totalMargin: number;
  heads: {
    name: string;
    active: boolean;
    sales: number;
    orders: number;
    sharePct: number;
    costs: HeadCosts;
    margin: number;
    marginPct: number | null;
    services: { name: string; qty: number; sales: number }[];
  }[];
  unassignedCosts: HeadCosts;
}

export interface HeadCosts {
  purchases: number;
  expenses: number;
  total: number;
  expenseCategories: { category: string; amount: number }[];
}

export interface EmbroideryConsumableBreakdownRow {
  materialName: string;
  qty: number;
  totalCost: number;
}

export interface AccountsReceivableRow {
  id: number;
  orderNo: string;
  kind: 'walkin' | 'corporate';
  channel: 'general' | 'dtf';
  client: string;
  staffName: string;
  createdDate: string;
  dueDate: string | null;
  grandTotal: number;
  paidTotal: number;
  balanceDue: number;
  daysOverdue: number;
}

export interface AccountsReceivableData {
  asOf: string;
  totalOutstanding: number;
  buckets: {
    current: number;
    days1to30: number;
    days31to60: number;
    days61to90: number;
    days90plus: number;
  };
  rows: AccountsReceivableRow[];
}

export interface EmbroideryProfitabilityData {
  fromDate: string;
  toDate: string;
  serviceFound: boolean;
  revenue: number;
  qtyPieces: number;
  consumablesCost: number;
  grossProfit: number;
  marginPct: number | null;
  avgRevenuePerPiece: number | null;
  avgCostPerPiece: number | null;
  marginPerPiece: number | null;
  underpriced: boolean;
  consumableBreakdown: EmbroideryConsumableBreakdownRow[];
}
