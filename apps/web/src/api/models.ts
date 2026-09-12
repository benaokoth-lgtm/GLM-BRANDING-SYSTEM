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
  tracksFilm: boolean;
  usesArtworkPricing: boolean;
  chargesPressingFee: boolean;
}

export interface CatalogMaterial {
  id: number;
  name: string;
  price: number;
  stockQty: number;
  reorderLevel: number;
}

export interface ArtworkSizeBand {
  id: number;
  serviceId: number;
  label: string;
  lengthCm: number;
  widthCm: number;
  areaSqm: number;
  price: number;
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
  filmLengthM: number | null;
  heatPressFee: number | null;
  artworkAreaSqm: number | null;
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
  invoiceNumber: string | null;
  capturedByName: string;
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
  expenseCategories: readonly string[];
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

export interface StockRequisitionRow {
  id: number;
  materialId: number;
  materialName: string;
  qty: number;
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
  filmLengthM: number | string;
  heatPressFee: number | string;
  artworkAreaSqm: number | string;
}

export interface FilmRollRow {
  id: number;
  lengthM: number;
  costTotal: number;
  invoiceNumber: string | null;
  costPerMeter: number;
  installedDate: string;
  installedByName: string;
  status: 'Active' | 'Finished';
  finishedDate: string | null;
  usedM: number;
  remainingM: number;
  wasteM: number;
  avgRatePerMeter: number | null;
  marginPerMeter: number | null;
  undercharged: boolean;
}

export interface FilmUsageRow {
  id: number;
  date: string;
  lengthM: number;
  source: 'Order' | 'Manual';
  orderId: number | null;
  orderNo: string | null;
  ratePerMeter: number | null;
  revenue: number | null;
  note: string;
  capturedByName: string;
}

export interface PrintQueueItem {
  id: number;
  orderId: number;
  orderNo: string;
  clientName: string;
  date: string;
  serviceName: string;
  artworkAreaSqm: number;
  qty: number;
  totalAreaSqm: number;
  heatPressFee: number | null;
}

export interface PrintQueueData {
  items: PrintQueueItem[];
  totalPendingSqm: number;
  batchThresholdSqm: number;
  readyToRun: boolean;
}

export interface FilmExpenseOption {
  id: number;
  date: string;
  invoiceNumber: string | null;
  amount: number;
  note: string;
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

export interface RequisitionAwaitingPurchase {
  id: number;
  materialId: number;
  materialName: string;
  qty: number;
  note: string;
  requestedByName: string;
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
}

export interface PurchaseRow {
  id: number;
  requisitionId: number | null;
  materialId: number;
  materialName: string;
  date: string;
  supplier: string;
  qty: number;
  unitCost: number;
  totalCost: number;
  invoiceNumber: string | null;
  status: 'Held' | 'Accepted' | 'Rejected';
  requisitionedQty: number | null;
  varianceQty: number | null;
  acceptedByName: string | null;
  acceptedAt: string | null;
  rejectReason: string | null;
  capturedByName: string;
  createdAt: string;
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

export interface EmbroideryConsumableBreakdownRow {
  materialName: string;
  qty: number;
  totalCost: number;
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
