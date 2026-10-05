import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission } from '../middleware/auth';
import {
  computeOrderTotals,
  computePay,
  EXPENSE_METHODS,
  PETTY_CASH_SOURCES,
  PETTY_CASH_METHOD,
  ACCT,
  VAT_RATE,
  buildLineTotal,
  cleanKraPin,
  cleanNationalId,
  cleanShifNumber,
  defaultExpenseVatApplicable,
  round2,
  splitGross,
} from '@glm/shared';
import { ensureStaffNamesOnce } from '../staffNames';
import type { LineItemInput } from '@glm/shared';
import { ensureChartOnce, accountIdForNewExpenseHead } from '../accounting/chart';
import { loadLedger, pettyCashBalance, pettyCashShortfall } from '../accounting/ledger';

export const financeRouter = Router();
financeRouter.use(requireAuth, requirePermission('canAccessFinance'));

function inRange(d: string, from: string, to: string): boolean {
  return d >= from && d <= to;
}

function parseRange(req: { query: Record<string, unknown> }): { from: string; to: string } | null {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  return { from, to };
}

// Current Petty Cash float, read from the ledger (accounting/ledger.ts) so the float, the books and the
// insufficient-funds guards on new expenses/wages always agree on one number: top-ups in, minus every expense paid from
// petty cash, minus the net pay of every pay-run paid from it, minus petty-cash refunds. Shared with Stock's purchase flow.
export async function computePettyCashBalance(asOfDate?: string): Promise<number> {
  return pettyCashBalance(asOfDate);
}

function shortMessage(available: number, needed: number): string {
  return `Insufficient petty cash balance (Ksh ${Math.round(available).toLocaleString('en-KE')} available, Ksh ${Math.round(needed).toLocaleString('en-KE')} needed)`;
}

// ── Payroll (also backs the NSSF/SHIF derived views on the frontend) ───────
financeRouter.get('/payroll', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });

  const entries = await prisma.payrollEntry.findMany({
    where: { date: { gte: range.from, lte: range.to } },
    include: { staff: true },
    orderBy: { date: 'desc' },
  });

  const rows = entries.map((e) => {
    const pay = computePay(e.grossPay, e.employeeType as 'Employee' | 'Casual', e.date);
    return {
      id: e.id,
      date: e.date,
      staffId: e.staffId,
      name: e.staff.name,
      nationalId: e.staff.nationalId,
      kraPin: e.staff.kraPin,
      shifNumber: e.staff.shifNumber,
      employeeType: e.employeeType,
      department: e.department,
      daysWorked: e.daysWorked,
      rate: e.rate,
      paymentSource: e.paymentSource,
      capturedByName: e.capturedByName,
      ...pay,
    };
  });

  const totals = rows.reduce(
    (a, r) => ({
      grossPayroll: a.grossPayroll + r.grossPay,
      totalStatutory: a.totalStatutory + r.totalDeductions,
      netPayroll: a.netPayroll + r.netPay,
      totalPaye: a.totalPaye + r.paye,
      totalNssf: a.totalNssf + r.nssf,
      totalNssfEmployer: a.totalNssfEmployer + r.nssfEmployer,
      totalShif: a.totalShif + r.shif,
      totalHousingLevy: a.totalHousingLevy + r.housingLevy,
      totalHousingLevyEmployer: a.totalHousingLevyEmployer + r.housingLevyEmployer,
    }),
    { grossPayroll: 0, totalStatutory: 0, netPayroll: 0, totalPaye: 0, totalNssf: 0, totalNssfEmployer: 0, totalShif: 0, totalHousingLevy: 0, totalHousingLevyEmployer: 0 },
  );

  res.json({ fromDate: range.from, toDate: range.to, rows, ...totals });
});

// ── Employee details (Compliance → Employees) ─────────────────────────────
// The identifiers payroll and the P9 need for each person: National ID, KRA PIN and SHIF registration number. Optional, tidied on the way in
// (KRA PIN in capitals, spaces removed), and National ID / KRA PIN cannot belong to two people.
financeRouter.get('/employees', async (_req, res) => {
  await ensureStaffNamesOnce();
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  res.json(users.map((u) => ({ id: u.id, name: u.name, firstName: u.firstName, middleName: u.middleName, lastName: u.lastName, role: u.role, nationalId: u.nationalId, kraPin: u.kraPin, shifNumber: u.shifNumber })));
});

const employeeSchema = z.object({
  nationalId: z.string().max(40).optional().default(''),
  kraPin: z.string().max(40).optional().default(''),
  shifNumber: z.string().max(60).optional().default(''),
});

financeRouter.put('/employees/:id', async (req, res) => {
  const parsed = employeeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const id = Number(req.params.id);
  if (!(await prisma.user.findUnique({ where: { id } }))) return res.status(404).json({ error: 'Staff member not found' });
  const nationalId = cleanNationalId(parsed.data.nationalId);
  const kraPin = cleanKraPin(parsed.data.kraPin);
  const shif = cleanShifNumber(parsed.data.shifNumber);
  const problem = nationalId.error ?? kraPin.error ?? shif.error;
  if (problem) return res.status(400).json({ error: problem });
  if (nationalId.value) {
    const other = await prisma.user.findFirst({ where: { nationalId: nationalId.value, id: { not: id } } });
    if (other) return res.status(400).json({ error: `That National ID number is already recorded for ${other.name}` });
  }
  if (kraPin.value) {
    const other = await prisma.user.findFirst({ where: { kraPin: kraPin.value, id: { not: id } } });
    if (other) return res.status(400).json({ error: `That KRA PIN is already recorded for ${other.name}` });
  }
  const u = await prisma.user.update({ where: { id }, data: { nationalId: nationalId.value, kraPin: kraPin.value, shifNumber: shif.value } });
  res.json({ id: u.id, name: u.name, nationalId: u.nationalId, kraPin: u.kraPin, shifNumber: u.shifNumber });
});

// ── P9 (tax deduction card) ───────────────────────────────────────────────
// A year's pay and tax for each employee, month by month, worked out exactly as the payroll works it out: NSSF, SHIF and the housing levy come off
// the gross pay first, PAYE is charged on the taxable pay that is left by the monthly bands, less the personal relief. Casuals carry no PAYE, so they have no P9.
financeRouter.get('/p9', async (req, res) => {
  const year = String(req.query.year || '');
  if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: 'year (YYYY) is required' });
  const staffId = req.query.staffId ? Number(req.query.staffId) : null;
  const entries = await prisma.payrollEntry.findMany({
    where: { employeeType: 'Employee', date: { gte: `${year}-01-01`, lte: `${year}-12-31` }, ...(staffId ? { staffId } : {}) },
    include: { staff: true },
    orderBy: { date: 'asc' },
  });
  const setting = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });

  type Month = { month: number; gross: number; nssf: number; shif: number; housingLevy: number; taxable: number; taxCharged: number; relief: number; paye: number };
  const blank = (m: number): Month => ({ month: m, gross: 0, nssf: 0, shif: 0, housingLevy: 0, taxable: 0, taxCharged: 0, relief: 0, paye: 0 });
  const people = new Map<number, { staff: (typeof entries)[number]['staff']; months: Month[] }>();
  for (const e of entries) {
    let p = people.get(e.staffId);
    if (!p) people.set(e.staffId, (p = { staff: e.staff, months: Array.from({ length: 12 }, (_, i) => blank(i + 1)) }));
    const m = p.months[Number(e.date.slice(5, 7)) - 1]!;
    const pay = computePay(e.grossPay, 'Employee', e.date);
    m.gross += pay.grossPay;
    m.nssf += pay.nssf;
    m.shif += pay.shif;
    m.housingLevy += pay.housingLevy;
    m.taxable += pay.taxablePay;
    m.taxCharged += pay.taxCharged;
    m.relief += pay.personalRelief;
    m.paye += pay.paye;
  }
  const rounded = (m: Month): Month => ({ month: m.month, gross: round2(m.gross), nssf: round2(m.nssf), shif: round2(m.shif), housingLevy: round2(m.housingLevy), taxable: round2(m.taxable), taxCharged: round2(m.taxCharged), relief: round2(m.relief), paye: round2(m.paye) });
  const employees = [...people.values()]
    .map((p) => {
      const months = p.months.map(rounded);
      const totals = months.reduce((a, m) => ({ gross: a.gross + m.gross, nssf: a.nssf + m.nssf, shif: a.shif + m.shif, housingLevy: a.housingLevy + m.housingLevy, taxable: a.taxable + m.taxable, taxCharged: a.taxCharged + m.taxCharged, relief: a.relief + m.relief, paye: a.paye + m.paye }), { gross: 0, nssf: 0, shif: 0, housingLevy: 0, taxable: 0, taxCharged: 0, relief: 0, paye: 0 });
      return {
        staff: { id: p.staff.id, name: p.staff.name, firstName: p.staff.firstName, middleName: p.staff.middleName, lastName: p.staff.lastName, nationalId: p.staff.nationalId, kraPin: p.staff.kraPin, shifNumber: p.staff.shifNumber },
        months,
        totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round2(v)])),
      };
    })
    .sort((a, b) => a.staff.name.localeCompare(b.staff.name));

  res.json({ year, employer: { name: setting.legalName?.trim() || setting.companyName, tradingName: setting.companyName, kraPin: setting.kraPin || null, address: setting.companyAddress }, employees });
});


// Employees are paid a fixed monthly salary (grossPay entered directly) —
// no daysWorked/rate. Casuals stay day-rate (grossPay = daysWorked * rate).
const payrollSchema = z.discriminatedUnion('employeeType', [
  z.object({
    employeeType: z.literal('Employee'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    staffId: z.number().int(),
    department: z.string().max(100).optional(),
    grossPay: z.number().positive(),
    paymentSource: z.string().optional(), // ignored: wages are always paid from petty cash
  }),
  z.object({
    employeeType: z.literal('Casual'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    staffId: z.number().int(),
    department: z.string().max(100).optional(),
    daysWorked: z.number().positive(),
    rate: z.number().positive(),
    paymentSource: z.string().optional(), // ignored: wages are always paid from petty cash
  }),
]);

financeRouter.post('/payroll', async (req, res) => {
  const parsed = payrollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const data = parsed.data;

  const staff = await prisma.user.findUnique({ where: { id: data.staffId } });
  if (!staff) return res.status(400).json({ error: 'Selected staff member not found' });

  const grossPay = data.employeeType === 'Employee' ? data.grossPay : data.daysWorked * data.rate;

  // Wages are always paid out of petty cash — net pay leaves the float, so the float must cover it (on the pay date and
  // on every later day). The statutory deductions are held as liabilities until remitted.
  const netPay = computePay(grossPay, data.employeeType, data.date).netPay;
  const check = await pettyCashShortfall(netPay, data.date);
  if (check.short) return res.status(400).json({ error: shortMessage(check.available, netPay) });

  const entry = await prisma.payrollEntry.create({
    data: {
      date: data.date,
      staffId: data.staffId,
      employeeType: data.employeeType,
      department: data.department ?? '',
      daysWorked: data.employeeType === 'Casual' ? data.daysWorked : null,
      rate: data.employeeType === 'Casual' ? data.rate : null,
      grossPay,
      paymentSource: PETTY_CASH_METHOD,
      capturedByName: req.user!.name,
    },
  });
  res.status(201).json({ ...entry, name: staff.name });
});

// No direct DELETE for payroll — see the generic DeletionRequest flow below.

// ── VAT — output VAT on real sales for the period ───────────────────────────
interface OrderForVat {
  kind: string;
  status: string;
  createdDate: string;
  orderDiscountPct: number;
  orderDiscountAmt: number;
  lineItems: LineItemInput[];
}

// The VAT return, worked out from the books so it always agrees with them: Output VAT is the VAT on sales (every order that is a sale — a
// walk-in or anything past Quote — less credit notes, plus debit notes); Input VAT is what was claimed on purchases and expenses (supplier
// tax invoices); Net VAT payable is the difference. (Prices are VAT-inclusive at 16%.)
const VAT_SALE_SOURCES = new Set(['Order', 'Debit note', 'Credit note']);
const VAT_PURCHASE_SOURCES = new Set(['Expense', 'Supplier debit note']);

financeRouter.get('/vat', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });

  const ledger = await loadLedger();
  const vatAcct = ledger.byCode.get(ACCT.vatPayable);
  let outputVat = 0;
  let inputVat = 0;
  let otherVat = 0; // anything else posted to the VAT account (a manual journal)
  for (const p of ledger.postings) {
    if (p.accountId !== vatAcct?.id || !inRange(p.date, range.from, range.to)) continue;
    if (VAT_SALE_SOURCES.has(p.source)) outputVat += p.credit - p.debit;
    else if (VAT_PURCHASE_SOURCES.has(p.source)) inputVat += p.debit - p.credit;
    else otherVat += p.credit - p.debit;
  }

  // Sales (VAT-inclusive), split walk-in / corporate, with the notes that adjust them.
  const orders = await prisma.order.findMany({ include: { lineItems: { include: { service: true } }, corporateClient: true } });
  let walkinSales = 0;
  let corporateSales = 0;
  for (const o of orders) {
    const recognised = o.kind === 'walkin' || o.status !== 'Quote'; // the same rule the books use
    if (!recognised || !inRange(o.createdDate, range.from, range.to)) continue;
    const lines: LineItemInput[] = o.lineItems.map((li) => ({
      itemType: li.itemType as LineItemInput['itemType'],
      serviceId: li.serviceId,
      materialId: li.materialId,
      qty: li.qty,
      unitPrice: li.unitPrice,
      discountPct: li.discountPct,
      discountAmt: li.discountAmt,
      heatPressFee: li.heatPressFee,
    }));
    const total = computeOrderTotals({ lineItems: lines, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt }).grandTotal;
    if (o.kind === 'walkin') walkinSales += total;
    else corporateSales += total;
  }
  const notes = await prisma.adjustmentNote.findMany({ where: { type: { in: ['Credit', 'Debit'] }, date: { gte: range.from, lte: range.to } }, select: { type: true, total: true } });
  const creditNotes = notes.filter((n) => n.type === 'Credit').reduce((a, n) => a + n.total, 0);
  const debitNotes = notes.filter((n) => n.type === 'Debit').reduce((a, n) => a + n.total, 0);
  const totalSales = walkinSales + corporateSales + debitNotes - creditNotes;
  const netSales = totalSales - outputVat;

  // Purchases and expenses in the period, each with the input VAT it carries — worked out from its expense head (so nothing is claimed by hand).
  // An expense with no invoice/receipt number is flagged: the VAT is counted, but a KRA claim needs the supplier's tax invoice on file.
  await ensureChartOnce();
  const purchaseExpenseIds = new Set((await prisma.purchase.findMany({ where: { expenseId: { not: null } }, select: { expenseId: true } })).map((p) => p.expenseId as number));
  const headRows = await prisma.expenseHead.findMany({ orderBy: { name: 'asc' } });
  const vatOf = (category: string) => headRows.find((h) => h.name === category)?.vatApplicable ?? defaultExpenseVatApplicable(category);
  const expenses = await prisma.expense.findMany({ where: { date: { gte: range.from, lte: range.to } }, orderBy: [{ date: 'desc' }, { id: 'desc' }] });
  const purchases = expenses.map((e) => ({
    id: e.id,
    date: e.date,
    category: e.category,
    supplier: e.supplier,
    invoiceNumber: e.invoiceNumber,
    note: e.note,
    amount: round2(e.amount),
    vatAmount: vatOf(e.category) ? splitGross(e.amount, VAT_RATE).vat : 0,
    isStockPurchase: purchaseExpenseIds.has(e.id),
  }));
  // How each expense head is treated (set once; the standing answer applies until an Admin changes it).
  const heads = headRows.map((h) => ({ id: h.id, name: h.name, applicable: vatOf(h.name), isDefault: h.vatApplicable == null }));

  // ── The statement by account, straight from the books ─────────────────────────────────────────────────────────────────────────
  // Output VAT by INCOME account (every sale, with credit and debit notes) and input VAT by EXPENSE account (every purchase and expense), so the
  // VAT figures can be read off the same accounts as the income statement. A document's VAT is spread over the accounts it posted to in proportion
  // to their amounts (an order's VAT is posted once for the whole order, its sales line by line to the income accounts).
  type StatementLine = { date: string; ref: string; memo: string; net: number; vat: number };
  type StatementRow = { accountId: number; code: string; name: string; net: number; vat: number; gross: number; lines: StatementLine[] };
  const groups = new Map<string, typeof ledger.postings>();
  for (const p of ledger.postings) {
    if (!inRange(p.date, range.from, range.to) || !(VAT_SALE_SOURCES.has(p.source) || VAT_PURCHASE_SOURCES.has(p.source))) continue;
    const k = `${p.source}\u0000${p.ref}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const incomeRows = new Map<number, StatementRow>();
  const expenseRows = new Map<number, StatementRow>();
  for (const ps of groups.values()) {
    const sale = VAT_SALE_SOURCES.has(ps[0]!.source);
    const vatDoc = round2(ps.filter((p) => p.accountId === vatAcct?.id).reduce((a, p) => a + (sale ? p.credit - p.debit : p.debit - p.credit), 0));
    const parts = ps
      .filter((p) => ledger.byId.get(p.accountId)?.type === (sale ? 'Income' : 'Expense'))
      .map((p) => ({ p, net: round2(sale ? p.credit - p.debit : p.debit - p.credit) }));
    const total = parts.reduce((a, x) => a + x.net, 0);
    if (parts.length === 0 || total === 0) continue;
    let left = vatDoc;
    parts.forEach((x, i) => {
      const vat = i === parts.length - 1 ? left : round2((vatDoc * x.net) / total);
      left = round2(left - vat);
      const acct = ledger.byId.get(x.p.accountId)!;
      const rows = sale ? incomeRows : expenseRows;
      let row = rows.get(acct.id);
      if (!row) rows.set(acct.id, (row = { accountId: acct.id, code: acct.code, name: acct.name, net: 0, vat: 0, gross: 0, lines: [] }));
      row.net = round2(row.net + x.net);
      row.vat = round2(row.vat + vat);
      row.lines.push({ date: x.p.date, ref: x.p.ref, memo: x.p.memo, net: x.net, vat });
    });
  }
  const finish = (rows: Map<number, StatementRow>) => {
    const list = [...rows.values()].map((r) => ({ ...r, gross: round2(r.net + r.vat), lines: r.lines.sort((a, b) => b.date.localeCompare(a.date) || a.ref.localeCompare(b.ref)) })).sort((a, b) => a.code.localeCompare(b.code));
    const net = round2(list.reduce((a, r) => a + r.net, 0));
    const vatSum = round2(list.reduce((a, r) => a + r.vat, 0));
    return { rows: list, net, vat: vatSum, gross: round2(net + vatSum) };
  };

  // ── Outsourced (contracted-out) work: the sale carries Output VAT, the supplier's bill carries Input VAT ─────────────────────────
  const outsourcedSales: { orderId: number; orderNo: string; date: string; customer: string; net: number; vat: number; gross: number; quoted: number; billed: number }[] = [];
  for (const o of orders) {
    if (!(o.kind === 'walkin' || o.status !== 'Quote') || !inRange(o.createdDate, range.from, range.to)) continue;
    const lines: LineItemInput[] = o.lineItems.map((li) => ({ itemType: li.itemType as LineItemInput['itemType'], serviceId: li.serviceId, materialId: li.materialId, qty: li.qty, unitPrice: li.unitPrice, discountPct: li.discountPct, discountAmt: li.discountAmt, heatPressFee: li.heatPressFee }));
    const total = round2(computeOrderTotals({ lineItems: lines, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt }).grandTotal);
    if (total <= 0 || !o.lineItems.some((li) => li.service?.outsourced)) continue;
    const { net, vat } = splitGross(total, VAT_RATE);
    // the same split of the net across the lines that the books use (by each line's value after discounts; the last line takes the cent remainder)
    const weights = o.lineItems.map((_, i) => buildLineTotal(lines[i]!));
    const wSum = weights.reduce((a, w) => a + w, 0) || 1;
    let allocated = 0;
    let outNet = 0;
    let quoted = 0;
    o.lineItems.forEach((li, i) => {
      const share = i === o.lineItems.length - 1 ? round2(net - allocated) : round2((net * weights[i]!) / wSum);
      allocated += share;
      if (li.service?.outsourced) {
        outNet += share;
        quoted += (li.supplierCost ?? 0) * li.qty;
      }
    });
    const outVat = net > 0 ? round2((vat * outNet) / net) : 0;
    outsourcedSales.push({ orderId: o.id, orderNo: o.orderNo, date: o.createdDate, customer: o.corporateClient?.name || o.customerName || 'Walk-in', net: round2(outNet), vat: outVat, gross: round2(outNet + outVat), quoted: round2(quoted), billed: 0 });
  }
  const billedByOrder = outsourcedSales.length
    ? await prisma.expense.groupBy({ by: ['orderId'], where: { orderId: { in: outsourcedSales.map((s) => s.orderId) } }, _sum: { amount: true } })
    : [];
  for (const s of outsourcedSales) s.billed = round2(billedByOrder.find((b) => b.orderId === s.orderId)?._sum.amount ?? 0);
  const orderNoById = new Map(orders.map((o) => [o.id, o.orderNo]));
  const outsourcedBills = expenses
    .filter((e) => e.category === 'Outsourced Services' || e.orderId != null)
    .map((e) => {
      const billVat = vatOf(e.category) ? splitGross(e.amount, VAT_RATE).vat : 0;
      return { expenseId: e.id, date: e.date, orderNo: e.orderId != null ? orderNoById.get(e.orderId) ?? null : null, supplier: e.supplier, invoiceNumber: e.invoiceNumber, gross: round2(e.amount), net: round2(e.amount - billVat), vat: billVat };
    });
  const sum = <T,>(rows: T[], pick: (r: T) => number) => round2(rows.reduce((a, r) => a + pick(r), 0));
  const outsourced = {
    sales: { rows: outsourcedSales, net: sum(outsourcedSales, (r) => r.net), vat: sum(outsourcedSales, (r) => r.vat), gross: sum(outsourcedSales, (r) => r.gross) },
    bills: { rows: outsourcedBills, net: sum(outsourcedBills, (r) => r.net), vat: sum(outsourcedBills, (r) => r.vat), gross: sum(outsourcedBills, (r) => r.gross) },
    netVat: round2(sum(outsourcedSales, (r) => r.vat) - sum(outsourcedBills, (r) => r.vat)),
  };

  res.json({
    fromDate: range.from,
    toDate: range.to,
    walkinSales: round2(walkinSales),
    corporateSales: round2(corporateSales),
    creditNotes: round2(creditNotes),
    debitNotes: round2(debitNotes),
    totalSales: round2(totalSales),
    netSales: round2(netSales),
    outputVat: round2(outputVat),
    inputVat: round2(inputVat),
    otherVat: round2(otherVat),
    netVatPayable: round2(outputVat - inputVat + otherVat),
    purchases,
    heads,
    statement: { income: finish(incomeRows), expenses: finish(expenseRows), outsourced },
  });
});

// Whether spending on an expense head carries claimable input VAT. Set once per head (null goes back to the standing answer for its name);
// every expense and purchase under the head follows, past and future, so nothing is claimed item by item.
financeRouter.patch('/expense-heads/:id/vat', requirePermission('canAccessFinance'), async (req, res) => {
  const parsed = z.object({ applicable: z.boolean().nullable() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'applicable (true, false or null) is required' });
  const head = await prisma.expenseHead.findUnique({ where: { id: Number(req.params.id) } });
  if (!head) return res.status(404).json({ error: 'Expense head not found' });
  const updated = await prisma.expenseHead.update({ where: { id: head.id }, data: { vatApplicable: parsed.data.applicable } });
  res.json({ id: updated.id, name: updated.name, applicable: updated.vatApplicable ?? defaultExpenseVatApplicable(updated.name), isDefault: updated.vatApplicable == null });
});

// ── Operating expenses (capture) — P&L reads/aggregates the same table ──────
async function expenseHeadNames(): Promise<string[]> {
  await ensureChartOnce();
  return (await prisma.expenseHead.findMany({ orderBy: { name: 'asc' } })).map((h) => h.name);
}

financeRouter.get('/expenses', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });

  const rows = await prisma.expense.findMany({
    where: { date: { gte: range.from, lte: range.to } },
    include: { payments: true, notes: true },
    orderBy: { date: 'desc' },
  });
  const out = rows.map(({ payments, notes, ...e }) => {
    const paidAmount = e.paid ? e.amount : payments.reduce((a, p) => a + p.amount, 0);
    const credited = notes.filter((n) => n.type === 'SupplierDebit').reduce((a, n) => a + n.total, 0);
    return { ...e, paidAmount, credited, outstanding: e.paid ? 0 : Math.max(0, Math.round((e.amount - paidAmount - credited) * 100) / 100), payments };
  });
  const totalExpenses = rows.reduce((a, e) => a + e.amount, 0);

  res.json({ fromDate: range.from, toDate: range.to, rows: out, totalExpenses, expenseCategories: await expenseHeadNames(), expenseMethods: EXPENSE_METHODS });
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const expenseSchema = z.object({
  date: dateStr,
  category: z.string().min(1).max(100),
  note: z.string().max(200).optional(),
  amount: z.number().positive(),
  // Optional generally, but a "Printing Materials & Consumables" expense
  // needs one on file to later be linked to a Stock purchase (see
  // routes/stock.ts).
  invoiceNumber: z.string().max(100).optional(),
  // How it was paid. Defaults to petty cash (the historical behaviour). `paid: false` records a bill on credit — it
  // goes to Accounts Payable until payments are made against it (POST /expenses/:id/payments).
  method: z.enum(EXPENSE_METHODS).default(PETTY_CASH_METHOD),
  paid: z.boolean().default(true),
  supplier: z.string().max(120).optional(),
  dueDate: dateStr.optional().nullable(),
  // The line of business this cost belongs to (see Master Data → Business Heads); blank = shared, not tagged to one.
  businessHeadId: z.number().int().nullable().optional(),
});

financeRouter.post('/expenses', async (req, res) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  if (!(await expenseHeadNames()).includes(d.category)) return res.status(400).json({ error: 'Choose one of the expense heads (add new ones under Accounting → Chart of Accounts)' });
  if (!d.paid && !(d.supplier || '').trim()) return res.status(400).json({ error: 'A supplier is required for an expense bought on credit' });
  if (d.businessHeadId != null && !(await prisma.businessHead.findUnique({ where: { id: d.businessHeadId } }))) return res.status(400).json({ error: 'That business head does not exist' });

  // Anything paid from petty cash — now, not on credit — must be covered by the float (on its day and every later day).
  if (d.paid && d.method === PETTY_CASH_METHOD) {
    const check = await pettyCashShortfall(d.amount, d.date);
    if (check.short) return res.status(400).json({ error: shortMessage(check.available, d.amount) });
  }

  const expense = await prisma.expense.create({
    data: {
      date: d.date,
      category: d.category,
      note: d.note ?? '',
      amount: d.amount,
      invoiceNumber: d.invoiceNumber,
      method: d.paid ? d.method : PETTY_CASH_METHOD,
      paid: d.paid,
      supplier: (d.supplier || '').trim(),
      dueDate: d.paid ? null : d.dueDate ?? null,
      businessHeadId: d.businessHeadId ?? null,
      capturedByName: req.user!.name,
    },
  });
  res.status(201).json(expense);
});

// Tagging an expense to a line of business (or clearing it) changes no amount, so it needs no amendment request.
financeRouter.patch('/expenses/:id/business-head', async (req, res) => {
  const parsed = z.object({ businessHeadId: z.number().int().nullable() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a business head, or none' });
  if (parsed.data.businessHeadId != null && !(await prisma.businessHead.findUnique({ where: { id: parsed.data.businessHeadId } }))) return res.status(400).json({ error: 'That business head does not exist' });
  const updated = await prisma.expense.update({ where: { id: Number(req.params.id) }, data: { businessHeadId: parsed.data.businessHeadId } }).catch(() => null);
  if (!updated) return res.status(404).json({ error: 'Expense not found' });
  res.json(updated);
});

// Pay down an expense bought on credit — in full or in part, by any method (petty cash included, if the float covers it).
const expensePaymentSchema = z.object({ date: dateStr, amount: z.number().positive(), method: z.enum(EXPENSE_METHODS), note: z.string().max(200).optional() });

financeRouter.post('/expenses/:id/payments', async (req, res) => {
  const parsed = expensePaymentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const expense = await prisma.expense.findUnique({ where: { id: Number(req.params.id) }, include: { payments: true, notes: true } });
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  if (expense.paid) return res.status(400).json({ error: 'This expense was paid when it was recorded — there is nothing outstanding' });
  const paidSoFar = expense.payments.reduce((a, p) => a + p.amount, 0);
  const credited = expense.notes.filter((n) => n.type === 'SupplierDebit').reduce((a, n) => a + n.total, 0);
  const outstanding = Math.round((expense.amount - paidSoFar - credited) * 100) / 100;
  if (parsed.data.amount > outstanding + 0.01) return res.status(400).json({ error: `Only Ksh ${Math.round(outstanding).toLocaleString('en-KE')} is outstanding on this bill` });
  if (parsed.data.method === PETTY_CASH_METHOD) {
    const check = await pettyCashShortfall(parsed.data.amount, parsed.data.date);
    if (check.short) return res.status(400).json({ error: shortMessage(check.available, parsed.data.amount) });
  }
  const payment = await prisma.expensePayment.create({
    data: { expenseId: expense.id, date: parsed.data.date, amount: parsed.data.amount, method: parsed.data.method, note: parsed.data.note ?? '', capturedByName: req.user!.name },
  });
  res.status(201).json(payment);
});

// Expense heads (and the account each posts to) are managed under Accounting → Chart of Accounts.
financeRouter.post('/expense-heads', async (req, res) => {
  const name = String((req.body as { name?: string }).name || '').trim();
  if (!name || name.length > 100) return res.status(400).json({ error: 'Enter a name for the expense head' });
  await ensureChartOnce();
  if (await prisma.expenseHead.findUnique({ where: { name } })) return res.status(400).json({ error: 'That expense head already exists' });
  const head = await prisma.expenseHead.create({ data: { name, accountId: await accountIdForNewExpenseHead(name) } });
  res.status(201).json(head);
});

// No direct DELETE for expenses — see the generic DeletionRequest flow below.

// ── Expense amendments — correct a wrong entry without editing history; the
// Expense row itself (and P&L numbers built from it) only change once a
// finance manager/general manager/admin approves the request. ─────────────
financeRouter.get('/expenses/amendments', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const amendments = await prisma.expenseAmendment.findMany({
    where: status ? { status } : undefined,
    include: { expense: true },
    orderBy: { requestedAt: 'desc' },
  });
  res.json(
    amendments.map((a) => ({
      id: a.id,
      expenseId: a.expenseId,
      currentDate: a.expense.date,
      currentCategory: a.expense.category,
      currentNote: a.expense.note,
      currentAmount: a.expense.amount,
      proposedDate: a.proposedDate,
      proposedCategory: a.proposedCategory,
      proposedNote: a.proposedNote,
      proposedAmount: a.proposedAmount,
      reason: a.reason,
      status: a.status,
      requestedByName: a.requestedByName,
      requestedAt: a.requestedAt,
      decidedByName: a.decidedByName,
      decidedAt: a.decidedAt,
    })),
  );
});

const amendSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.string().min(1).max(100),
  note: z.string().max(200).optional(),
  amount: z.number().positive(),
  reason: z.string().min(1, 'A reason for the amendment is required'),
});

financeRouter.post('/expenses/:id/amend', async (req, res) => {
  const parsed = amendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const expense = await prisma.expense.findUnique({ where: { id: Number(req.params.id) } });
  if (!expense) return res.status(404).json({ error: 'Expense not found' });
  if (!(await expenseHeadNames()).includes(parsed.data.category)) return res.status(400).json({ error: 'Choose one of the expense heads' });

  const amendment = await prisma.expenseAmendment.create({
    data: {
      expenseId: expense.id,
      proposedDate: parsed.data.date,
      proposedCategory: parsed.data.category,
      proposedNote: parsed.data.note ?? '',
      proposedAmount: parsed.data.amount,
      reason: parsed.data.reason,
      requestedByName: req.user!.name,
    },
  });
  res.status(201).json(amendment);
});

async function decideAmendment(req: Request, res: Response, approve: boolean) {
  const amendment = await prisma.expenseAmendment.findUnique({ where: { id: Number(req.params.id) } });
  if (!amendment) return res.status(404).json({ error: 'Amendment not found' });
  if (amendment.status !== 'Pending') return res.status(400).json({ error: 'Amendment has already been decided' });
  if (amendment.requestedByName === req.user!.name) {
    return res.status(400).json({ error: 'You cannot approve or reject your own amendment request' });
  }

  if (approve) {
    await prisma.expense.update({
      where: { id: amendment.expenseId },
      data: { date: amendment.proposedDate, category: amendment.proposedCategory, note: amendment.proposedNote, amount: amendment.proposedAmount },
    });
  }

  const updated = await prisma.expenseAmendment.update({
    where: { id: amendment.id },
    data: { status: approve ? 'Approved' : 'Rejected', decidedByName: req.user!.name, decidedAt: new Date() },
  });
  res.json(updated);
}

financeRouter.post('/expenses/amendments/:id/approve', (req, res) => decideAmendment(req, res, true));
financeRouter.post('/expenses/amendments/:id/reject', (req, res) => decideAmendment(req, res, false));

// ── Petty cash — "in" from bank withdrawals / cash-sales allocations (this ──
// route is Finance-Manager/General-Manager/Admin only, so every top-up is
// inherently manager-authorized); "out" is the same Expense ledger as above.
financeRouter.get('/petty-cash', async (req, res) => {
  const range = parseRange(req);
  if (!range) return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });

  const [ledger, cashPayments] = await Promise.all([
    loadLedger(),
    prisma.payment.findMany({ where: { method: 'Cash', date: { gte: range.from, lte: range.to } } }),
  ]);
  const petty = ledger.byCode.get('1010');
  const mine = petty ? ledger.postings.filter((p) => p.accountId === petty.id && inRange(p.date, range.from, range.to)) : [];
  const balance = await computePettyCashBalance(range.to);

  const rows = mine
    .map((p, i) => {
      const isTopUp = p.source === 'Petty cash top-up';
      const topUpId = isTopUp && p.ref.startsWith('PCT-') ? Number(p.ref.slice(4)) : null;
      return {
        id: `${p.source}:${p.ref}:${i}`,
        date: p.date,
        type: (p.debit > 0 ? 'topup' : 'expense') as 'topup' | 'expense',
        description: p.memo || p.source,
        amountIn: p.debit,
        amountOut: p.credit,
        topUpId,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  res.json({
    fromDate: range.from,
    toDate: range.to,
    balance,
    periodTopUpsTotal: rows.reduce((a, r) => a + r.amountIn, 0),
    periodExpensesTotal: rows.reduce((a, r) => a + r.amountOut, 0),
    cashSalesInPeriod: cashPayments.reduce((a, p) => a + p.amount, 0),
    ledger: rows,
    pettyCashSources: PETTY_CASH_SOURCES,
  });
});

const pettyCashSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.enum(PETTY_CASH_SOURCES),
  amount: z.number().positive(),
  note: z.string().max(200).optional(),
});

financeRouter.post('/petty-cash/topups', async (req, res) => {
  const parsed = pettyCashSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const topUp = await prisma.pettyCashTopUp.create({
    data: { ...parsed.data, note: parsed.data.note ?? '', authorizedByName: req.user!.name },
  });
  res.status(201).json(topUp);
});

// No direct DELETE for petty cash top-ups — see the generic DeletionRequest flow below.

// ── Deletion requests — the only way to remove an Expense, PayrollEntry, or ──
// PettyCashTopUp. Requires a reason and approval from a *different* finance
// manager/general manager/admin before the row is actually deleted, same
// segregation-of-duties rule as expense amendments above.
const DELETABLE_TYPES = ['Expense', 'PayrollEntry', 'PettyCashTopUp'] as const;
type DeletableType = (typeof DELETABLE_TYPES)[number];

async function buildDeletionSummary(recordType: DeletableType, recordId: number): Promise<string | null> {
  if (recordType === 'Expense') {
    const e = await prisma.expense.findUnique({ where: { id: recordId } });
    if (!e) return null;
    return `Expense: ${e.category} — Ksh ${Math.round(e.amount).toLocaleString('en-KE')} (${e.date})`;
  }
  if (recordType === 'PayrollEntry') {
    const p = await prisma.payrollEntry.findUnique({ where: { id: recordId }, include: { staff: true } });
    if (!p) return null;
    return `Payroll: ${p.staff.name} — Ksh ${Math.round(p.grossPay).toLocaleString('en-KE')} (${p.date})`;
  }
  const t = await prisma.pettyCashTopUp.findUnique({ where: { id: recordId } });
  if (!t) return null;
  return `Petty cash top-up: ${t.source} — Ksh ${Math.round(t.amount).toLocaleString('en-KE')} (${t.date})`;
}

financeRouter.get('/deletion-requests', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const requests = await prisma.deletionRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: { requestedAt: 'desc' },
  });
  res.json(requests);
});

const deletionRequestSchema = z.object({
  recordType: z.enum(DELETABLE_TYPES),
  recordId: z.number().int(),
  reason: z.string().min(1, 'A reason for the deletion is required'),
});

financeRouter.post('/deletion-requests', async (req, res) => {
  const parsed = deletionRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const summary = await buildDeletionSummary(parsed.data.recordType, parsed.data.recordId);
  if (!summary) return res.status(404).json({ error: 'Record not found' });

  const request = await prisma.deletionRequest.create({
    data: { ...parsed.data, summary, requestedByName: req.user!.name },
  });
  res.status(201).json(request);
});

async function decideDeletionRequest(req: Request, res: Response, approve: boolean) {
  const request = await prisma.deletionRequest.findUnique({ where: { id: Number(req.params.id) } });
  if (!request) return res.status(404).json({ error: 'Deletion request not found' });
  if (request.status !== 'Pending') return res.status(400).json({ error: 'Deletion request has already been decided' });
  if (request.requestedByName === req.user!.name) {
    return res.status(400).json({ error: 'You cannot approve or reject your own deletion request' });
  }

  if (approve) {
    const recordType = request.recordType as DeletableType;
    if (recordType === 'Expense') await prisma.expense.delete({ where: { id: request.recordId } }).catch(() => null);
    else if (recordType === 'PayrollEntry') await prisma.payrollEntry.delete({ where: { id: request.recordId } }).catch(() => null);
    else await prisma.pettyCashTopUp.delete({ where: { id: request.recordId } }).catch(() => null);
  }

  const updated = await prisma.deletionRequest.update({
    where: { id: request.id },
    data: { status: approve ? 'Approved' : 'Rejected', decidedByName: req.user!.name, decidedAt: new Date() },
  });
  res.json(updated);
}

financeRouter.post('/deletion-requests/:id/approve', (req, res) => decideDeletionRequest(req, res, true));
financeRouter.post('/deletion-requests/:id/reject', (req, res) => decideDeletionRequest(req, res, false));
