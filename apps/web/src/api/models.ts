import type { ItemType, OrderStage, OrderStatus, PaymentMethod, PaymentTiming, Role, ServiceUnit, OrderTotals } from '@glm/shared';

export interface StaffUser {
  id: number;
  name: string;
  role: Role;
  /** False once the Admin has switched their sign-in off (they stay on record for history). */
  active?: boolean;
}

export interface CatalogService {
  id: number;
  /** The full name orders and invoices show: the service and its size ("Banner — A3"). */
  name: string;
  /** The service itself, its description and size — the price-list columns. */
  item?: string;
  description?: string;
  size?: string;
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
  /** The full name orders and stock show: the item and its size ("Polo Shirt — L"). */
  name: string;
  /** The item ("Polo Shirt"), its description, size and unit — the price-list columns. */
  item?: string;
  description?: string;
  size?: string;
  unit?: string;
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
  /** The name on the system screens (header, tab, sign-in); blank = the company name. */
  systemName?: string;
  /** A second phone number. */
  companyPhone2?: string;
  website?: string;
  facebook?: string;
  tiktok?: string;
  companyEmail: string;
  /** The company's KRA PIN — the employer's PIN on the payroll and P9. */
  kraPin?: string;
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
  /** An artwork job priced below the recommended price waits for a manager's approval. */
  priceApproval?: 'Pending' | null;
  /** For Film/Artwork orders: which of the two it is. */
  dtfKind?: 'film' | 'artwork' | null;
  /** The business heads the order's lines belong to. */
  businessHeads?: string[];
  /** The one head the order is counted under (the head carrying most of its value). */
  businessHead?: string;
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
  /** Whether this person may record a payment on the order (its capturer, or someone who handles payments). */
  canTakePayment?: boolean;
  paymentTiming: PaymentTiming | null;
  // Sales commission: who the order is credited to (a staff member's own client), or the house
  salesSource?: 'sourced' | 'house' | 'freelance';
  /** The freelance sales person it is credited to (then no staff member is). */
  freelanceAgentName?: string | null;
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

export interface PayrollRow {
  id: number;
  date: string;
  staffId: number;
  name: string;
  employeeType: 'Employee' | 'Casual';
  nationalId?: string | null;
  kraPin?: string | null;
  shifNumber?: string | null;
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
  /** What PAYE was worked out on (gross less NSSF, SHIF and the housing levy). */
  taxablePay: number;
  /** The employer's matching shares — a business cost, not taken from the employee. */
  nssfEmployer: number;
  housingLevyEmployer: number;
  capturedByName: string;
}

/** An employee's statutory identifiers (Compliance → Employees). */
export interface EmployeeRow {
  id: number;
  name: string;
  firstName: string;
  middleName: string;
  lastName: string;
  role: string;
  nationalId: string | null;
  kraPin: string | null;
  shifNumber: string | null;
  /** Gross monthly salary (Ksh): basic plus fixed allowances, before deductions. The sales target for commission is a multiple of it. */
  basicSalary: number | null;
}

export interface P9Month {
  month: number;
  gross: number;
  nssf: number;
  shif: number;
  housingLevy: number;
  taxable: number;
  taxCharged: number;
  relief: number;
  paye: number;
}

export interface P9Data {
  year: string;
  employer: { name: string; tradingName: string; kraPin: string | null; address: string };
  employees: { staff: { id: number; name: string; firstName: string; middleName: string; lastName: string; nationalId: string | null; kraPin: string | null; shifNumber: string | null }; months: P9Month[]; totals: Omit<P9Month, 'month'> }[];
}

export interface PayrollData {
  fromDate: string;
  toDate: string;
  rows: PayrollRow[];
  grossPayroll: number;
  totalStatutory: number;
  netPayroll: number;
  totalPaye: number;
  /** The employees' NSSF; the employer matches it (`totalNssfEmployer`). */
  totalNssf: number;
  totalNssfEmployer: number;
  totalShif: number;
  /** The employees' housing levy; the employer matches it (`totalHousingLevyEmployer`). */
  totalHousingLevy: number;
  totalHousingLevyEmployer: number;
}

export interface VatData {
  fromDate: string;
  toDate: string;
  walkinSales: number;
  corporateSales: number;
  creditNotes: number;
  debitNotes: number;
  totalSales: number;
  netSales: number;
  outputVat: number;
  inputVat: number;
  otherVat: number;
  netVatPayable: number;
  purchases: VatPurchaseRow[];
  heads: VatHeadRow[];
  statement: VatStatement;
}

/** The VAT statement generated from the books: income accounts (output VAT), expense accounts (input VAT) and outsourced work. */
export interface VatStatementLine {
  date: string;
  ref: string;
  memo: string;
  net: number;
  vat: number;
}
export interface VatStatementRow {
  accountId: number;
  code: string;
  name: string;
  net: number;
  vat: number;
  gross: number;
  lines: VatStatementLine[];
}
export interface VatStatementPart {
  rows: VatStatementRow[];
  net: number;
  vat: number;
  gross: number;
}
export interface VatStatement {
  income: VatStatementPart;
  expenses: VatStatementPart;
  outsourced: {
    sales: { rows: { orderId: number; orderNo: string; date: string; customer: string; net: number; vat: number; gross: number; quoted: number; billed: number }[]; net: number; vat: number; gross: number };
    bills: { rows: { expenseId: number; date: string; orderNo: string | null; supplier: string; invoiceNumber: string | null; gross: number; net: number; vat: number }[]; net: number; vat: number; gross: number };
    netVat: number;
  };
}

export interface VatHeadRow {
  id: number;
  name: string;
  applicable: boolean;
  isDefault: boolean;
}

export interface VatPurchaseRow {
  id: number;
  date: string;
  category: string;
  supplier: string;
  invoiceNumber: string | null;
  note: string;
  amount: number;
  vatAmount: number;
  isStockPurchase: boolean;
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
  // Which of the two discounts the single discount box is showing (a line carries one or the other).
  discountMode?: 'pct' | 'amt';
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
