"use strict";

// apps/api/prisma/books-check.ts
var import_client2 = require("@prisma/client");

// packages/shared/src/types.ts
var PERMISSION_KEYS = [
  "canCaptureOrders",
  "canViewAllOrders",
  "canManagePayments",
  "canAccessPnl",
  "canAccessFinance",
  "canAccessStock",
  "canApproveStock",
  "canAccessReports",
  "canAccessDtf",
  "canManageDtf",
  "canAccessAccounting",
  "canSeeCosts",
  "canAccessProduction",
  "canManageProduction",
  "canAccessQuality",
  "canReceiveStock",
  "canManageCommission",
  "canCaptureForOthers",
  // Front office: capture General / Film / Artwork orders in a sales person's name, and for freelancers
  "canBeAssignedOrders"
  // Sales person: orders can be captured for (and credited to) this role by the front office
];

// packages/shared/src/calc.ts
function buildLineTotal(li) {
  const qty = Number(li.qty) || 0;
  const price = Number(li.unitPrice) || 0;
  const heatPressFee = Number(li.heatPressFee) || 0;
  const pct = Number(li.discountPct) || 0;
  const amt = Number(li.discountAmt) || 0;
  return Math.max(0, qty * (price + heatPressFee) * (1 - pct / 100) - amt);
}
function computeOrderTotals(order, payments = []) {
  const subtotal = order.lineItems.reduce((a2, li) => a2 + buildLineTotal(li), 0);
  const opct = Number(order.orderDiscountPct) || 0;
  const oamt = Number(order.orderDiscountAmt) || 0;
  const grandTotal = Math.max(0, subtotal * (1 - opct / 100) - oamt);
  const paidTotal = payments.reduce((a2, p) => a2 + (Number(p.amount) || 0), 0);
  const balanceDue = Math.max(0, grandTotal - paidTotal);
  const paidPct = grandTotal > 0 ? Math.min(100, paidTotal / grandTotal * 100) : paidTotal > 0 ? 100 : 0;
  return { subtotal, grandTotal, orderDiscount: subtotal - grandTotal, paidTotal, balanceDue, paidPct };
}
function todayStr() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}

// packages/shared/src/constants.ts
var ALL_FALSE = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false]));
var ALL_TRUE = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));
var DEFAULT_ROLE_PERMISSIONS = {
  // canAccessDtf lets Staff reach Film Order/Artwork Order (next to General
  // Order) without exposing roll costs, Dashboard, Rolls, or Setup — those
  // stay canManageDtf-only (Supervisor/Finance/General Manager/Admin below).
  // Staff work the jobs they are assigned in Production; Supervisors assign them and inspect quality.
  Staff: { ...ALL_FALSE, canCaptureOrders: true, canAccessDtf: true, canAccessProduction: true, canBeAssignedOrders: true },
  // The receptionist / cashier: captures orders for the sales persons (or freelancers), takes the money, and sees every order — no costs, no commission.
  "Front Office": { ...ALL_FALSE, canCaptureOrders: true, canAccessDtf: true, canManagePayments: true, canViewAllOrders: true, canCaptureForOthers: true },
  Supervisor: {
    ...ALL_FALSE,
    canViewAllOrders: true,
    canManagePayments: true,
    canAccessStock: true,
    canReceiveStock: true,
    canAccessDtf: true,
    canAccessProduction: true,
    canManageProduction: true,
    canAccessQuality: true
  },
  "Finance Manager": {
    ...ALL_FALSE,
    canViewAllOrders: true,
    canManagePayments: true,
    canAccessPnl: true,
    canAccessFinance: true,
    canAccessStock: true,
    canApproveStock: true,
    canAccessReports: true,
    canAccessDtf: true,
    canManageDtf: true,
    canAccessAccounting: true,
    canAccessProduction: true,
    canManageProduction: true,
    canAccessQuality: true,
    canSeeCosts: true,
    canManageCommission: true,
    canReceiveStock: true
  },
  "General Manager": {
    ...ALL_FALSE,
    canViewAllOrders: true,
    canManagePayments: true,
    canAccessPnl: true,
    canAccessFinance: true,
    canAccessStock: true,
    canApproveStock: true,
    canAccessReports: true,
    canAccessDtf: true,
    canManageDtf: true,
    canAccessAccounting: true,
    canAccessProduction: true,
    canManageProduction: true,
    canAccessQuality: true,
    canSeeCosts: true,
    canManageCommission: true,
    canReceiveStock: true
  },
  Admin: ALL_TRUE
};
var EXPENSE_CATEGORIES = [
  "Printing Materials & Consumables",
  "Casual Labour",
  "Transport",
  "Utilities",
  "Equipment Maintenance",
  "Office Supplies",
  "Courier/Delivery",
  "Refreshments",
  "Miscellaneous",
  "Airtime/Data",
  "Cleaning",
  "Bank Charges",
  // Contracted-out jobs (eulogies, banners, screen printing…): the supplier's bill is the job's cost of sales.
  "Outsourced Services",
  // Staff sales commission paid out from Sales Commission → Payouts.
  "Sales Commission",
  // Weekly pay to freelance sales persons who bring us work, from Commission → Freelancers.
  "Freelance Commission"
];

// packages/shared/src/tax.ts
var VAT_RATE = 0.16;
function defaultExpenseVatApplicable(head) {
  const h = head.trim().toLowerCase();
  if (/labou?r|wage|salar|payroll|commission|bank|refreshment|entertain|tea\b|lunch|miscellaneous|tax|licen[cs]e|insurance|interest|depreciation/.test(h)) return false;
  return /material|consumable|stock|transport|fuel|utilit|electric|maintenance|repair|office|stationer|courier|delivery|airtime|data|internet|cleaning|outsourc|rent|advert|marketing|professional|software|equipment|packag/.test(h);
}
var NSSF_RATE = 0.06;
var NSSF_EMPLOYER_RATE = 0.06;
var SHIF_RATE = 0.0275;
var SHIF_MIN = 300;
var HOUSING_LEVY_RATE = 0.015;
var HOUSING_LEVY_EMPLOYER_RATE = 0.015;
var NSSF_UPPER_LIMITS = [
  ["2026-02-01", 108e3],
  ["2025-02-01", 72e3],
  ["2024-02-01", 36e3],
  ["2023-02-01", 18e3]
];
function nssfUpperLimit(date) {
  if (!date) return NSSF_UPPER_LIMITS[0][1];
  for (const [from, limit] of NSSF_UPPER_LIMITS) if (date >= from) return limit;
  return NSSF_UPPER_LIMITS[NSSF_UPPER_LIMITS.length - 1][1];
}
var PAYE_MONTHLY_RELIEF = 2400;
var PAYE_BANDS = [
  [24e3, 0.1],
  [8333, 0.25],
  [467667, 0.3],
  [3e5, 0.325],
  [Infinity, 0.35]
];
function payeBand(monthlyPay) {
  let tax = 0;
  let remaining = monthlyPay;
  for (const [width, rate] of PAYE_BANDS) {
    if (remaining <= 0) break;
    const x = Math.min(remaining, width);
    tax += x * rate;
    remaining -= x;
  }
  return tax;
}
function nssfContribution(grossPay, date) {
  return Math.min(Math.max(grossPay, 0), nssfUpperLimit(date)) * NSSF_RATE;
}
function nssfEmployerContribution(grossPay, date) {
  return Math.min(Math.max(grossPay, 0), nssfUpperLimit(date)) * NSSF_EMPLOYER_RATE;
}
function shifContribution(grossPay) {
  return Math.max(grossPay * SHIF_RATE, SHIF_MIN);
}
function housingLevy(grossPay) {
  return grossPay * HOUSING_LEVY_RATE;
}
function housingLevyEmployer(grossPay) {
  return grossPay * HOUSING_LEVY_EMPLOYER_RATE;
}
function computePay(grossPay, employeeType, date) {
  if (employeeType === "Casual") {
    return { grossPay, paye: 0, nssf: 0, shif: 0, housingLevy: 0, totalDeductions: 0, netPay: grossPay, taxablePay: grossPay, taxCharged: 0, personalRelief: 0, nssfEmployer: 0, housingLevyEmployer: 0 };
  }
  const nssf = nssfContribution(grossPay, date);
  const shif = shifContribution(grossPay);
  const housing = housingLevy(grossPay);
  const taxablePay = Math.max(0, grossPay - nssf - shif - housing);
  const taxCharged = payeBand(taxablePay);
  const personalRelief = Math.min(PAYE_MONTHLY_RELIEF, taxCharged);
  const paye = taxCharged - personalRelief;
  const totalDeductions = paye + nssf + shif + housing;
  return {
    grossPay,
    paye,
    nssf,
    shif,
    housingLevy: housing,
    totalDeductions,
    netPay: grossPay - totalDeductions,
    taxablePay,
    taxCharged,
    personalRelief,
    nssfEmployer: nssfEmployerContribution(grossPay, date),
    housingLevyEmployer: housingLevyEmployer(grossPay)
  };
}

// packages/shared/src/accounting.ts
function isDebitNormal(type) {
  return type === "Asset" || type === "Expense";
}
var ACCT = {
  pettyCash: "1010",
  cash: "1020",
  mpesa: "1030",
  card: "1040",
  bank: "1050",
  receivables: "1100",
  inventory: "1200",
  fixedAssets: "1500",
  accumDepreciation: "1590",
  payables: "2010",
  vatPayable: "2100",
  payePayable: "2200",
  whtPayable: "2240",
  nssfPayable: "2210",
  shifPayable: "2220",
  housingLevyPayable: "2230",
  customerCredits: "2300",
  unallocatedMpesa: "2310",
  loans: "2400",
  capital: "3010",
  drawings: "3020",
  retainedEarnings: "3030",
  printingIncome: "4010",
  merchandiseIncome: "4020",
  dtfIncome: "4030",
  embroideryIncome: "4040",
  otherIncome: "4100",
  salesReturns: "4900",
  costOfSales: "5000",
  salaries: "5010",
  depreciation: "6800",
  uncategorised: "6999"
};
var a = (code, name, type, subtype = "", description = "") => ({ code, name, type, subtype, description });
var DEFAULT_CHART = [
  // Assets
  a("1010", "Petty Cash", "Asset", "PettyCash", "The petty-cash float. Pays all wages and small expenses; topped up only by a bank withdrawal, a cash-sales allocation or an owner injection."),
  a("1020", "Cash on Hand (Tills)", "Asset", "Cash", "Cash collected from customers, before it is banked."),
  a("1030", "M-Pesa", "Asset", "Mobile", "M-Pesa receipts and payments."),
  a("1040", "Card Settlements", "Asset", "Card", "Card payments awaiting settlement by the bank."),
  a("1050", "Bank Account", "Asset", "Bank", "The business bank account."),
  a("1100", "Accounts Receivable", "Asset", "Receivable", "What customers and corporate clients still owe on invoices."),
  a("1200", "Stock & Inventory", "Asset", "Inventory", "Stock held in stores (opening balance and manual adjustments)."),
  a("1500", "Machinery, Equipment & Vehicles (Cost)", "Asset", "FixedAsset", "Cost of fixed assets from the Asset Register."),
  a("1590", "Accumulated Depreciation", "Asset", "FixedAsset", "Contra-asset: the depreciation charged to date on the Asset Register."),
  // Liabilities
  a("2010", "Accounts Payable", "Liability", "Payable", "Suppliers owed."),
  a("2100", "VAT Payable", "Liability", "Tax", "Output VAT collected on sales, owed to KRA."),
  a("2200", "PAYE Payable", "Liability", "Tax", "PAYE withheld from employees."),
  a("2210", "NSSF Payable", "Liability", "Tax"),
  a("2220", "SHIF Payable", "Liability", "Tax"),
  a("2230", "Housing Levy Payable", "Liability", "Tax"),
  a("2240", "Withholding Tax Payable", "Liability", "", "Tax withheld from commission paid to freelance sales persons, held until it is paid over to KRA."),
  a("2300", "Customer Deposits & Credits", "Liability", "Deposit", "Money received before an order is invoiced, or owed back to a customer after a credit note."),
  a("2310", "Unallocated M-Pesa Receipts", "Liability", "Suspense", "M-Pesa money received that has not yet been matched to an order."),
  a("2400", "Loans Payable", "Liability", "Loan"),
  // Equity
  a("3010", "Owner's Capital", "Equity", "Capital", "Money the owner has put into the business."),
  a("3020", "Owner's Drawings", "Equity", "Drawings", "Money the owner has taken out of the business."),
  a("3030", "Retained Earnings", "Equity", "RetainedEarnings", "Profit kept from earlier periods (opening balance)."),
  // Income
  a("4010", "Printing & Branding Services Income", "Income", "", "Default account for services with no account of their own."),
  a("4020", "Merchandise & Materials Sales", "Income", "", "Caps, shirts, canvas and other materials sold."),
  a("4030", "DTF Film & Printing Income", "Income"),
  a("4040", "Embroidery Income", "Income"),
  a("4100", "Other Income", "Income"),
  a("4900", "Sales Returns & Credit Notes", "Income", "", "Credit notes issued to customers (a debit balance that reduces income)."),
  // Cost of sales — what was bought to sell and produce with. It is simply the purchases: stock purchases and material
  // expenses post here, there is no percentage assumption. Everything below it is an operating expense.
  a("5000", "Cost of Sales \u2014 Purchases", "Expense", "CostOfSales", "Materials, blanks, film, ink and consumables purchased (stock purchases and the Printing Materials & Consumables expense head)."),
  // Expenses
  a("5010", "Salaries & Wages", "Expense", "Payroll"),
  a("5100", "Production Supplies & Overheads", "Expense"),
  a("5020", "Sales Commission", "Expense", "", "Commission paid to staff on sales they sourced and on film/artwork sold above the recommended price."),
  a("5025", "Freelance Commission", "Expense", "", "Weekly commission paid to freelance sales persons on the sales they bring, at or above our base prices."),
  a("5110", "Casual Labour", "Expense", "Payroll"),
  a("5120", "Transport", "Expense"),
  a("5130", "Utilities", "Expense"),
  a("5140", "Equipment Maintenance", "Expense"),
  a("5150", "Office Supplies", "Expense"),
  a("5160", "Courier & Delivery", "Expense"),
  a("5170", "Refreshments", "Expense"),
  a("5180", "Airtime & Data", "Expense"),
  a("5190", "Cleaning", "Expense"),
  a("5200", "Bank Charges", "Expense"),
  a("6800", "Depreciation", "Expense", "", "Charged automatically each month from the Asset Register."),
  a("6900", "Miscellaneous Expenses", "Expense"),
  a("6999", "Uncategorised Expenses", "Expense", "", "Catch-all for an expense head that has no account yet.")
];
var SYSTEM_ACCOUNT_CODES = [...Object.values(ACCT)];
var EXPENSE_HEAD_ACCOUNT_CODES = {
  "Printing Materials & Consumables": "5000",
  // purchases of materials = cost of sales
  "Outsourced Services": "5000",
  // contracted-out jobs: the supplier's bill is cost of sales too
  "Sales Commission": "5020",
  "Freelance Commission": "5025",
  "Casual Labour": "5110",
  Transport: "5120",
  Utilities: "5130",
  "Equipment Maintenance": "5140",
  "Office Supplies": "5150",
  "Courier/Delivery": "5160",
  Refreshments: "5170",
  "Airtime/Data": "5180",
  Cleaning: "5190",
  "Bank Charges": "5200",
  Miscellaneous: "6900"
};
function defaultServiceIncomeCode(serviceName) {
  const n = serviceName.toLowerCase();
  if (n.includes("dtf")) return ACCT.dtfIncome;
  if (n.includes("embroid")) return ACCT.embroideryIncome;
  return ACCT.printingIncome;
}
function methodAccountCode(method) {
  switch ((method || "").trim().toLowerCase()) {
    case "m-pesa":
    case "mpesa":
      return ACCT.mpesa;
    case "card":
      return ACCT.card;
    case "bank transfer":
    case "bank":
    case "bank/cheque":
    case "cheque":
      return ACCT.bank;
    case "petty cash":
      return ACCT.pettyCash;
    default:
      return ACCT.cash;
  }
}
var CASH_ACCOUNT_CODES = [ACCT.pettyCash, ACCT.cash, ACCT.mpesa, ACCT.card, ACCT.bank];
var round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function monthOf(date) {
  return date.slice(0, 7);
}
function nextMonth(period) {
  const [y, m] = period.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
function monthEnd(period) {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}
function monthsBetween(from, to) {
  const out = [];
  for (let p = from; p <= to; p = nextMonth(p)) out.push(p);
  return out;
}
function monthlyDepreciation(asset, accumulated) {
  const cost = Math.max(0, asset.cost);
  const salvage = Math.min(Math.max(0, asset.salvage), cost);
  const bookValue = cost - accumulated;
  const room = bookValue - salvage;
  if (!(room > 4e-3)) return 0;
  let charge = 0;
  if (asset.method === "Straight-line" && asset.lifeYears && asset.lifeYears > 0) {
    charge = (cost - salvage) / (asset.lifeYears * 12);
  } else if (asset.method === "Reducing balance" && asset.ratePct && asset.ratePct > 0) {
    charge = bookValue * (asset.ratePct / 100 / 12);
  } else {
    return 0;
  }
  return round2(Math.min(charge, room));
}
function depreciationMonthsDue(purchaseDate, throughMonth, charged, retiredOn) {
  const first = nextMonth(monthOf(purchaseDate));
  const last = retiredOn && monthOf(retiredOn) < throughMonth ? monthOf(retiredOn) : throughMonth;
  return monthsBetween(first, last).filter((p) => !charged.has(p));
}
function splitGross(gross, vatRate) {
  const total = round2(gross);
  const vat = round2(total - total / (1 + vatRate));
  return { net: round2(total - vat), vat, total };
}

// apps/api/src/db.ts
var import_client = require("@prisma/client");
var prisma = new import_client.PrismaClient();

// apps/api/src/accounting/chart.ts
var CUSTOM_EXPENSE_START = 5300;
var CUSTOM_EXPENSE_CEILING = 5999;
async function nextCustomExpenseCode() {
  const rows = await prisma.account.findMany({ where: { type: "Expense" }, select: { code: true } });
  let max = CUSTOM_EXPENSE_START - 10;
  for (const r of rows) {
    const n = Number(r.code);
    if (Number.isFinite(n) && n >= CUSTOM_EXPENSE_START && n <= CUSTOM_EXPENSE_CEILING && n > max) max = n;
  }
  return String(max + 10);
}
async function accountIdForNewExpenseHead(name) {
  const standardCode = EXPENSE_HEAD_ACCOUNT_CODES[name];
  if (standardCode) {
    const acc = await prisma.account.findUnique({ where: { code: standardCode } });
    if (acc && acc.type === "Expense") return acc.id;
  }
  const created = await prisma.account.create({
    data: { code: await nextCustomExpenseCode(), name, type: "Expense", description: `Auto-created for the \u201C${name}\u201D expense head.` }
  });
  return created.id;
}
async function ensureChartOfAccounts() {
  const existing = await prisma.account.findMany({ select: { code: true } });
  const have = new Set(existing.map((a2) => a2.code));
  for (const def of DEFAULT_CHART) {
    if (have.has(def.code)) continue;
    await prisma.account.create({
      data: { code: def.code, name: def.name, type: def.type, subtype: def.subtype, description: def.description || "", system: SYSTEM_ACCOUNT_CODES.includes(def.code) }
    });
  }
  for (const name of EXPENSE_CATEGORIES) {
    const head = await prisma.expenseHead.findUnique({ where: { name } });
    if (!head) await prisma.expenseHead.create({ data: { name, accountId: await accountIdForNewExpenseHead(name) } });
  }
  {
    const cos = await prisma.account.findUnique({ where: { code: ACCT.costOfSales } });
    const head = await prisma.expenseHead.findUnique({ where: { name: "Printing Materials & Consumables" }, include: { account: true } });
    if (cos && head && head.account?.code === "5100") await prisma.expenseHead.update({ where: { id: head.id }, data: { accountId: cos.id } });
  }
  const used = await prisma.expense.findMany({ distinct: ["category"], select: { category: true } });
  for (const { category } of used) {
    if (!await prisma.expenseHead.findUnique({ where: { name: category } })) {
      await prisma.expenseHead.create({ data: { name: category, accountId: await accountIdForNewExpenseHead(category) } });
    }
  }
  for (const head of await prisma.expenseHead.findMany({ where: { accountId: null } })) {
    await prisma.expenseHead.update({ where: { id: head.id }, data: { accountId: await accountIdForNewExpenseHead(head.name) } });
  }
  const byCode = new Map((await prisma.account.findMany()).map((x) => [x.code, x.id]));
  for (const s of await prisma.service.findMany({ where: { accountId: null } })) {
    const id = byCode.get(defaultServiceIncomeCode(s.name)) ?? byCode.get(ACCT.printingIncome);
    if (id) await prisma.service.update({ where: { id: s.id }, data: { accountId: id } });
  }
  if (await prisma.role.count({ where: { canAccessAccounting: true } }) === 0) {
    await prisma.role.updateMany({ where: { name: { in: ["Finance Manager", "General Manager"] } }, data: { canAccessAccounting: true } });
  }
}

// apps/api/src/accounting/depreciation.ts
function previousMonth(period) {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
async function runDepreciation(today = todayStr()) {
  const through = previousMonth(monthOf(today));
  let created = 0;
  const assets = await prisma.asset.findMany({
    where: { depreciationMethod: { not: "None" }, purchaseDate: { not: null }, value: { gt: 0 } },
    include: { depreciations: true }
  });
  for (const a2 of assets) {
    const charged = new Set(a2.depreciations.map((d) => d.period));
    let accumulated = a2.depreciations.reduce((x, d) => x + d.amount, 0);
    for (const period of depreciationMonthsDue(a2.purchaseDate, through, charged, a2.condition === "Retired" ? a2.retiredOn : null)) {
      const amount = monthlyDepreciation(
        { cost: a2.value ?? 0, salvage: a2.salvageValue, method: a2.depreciationMethod, lifeYears: a2.usefulLifeYears, ratePct: a2.depreciationRatePct },
        accumulated
      );
      if (amount <= 0) break;
      try {
        await prisma.assetDepreciation.create({ data: { assetId: a2.id, period, date: monthEnd(period), amount } });
        accumulated += amount;
        created++;
      } catch {
      }
    }
  }
  return created;
}

// apps/api/src/accounting/ledger.ts
async function loadCtx() {
  const [accounts, heads] = await Promise.all([prisma.account.findMany(), prisma.expenseHead.findMany()]);
  return {
    byId: new Map(accounts.map((a2) => [a2.id, a2])),
    byCode: new Map(accounts.map((a2) => [a2.code, a2])),
    expenseHeadAcct: new Map(heads.filter((h) => h.accountId).map((h) => [h.name, h.accountId])),
    vatApplicable: (head) => {
      const set = heads.find((h) => h.name === head)?.vatApplicable;
      return set ?? defaultExpenseVatApplicable(head);
    }
  };
}
function idOf(ctx, code) {
  const a2 = ctx.byCode.get(code);
  if (!a2) throw new Error(`Chart of accounts is missing account ${code}`);
  return a2.id;
}
var Book = class {
  constructor(ctx) {
    this.ctx = ctx;
    this.postings = [];
  }
  push(date, accountId, debit, credit, source, ref, memo) {
    if (!(debit > 0 || credit > 0)) return;
    this.postings.push({ date, accountId, debit: round2(debit), credit: round2(credit), source, ref, memo });
  }
  dr(date, code, amount, source, ref, memo) {
    this.push(date, idOf(this.ctx, code), amount, 0, source, ref, memo);
  }
  cr(date, code, amount, source, ref, memo) {
    this.push(date, idOf(this.ctx, code), 0, amount, source, ref, memo);
  }
  drId(date, accountId, amount, source, ref, memo) {
    this.push(date, accountId, amount, 0, source, ref, memo);
  }
  crId(date, accountId, amount, source, ref, memo) {
    this.push(date, accountId, 0, amount, source, ref, memo);
  }
};
function expenseAcctId(ctx, head) {
  return ctx.expenseHeadAcct.get(head) || idOf(ctx, ACCT.uncategorised);
}
async function journalPostings(book) {
  const entries = await prisma.journalEntry.findMany({ include: { lines: true } });
  for (const e of entries) {
    for (const l of e.lines) {
      book.postings.push({ date: e.date, accountId: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo || e.memo, source: e.source, ref: e.ref });
    }
  }
}
async function expensePostings(book, ctx) {
  const purchaseExpenseIds = new Set((await prisma.purchase.findMany({ where: { expenseId: { not: null } }, select: { expenseId: true } })).map((p) => p.expenseId));
  for (const e of await prisma.expense.findMany({ include: { payments: true } })) {
    const memo = [e.category, e.supplier, e.note].filter(Boolean).join(" \xB7 ");
    const ref = e.invoiceNumber || `EXP-${e.id}`;
    const vat = ctx.vatApplicable(e.category) ? splitGross(e.amount, VAT_RATE).vat : 0;
    const cost = e.amount - vat;
    if (purchaseExpenseIds.has(e.id)) book.dr(e.date, ACCT.costOfSales, cost, "Expense", ref, memo);
    else book.drId(e.date, expenseAcctId(ctx, e.category), cost, "Expense", ref, memo);
    book.dr(e.date, ACCT.vatPayable, vat, "Expense", ref, `Input VAT \u2014 ${memo}`);
    if (e.paid) {
      const wht = e.withholdingTax || 0;
      book.cr(e.date, methodAccountCode(e.method), e.amount - wht, "Expense", ref, memo);
      if (wht > 0) book.cr(e.date, ACCT.whtPayable, wht, "Expense", ref, `Withholding tax \u2014 ${memo}`);
      continue;
    }
    book.cr(e.date, ACCT.payables, e.amount, "Expense", ref, memo);
    for (const p of e.payments) {
      book.dr(p.date, ACCT.payables, p.amount, "Expense", ref, `Payment \u2014 ${memo}`);
      book.cr(p.date, methodAccountCode(p.method), p.amount, "Expense", ref, `Payment \u2014 ${memo}`);
    }
  }
}
async function payrollPostings(book) {
  for (const p of await prisma.payrollEntry.findMany({ include: { staff: true } })) {
    const pay = computePay(p.grossPay, p.employeeType, p.date);
    const ref = `WAGE-${p.id}`;
    const memo = `${p.staff.name} (${p.employeeType}${p.department ? `, ${p.department}` : ""})`;
    const gross = round2(pay.grossPay);
    const paye = round2(pay.paye);
    const nssf = round2(pay.nssf);
    const shif = round2(pay.shif);
    const housing = round2(pay.housingLevy);
    const net = round2(gross - paye - nssf - shif - housing);
    const nssfEr = round2(pay.nssfEmployer);
    const housingEr = round2(pay.housingLevyEmployer);
    const salaryAcct = p.employeeType === "Casual" ? "5110" : ACCT.salaries;
    book.dr(p.date, salaryAcct, gross, "Wages", ref, memo);
    book.dr(p.date, salaryAcct, round2(nssfEr + housingEr), "Wages", ref, `Employer NSSF & housing levy \u2014 ${memo}`);
    book.cr(p.date, methodAccountCode(p.paymentSource), net, "Wages", ref, memo);
    book.cr(p.date, ACCT.payePayable, paye, "Wages", ref, memo);
    book.cr(p.date, ACCT.nssfPayable, round2(nssf + nssfEr), "Wages", ref, memo);
    book.cr(p.date, ACCT.shifPayable, shif, "Wages", ref, memo);
    book.cr(p.date, ACCT.housingLevyPayable, round2(housing + housingEr), "Wages", ref, memo);
  }
}
async function unlinkedPurchasePostings(book) {
  for (const p of await prisma.purchase.findMany({ where: { expenseId: null, status: { not: "Rejected" } }, include: { material: true, lines: { include: { material: true } } } })) {
    const ref = p.poRef ?? `PUR-${p.id}`;
    const what = p.lines.length ? p.lines.map((l) => l.material.name).join(", ") : p.material?.name ?? "stock";
    const memo = `Stock purchase \u2014 ${what}${p.supplier ? ` \u2014 ${p.supplier}` : ""}`;
    book.dr(p.date, ACCT.costOfSales, p.totalCost, "Purchase", ref, memo);
    book.cr(p.date, ACCT.bank, p.totalCost, "Purchase", ref, memo);
  }
}
var TOP_UP_FUNDING = {
  "Bank Withdrawal": ACCT.bank,
  "Cash Sales Allocation": ACCT.cash,
  "Owner Injection": ACCT.capital
};
async function pettyCashTopUpPostings(book) {
  for (const t of await prisma.pettyCashTopUp.findMany()) {
    const ref = `PCT-${t.id}`;
    const memo = `Petty cash top-up \u2014 ${t.source}${t.note ? ` (${t.note})` : ""}`;
    book.dr(t.date, ACCT.pettyCash, t.amount, "Petty cash top-up", ref, memo);
    book.cr(t.date, TOP_UP_FUNDING[t.source] || ACCT.cash, t.amount, "Petty cash top-up", ref, memo);
  }
}
async function orderPostings(book, ctx) {
  const merchandise = idOf(ctx, ACCT.merchandiseIncome);
  const orders = await prisma.order.findMany({
    include: { lineItems: { include: { service: true, material: true } }, payments: { include: { mpesaTransaction: true } }, corporateClient: true }
  });
  for (const o of orders) {
    const party = o.customerName || o.corporateClient?.name || "Customer";
    const memo = `${o.orderNo} \u2014 ${party}`;
    const lines = o.lineItems.map((li) => ({
      itemType: li.itemType,
      serviceId: li.serviceId,
      materialId: li.materialId,
      qty: li.qty,
      unitPrice: li.unitPrice,
      discountPct: li.discountPct,
      discountAmt: li.discountAmt,
      heatPressFee: li.heatPressFee
    }));
    const totals = computeOrderTotals({ lineItems: lines, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt });
    const total = round2(totals.grandTotal);
    const recognised = o.kind === "walkin" || o.status !== "Quote";
    if (recognised && total > 0) {
      const { net, vat } = splitGross(total, VAT_RATE);
      book.dr(o.createdDate, ACCT.receivables, total, "Order", o.orderNo, memo);
      const weights = o.lineItems.map((li, i) => ({ li, w: buildLineTotal(lines[i]) }));
      const wSum = weights.reduce((a2, x) => a2 + x.w, 0) || 1;
      let allocated = 0;
      weights.forEach(({ li, w }, i) => {
        const share = i === weights.length - 1 ? round2(net - allocated) : round2(net * w / wSum);
        allocated += share;
        const accountId = li.itemType === "material" ? li.material?.accountId ?? merchandise : li.service?.accountId ?? idOf(ctx, defaultServiceIncomeCode(li.service?.name ?? ""));
        book.crId(o.createdDate, accountId, share, "Order", o.orderNo, memo);
      });
      book.cr(o.createdDate, ACCT.vatPayable, vat, "Order", o.orderNo, memo);
    }
    for (const p of o.payments) {
      const received = !!p.mpesaTransaction && p.mpesaTransaction.kind !== "STK";
      const label = `Payment (${p.method}${p.reference ? ` ${p.reference}` : ""}) \u2014 ${memo}`;
      if (received) {
        book.dr(p.date, ACCT.unallocatedMpesa, p.amount, "Payment", o.orderNo, label);
      } else {
        book.dr(p.date, methodAccountCode(p.method), p.amount, "Payment", o.orderNo, label);
      }
      book.cr(p.date, recognised ? ACCT.receivables : ACCT.customerCredits, p.amount, "Payment", o.orderNo, label);
    }
  }
}
async function mpesaPostings(book) {
  for (const t of await prisma.mpesaTransaction.findMany({ where: { kind: { in: ["C2B", "Import"] }, status: { in: ["Unmatched", "Applied"] } } })) {
    const date = t.receivedOn || t.createdAt.toISOString().slice(0, 10);
    const ref = t.mpesaReceipt || `MPESA-${t.id}`;
    const memo = `M-Pesa receipt ${t.mpesaReceipt || ""} \u2014 ${t.payerName || t.phone}`.trim();
    book.dr(date, ACCT.mpesa, t.amount, "M-Pesa receipt", ref, memo);
    book.cr(date, ACCT.unallocatedMpesa, t.amount, "M-Pesa receipt", ref, memo);
  }
}
async function notePostings(book, ctx) {
  const purchaseLinked = new Set((await prisma.purchase.findMany({ where: { expenseId: { not: null } }, select: { expenseId: true } })).map((p) => p.expenseId));
  for (const n of await prisma.adjustmentNote.findMany({ include: { expense: true } })) {
    const memo = `${n.number} \u2014 ${n.party} \u2014 ${n.reason}`;
    if (n.type === "Credit") {
      book.dr(n.date, ACCT.salesReturns, n.net, "Credit note", n.number, memo);
      book.dr(n.date, ACCT.vatPayable, n.vat, "Credit note", n.number, memo);
      book.cr(n.date, ACCT.receivables, n.receivableAmt, "Credit note", n.number, memo);
      book.cr(n.date, ACCT.customerCredits, n.creditAmt, "Credit note", n.number, memo);
      if (n.refundAmt > 0 && n.refundMethod) {
        book.dr(n.date, ACCT.customerCredits, n.refundAmt, "Credit note", n.number, `Refund \u2014 ${memo}`);
        book.cr(n.date, methodAccountCode(n.refundMethod), n.refundAmt, "Credit note", n.number, `Refund \u2014 ${memo}`);
      }
    } else if (n.type === "Debit") {
      book.dr(n.date, ACCT.receivables, n.total, "Debit note", n.number, memo);
      if (n.incomeAccountId) book.crId(n.date, n.incomeAccountId, n.net, "Debit note", n.number, memo);
      else book.cr(n.date, ACCT.otherIncome, n.net, "Debit note", n.number, memo);
      book.cr(n.date, ACCT.vatPayable, n.vat, "Debit note", n.number, memo);
    } else {
      book.dr(n.date, ACCT.payables, n.total, "Supplier debit note", n.number, memo);
      const vatShare = n.expense && n.expense.amount > 0 && ctx.vatApplicable(n.expense.category) ? splitGross(n.total, VAT_RATE).vat : 0;
      book.crId(n.date, n.expense ? purchaseLinked.has(n.expense.id) ? idOf(ctx, ACCT.costOfSales) : expenseAcctId(ctx, n.expense.category) : idOf(ctx, ACCT.uncategorised), round2(n.total - vatShare), "Supplier debit note", n.number, memo);
      book.cr(n.date, ACCT.vatPayable, vatShare, "Supplier debit note", n.number, `Input VAT \u2014 ${memo}`);
    }
  }
}
var ASSET_FUNDING = {
  Bank: ACCT.bank,
  Cash: ACCT.cash,
  "M-Pesa": ACCT.mpesa,
  "Petty Cash": ACCT.pettyCash,
  "Owner Capital": ACCT.capital,
  "Opening Balance": ACCT.retainedEarnings
};
async function assetPostings(book) {
  for (const a2 of await prisma.asset.findMany({ include: { depreciations: true } })) {
    const cost = round2(a2.value ?? 0);
    if (cost > 0 && a2.purchaseDate) {
      const memo = `${a2.tag} ${a2.name}`;
      book.dr(a2.purchaseDate, ACCT.fixedAssets, cost, "Asset purchase", a2.tag, memo);
      book.cr(a2.purchaseDate, ASSET_FUNDING[a2.fundedBy] || ACCT.capital, cost, "Asset purchase", a2.tag, `Funded by ${a2.fundedBy} \u2014 ${memo}`);
    }
    for (const d of a2.depreciations) {
      const memo = `Depreciation ${d.period} \u2014 ${a2.tag} ${a2.name}`;
      book.dr(d.date, ACCT.depreciation, d.amount, "Depreciation", `${a2.tag}@${d.period}`, memo);
      book.cr(d.date, ACCT.accumDepreciation, d.amount, "Depreciation", `${a2.tag}@${d.period}`, memo);
    }
  }
}
async function loadLedger() {
  const ctx = await loadCtx();
  const book = new Book(ctx);
  await journalPostings(book);
  await orderPostings(book, ctx);
  await mpesaPostings(book);
  await expensePostings(book, ctx);
  await unlinkedPurchasePostings(book);
  await payrollPostings(book);
  await pettyCashTopUpPostings(book);
  await notePostings(book, ctx);
  await assetPostings(book);
  return { accounts: [...ctx.byId.values()], byId: ctx.byId, byCode: ctx.byCode, postings: book.postings };
}
function sumByAccount(postings, filter) {
  const out = /* @__PURE__ */ new Map();
  for (const p of postings) {
    if (filter && !filter(p)) continue;
    const cur = out.get(p.accountId) || { debit: 0, credit: 0 };
    cur.debit += p.debit;
    cur.credit += p.credit;
    out.set(p.accountId, cur);
  }
  return out;
}
function naturalBalance(type, b) {
  if (!b) return 0;
  return round2(isDebitNormal(type) ? b.debit - b.credit : b.credit - b.debit);
}

// apps/api/src/accounting/reports.ts
var inRange = (d, from, to) => d >= from && d <= to;
async function buildBalanceSheet(asOf) {
  const ledger = await loadLedger();
  const sums = sumByAccount(ledger.postings, (p) => p.date <= asOf);
  const line = (type) => ledger.accounts.filter((a2) => a2.type === type).sort((a2, b) => a2.code.localeCompare(b.code)).map((a2) => ({ id: a2.id, code: a2.code, name: a2.name, subtype: a2.subtype, amount: naturalBalance(a2.type, sums.get(a2.id)) })).filter((r) => Math.abs(r.amount) > 4e-3);
  const total = (rows) => round2(rows.reduce((a2, r) => a2 + r.amount, 0));
  const assets = line("Asset");
  const liabilities = line("Liability");
  const equityAccounts = line("Equity");
  const currentEarnings = round2(total(line("Income")) - total(line("Expense")));
  const equity = [
    ...equityAccounts,
    { id: 0, code: "", name: "Profit earned to date (not yet closed to retained earnings)", subtype: "CurrentEarnings", amount: currentEarnings }
  ];
  const totalAssets = total(assets);
  const totalLiabilities = total(liabilities);
  const totalEquity = total(equity);
  return {
    asOf,
    assets: { rows: assets, total: totalAssets },
    liabilities: { rows: liabilities, total: totalLiabilities },
    equity: { rows: equity, total: totalEquity },
    liabilitiesAndEquity: round2(totalLiabilities + totalEquity),
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01
  };
}
async function buildTrialBalance(asOf) {
  const ledger = await loadLedger();
  const sums = sumByAccount(ledger.postings, (p) => p.date <= asOf);
  const rows = ledger.accounts.sort((a2, b) => a2.code.localeCompare(b.code)).map((a2) => {
    const b = sums.get(a2.id) || { debit: 0, credit: 0 };
    const net = round2(b.debit - b.credit);
    return { id: a2.id, code: a2.code, name: a2.name, type: a2.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  }).filter((r) => r.debit > 4e-3 || r.credit > 4e-3);
  const debit = round2(rows.reduce((x, r) => x + r.debit, 0));
  const credit = round2(rows.reduce((x, r) => x + r.credit, 0));
  return { asOf, rows, debit, credit, balanced: Math.abs(debit - credit) < 0.01 };
}
var AGE_BUCKETS = ["Not yet due", "0\u201330 days", "31\u201360 days", "61\u201390 days", "Over 90 days"];
function ageBucket(ageDays) {
  return ageDays < 0 ? "Not yet due" : ageDays <= 30 ? "0\u201330 days" : ageDays <= 60 ? "31\u201360 days" : ageDays <= 90 ? "61\u201390 days" : "Over 90 days";
}
var daysBetween = (from, to) => Math.floor(((/* @__PURE__ */ new Date(to + "T00:00:00")).getTime() - (/* @__PURE__ */ new Date(from + "T00:00:00")).getTime()) / 864e5);
async function buildPayablesAging(asOf) {
  const entries = await prisma.expense.findMany({ where: { paid: false, date: { lte: asOf } }, include: { payments: true, notes: true } });
  const rows = entries.map((e) => {
    const paidAmount = round2(e.payments.filter((p) => p.date <= asOf).reduce((a2, p) => a2 + p.amount, 0));
    const credited = round2(e.notes.filter((n) => n.type === "SupplierDebit" && n.date <= asOf).reduce((a2, n) => a2 + n.total, 0));
    const outstanding = round2(e.amount - paidAmount - credited);
    const ageDays = daysBetween(e.dueDate ?? e.date, asOf);
    return { id: e.id, date: e.date, dueDate: e.dueDate, supplier: e.supplier, head: e.category, invoice: e.invoiceNumber, amount: e.amount, paidAmount, credited, outstanding, ageDays, bucket: ageBucket(ageDays) };
  }).filter((r) => r.outstanding > 4e-3).sort((a2, b) => b.ageDays - a2.ageDays);
  const byBucket = AGE_BUCKETS.map((bucket) => ({ bucket, total: round2(rows.filter((r) => r.bucket === bucket).reduce((a2, r) => a2 + r.outstanding, 0)) }));
  return { asOf, rows, total: round2(rows.reduce((a2, r) => a2 + r.outstanding, 0)), byBucket };
}
async function buildReceivablesAging(asOf) {
  const orders = await prisma.order.findMany({
    where: { createdDate: { lte: asOf } },
    include: { lineItems: true, payments: true, corporateClient: true, notes: true }
  });
  let credits = 0;
  const rows = [];
  for (const o of orders) {
    if (!(o.kind === "walkin" || o.status !== "Quote")) continue;
    const lines = o.lineItems.map((li) => ({
      itemType: li.itemType,
      serviceId: li.serviceId,
      materialId: li.materialId,
      qty: li.qty,
      unitPrice: li.unitPrice,
      discountPct: li.discountPct,
      discountAmt: li.discountAmt,
      heatPressFee: li.heatPressFee
    }));
    const amount = round2(computeOrderTotals({ lineItems: lines, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt }).grandTotal);
    const paid = round2(o.payments.filter((p) => p.date <= asOf).reduce((a2, p) => a2 + p.amount, 0));
    const adjustments = round2(
      o.notes.filter((n) => n.date <= asOf).reduce((a2, n) => a2 + (n.type === "Credit" ? -n.receivableAmt : n.type === "Debit" ? n.total : 0), 0)
    );
    const outstanding = round2(amount + adjustments - paid);
    if (outstanding < -4e-3) credits += outstanding;
    if (!(outstanding > 4e-3)) continue;
    const ageDays = daysBetween(o.dueDate ?? o.createdDate, asOf);
    rows.push({
      orderId: o.id,
      ref: o.orderNo,
      party: o.customerName || o.corporateClient?.name || "Customer",
      status: o.status,
      date: o.createdDate,
      dueDate: o.dueDate,
      amount,
      paid,
      adjustments,
      outstanding,
      ageDays,
      bucket: ageBucket(ageDays)
    });
  }
  rows.sort((a2, b) => b.ageDays - a2.ageDays);
  const byBucket = AGE_BUCKETS.map((bucket) => ({ bucket, total: round2(rows.filter((r) => r.bucket === bucket).reduce((a2, r) => a2 + r.outstanding, 0)) }));
  return { asOf, rows, total: round2(rows.reduce((a2, r) => a2 + r.outstanding, 0)), byBucket, overpaidCredits: round2(credits) };
}
async function buildCashFlowStatement(from, to) {
  const ledger = await loadLedger();
  const cashIds = new Set(CASH_ACCOUNT_CODES.map((c) => ledger.byCode.get(c)?.id).filter((id) => !!id));
  const isCash = (p) => cashIds.has(p.accountId);
  const cashBalanceAsOf = (cutoff) => ledger.postings.filter((p) => isCash(p) && cutoff(p.date)).reduce((a2, p) => a2 + p.debit - p.credit, 0);
  const openingCash = round2(cashBalanceAsOf((d) => d < from));
  const closingCash = round2(cashBalanceAsOf((d) => d <= to));
  const moves = ledger.postings.filter((p) => isCash(p) && inRange(p.date, from, to) && p.source !== "Opening");
  const legsByEntry = /* @__PURE__ */ new Map();
  for (const p of ledger.postings) {
    if (!inRange(p.date, from, to)) continue;
    const k = `${p.source}\0${p.ref}\0${p.date}`;
    legsByEntry.set(k, [...legsByEntry.get(k) || [], p]);
  }
  const STATIC = { Capital: "Financing", Drawings: "Financing", "Asset purchase": "Investing" };
  const bucketFor = (p) => {
    if (STATIC[p.source]) return STATIC[p.source];
    const legs = legsByEntry.get(`${p.source}\0${p.ref}\0${p.date}`) || [];
    const other = legs.filter((l) => !isCash(l));
    if (other.length === 0) return "Internal";
    if (p.source === "Petty cash top-up") {
      return other.some((l) => ledger.byId.get(l.accountId)?.type === "Equity") ? "Financing" : "Internal";
    }
    if (["Manual", "BankDeposit", "TaxPayment"].includes(p.source) || p.source === "Opening") {
      const types = new Set(other.map((l) => ledger.byId.get(l.accountId)?.type));
      if (types.has("Equity") || other.some((l) => ledger.byId.get(l.accountId)?.code === ACCT.loans)) return "Financing";
      if (other.some((l) => ledger.byId.get(l.accountId)?.subtype === "FixedAsset")) return "Investing";
    }
    return "Operating";
  };
  const totals = { Operating: 0, Investing: 0, Financing: 0, Internal: 0 };
  const bySource = /* @__PURE__ */ new Map();
  for (const p of moves) {
    const bucket = bucketFor(p);
    const signed = p.debit - p.credit;
    totals[bucket] += signed;
    const key2 = `${bucket}:${p.source}`;
    const row = bySource.get(key2) || { source: p.source, bucket, amount: 0 };
    row.amount += signed;
    bySource.set(key2, row);
  }
  const lines = [...bySource.values()].map((r) => ({ ...r, amount: round2(r.amount) })).filter((r) => Math.abs(r.amount) > 4e-3);
  const section = (bucket) => ({ total: round2(totals[bucket]), lines: lines.filter((l) => l.bucket === bucket) });
  const netChange = round2(totals.Operating + totals.Investing + totals.Financing);
  return {
    from,
    to,
    openingCash,
    closingCash,
    netChange,
    operating: section("Operating"),
    investing: section("Investing"),
    financing: section("Financing"),
    internalTransfers: round2(totals.Internal),
    reconciles: Math.abs(round2(openingCash + netChange + totals.Internal) - closingCash) < 0.01
  };
}

// apps/api/src/accounting/reconcile.ts
var key = (source, ref) => `${source}\0${ref}`;
var fmt = (n) => `Ksh ${Math.round(n).toLocaleString("en-KE")}`;
async function reconcile(from, to, asOf) {
  const ledger = await loadLedger();
  const inWindow = (d) => d >= from && d <= to;
  const salesPosted = /* @__PURE__ */ new Map();
  const expensePosted = /* @__PURE__ */ new Map();
  const cashPosted = /* @__PURE__ */ new Map();
  const add = (m, k, v) => m.set(k, round2((m.get(k) || 0) + v));
  const cashIds = new Set([ACCT.cash, ACCT.mpesa, ACCT.card, ACCT.bank, ACCT.pettyCash].map((c) => ledger.byCode.get(c)?.id));
  for (const p of ledger.postings) {
    const a2 = ledger.byId.get(p.accountId);
    if (!a2) continue;
    const k = key(p.source, p.ref);
    if (p.source === "Order" && (a2.type === "Income" || a2.code === ACCT.vatPayable)) add(salesPosted, k, p.credit - p.debit);
    if (a2.type === "Expense") add(expensePosted, k, p.debit - p.credit);
    if (p.source === "Expense" && a2.code === ACCT.vatPayable) add(expensePosted, k, p.debit - p.credit);
    if (p.source === "Payment" && cashIds.has(a2.id)) add(cashPosted, k, p.debit - p.credit);
    if (p.source === "Payment" && a2.code === ACCT.unallocatedMpesa) add(cashPosted, k, p.debit - p.credit);
  }
  const expected = [];
  const bucket = (source, label, side) => {
    const b = { source, label, side, items: /* @__PURE__ */ new Map() };
    expected.push(b);
    return b;
  };
  const put = (b, ref, amount) => b.items.set(ref, round2((b.items.get(ref) || 0) + amount));
  const orders = await prisma.order.findMany({ include: { lineItems: true, payments: true } });
  const orderSales = bucket("Order", "Orders (invoiced / walk-in)", "sales");
  const orderPayments = bucket("Payment", "Order payments received", "cash");
  const overpaid = [];
  for (const o of orders) {
    const lines = o.lineItems.map((li) => ({
      itemType: li.itemType,
      serviceId: li.serviceId,
      materialId: li.materialId,
      qty: li.qty,
      unitPrice: li.unitPrice,
      discountPct: li.discountPct,
      discountAmt: li.discountAmt,
      heatPressFee: li.heatPressFee
    }));
    const total = round2(computeOrderTotals({ lineItems: lines, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt }).grandTotal);
    if ((o.kind === "walkin" || o.status !== "Quote") && total > 0) put(orderSales, o.orderNo, total);
    const paid = round2(o.payments.reduce((a2, p) => a2 + p.amount, 0));
    if (paid > 0) put(orderPayments, o.orderNo, paid);
    if (paid > total + 0.5 && (o.kind === "walkin" || o.status !== "Quote")) {
      overpaid.push({ source: "Order payments received", ref: o.orderNo, expected: total, posted: paid, problem: "Paid more than the order is worth \u2014 the extra sits as a credit owed to the customer" });
    }
  }
  const expenses = bucket("Expense", "Expense entries", "expenses");
  for (const e of await prisma.expense.findMany()) put(expenses, e.invoiceNumber || `EXP-${e.id}`, e.amount);
  const purchases = bucket("Purchase", "Stock purchases with no expense (cost of sales)", "expenses");
  for (const p of await prisma.purchase.findMany({ where: { expenseId: null, status: { not: "Rejected" } } })) put(purchases, `PUR-${p.id}`, p.totalCost);
  const wages = bucket("Wages", "Wages & salaries (gross pay + employer's NSSF and housing levy)", "expenses");
  for (const p of await prisma.payrollEntry.findMany()) {
    const pay = computePay(p.grossPay, p.employeeType, p.date);
    put(wages, `WAGE-${p.id}`, round2(p.grossPay) + round2(pay.nssfEmployer) + round2(pay.housingLevyEmployer));
  }
  const dep = bucket("Depreciation", "Asset depreciation", "expenses");
  for (const d of await prisma.assetDepreciation.findMany({ include: { asset: true } })) put(dep, `${d.asset.tag}@${d.period}`, d.amount);
  const sources = [];
  const issues = [...overpaid];
  for (const b of expected) {
    const posted = b.side === "sales" ? salesPosted : b.side === "cash" ? cashPosted : expensePosted;
    let expectedTotal = 0;
    let postedTotal = 0;
    for (const [ref, exp] of b.items) {
      expectedTotal += exp;
      const got = posted.get(key(b.source, ref)) || 0;
      postedTotal += got;
      if (Math.abs(exp - got) > 0.02) {
        issues.push({ source: b.label, ref, expected: round2(exp), posted: round2(got), problem: got === 0 ? "Not posted to the books" : "Posted for a different amount" });
      }
    }
    for (const [k, v] of posted) {
      const [source, ref] = k.split("\0");
      if (source === b.source && !b.items.has(ref) && Math.abs(v) > 0.02) {
        issues.push({ source: b.label, ref, expected: 0, posted: round2(v), problem: "Posted, but the record itself shows nothing to book" });
      }
    }
    sources.push({ source: b.source, label: b.label, side: b.side, records: b.items.size, expected: round2(expectedTotal), posted: round2(postedTotal), difference: round2(postedTotal - expectedTotal) });
  }
  const integrity = [];
  const tb = await buildTrialBalance(asOf);
  integrity.push({ name: "Debits equal credits (trial balance)", ok: tb.balanced, detail: tb.balanced ? `Both sides total ${fmt(tb.debit)}` : `Debits ${fmt(tb.debit)} vs credits ${fmt(tb.credit)} \u2014 out by ${fmt(Math.abs(tb.debit - tb.credit))}` });
  const bs = await buildBalanceSheet(asOf);
  integrity.push({ name: "Balance sheet balances (assets = liabilities + equity)", ok: bs.balanced, detail: bs.balanced ? `Assets ${fmt(bs.assets.total)}` : `Assets ${fmt(bs.assets.total)} vs liabilities + equity ${fmt(bs.liabilitiesAndEquity)}` });
  const sums = sumByAccount(ledger.postings, (p) => p.date <= asOf);
  const bal = (code) => {
    const a2 = ledger.byCode.get(code);
    return a2 ? naturalBalance(a2.type, sums.get(a2.id)) : 0;
  };
  const ar = await buildReceivablesAging(asOf);
  const arLedger = bal(ACCT.receivables);
  const arExpected = round2(ar.total + ar.overpaidCredits);
  integrity.push({ name: "Accounts Receivable agrees with the receivables ageing", ok: Math.abs(arLedger - arExpected) < 0.02, detail: `Ledger ${fmt(arLedger)} vs ageing ${fmt(arExpected)}` });
  const ap = await buildPayablesAging(asOf);
  const apLedger = bal(ACCT.payables);
  const unpaidIds = new Set((await prisma.expense.findMany({ where: { paid: false }, select: { id: true } })).map((e) => e.id));
  const looseSupplierNotes = (await prisma.adjustmentNote.findMany({ where: { type: "SupplierDebit", date: { lte: asOf } } })).filter((n) => !n.expenseId || !unpaidIds.has(n.expenseId)).reduce((a2, n) => a2 + n.total, 0);
  const apExpected = round2(ap.total - looseSupplierNotes);
  integrity.push({ name: "Accounts Payable agrees with the payables ageing", ok: Math.abs(apLedger - apExpected) < 0.02, detail: `Ledger ${fmt(apLedger)} vs ageing ${fmt(apExpected)}` });
  const petty = ledger.byCode.get(ACCT.pettyCash);
  let pettyLow = null;
  if (petty) {
    const byDay = /* @__PURE__ */ new Map();
    for (const p of ledger.postings.filter((x) => x.accountId === petty.id)) byDay.set(p.date, (byDay.get(p.date) || 0) + p.debit - p.credit);
    let run = 0;
    for (const d of [...byDay.keys()].sort()) {
      run = round2(run + byDay.get(d));
      if (run < -5e-3 && (!pettyLow || run < pettyLow.balance)) pettyLow = { date: d, balance: run };
    }
  }
  integrity.push({ name: "Petty cash was never overdrawn", ok: !pettyLow, detail: pettyLow ? `Went to ${fmt(pettyLow.balance)} on ${pettyLow.date}` : `Float now ${fmt(bal(ACCT.pettyCash))}` });
  const cf = await buildCashFlowStatement(from, to);
  integrity.push({ name: "Cash flow statement reconciles to the cash accounts", ok: cf.reconciles, detail: `Opening ${fmt(cf.openingCash)} \u2192 closing ${fmt(cf.closingCash)}` });
  const unmatched = await prisma.mpesaTransaction.findMany({ where: { kind: { in: ["C2B", "Import"] }, status: "Unmatched" } });
  const unmatchedTotal = round2(unmatched.reduce((a2, t) => a2 + t.amount, 0));
  integrity.push({ name: "No M-Pesa receipts waiting to be matched", ok: unmatched.length === 0, detail: unmatched.length ? `${unmatched.length} receipt(s), ${fmt(unmatchedTotal)}, held in Unallocated M-Pesa Receipts` : "Every M-Pesa receipt is matched or dismissed" });
  const unallocated = bal(ACCT.unallocatedMpesa);
  integrity.push({ name: "Unallocated M-Pesa account equals the unmatched receipts", ok: Math.abs(unallocated - unmatchedTotal) < 0.02, detail: `Account ${fmt(unallocated)} vs receipts ${fmt(unmatchedTotal)}` });
  const catchAll = [];
  const heads = await prisma.expenseHead.findMany();
  const linkedHeads = new Set(heads.filter((h) => h.accountId).map((h) => h.name));
  for (const e of await prisma.expense.findMany()) {
    if (!linkedHeads.has(e.category)) catchAll.push({ kind: "expense", ref: e.invoiceNumber || `EXP-${e.id}`, head: e.category, amount: e.amount, account: "6999 Uncategorised Expenses" });
  }
  const notInBooks = [];
  const assets = (await prisma.asset.findMany({ where: { OR: [{ purchaseDate: null }, { value: null }] } })).filter((a2) => a2.condition !== "Retired");
  notInBooks.push({
    label: "Assets with no purchase date or value (not on the balance sheet)",
    amount: 0,
    count: assets.length,
    note: "Give each asset a purchase date and cost in the Asset Register so it is capitalised and can depreciate."
  });
  const undepreciated = await prisma.asset.findMany({ where: { depreciationMethod: "None", value: { gt: 0 }, condition: { not: "Retired" } } });
  notInBooks.push({
    label: "Assets with no depreciation method set",
    amount: round2(undepreciated.reduce((a2, x) => a2 + (x.value ?? 0), 0)),
    count: undepreciated.length,
    note: "These stay on the balance sheet at full cost. Set a method and useful life in the Asset Register for them to depreciate automatically."
  });
  const unverified = (await prisma.payment.findMany({ where: { method: "M-Pesa", reference: null } })).filter((p) => inWindow(p.date));
  notInBooks.push({
    label: "M-Pesa payments recorded with no M-Pesa receipt code",
    amount: round2(unverified.reduce((a2, p) => a2 + p.amount, 0)),
    count: unverified.length,
    note: "Without the receipt code these cannot be matched against the M-Pesa statement. Add the code when recording an M-Pesa payment."
  });
  const allPosted = issues.length === 0 && catchAll.length === 0 && integrity.every((c) => c.ok);
  return { sources, issues, integrity, catchAll, notInBooks, allPosted };
}

// apps/api/prisma/books-check.ts
var prisma2 = new import_client2.PrismaClient();
async function main() {
  const today = todayStr();
  const from = process.argv[2] || `${today.slice(0, 4)}-01-01`;
  const to = process.argv[3] || today;
  await ensureChartOfAccounts();
  const charged = await runDepreciation();
  if (charged) console.log(`Depreciation: ${charged} monthly charge(s) posted.
`);
  const r = await reconcile(from, to, to);
  console.log(`Books check ${from} \u2192 ${to}
`);
  for (const c of r.integrity) console.log(`${c.ok ? "OK  " : "FAIL"}  ${c.name} \u2014 ${c.detail}`);
  console.log("");
  for (const s of r.sources) console.log(`${s.label.padEnd(36)} ${String(s.records).padStart(4)} records   expected ${s.expected.toFixed(2).padStart(14)}   posted ${s.posted.toFixed(2).padStart(14)}   diff ${s.difference.toFixed(2)}`);
  if (r.issues.length) {
    console.log("\nIssues:");
    for (const i of r.issues) console.log(`  ${i.source} ${i.ref}: expected ${i.expected}, posted ${i.posted} \u2014 ${i.problem}`);
  }
  if (r.catchAll.length) {
    console.log("\nBooked to a catch-all account:");
    for (const c of r.catchAll) console.log(`  ${c.ref} (${c.head}) ${c.amount} -> ${c.account}`);
  }
  console.log("\nNot (fully) in the books:");
  for (const n of r.notInBooks) if (n.count) console.log(`  ${n.label}: ${n.count} (${n.amount.toFixed(2)})`);
  const tb = await buildTrialBalance(to);
  const bs = await buildBalanceSheet(to);
  console.log(`
Trial balance: debits ${tb.debit.toFixed(2)} / credits ${tb.credit.toFixed(2)}${tb.balanced ? "" : "  *** OUT OF BALANCE ***"}`);
  console.log(`Balance sheet: assets ${bs.assets.total.toFixed(2)} = liabilities ${bs.liabilities.total.toFixed(2)} + equity ${bs.equity.total.toFixed(2)}${bs.balanced ? "" : "  *** DOES NOT BALANCE ***"}`);
  console.log(r.allPosted ? "\nAll good: everything reaches the books." : "\nSomething needs attention \u2014 see above.");
  if (!r.allPosted) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(() => prisma2.$disconnect());
