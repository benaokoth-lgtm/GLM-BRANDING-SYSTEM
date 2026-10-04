import { prisma } from '../db';
import { ACCT, CASH_ACCOUNT_CODES, COST_OF_SALES_SUBTYPE, computeOrderTotals, round2 } from '@glm/shared';
import type { LineItemInput } from '@glm/shared';
import { loadLedger, naturalBalance, sumByAccount } from './ledger';
import type { Posting } from './ledger';

// The profit & loss, balance sheet, cash flow, trial balance and the receivables / payables ageing — plain functions of
// the ledger so every screen (and the books check) shows the same figures.

const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > endKey) break;
    out.push(key);
    if (m === 12) {
      y++;
      m = 1;
    } else m++;
    if (out.length > 120) break;
  }
  return out;
}

export async function buildProfitLoss(from: string, to: string) {
  const ledger = await loadLedger();
  const months = monthsOf(from, to);
  const monthIndex = new Map(months.map((m, i) => [m, i]));

  interface Row {
    id: number;
    code: string;
    name: string;
    amount: number;
    byMonth: number[];
  }
  const rows = new Map<number, Row>();
  const outside = { before: { income: 0, expenses: 0 }, after: { income: 0, expenses: 0 } };
  for (const p of ledger.postings) {
    const acc = ledger.byId.get(p.accountId);
    if (!acc || (acc.type !== 'Income' && acc.type !== 'Expense')) continue;
    const signed = acc.type === 'Income' ? p.credit - p.debit : p.debit - p.credit;
    if (!inRange(p.date, from, to)) {
      const side = p.date < from ? outside.before : outside.after;
      if (acc.type === 'Income') side.income += signed;
      else side.expenses += signed;
      continue;
    }
    let row = rows.get(acc.id);
    if (!row) {
      row = { id: acc.id, code: acc.code, name: acc.name, amount: 0, byMonth: months.map(() => 0) };
      rows.set(acc.id, row);
    }
    row.amount += signed;
    const idx = monthIndex.get(p.date.slice(0, 7));
    if (idx !== undefined) row.byMonth[idx]! += signed;
  }
  // Cost of sales (the purchases) is its own section between income and operating expenses.
  const section = (type: 'Income' | 'Expense' | 'CostOfSales') => {
    const isCos = (id: number) => ledger.byId.get(id)!.subtype === COST_OF_SALES_SUBTYPE;
    const list = [...rows.values()]
      .filter((r) => (type === 'CostOfSales' ? isCos(r.id) : ledger.byId.get(r.id)!.type === type && !(type === 'Expense' && isCos(r.id))) && (Math.abs(r.amount) > 0.004 || r.byMonth.some((v) => Math.abs(v) > 0.004)))
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((r) => ({ ...r, amount: round2(r.amount), byMonth: r.byMonth.map(round2) }));
    return { rows: list, total: round2(list.reduce((a, r) => a + r.amount, 0)), byMonth: months.map((_, i) => round2(list.reduce((a, r) => a + r.byMonth[i]!, 0))) };
  };
  const income = section('Income');
  const costOfSales = section('CostOfSales');
  const expenses = section('Expense'); // operating expenses (cost of sales shown above it)
  const grossProfit = round2(income.total - costOfSales.total);
  const netProfit = round2(grossProfit - expenses.total);
  return {
    from,
    to,
    months,
    income,
    costOfSales,
    grossProfit,
    grossByMonth: months.map((_, i) => round2(income.byMonth[i]! - costOfSales.byMonth[i]!)),
    grossMargin: income.total > 0 ? round2((grossProfit / income.total) * 100) : null,
    expenses,
    netProfit,
    netByMonth: months.map((_, i) => round2(income.byMonth[i]! - costOfSales.byMonth[i]! - expenses.byMonth[i]!)),
    margin: income.total > 0 ? round2((netProfit / income.total) * 100) : null,
    outside: {
      before: { income: round2(outside.before.income), expenses: round2(outside.before.expenses) },
      after: { income: round2(outside.after.income), expenses: round2(outside.after.expenses) },
    },
  };
}

// The four figures at the top of the Profit & Loss dashboard, with the comparison and the trend that sit beside them. Everything here
// comes from the same ledger as the statement below it, so the cards always agree with it.
//   • Revenue (accrual)       — income in the period, VAT out, net of credit notes (the statement's Income total)
//   • Revenue (cash received) — the money actually received from customers in the period (VAT included)
//   • Gross profit / Net profit — the statement's own figures
// The comparison is with the period of the same length just before it; the trend is the six months ending with the month of `to`.
function priorRange(from: string, to: string) {
  const fromD = new Date(from + 'T00:00:00Z');
  const toD = new Date(to + 'T00:00:00Z');
  const lengthMs = toD.getTime() - fromD.getTime();
  const priorTo = new Date(fromD.getTime() - 86400000);
  const priorFrom = new Date(priorTo.getTime() - lengthMs);
  return { from: priorFrom.toISOString().slice(0, 10), to: priorTo.toISOString().slice(0, 10) };
}

const pctChange = (cur: number, prev: number): number | null => (prev ? Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10 : null);

export async function buildProfitLossDashboard(from: string, to: string, current: { income: number; netProfit: number }) {
  const prior = priorRange(from, to);
  // six whole months ending with the month of `to`
  const y = Number(to.slice(0, 4));
  const m = Number(to.slice(5, 7));
  const first = new Date(Date.UTC(y, m - 1 - 5, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [priorPl, trendPl, cash] = await Promise.all([
    buildProfitLoss(prior.from, prior.to),
    buildProfitLoss(first, last),
    prisma.payment.aggregate({ _sum: { amount: true }, where: { date: { gte: from, lte: to } } }),
  ]);
  return {
    cashReceived: round2(cash._sum.amount ?? 0),
    revChangePct: pctChange(current.income, priorPl.income.total),
    profitChangePct: pctChange(current.netProfit, priorPl.netProfit),
    priorFrom: prior.from,
    priorTo: prior.to,
    trend: trendPl.months.map((month, i) => ({ label: `${month.slice(5, 7)}/${month.slice(2, 4)}`, revenue: trendPl.income.byMonth[i]!, netProfit: trendPl.netByMonth[i]! })),
  };
}

export async function buildBalanceSheet(asOf: string) {
  const ledger = await loadLedger();
  const sums = sumByAccount(ledger.postings, (p) => p.date <= asOf);
  const line = (type: string) =>
    ledger.accounts
      .filter((a) => a.type === type)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((a) => ({ id: a.id, code: a.code, name: a.name, subtype: a.subtype, amount: naturalBalance(a.type, sums.get(a.id)) }))
      .filter((r) => Math.abs(r.amount) > 0.004);
  const total = (rows: { amount: number }[]) => round2(rows.reduce((a, r) => a + r.amount, 0));

  const assets = line('Asset');
  const liabilities = line('Liability');
  const equityAccounts = line('Equity');
  const currentEarnings = round2(total(line('Income')) - total(line('Expense')));
  // Equity accounts are shown credit-positive, so drawings (a debit balance) come out negative.
  const equity = [
    ...equityAccounts,
    { id: 0, code: '', name: 'Profit earned to date (not yet closed to retained earnings)', subtype: 'CurrentEarnings', amount: currentEarnings },
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
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  };
}

/** Every account's debit/credit total to `asOf` — the books must always balance (debits = credits). */
export async function buildTrialBalance(asOf: string) {
  const ledger = await loadLedger();
  const sums = sumByAccount(ledger.postings, (p) => p.date <= asOf);
  const rows = ledger.accounts
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((a) => {
      const b = sums.get(a.id) || { debit: 0, credit: 0 };
      const net = round2(b.debit - b.credit);
      return { id: a.id, code: a.code, name: a.name, type: a.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
    })
    .filter((r) => r.debit > 0.004 || r.credit > 0.004);
  const debit = round2(rows.reduce((x, r) => x + r.debit, 0));
  const credit = round2(rows.reduce((x, r) => x + r.credit, 0));
  return { asOf, rows, debit, credit, balanced: Math.abs(debit - credit) < 0.01 };
}

/** One account's postings with a running balance (the general ledger). */
export async function buildAccountLedger(accountId: number, from: string, to: string) {
  const ledger = await loadLedger();
  const acc = ledger.byId.get(accountId);
  if (!acc) return null;
  const mine = ledger.postings.filter((p) => p.accountId === accountId).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const sign = (p: Posting) => (acc.type === 'Asset' || acc.type === 'Expense' ? p.debit - p.credit : p.credit - p.debit);
  const opening = round2(mine.filter((p) => p.date < from).reduce((a, p) => a + sign(p), 0));
  let running = opening;
  const rows = mine
    .filter((p) => inRange(p.date, from, to))
    .map((p) => {
      running = round2(running + sign(p));
      return { date: p.date, source: p.source, ref: p.ref, memo: p.memo, debit: p.debit, credit: p.credit, balance: running };
    });
  return { account: { id: acc.id, code: acc.code, name: acc.name, type: acc.type }, from, to, opening, closing: running, rows };
}

const AGE_BUCKETS = ['Not yet due', '0–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const;
type Bucket = (typeof AGE_BUCKETS)[number];
function ageBucket(ageDays: number): Bucket {
  return ageDays < 0 ? 'Not yet due' : ageDays <= 30 ? '0–30 days' : ageDays <= 60 ? '31–60 days' : ageDays <= 90 ? '61–90 days' : 'Over 90 days';
}
const daysBetween = (from: string, to: string) => Math.floor((new Date(to + 'T00:00:00').getTime() - new Date(from + 'T00:00:00').getTime()) / 86400000);

/** What suppliers are still owed — expenses bought on credit, less payments by `asOf`, less supplier debit notes. */
export async function buildPayablesAging(asOf: string) {
  const entries = await prisma.expense.findMany({ where: { paid: false, date: { lte: asOf } }, include: { payments: true, notes: true } });
  const rows = entries
    .map((e) => {
      const paidAmount = round2(e.payments.filter((p) => p.date <= asOf).reduce((a, p) => a + p.amount, 0));
      const credited = round2(e.notes.filter((n) => n.type === 'SupplierDebit' && n.date <= asOf).reduce((a, n) => a + n.total, 0));
      const outstanding = round2(e.amount - paidAmount - credited);
      const ageDays = daysBetween(e.dueDate ?? e.date, asOf);
      return { id: e.id, date: e.date, dueDate: e.dueDate, supplier: e.supplier, head: e.category, invoice: e.invoiceNumber, amount: e.amount, paidAmount, credited, outstanding, ageDays, bucket: ageBucket(ageDays) };
    })
    .filter((r) => r.outstanding > 0.004)
    .sort((a, b) => b.ageDays - a.ageDays);
  const byBucket = AGE_BUCKETS.map((bucket) => ({ bucket, total: round2(rows.filter((r) => r.bucket === bucket).reduce((a, r) => a + r.outstanding, 0)) }));
  return { asOf, rows, total: round2(rows.reduce((a, r) => a + r.outstanding, 0)), byBucket };
}

/** Every order's balance, as the ledger sees it: sale + debit notes − payments − credit notes. */
export async function buildReceivablesAging(asOf: string) {
  const orders = await prisma.order.findMany({
    where: { createdDate: { lte: asOf } },
    include: { lineItems: true, payments: true, corporateClient: true, notes: true },
  });
  let credits = 0; // orders paid or credited beyond what they were worth (owed back to the customer)
  const rows: { orderId: number; ref: string; party: string; status: string; date: string; dueDate: string | null; amount: number; paid: number; adjustments: number; outstanding: number; ageDays: number; bucket: Bucket }[] = [];
  for (const o of orders) {
    if (!(o.kind === 'walkin' || o.status !== 'Quote')) continue;
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
    const amount = round2(computeOrderTotals({ lineItems: lines, orderDiscountPct: o.orderDiscountPct, orderDiscountAmt: o.orderDiscountAmt }).grandTotal);
    const paid = round2(o.payments.filter((p) => p.date <= asOf).reduce((a, p) => a + p.amount, 0));
    const adjustments = round2(
      o.notes.filter((n) => n.date <= asOf).reduce((a, n) => a + (n.type === 'Credit' ? -n.receivableAmt : n.type === 'Debit' ? n.total : 0), 0),
    );
    const outstanding = round2(amount + adjustments - paid);
    if (outstanding < -0.004) credits += outstanding;
    if (!(outstanding > 0.004)) continue;
    const ageDays = daysBetween(o.dueDate ?? o.createdDate, asOf);
    rows.push({
      orderId: o.id,
      ref: o.orderNo,
      party: o.customerName || o.corporateClient?.name || 'Customer',
      status: o.status,
      date: o.createdDate,
      dueDate: o.dueDate,
      amount,
      paid,
      adjustments,
      outstanding,
      ageDays,
      bucket: ageBucket(ageDays),
    });
  }
  rows.sort((a, b) => b.ageDays - a.ageDays);
  const byBucket = AGE_BUCKETS.map((bucket) => ({ bucket, total: round2(rows.filter((r) => r.bucket === bucket).reduce((a, r) => a + r.outstanding, 0)) }));
  return { asOf, rows, total: round2(rows.reduce((a, r) => a + r.outstanding, 0)), byBucket, overpaidCredits: round2(credits) };
}

type CashBucket = 'Operating' | 'Investing' | 'Financing' | 'Internal';

/** Cash actually moving, direct method: every posting to a cash/bank/M-Pesa account in the period, grouped by what caused
 * it and classified Operating / Investing / Financing. Owner capital and drawings are Financing; an asset purchase is
 * Investing; a hand-typed journal is classified by what is on the other side of the same entry (equity/loans →
 * Financing, a fixed asset → Investing, anything else → Operating); a transfer between two cash accounts (a bank deposit,
 * a petty-cash top-up from the bank) nets to nothing and is shown separately. */
export async function buildCashFlowStatement(from: string, to: string) {
  const ledger = await loadLedger();
  const cashIds = new Set(CASH_ACCOUNT_CODES.map((c) => ledger.byCode.get(c)?.id).filter((id): id is number => !!id));
  const isCash = (p: Posting) => cashIds.has(p.accountId);
  const cashBalanceAsOf = (cutoff: (d: string) => boolean) => ledger.postings.filter((p) => isCash(p) && cutoff(p.date)).reduce((a, p) => a + p.debit - p.credit, 0);
  const openingCash = round2(cashBalanceAsOf((d) => d < from));
  const closingCash = round2(cashBalanceAsOf((d) => d <= to));

  // Opening-balance journals set a starting position, not a period cash flow — never a movement.
  const moves = ledger.postings.filter((p) => isCash(p) && inRange(p.date, from, to) && p.source !== 'Opening');

  // Classify a whole entry by its non-cash legs, so a transfer between cash accounts is recognised as internal.
  const legsByEntry = new Map<string, Posting[]>();
  for (const p of ledger.postings) {
    if (!inRange(p.date, from, to)) continue;
    const k = `${p.source}\u0000${p.ref}\u0000${p.date}`;
    legsByEntry.set(k, [...(legsByEntry.get(k) || []), p]);
  }
  const STATIC: Record<string, CashBucket> = { Capital: 'Financing', Drawings: 'Financing', 'Asset purchase': 'Investing' };
  const bucketFor = (p: Posting): CashBucket => {
    if (STATIC[p.source]) return STATIC[p.source]!;
    const legs = legsByEntry.get(`${p.source}\u0000${p.ref}\u0000${p.date}`) || [];
    const other = legs.filter((l) => !isCash(l));
    if (other.length === 0) return 'Internal';
    if (p.source === 'Petty cash top-up') {
      // Funded from the owner's capital → Financing; from bank/cash → an internal transfer.
      return other.some((l) => ledger.byId.get(l.accountId)?.type === 'Equity') ? 'Financing' : 'Internal';
    }
    if (['Manual', 'BankDeposit', 'TaxPayment'].includes(p.source) || p.source === 'Opening') {
      const types = new Set(other.map((l) => ledger.byId.get(l.accountId)?.type));
      if (types.has('Equity') || other.some((l) => ledger.byId.get(l.accountId)?.code === ACCT.loans)) return 'Financing';
      if (other.some((l) => ledger.byId.get(l.accountId)?.subtype === 'FixedAsset')) return 'Investing';
    }
    return 'Operating';
  };

  const totals: Record<CashBucket, number> = { Operating: 0, Investing: 0, Financing: 0, Internal: 0 };
  const bySource = new Map<string, { source: string; bucket: CashBucket; amount: number }>();
  for (const p of moves) {
    const bucket = bucketFor(p);
    const signed = p.debit - p.credit;
    totals[bucket] += signed;
    const key = `${bucket}:${p.source}`;
    const row = bySource.get(key) || { source: p.source, bucket, amount: 0 };
    row.amount += signed;
    bySource.set(key, row);
  }
  const lines = [...bySource.values()].map((r) => ({ ...r, amount: round2(r.amount) })).filter((r) => Math.abs(r.amount) > 0.004);
  const section = (bucket: CashBucket) => ({ total: round2(totals[bucket]), lines: lines.filter((l) => l.bucket === bucket) });
  const netChange = round2(totals.Operating + totals.Investing + totals.Financing);
  return {
    from,
    to,
    openingCash,
    closingCash,
    netChange,
    operating: section('Operating'),
    investing: section('Investing'),
    financing: section('Financing'),
    internalTransfers: round2(totals.Internal),
    reconciles: Math.abs(round2(openingCash + netChange + totals.Internal) - closingCash) < 0.01,
  };
}
