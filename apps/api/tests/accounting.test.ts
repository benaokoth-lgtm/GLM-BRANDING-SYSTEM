// End-to-end checks of the accounting module against a throwaway SQLite database (see scripts/run-tests.mjs). They call the
// same functions the routes do, so a pass means: every operational record reaches a balanced ledger, and the reports agree.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { loadLedger, pettyCashBalance, pettyCashShortfall, sumByAccount, naturalBalance } from '../src/accounting/ledger';
import { buildBalanceSheet, buildCashFlowStatement, buildPayablesAging, buildProfitLoss, buildReceivablesAging, buildTrialBalance } from '../src/accounting/reports';
import { reconcile } from '../src/accounting/reconcile';
import { issueCreditNote, issueDebitNote, issueSupplierDebitNote } from '../src/accounting/notes';
import { runDepreciation } from '../src/accounting/depreciation';
import { applyReceiptToOrder, importStatement, parseStatement } from '../src/accounting/mpesaMatching';
import { recordOrderPayments } from '../src/routes/orders';

const TODAY = '2031-03-20';
const bal = async (code: string, asOf = '2099-12-31') => {
  const l = await loadLedger();
  const a = l.byCode.get(code)!;
  return naturalBalance(a.type, sumByAccount(l.postings, (p) => p.date <= asOf).get(a.id));
};

let staffId = 0;
let printing = 0;
let cap = 0;

async function newOrder(orderNo: string, qtyPrice: [number, number][], opts: { kind?: string; status?: string; phone?: string; date?: string } = {}) {
  return prisma.order.create({
    data: {
      orderNo,
      kind: opts.kind ?? 'walkin',
      customerName: 'Test Customer',
      phone: opts.phone ?? null,
      staffId,
      createdDate: opts.date ?? '2031-03-01',
      status: opts.status ?? 'Invoice',
      stage: 'Order Received',
      lineItems: { create: qtyPrice.map(([qty, unitPrice], i) => (i === 0 ? { itemType: 'service', serviceId: printing, qty, unitPrice } : { itemType: 'material', materialId: cap, qty, unitPrice })) },
    },
    include: { corporateClient: true },
  });
}

describe('accounting module', () => {
  before(async () => {
    staffId = (await prisma.user.create({ data: { name: 'Tester', role: 'Admin', pinHash: 'x' } })).id;
    printing = (await prisma.service.create({ data: { name: 'DTF Printing', unit: 'piece', price: 100 } })).id;
    cap = (await prisma.material.create({ data: { name: 'Cap', price: 500, stockQty: 10 } })).id;
    await ensureChartOfAccounts();
  });
  after(() => prisma.$disconnect());

  it('builds the chart, links heads and services to accounts', async () => {
    const accounts = await prisma.account.findMany();
    assert.ok(accounts.find((a) => a.code === '1010' && a.type === 'Asset'));
    assert.ok(accounts.find((a) => a.code === '3010' && a.type === 'Equity'));
    for (const h of await prisma.expenseHead.findMany({ include: { account: true } })) assert.equal(h.account?.type, 'Expense', h.name);
    const svc = await prisma.service.findUniqueOrThrow({ where: { id: printing }, include: { account: true } });
    assert.equal(svc.account?.code, '4030'); // a DTF service lands on DTF income by default
  });

  it('posts a sale split into income and VAT, and clears receivables when it is paid by cash AND M-Pesa', async () => {
    const o = await newOrder('T-1', [[10, 100], [2, 500]]); // 1000 + 1000 = 2000
    assert.equal(await bal('1100'), 2000);
    assert.equal(await bal('2100'), 275.86); // 2000 - 2000/1.16
    assert.equal(await bal('4030'), 862.07 /* half of the net 1724.14, to the cent */);
    assert.equal(await bal('4020'), 862.07);
    await prisma.$transaction((tx) => recordOrderPayments(tx, o, [{ method: 'Cash', amount: 500 }, { method: 'M-Pesa', amount: 1500, reference: 'abc123xyz1' }], staffId, '2031-03-02'));
    assert.equal(await bal('1100'), 0);
    assert.equal(await bal('1020'), 500);
    assert.equal(await bal('1030'), 1500);
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true } });
    assert.equal(paid.payments.length, 2);
    assert.equal(paid.status, 'Order'); // cleared a walk-in invoice
  });

  it('refuses to count one M-Pesa receipt twice', async () => {
    const o = await newOrder('T-2', [[1, 1000]]);
    await prisma.mpesaTransaction.create({ data: { checkoutRequestId: 'C2B-DUP0000001', merchantRequestId: '', phone: '', amount: 1000, accountReference: '', mpesaReceipt: 'DUP0000001', status: 'Success', createdByName: 't', kind: 'STK', orderId: o.id } });
    await assert.rejects(prisma.$transaction((tx) => recordOrderPayments(tx, o, [{ method: 'M-Pesa', amount: 1000, reference: 'dup0000001' }], staffId)), /already been used/);
  });

  it('an STK push that succeeded before the order existed is claimed by the order it paid for', async () => {
    await prisma.mpesaTransaction.create({ data: { checkoutRequestId: 'ws_CO_claim1', merchantRequestId: '', phone: '254711111111', amount: 700, accountReference: 'Walk-in', mpesaReceipt: 'STKCLAIM01', status: 'Success', createdByName: 't', kind: 'STK' } });
    const o = await newOrder('T-2B', [[1, 700]]);
    await prisma.$transaction((tx) => recordOrderPayments(tx, o, [{ method: 'M-Pesa', amount: 700, reference: 'stkclaim01' }], staffId));
    const stk = await prisma.mpesaTransaction.findUniqueOrThrow({ where: { mpesaReceipt: 'STKCLAIM01' }, include: { payment: true } });
    assert.equal(stk.orderId, o.id);
    assert.equal(stk.payment?.amount, 700);
    assert.equal(stk.status, 'Success');
    // an STK receipt goes straight to M-Pesa (it is never held in the unallocated account)
    const l = await loadLedger();
    const unalloc = l.byCode.get('2310')!;
    assert.equal(l.postings.filter((p) => p.accountId === unalloc.id && p.ref === 'T-2B').length, 0);
  });

  it('credit note: itemised, restocks, reduces income and VAT, and refunds what was already paid', async () => {
    const o = await newOrder('T-3', [[1, 1000], [2, 500]]); // 2000
    await prisma.$transaction((tx) => recordOrderPayments(tx, o, [{ method: 'Cash', amount: 2000 }], staffId, '2031-03-03'));
    const capLine = (await prisma.orderLineItem.findMany({ where: { orderId: o.id } })).find((l) => l.materialId)!;
    const before = await prisma.material.findUniqueOrThrow({ where: { id: cap } });
    const note = await issueCreditNote({ orderId: o.id, reason: 'Faulty caps', items: [{ lineId: capLine.id, qty: 1 }], restock: true, refund: { method: 'Cash', amount: 500 }, date: '2031-03-04', createdBy: 'Tester' });
    assert.equal(note.total, 500);
    assert.equal(note.creditAmt, 500); // fully paid order → all of it is owed back
    assert.equal(note.receivableAmt, 0);
    assert.equal((await prisma.material.findUniqueOrThrow({ where: { id: cap } })).stockQty, before.stockQty + 1);
    assert.equal(await bal('4900'), -431.03); // a debit balance on an income account: 500 - 500*16/116
    await assert.rejects(issueCreditNote({ orderId: o.id, reason: 'too much', amount: 5000, date: TODAY, createdBy: 't' }), /only worth/);
    assert.equal(await bal('2300'), 0); // refunded in full on the day
  });

  it('debit note adds to what a customer owes; supplier debit note cuts what we owe', async () => {
    const o = await newOrder('T-4', [[1, 1160]]);
    const dn = await issueDebitNote({ orderId: o.id, reason: 'Rush delivery', amount: 116, date: '2031-03-05', createdBy: 'Tester' });
    assert.equal(dn.vat, 16);
    const aging = await buildReceivablesAging(TODAY);
    assert.equal(aging.rows.find((r) => r.ref === 'T-4')!.outstanding, 1276);

    const e = await prisma.expense.create({ data: { date: '2031-03-05', category: 'Printing Materials & Consumables', amount: 3000, supplier: 'Ink Co', paid: false, method: 'Cash' } });
    await issueSupplierDebitNote({ expenseId: e.id, reason: 'Returned wrong ink', amount: 500, date: '2031-03-06', createdBy: 'Tester' });
    await prisma.expensePayment.create({ data: { expenseId: e.id, date: '2031-03-07', amount: 1000, method: 'Bank Transfer' } });
    const ap = await buildPayablesAging(TODAY);
    assert.equal(ap.rows.find((r) => r.supplier === 'Ink Co')!.outstanding, 1500); // 3000 - 500 note - 1000 paid
    assert.equal(await bal('2010'), 1500);
  });

  it('wages are paid from petty cash, which cannot be overdrawn, and deductions become liabilities', async () => {
    assert.equal((await pettyCashShortfall(1000, '2031-03-08')).short, true); // empty float
    await prisma.pettyCashTopUp.create({ data: { date: '2031-03-08', source: 'Owner Injection', amount: 100000, authorizedByName: 'Tester' } });
    assert.equal(await pettyCashBalance(), 100000);
    assert.equal(await bal('3010'), 100000); // owner injection → capital
    await prisma.payrollEntry.create({ data: { date: '2031-03-09', staffId, employeeType: 'Employee', grossPay: 60000, paymentSource: 'Petty Cash' } });
    const l = await loadLedger();
    const petty = l.byCode.get('1010')!;
    const pettyBal = naturalBalance('Asset', sumByAccount(l.postings).get(petty.id));
    assert.ok(pettyBal < 100000 && pettyBal > 40000, `net pay should leave the float, left ${pettyBal}`);
    assert.ok((await bal('2200')) > 0, 'PAYE payable');
    assert.equal(await bal('5010'), 60000);
    assert.equal((await pettyCashShortfall(1e9, '2031-03-10')).short, true);
  });

  it('depreciates assets automatically, once per month, and never below salvage', async () => {
    const a = await prisma.asset.create({ data: { tag: 'A-1', name: 'Heat press', category: 'Heat Press & Curing', purchaseDate: '2031-01-15', value: 120000, depreciationMethod: 'Straight-line', usefulLifeYears: 5, salvageValue: 12000, fundedBy: 'Bank' } });
    const first = await runDepreciation('2031-03-20'); // Feb is the first full month after purchase; March is still running
    assert.equal(first, 1);
    assert.equal(await runDepreciation('2031-03-20'), 0); // idempotent
    assert.equal(await runDepreciation('2031-05-02'), 2); // March and April
    const rows = await prisma.assetDepreciation.findMany({ where: { assetId: a.id }, orderBy: { period: 'asc' } });
    assert.deepEqual(rows.map((r) => r.period), ['2031-02', '2031-03', '2031-04']);
    assert.equal(rows[0]!.amount, 1800); // (120000 - 12000) / 60
    assert.equal(await bal('1590'), -5400); // a contra-asset: a credit balance
    assert.equal(await bal('6800'), 5400);
    assert.equal(await bal('1500'), 120000);
    const reducing = await prisma.asset.create({ data: { tag: 'A-2', name: 'Laptop', category: 'Computers & IT Equipment', purchaseDate: '2031-01-31', value: 60000, depreciationMethod: 'Reducing balance', depreciationRatePct: 30, fundedBy: 'Owner Capital' } });
    await runDepreciation('2031-04-01');
    const feb = await prisma.assetDepreciation.findFirstOrThrow({ where: { assetId: reducing.id, period: '2031-02' } });
    assert.equal(feb.amount, 1500); // 60000 × 30% ÷ 12
  });

  it('M-Pesa statement: matches by order number, keeps the rest unmatched, and the books still balance', async () => {
    const o = await newOrder('W-9001', [[1, 2320]], { phone: '0712345678', date: '2031-03-10' });
    const o2 = await newOrder('W-9002', [[1, 580]], { phone: '0799999999', date: '2031-03-10' });
    const csv = [
      'Receipt No.,Completion Time,Details,Transaction Status,Paid In,Withdrawn,Balance',
      'SGH1A2B3C4,2031-03-12 10:15:00,Pay Bill Funds received from 254712345678 - JOHN DOE Acc. W-9001,Completed,2320.00,,50000',
      'SGH1A2B3C5,2031-03-12 11:00:00,Funds received from 254799999999 - JANE ROE,Completed,580.00,,50580',
      'SGH1A2B3C6,2031-03-12 12:00:00,Funds received from 254700000000 - UNKNOWN,Completed,999.00,,51579',
      'SGH1A2B3C7,2031-03-12 13:00:00,Customer Payment to Small Business,Completed,,1000.00,50579',
    ].join('\n');
    assert.equal(parseStatement(csv).receipts.length, 3);
    const r = await importStatement(csv, 'Tester');
    assert.equal(r.added + r.autoApplied >= 3, true);
    assert.equal(r.autoApplied, 1); // only the one that named its order number is applied without a person
    assert.equal((await importStatement(csv, 'Tester')).duplicates, 3); // re-uploading is harmless

    const paid = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true } });
    assert.equal(paid.status, 'Order');
    assert.equal(paid.payments[0]!.reference, 'SGH1A2B3C4');
    assert.equal(await bal('2310'), 580 + 999); // two receipts still waiting, held in suspense

    const waiting = await prisma.mpesaTransaction.findFirstOrThrow({ where: { mpesaReceipt: 'SGH1A2B3C5' } });
    await assert.rejects(applyReceiptToOrder(waiting.id, o.id, 'T'), /nothing outstanding/);
    await applyReceiptToOrder(waiting.id, o2.id, 'Tester');
    assert.equal(await bal('2310'), 999);
    await prisma.mpesaTransaction.update({ where: { mpesaReceipt: 'SGH1A2B3C6' }, data: { status: 'Dismissed', dismissedNote: 'not ours' } });
    assert.equal(await bal('2310'), 0);
  });

  it('cost of sales is the purchases: purchase expenses and unlinked purchases post there, rejected ones do not', async () => {
    const before = await bal('5000');
    const mat = await prisma.material.create({ data: { name: 'Blank tee', price: 400 } });
    // 1) a purchase backed by an expense filed under a different head is still cost of sales
    const exp = await prisma.expense.create({ data: { date: '2031-03-12', category: 'Transport', amount: 1000, invoiceNumber: 'INV-COS-1', method: 'Cash' } });
    await prisma.purchase.create({ data: { materialId: mat.id, date: '2031-03-12', qty: 10, unitCost: 100, totalCost: 1000, expenseId: exp.id, capturedByName: 't' } });
    // 2) a purchase with no expense behind it (an import batch) posts straight to cost of sales, paid from the bank
    await prisma.purchase.create({ data: { materialId: mat.id, date: '2031-03-13', qty: 50, unitCost: 60, totalCost: 3000, capturedByName: 't', status: 'Accepted' } });
    // 3) …and a rejected one costs nothing
    await prisma.purchase.create({ data: { materialId: mat.id, date: '2031-03-13', qty: 5, unitCost: 10, totalCost: 50, capturedByName: 't', status: 'Rejected' } });
    // 4) the materials expense head is cost of sales too, with no purchase record at all
    await prisma.expense.create({ data: { date: '2031-03-14', category: 'Printing Materials & Consumables', amount: 700, method: 'Cash' } });
    assert.equal(await bal('5000'), before + 1000 + 3000 + 700);
    const pl = await buildProfitLoss('2031-03-01', '2031-03-31');
    assert.ok(pl.costOfSales.rows.some((r) => r.code === '5000'));
    assert.ok(!pl.expenses.rows.some((r) => r.code === '5000'), 'cost of sales is not repeated among the operating expenses');
    assert.equal(pl.grossProfit, Math.round((pl.income.total - pl.costOfSales.total) * 100) / 100);
  });

  it('the books hang together: balanced, reconciled, statements agree', async () => {
    const tb = await buildTrialBalance('2099-12-31');
    assert.ok(tb.balanced, `debits ${tb.debit} credits ${tb.credit}`);
    const bs = await buildBalanceSheet('2099-12-31');
    assert.ok(bs.balanced);
    const pl = await buildProfitLoss('2031-01-01', '2031-12-31');
    assert.equal(Math.round((pl.income.total - pl.costOfSales.total - pl.expenses.total) * 100), Math.round(pl.netProfit * 100));
    assert.equal(Math.round((pl.income.total - pl.costOfSales.total) * 100), Math.round(pl.grossProfit * 100));
    assert.equal(pl.expenses.rows.find((r) => r.code === '6800')!.amount > 0, true);
    const cf = await buildCashFlowStatement('2031-01-01', '2031-12-31');
    assert.ok(cf.reconciles);
    assert.equal(cf.financing.lines.length > 0, true); // the owner injection
    const rec = await reconcile('2031-01-01', '2031-12-31', '2099-12-31');
    assert.deepEqual(rec.issues, []);
    for (const c of rec.integrity.filter((x) => x.name !== 'Petty cash was never overdrawn')) assert.ok(c.ok, `${c.name}: ${c.detail}`);
  });
});
