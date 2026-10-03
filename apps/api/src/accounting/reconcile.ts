import { prisma } from '../db';
import { ACCT, computeOrderTotals, round2 } from '@glm/shared';
import type { LineItemInput } from '@glm/shared';
import { loadLedger, sumByAccount, naturalBalance } from './ledger';
import type { Posting } from './ledger';
import { buildBalanceSheet, buildCashFlowStatement, buildPayablesAging, buildReceivablesAging, buildTrialBalance } from './reports';

// The "books check". It answers: does every sale and expense actually reach the profit & loss, and do the books hang
// together? For each operational record it works out what it SHOULD contribute straight from the record itself, then
// compares that with what the ledger actually posted for it. A record that was skipped, posted for the wrong amount or
// posted to a catch-all account shows up here. A second list of integrity checks (debits = credits, the balance sheet
// balances, receivables and payables agree with their ageing reports, petty cash never went negative…) catches errors
// in the ledger itself.

export interface SourceCheck {
  source: string;
  label: string;
  side: 'sales' | 'expenses' | 'cash';
  records: number;
  expected: number;
  posted: number;
  difference: number;
}
export interface Issue {
  source: string;
  ref: string;
  expected: number;
  posted: number;
  problem: string;
}
export interface IntegrityCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface Reconciliation {
  sources: SourceCheck[];
  issues: Issue[];
  integrity: IntegrityCheck[];
  /** Records booked to a catch-all because their head/service has no account. */
  catchAll: { kind: 'expense' | 'income'; ref: string; head: string; amount: number; account: string }[];
  /** Money that has an operational record but no automatic posting. */
  notInBooks: { label: string; amount: number; count: number; note: string }[];
  allPosted: boolean;
}

const key = (source: string, ref: string) => `${source}\u0000${ref}`;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const fmt = (n: number) => `Ksh ${Math.round(n).toLocaleString('en-KE')}`;

export async function reconcile(from: string, to: string, asOf: string): Promise<Reconciliation> {
  const ledger = await loadLedger();
  const inWindow = (d: string) => d >= from && d <= to;

  // What was posted, per source + reference, on each side.
  const salesPosted = new Map<string, number>(); // income + VAT credits (sales as posted)
  const expensePosted = new Map<string, number>(); // expense debits
  const cashPosted = new Map<string, number>(); // debits to cash accounts (money in)
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, round2((m.get(k) || 0) + v));
  const cashIds = new Set([ACCT.cash, ACCT.mpesa, ACCT.card, ACCT.bank, ACCT.pettyCash].map((c) => ledger.byCode.get(c)?.id));
  for (const p of ledger.postings) {
    const a = ledger.byId.get(p.accountId);
    if (!a) continue;
    const k = key(p.source, p.ref);
    if (p.source === 'Order' && (a.type === 'Income' || a.code === ACCT.vatPayable)) add(salesPosted, k, p.credit - p.debit);
    if (a.type === 'Expense') add(expensePosted, k, p.debit - p.credit);
    if (p.source === 'Payment' && cashIds.has(a.id)) add(cashPosted, k, p.debit - p.credit);
    if (p.source === 'Payment' && a.code === ACCT.unallocatedMpesa) add(cashPosted, k, p.debit - p.credit);
  }

  const expected: { source: string; label: string; side: SourceCheck['side']; items: Map<string, number> }[] = [];
  const bucket = (source: string, label: string, side: SourceCheck['side']) => {
    const b = { source, label, side, items: new Map<string, number>() };
    expected.push(b);
    return b;
  };
  const put = (b: { items: Map<string, number> }, ref: string, amount: number) => b.items.set(ref, round2((b.items.get(ref) || 0) + amount));

  // Orders: every order that is a sale should have posted its full grand total (income + VAT).
  const orders = await prisma.order.findMany({ include: { lineItems: true, payments: true } });
  const orderSales = bucket('Order', 'Orders (invoiced / walk-in)', 'sales');
  const orderPayments = bucket('Payment', 'Order payments received', 'cash');
  const overpaid: Issue[] = [];
  for (const o of orders) {
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
    const total = round2(computeOrderTotals({ lineItems: lines, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt }).grandTotal);
    if ((o.kind === 'walkin' || o.status !== 'Quote') && total > 0) put(orderSales, o.orderNo, total);
    const paid = round2(o.payments.reduce((a, p) => a + p.amount, 0));
    if (paid > 0) put(orderPayments, o.orderNo, paid);
    if (paid > total + 0.5 && (o.kind === 'walkin' || o.status !== 'Quote')) {
      overpaid.push({ source: 'Order payments received', ref: o.orderNo, expected: total, posted: paid, problem: 'Paid more than the order is worth — the extra sits as a credit owed to the customer' });
    }
  }

  const expenses = bucket('Expense', 'Expense entries', 'expenses');
  for (const e of await prisma.expense.findMany()) put(expenses, e.invoiceNumber || `EXP-${e.id}`, e.amount);

  // Stock purchases with no expense behind them (China imports) post to cost of sales on their own; the ones WITH an expense
  // are posted by that expense (above).
  const purchases = bucket('Purchase', 'Stock purchases with no expense (cost of sales)', 'expenses');
  for (const p of await prisma.purchase.findMany({ where: { expenseId: null, status: { not: 'Rejected' } } })) put(purchases, `PUR-${p.id}`, p.totalCost);

  const wages = bucket('Wages', 'Wages & salaries (gross)', 'expenses');
  for (const p of await prisma.payrollEntry.findMany()) put(wages, `WAGE-${p.id}`, p.grossPay);

  const dep = bucket('Depreciation', 'Asset depreciation', 'expenses');
  for (const d of await prisma.assetDepreciation.findMany({ include: { asset: true } })) put(dep, `${d.asset.tag}@${d.period}`, d.amount);

  const sources: SourceCheck[] = [];
  const issues: Issue[] = [...overpaid];
  for (const b of expected) {
    const posted = b.side === 'sales' ? salesPosted : b.side === 'cash' ? cashPosted : expensePosted;
    let expectedTotal = 0;
    let postedTotal = 0;
    for (const [ref, exp] of b.items) {
      expectedTotal += exp;
      const got = posted.get(key(b.source, ref)) || 0;
      postedTotal += got;
      if (Math.abs(exp - got) > 0.02) {
        issues.push({ source: b.label, ref, expected: round2(exp), posted: round2(got), problem: got === 0 ? 'Not posted to the books' : 'Posted for a different amount' });
      }
    }
    for (const [k, v] of posted) {
      const [source, ref] = k.split('\u0000');
      if (source === b.source && !b.items.has(ref!) && Math.abs(v) > 0.02) {
        issues.push({ source: b.label, ref: ref!, expected: 0, posted: round2(v), problem: 'Posted, but the record itself shows nothing to book' });
      }
    }
    sources.push({ source: b.source, label: b.label, side: b.side, records: b.items.size, expected: round2(expectedTotal), posted: round2(postedTotal), difference: round2(postedTotal - expectedTotal) });
  }

  // ── Integrity checks on the ledger itself ──
  const integrity: IntegrityCheck[] = [];
  const tb = await buildTrialBalance(asOf);
  integrity.push({ name: 'Debits equal credits (trial balance)', ok: tb.balanced, detail: tb.balanced ? `Both sides total ${fmt(tb.debit)}` : `Debits ${fmt(tb.debit)} vs credits ${fmt(tb.credit)} — out by ${fmt(Math.abs(tb.debit - tb.credit))}` });
  const bs = await buildBalanceSheet(asOf);
  integrity.push({ name: 'Balance sheet balances (assets = liabilities + equity)', ok: bs.balanced, detail: bs.balanced ? `Assets ${fmt(bs.assets.total)}` : `Assets ${fmt(bs.assets.total)} vs liabilities + equity ${fmt(bs.liabilitiesAndEquity)}` });

  const sums = sumByAccount(ledger.postings, (p) => p.date <= asOf);
  const bal = (code: string) => {
    const a = ledger.byCode.get(code);
    return a ? naturalBalance(a.type, sums.get(a.id)) : 0;
  };
  const ar = await buildReceivablesAging(asOf);
  const arLedger = bal(ACCT.receivables);
  const arExpected = round2(ar.total + ar.overpaidCredits);
  integrity.push({ name: 'Accounts Receivable agrees with the receivables ageing', ok: Math.abs(arLedger - arExpected) < 0.02, detail: `Ledger ${fmt(arLedger)} vs ageing ${fmt(arExpected)}` });

  const ap = await buildPayablesAging(asOf);
  const apLedger = bal(ACCT.payables);
  // Supplier debit notes against an expense that was already paid in full leave the supplier owing us; they are not in the ageing.
  const unpaidIds = new Set((await prisma.expense.findMany({ where: { paid: false }, select: { id: true } })).map((e) => e.id));
  const looseSupplierNotes = (await prisma.adjustmentNote.findMany({ where: { type: 'SupplierDebit', date: { lte: asOf } } })).filter((n) => !n.expenseId || !unpaidIds.has(n.expenseId)).reduce((a, n) => a + n.total, 0);
  const apExpected = round2(ap.total - looseSupplierNotes);
  integrity.push({ name: 'Accounts Payable agrees with the payables ageing', ok: Math.abs(apLedger - apExpected) < 0.02, detail: `Ledger ${fmt(apLedger)} vs ageing ${fmt(apExpected)}` });

  // Petty cash must never have been overdrawn on any day.
  const petty = ledger.byCode.get(ACCT.pettyCash);
  let pettyLow: { date: string; balance: number } | null = null;
  if (petty) {
    const byDay = new Map<string, number>();
    for (const p of ledger.postings.filter((x) => x.accountId === petty.id)) byDay.set(p.date, (byDay.get(p.date) || 0) + p.debit - p.credit);
    let run = 0;
    for (const d of [...byDay.keys()].sort()) {
      run = round2(run + byDay.get(d)!);
      if (run < -0.005 && (!pettyLow || run < pettyLow.balance)) pettyLow = { date: d, balance: run };
    }
  }
  integrity.push({ name: 'Petty cash was never overdrawn', ok: !pettyLow, detail: pettyLow ? `Went to ${fmt(pettyLow.balance)} on ${pettyLow.date}` : `Float now ${fmt(bal(ACCT.pettyCash))}` });

  const cf = await buildCashFlowStatement(from, to);
  integrity.push({ name: 'Cash flow statement reconciles to the cash accounts', ok: cf.reconciles, detail: `Opening ${fmt(cf.openingCash)} → closing ${fmt(cf.closingCash)}` });

  const unmatched = await prisma.mpesaTransaction.findMany({ where: { kind: { in: ['C2B', 'Import'] }, status: 'Unmatched' } });
  const unmatchedTotal = round2(unmatched.reduce((a, t) => a + t.amount, 0));
  integrity.push({ name: 'No M-Pesa receipts waiting to be matched', ok: unmatched.length === 0, detail: unmatched.length ? `${unmatched.length} receipt(s), ${fmt(unmatchedTotal)}, held in Unallocated M-Pesa Receipts` : 'Every M-Pesa receipt is matched or dismissed' });
  const unallocated = bal(ACCT.unallocatedMpesa);
  integrity.push({ name: 'Unallocated M-Pesa account equals the unmatched receipts', ok: Math.abs(unallocated - unmatchedTotal) < 0.02, detail: `Account ${fmt(unallocated)} vs receipts ${fmt(unmatchedTotal)}` });

  // ── Booked to a catch-all ──
  const catchAll: Reconciliation['catchAll'] = [];
  const heads = await prisma.expenseHead.findMany();
  const linkedHeads = new Set(heads.filter((h) => h.accountId).map((h) => h.name));
  for (const e of await prisma.expense.findMany()) {
    if (!linkedHeads.has(e.category)) catchAll.push({ kind: 'expense', ref: e.invoiceNumber || `EXP-${e.id}`, head: e.category, amount: e.amount, account: '6999 Uncategorised Expenses' });
  }

  // ── Things with a record of their own but no automatic posting ──
  const notInBooks: Reconciliation['notInBooks'] = [];
  const assets = (await prisma.asset.findMany({ where: { OR: [{ purchaseDate: null }, { value: null }] } })).filter((a) => a.condition !== 'Retired');
  notInBooks.push({
    label: 'Assets with no purchase date or value (not on the balance sheet)',
    amount: 0,
    count: assets.length,
    note: 'Give each asset a purchase date and cost in the Asset Register so it is capitalised and can depreciate.',
  });
  const undepreciated = (await prisma.asset.findMany({ where: { depreciationMethod: 'None', value: { gt: 0 }, condition: { not: 'Retired' } } }));
  notInBooks.push({
    label: 'Assets with no depreciation method set',
    amount: round2(undepreciated.reduce((a, x) => a + (x.value ?? 0), 0)),
    count: undepreciated.length,
    note: 'These stay on the balance sheet at full cost. Set a method and useful life in the Asset Register for them to depreciate automatically.',
  });
  const unverified = (await prisma.payment.findMany({ where: { method: 'M-Pesa', reference: null } })).filter((p) => inWindow(p.date));
  notInBooks.push({
    label: 'M-Pesa payments recorded with no M-Pesa receipt code',
    amount: round2(unverified.reduce((a, p) => a + p.amount, 0)),
    count: unverified.length,
    note: 'Without the receipt code these cannot be matched against the M-Pesa statement. Add the code when recording an M-Pesa payment.',
  });

  const allPosted = issues.length === 0 && catchAll.length === 0 && integrity.every((c) => c.ok);
  return { sources, issues, integrity, catchAll, notInBooks, allPosted };
}

export type { Posting };
