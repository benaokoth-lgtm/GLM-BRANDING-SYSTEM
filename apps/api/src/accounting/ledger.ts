import { prisma } from '../db';
import {
  ACCT,
  VAT_RATE,
  defaultExpenseVatApplicable,
  buildLineTotal,
  computeOrderTotals,
  computePay,
  defaultServiceIncomeCode,
  isDebitNormal,
  methodAccountCode,
  round2,
  splitGross,
} from '@glm/shared';
import type { LineItemInput } from '@glm/shared';

// The ledger is a list of postings (one account, one date, a debit or a credit). A few come from journals someone
// typed in (opening balances, owner capital/drawings, bank deposits, tax remittances); the rest are DERIVED, on every
// read, from the operational tables — an order, a payment, an expense, a pay-run, a credit note. Deriving them means
// the books cannot drift from operations: fix or remove the source record and the ledger follows. Every derived
// event posts a balanced set of lines.

export interface Posting {
  date: string; // 'YYYY-MM-DD'
  accountId: number;
  debit: number;
  credit: number;
  memo: string;
  source: string;
  ref: string;
}

export interface LedgerAccount {
  id: number;
  code: string;
  name: string;
  type: string;
  subtype: string;
  active: boolean;
}

interface Ctx {
  byId: Map<number, LedgerAccount>;
  byCode: Map<string, LedgerAccount>;
  expenseHeadAcct: Map<string, number>;
  /** Does an expense head carry claimable input VAT? (An Admin's setting, else the standing answer for the name.) */
  vatApplicable: (head: string) => boolean;
}

export { round2 };

async function loadCtx(): Promise<Ctx> {
  const [accounts, heads] = await Promise.all([prisma.account.findMany(), prisma.expenseHead.findMany()]);
  return {
    byId: new Map(accounts.map((a) => [a.id, a])),
    byCode: new Map(accounts.map((a) => [a.code, a])),
    expenseHeadAcct: new Map(heads.filter((h) => h.accountId).map((h) => [h.name, h.accountId as number])),
    vatApplicable: (head) => {
      const set = heads.find((h) => h.name === head)?.vatApplicable;
      return set ?? defaultExpenseVatApplicable(head);
    },
  };
}

function idOf(ctx: Ctx, code: string): number {
  const a = ctx.byCode.get(code);
  if (!a) throw new Error(`Chart of accounts is missing account ${code}`);
  return a.id;
}

class Book {
  postings: Posting[] = [];
  constructor(private ctx: Ctx) {}
  private push(date: string, accountId: number, debit: number, credit: number, source: string, ref: string, memo: string) {
    if (!(debit > 0 || credit > 0)) return;
    this.postings.push({ date, accountId, debit: round2(debit), credit: round2(credit), source, ref, memo });
  }
  dr(date: string, code: string, amount: number, source: string, ref: string, memo: string) {
    this.push(date, idOf(this.ctx, code), amount, 0, source, ref, memo);
  }
  cr(date: string, code: string, amount: number, source: string, ref: string, memo: string) {
    this.push(date, idOf(this.ctx, code), 0, amount, source, ref, memo);
  }
  drId(date: string, accountId: number, amount: number, source: string, ref: string, memo: string) {
    this.push(date, accountId, amount, 0, source, ref, memo);
  }
  crId(date: string, accountId: number, amount: number, source: string, ref: string, memo: string) {
    this.push(date, accountId, 0, amount, source, ref, memo);
  }
}

function expenseAcctId(ctx: Ctx, head: string): number {
  return ctx.expenseHeadAcct.get(head) || idOf(ctx, ACCT.uncategorised);
}

// ── Postings typed in by hand ─────────────────────────────────────────────
async function journalPostings(book: Book) {
  const entries = await prisma.journalEntry.findMany({ include: { lines: true } });
  for (const e of entries) {
    for (const l of e.lines) {
      book.postings.push({ date: e.date, accountId: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo || e.memo, source: e.source, ref: e.ref });
    }
  }
}

// ── Money spent ───────────────────────────────────────────────────────────
// An expense bought on credit (paid = false) is recognised as spent immediately, but the cash side waits: it goes to
// Accounts Payable until ExpensePayment rows (partial payments allowed) settle it. A paid-on-the-spot expense — the
// historical default, always from petty cash — is cash out the same day.
async function expensePostings(book: Book, ctx: Ctx) {
  // An expense that backs a stock purchase is cost of sales, whichever head it was filed under.
  const purchaseExpenseIds = new Set((await prisma.purchase.findMany({ where: { expenseId: { not: null } }, select: { expenseId: true } })).map((p) => p.expenseId as number));
  for (const e of await prisma.expense.findMany({ include: { payments: true } })) {
    const memo = [e.category, e.supplier, e.note].filter(Boolean).join(' · ');
    const ref = e.invoiceNumber || `EXP-${e.id}`;
    // The cost is what is left once the input VAT (claimed from KRA) is taken out; the VAT sits in the VAT account. Which spending carries
    // VAT is decided by the expense head — nothing is claimed by hand.
    const vat = ctx.vatApplicable(e.category) ? splitGross(e.amount, VAT_RATE).vat : 0;
    const cost = e.amount - vat;
    if (purchaseExpenseIds.has(e.id)) book.dr(e.date, ACCT.costOfSales, cost, 'Expense', ref, memo);
    else book.drId(e.date, expenseAcctId(ctx, e.category), cost, 'Expense', ref, memo);
    book.dr(e.date, ACCT.vatPayable, vat, 'Expense', ref, `Input VAT — ${memo}`);
    if (e.paid) {
      book.cr(e.date, methodAccountCode(e.method), e.amount, 'Expense', ref, memo);
      continue;
    }
    book.cr(e.date, ACCT.payables, e.amount, 'Expense', ref, memo);
    for (const p of e.payments) {
      book.dr(p.date, ACCT.payables, p.amount, 'Expense', ref, `Payment — ${memo}`);
      book.cr(p.date, methodAccountCode(p.method), p.amount, 'Expense', ref, `Payment — ${memo}`);
    }
  }
}

// Wages are paid out of petty cash: gross pay is the cost, net pay leaves the float, and the statutory deductions are
// held as liabilities until remitted. Rows recorded before that rule keep whatever source they were paid from.
async function payrollPostings(book: Book) {
  for (const p of await prisma.payrollEntry.findMany({ include: { staff: true } })) {
    const pay = computePay(p.grossPay, p.employeeType as 'Employee' | 'Casual');
    const ref = `WAGE-${p.id}`;
    const memo = `${p.staff.name} (${p.employeeType}${p.department ? `, ${p.department}` : ''})`;
    // Every component is rounded to the cent first and net pay is what is left, so the entry balances exactly.
    const gross = round2(pay.grossPay);
    const paye = round2(pay.paye);
    const nssf = round2(pay.nssf);
    const shif = round2(pay.shif);
    const housing = round2(pay.housingLevy);
    const net = round2(gross - paye - nssf - shif - housing);
    book.dr(p.date, p.employeeType === 'Casual' ? '5110' : ACCT.salaries, gross, 'Wages', ref, memo);
    book.cr(p.date, methodAccountCode(p.paymentSource), net, 'Wages', ref, memo);
    book.cr(p.date, ACCT.payePayable, paye, 'Wages', ref, memo);
    book.cr(p.date, ACCT.nssfPayable, nssf, 'Wages', ref, memo);
    book.cr(p.date, ACCT.shifPayable, shif, 'Wages', ref, memo);
    book.cr(p.date, ACCT.housingLevyPayable, housing, 'Wages', ref, memo);
  }
}

// A stock purchase that has no expense behind it — a China import batch, settled by bank transfer — has no other record, so it
// posts here: cost of sales, paid from the bank. (Purchases WITH an expense are posted by the expense, above.) A rejected purchase
// was never accepted into stock and costs nothing.
async function unlinkedPurchasePostings(book: Book) {
  for (const p of await prisma.purchase.findMany({ where: { expenseId: null, status: { not: 'Rejected' } }, include: { material: true, lines: { include: { material: true } } } })) {
    const ref = p.poRef ?? `PUR-${p.id}`;
    const what = p.lines.length ? p.lines.map((l) => l.material.name).join(', ') : (p.material?.name ?? 'stock');
    const memo = `Stock purchase — ${what}${p.supplier ? ` — ${p.supplier}` : ''}`;
    book.dr(p.date, ACCT.costOfSales, p.totalCost, 'Purchase', ref, memo);
    book.cr(p.date, ACCT.bank, p.totalCost, 'Purchase', ref, memo);
  }
}

const TOP_UP_FUNDING: Record<string, string> = {
  'Bank Withdrawal': ACCT.bank,
  'Cash Sales Allocation': ACCT.cash,
  'Owner Injection': ACCT.capital,
};

async function pettyCashTopUpPostings(book: Book) {
  for (const t of await prisma.pettyCashTopUp.findMany()) {
    const ref = `PCT-${t.id}`;
    const memo = `Petty cash top-up — ${t.source}${t.note ? ` (${t.note})` : ''}`;
    book.dr(t.date, ACCT.pettyCash, t.amount, 'Petty cash top-up', ref, memo);
    book.cr(t.date, TOP_UP_FUNDING[t.source] || ACCT.cash, t.amount, 'Petty cash top-up', ref, memo);
  }
}

// ── Money earned ──────────────────────────────────────────────────────────
// An order is a sale from the day it is created, unless it is still a Quote (a corporate quotation is only an offer).
// Prices are VAT-inclusive, so the sale is split into income (net) and VAT payable. The whole amount is owed by the
// customer (Accounts Receivable) until payments arrive; each payment, whichever method, clears receivables on its day.
// A deposit taken against a quote that has not been invoiced yet is held as a customer deposit instead.
async function orderPostings(book: Book, ctx: Ctx) {
  const merchandise = idOf(ctx, ACCT.merchandiseIncome);
  const orders = await prisma.order.findMany({
    include: { lineItems: { include: { service: true, material: true } }, payments: { include: { mpesaTransaction: true } }, corporateClient: true },
  });
  for (const o of orders) {
    const party = o.customerName || o.corporateClient?.name || 'Customer';
    const memo = `${o.orderNo} — ${party}`;
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
    const totals = computeOrderTotals({ lineItems: lines, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt });
    const total = round2(totals.grandTotal);
    const recognised = o.kind === 'walkin' || o.status !== 'Quote';

    if (recognised && total > 0) {
      const { net, vat } = splitGross(total, VAT_RATE);
      book.dr(o.createdDate, ACCT.receivables, total, 'Order', o.orderNo, memo);
      // Share the net across the lines by their (post-discount) value; the last line takes the cent remainder.
      const weights = o.lineItems.map((li, i) => ({ li, w: buildLineTotal(lines[i]!) }));
      const wSum = weights.reduce((a, x) => a + x.w, 0) || 1;
      let allocated = 0;
      weights.forEach(({ li, w }, i) => {
        const share = i === weights.length - 1 ? round2(net - allocated) : round2((net * w) / wSum);
        allocated += share;
        const accountId =
          li.itemType === 'material'
            ? li.material?.accountId ?? merchandise
            : li.service?.accountId ?? idOf(ctx, defaultServiceIncomeCode(li.service?.name ?? ''));
        book.crId(o.createdDate, accountId, share, 'Order', o.orderNo, memo);
      });
      book.cr(o.createdDate, ACCT.vatPayable, vat, 'Order', o.orderNo, memo);
    }

    for (const p of o.payments) {
      // An M-Pesa payment recorded against a received receipt moves money from the unallocated M-Pesa account (see
      // mpesaPostings) — the receipt was already booked when it arrived, so only the allocation is posted here.
      const received = !!p.mpesaTransaction && p.mpesaTransaction.kind !== 'STK';
      const label = `Payment (${p.method}${p.reference ? ` ${p.reference}` : ''}) — ${memo}`;
      if (received) {
        book.dr(p.date, ACCT.unallocatedMpesa, p.amount, 'Payment', o.orderNo, label);
      } else {
        book.dr(p.date, methodAccountCode(p.method), p.amount, 'Payment', o.orderNo, label);
      }
      book.cr(p.date, recognised ? ACCT.receivables : ACCT.customerCredits, p.amount, 'Payment', o.orderNo, label);
    }
  }
}

// M-Pesa money that arrived through Paybill/Till or a statement upload is booked the day it was received: money in
// M-Pesa, and a suspense liability until it is matched to an order. Matching creates a Payment (above) that moves it
// out of suspense into receivables. STK pushes are not booked here — they create their Payment directly.
async function mpesaPostings(book: Book) {
  for (const t of await prisma.mpesaTransaction.findMany({ where: { kind: { in: ['C2B', 'Import'] }, status: { in: ['Unmatched', 'Applied'] } } })) {
    const date = t.receivedOn || t.createdAt.toISOString().slice(0, 10);
    const ref = t.mpesaReceipt || `MPESA-${t.id}`;
    const memo = `M-Pesa receipt ${t.mpesaReceipt || ''} — ${t.payerName || t.phone}`.trim();
    book.dr(date, ACCT.mpesa, t.amount, 'M-Pesa receipt', ref, memo);
    book.cr(date, ACCT.unallocatedMpesa, t.amount, 'M-Pesa receipt', ref, memo);
  }
}

// Credit and debit notes. A credit note takes a sale (and its VAT) back and cuts what the customer owes — the part
// they had already paid is left as a credit owed back to them (and, if refunded on the day, paid out). A customer debit
// note charges more. A supplier debit note reduces what we owe a supplier, and the expense it was booked to.
async function notePostings(book: Book, ctx: Ctx) {
  const purchaseLinked = new Set((await prisma.purchase.findMany({ where: { expenseId: { not: null } }, select: { expenseId: true } })).map((p) => p.expenseId as number));
  for (const n of await prisma.adjustmentNote.findMany({ include: { expense: true } })) {
    const memo = `${n.number} — ${n.party} — ${n.reason}`;
    if (n.type === 'Credit') {
      book.dr(n.date, ACCT.salesReturns, n.net, 'Credit note', n.number, memo);
      book.dr(n.date, ACCT.vatPayable, n.vat, 'Credit note', n.number, memo);
      book.cr(n.date, ACCT.receivables, n.receivableAmt, 'Credit note', n.number, memo);
      book.cr(n.date, ACCT.customerCredits, n.creditAmt, 'Credit note', n.number, memo);
      if (n.refundAmt > 0 && n.refundMethod) {
        book.dr(n.date, ACCT.customerCredits, n.refundAmt, 'Credit note', n.number, `Refund — ${memo}`);
        book.cr(n.date, methodAccountCode(n.refundMethod), n.refundAmt, 'Credit note', n.number, `Refund — ${memo}`);
      }
    } else if (n.type === 'Debit') {
      book.dr(n.date, ACCT.receivables, n.total, 'Debit note', n.number, memo);
      if (n.incomeAccountId) book.crId(n.date, n.incomeAccountId, n.net, 'Debit note', n.number, memo);
      else book.cr(n.date, ACCT.otherIncome, n.net, 'Debit note', n.number, memo);
      book.cr(n.date, ACCT.vatPayable, n.vat, 'Debit note', n.number, memo);
    } else {
      book.dr(n.date, ACCT.payables, n.total, 'Supplier debit note', n.number, memo);
      // If the expense it reduces had input VAT claimed, the same share of the note comes back off that VAT.
      const vatShare = n.expense && n.expense.amount > 0 && ctx.vatApplicable(n.expense.category) ? splitGross(n.total, VAT_RATE).vat : 0;
      book.crId(n.date, n.expense ? (purchaseLinked.has(n.expense.id) ? idOf(ctx, ACCT.costOfSales) : expenseAcctId(ctx, n.expense.category)) : idOf(ctx, ACCT.uncategorised), round2(n.total - vatShare), 'Supplier debit note', n.number, memo);
      book.cr(n.date, ACCT.vatPayable, vatShare, 'Supplier debit note', n.number, `Input VAT — ${memo}`);
    }
  }
}

// ── Fixed assets ──────────────────────────────────────────────────────────
const ASSET_FUNDING: Record<string, string> = {
  Bank: ACCT.bank,
  Cash: ACCT.cash,
  'M-Pesa': ACCT.mpesa,
  'Petty Cash': ACCT.pettyCash,
  'Owner Capital': ACCT.capital,
  'Opening Balance': ACCT.retainedEarnings,
};

async function assetPostings(book: Book) {
  for (const a of await prisma.asset.findMany({ include: { depreciations: true } })) {
    const cost = round2(a.value ?? 0);
    if (cost > 0 && a.purchaseDate) {
      const memo = `${a.tag} ${a.name}`;
      book.dr(a.purchaseDate, ACCT.fixedAssets, cost, 'Asset purchase', a.tag, memo);
      book.cr(a.purchaseDate, ASSET_FUNDING[a.fundedBy] || ACCT.capital, cost, 'Asset purchase', a.tag, `Funded by ${a.fundedBy} — ${memo}`);
    }
    for (const d of a.depreciations) {
      const memo = `Depreciation ${d.period} — ${a.tag} ${a.name}`;
      book.dr(d.date, ACCT.depreciation, d.amount, 'Depreciation', `${a.tag}@${d.period}`, memo);
      book.cr(d.date, ACCT.accumDepreciation, d.amount, 'Depreciation', `${a.tag}@${d.period}`, memo);
    }
  }
}

export interface Ledger {
  accounts: LedgerAccount[];
  byId: Map<number, LedgerAccount>;
  byCode: Map<string, LedgerAccount>;
  postings: Posting[];
}

/** Every posting in the books — derived from operations plus the journals typed in by hand. */
export async function loadLedger(): Promise<Ledger> {
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

/** Just the sources that can touch petty cash — cheap enough to check on every wage/expense entry. */
export async function pettyCashBalance(asOf?: string): Promise<number> {
  const ctx = await loadCtx();
  const book = new Book(ctx);
  await expensePostings(book, ctx);
  await payrollPostings(book);
  await pettyCashTopUpPostings(book);
  await notePostings(book, ctx);
  await journalPostings(book);
  const petty = idOf(ctx, ACCT.pettyCash);
  return round2(
    book.postings
      .filter((p) => p.accountId === petty && (!asOf || p.date <= asOf))
      .reduce((a, p) => a + p.debit - p.credit, 0),
  );
}

/** Would paying `amount` out of petty cash on `date` leave the float short — on that day, or now? */
export async function pettyCashShortfall(amount: number, date: string): Promise<{ short: boolean; available: number }> {
  const [atDate, now] = await Promise.all([pettyCashBalance(date), pettyCashBalance()]);
  const available = Math.min(atDate, now);
  return { short: amount > available + 0.005, available };
}

export interface Balance {
  debit: number;
  credit: number;
}

export function sumByAccount(postings: Posting[], filter?: (p: Posting) => boolean): Map<number, Balance> {
  const out = new Map<number, Balance>();
  for (const p of postings) {
    if (filter && !filter(p)) continue;
    const cur = out.get(p.accountId) || { debit: 0, credit: 0 };
    cur.debit += p.debit;
    cur.credit += p.credit;
    out.set(p.accountId, cur);
  }
  return out;
}

/** Signed balance in the account's natural direction (assets/expenses: debit − credit; others: credit − debit). */
export function naturalBalance(type: string, b: Balance | undefined): number {
  if (!b) return 0;
  return round2(isDebitNormal(type) ? b.debit - b.credit : b.credit - b.debit);
}
