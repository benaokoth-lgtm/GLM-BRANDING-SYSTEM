// One M-Pesa payment applied to several orders: suggested split (the payer's orders, oldest first), applying part of a receipt, the amount left staying on the waiting list, typing the same code on several
// orders, correcting one part, a statement line arriving after the codes were typed by hand, and the NCBA tie-out. (Named z… because it records data.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { todayStr } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { storeReceipt } from '../src/accounting/mpesaMatching';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { loadLedger, naturalBalance, sumByAccount } from '../src/accounting/ledger';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
let svc = 0;
let staffId = 0;
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
let n = 0;
// an unpaid invoice for a customer, owing `price`
const owing = async (phone: string, name: string, price: number) => (await call('front', 'POST', '/orders/walkin', { customerName: name, phone, staffId, paymentTiming: 'onCompletion', lineItems: [{ itemType: 'service', serviceId: svc, qty: 1, unitPrice: price }] })).body;
const receipt = (amount: number, phone: string, code = `QSPLIT${String(++n).padStart(3, '0')}`) => prisma.mpesaTransaction.create({ data: { checkoutRequestId: `IMPORT-${code}`, merchantRequestId: '', phone, amount, accountReference: 'Paybill', status: 'Unmatched', mpesaReceipt: code, kind: 'C2B', payerName: 'Split Payer', receivedOn: todayStr(), createdByName: 'test' } });
const owed = async (id: number) => (await call('admin', 'GET', `/orders/${id}`)).body.totals.balanceDue;
const unalloc = async () => {
  const l = await loadLedger();
  const a = l.byCode.get('2310')!;
  return naturalBalance(a.type, sumByAccount(l.postings).get(a.id));
};

describe('one M-Pesa payment applied to several orders', () => {
  before(async () => {
    await prisma.dayCloseSettings.upsert({ where: { id: 1 }, update: { readyBeforeFinalPayment: false, warnDuplicateOrders: false }, create: { id: 1, readyBeforeFinalPayment: false, warnDuplicateOrders: false } });
    await prisma.role.create({ data: { name: 'Front (split test)', canCaptureOrders: true, canManagePayments: true, canViewAllOrders: true } });
    await prisma.role.create({ data: { name: 'Seller (split test)', canCaptureOrders: true } });
    for (const [key, role] of [['front', 'Front (split test)'], ['seller', 'Seller (split test)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (split test)`, role, pinHash: 'x' } });
      if (key === 'front') staffId = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    svc = (await prisma.service.create({ data: { name: 'Print (split test)', unit: 'piece', price: 1000 } })).id;
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('suggests the payer’s own orders oldest first, and a person confirms; the whole payment is used up across the orders', async () => {
    const a = await owing('0711 700 001', 'Multi Payer', 4000);
    const b = await owing('0711 700 001', 'Multi Payer', 5000);
    const c = await owing('0711 700 001', 'Multi Payer', 3500);
    const other = await owing('0711 700 999', 'Someone Else', 3000);
    const before = await unalloc();
    const tx = await receipt(12000, '254711700001');

    // seller cannot; the front office sees the suggestion
    assert.equal((await call('seller', 'GET', `/accounting/mpesa/${tx.id}/split`)).status, 403);
    const s = (await call('front', 'GET', `/accounting/mpesa/${tx.id}/split`)).body;
    assert.equal(s.left, 12000);
    assert.deepEqual(s.suggested, [{ orderId: a.id, amount: 4000 }, { orderId: b.id, amount: 5000 }, { orderId: c.id, amount: 3000 }]);
    assert.ok(s.orders.find((o: any) => o.orderId === a.id).samePayer);
    assert.equal(s.orders.find((o: any) => o.orderId === other.id).samePayer, false);

    // refused: more than the payment holds, more than an order owes, an order twice, nothing at all
    const post = (allocations: any[]) => call('front', 'POST', `/accounting/mpesa/${tx.id}/allocate`, { allocations });
    assert.match((await post([{ orderId: a.id, amount: 4000 }, { orderId: b.id, amount: 5000 }, { orderId: c.id, amount: 3500 }, { orderId: other.id, amount: 100 }])).body.error, /only Ksh 12,000/);
    assert.match((await post([{ orderId: a.id, amount: 4500 }])).body.error, /only owes/);
    assert.equal((await post([{ orderId: a.id, amount: 1000 }, { orderId: a.id, amount: 1000 }])).status, 400);
    assert.equal((await post([])).status, 400);

    const ok = await post(s.suggested);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.applied, ok.body.remaining, ok.body.orders], [12000, 0, 3]);
    assert.deepEqual([await owed(a.id), await owed(b.id), await owed(c.id), await owed(other.id)], [0, 0, 500, 3000]);
    assert.equal((await prisma.mpesaTransaction.findUniqueOrThrow({ where: { id: tx.id } })).status, 'Applied');
    assert.equal(await prisma.payment.count({ where: { mpesaTransactionId: tx.id } }), 3);
    // the books: the receipt held in unallocated money was moved to the orders, all of it
    assert.equal(Math.round(((await unalloc()) - before) * 100) / 100, 0);
    // it cannot be applied again
    assert.match((await post([{ orderId: c.id, amount: 500 }])).body.error, /already been dealt with/);
  });

  it('part of a payment can be applied, and what is left stays on the waiting list — then applied to another order later', async () => {
    const a = await owing('0711 700 002', 'Part Payer', 4000);
    const b = await owing('0711 700 002', 'Part Payer', 6000);
    const tx = await receipt(10000, '254711700002');
    const first = await call('front', 'POST', `/accounting/mpesa/${tx.id}/allocate`, { allocations: [{ orderId: a.id, amount: 4000 }] });
    assert.deepEqual([first.status, first.body.remaining], [200, 6000]);
    assert.equal((await prisma.mpesaTransaction.findUniqueOrThrow({ where: { id: tx.id } })).status, 'Unmatched'); // still waiting, with 6,000 left
    const waiting = (await call('front', 'GET', '/accounting/mpesa?status=Unmatched&pageSize=100')).body.rows.find((r: any) => r.id === tx.id);
    assert.deepEqual([waiting.allocated, waiting.left, waiting.parts.length], [4000, 6000, 1]);
    // the Dismiss button is for a payment nobody has used: refused once part is on an order
    assert.match((await call('front', 'POST', `/accounting/mpesa/${tx.id}/dismiss`, { note: 'x' })).body.error, /already on an order/);
    const second = await call('front', 'POST', `/accounting/mpesa/${tx.id}/allocate`, { allocations: [{ orderId: b.id, amount: 6000 }] });
    assert.deepEqual([second.status, second.body.remaining], [200, 0]);
    assert.equal((await prisma.mpesaTransaction.findUniqueOrThrow({ where: { id: tx.id } })).status, 'Applied');
  });

  it('the same M-Pesa code typed on several orders takes only what is left of it, until it is used up', async () => {
    const a = await owing('0711 700 003', 'Typed Payer', 3000);
    const b = await owing('0711 700 003', 'Typed Payer', 4000);
    const c = await owing('0711 700 003', 'Typed Payer', 5000);
    const tx = await receipt(7000, '254711700003', 'QTYPED0001');
    const pay = (id: number, amount: number) => call('front', 'POST', `/orders/${id}/payments`, { payments: [{ method: 'M-Pesa', amount, reference: 'qtyped0001' }] });
    assert.equal((await pay(a.id, 3000)).status, 200);
    const mid = await prisma.mpesaTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    assert.equal(mid.status, 'Unmatched'); // 4,000 still free
    const tooMuch = await pay(c.id, 4500);
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body.error, /only Ksh 4,000 of it is still free/);
    assert.equal((await pay(b.id, 4000)).status, 200);
    assert.equal((await prisma.mpesaTransaction.findUniqueOrThrow({ where: { id: tx.id } })).status, 'Applied');
    assert.match((await pay(c.id, 500)).body.error, /already been used/);
  });

  it('one part can be moved or taken off on its own; the rest stays where it is, and the receipt goes back to waiting for what was taken off', async () => {
    const a = await owing('0711 700 004', 'Fix Payer', 3000);
    const b = await owing('0711 700 004', 'Fix Payer', 3000);
    const right = await owing('0711 700 004', 'Fix Payer', 3000);
    const tx = await receipt(6000, '254711700004');
    await call('front', 'POST', `/accounting/mpesa/${tx.id}/allocate`, { allocations: [{ orderId: a.id, amount: 3000 }, { orderId: b.id, amount: 3000 }] });
    const rows = (await call('front', 'GET', `/accounting/mpesa/matched?q=${tx.mpesaReceipt}`)).body.rows;
    assert.equal(rows.length, 2); // a row for each part
    assert.ok(rows.every((r: any) => r.shared && r.receiptAmount === 6000));
    const partB = rows.find((r: any) => r.orderId === b.id);
    // without saying which part, a shared receipt is refused
    assert.match((await call('front', 'POST', `/accounting/mpesa/${tx.id}/rematch`, { orderId: right.id, reason: 'wrong order' })).body.error, /choose which part/);
    assert.equal((await call('front', 'POST', `/accounting/mpesa/${tx.id}/rematch`, { orderId: right.id, reason: 'The customer meant the other order', paymentId: partB.paymentId })).status, 200);
    assert.deepEqual([await owed(a.id), await owed(b.id), await owed(right.id)], [0, 3000, 0]);
    // take the first part off: its 3,000 goes back to waiting; the moved part stays
    const partA = (await call('front', 'GET', `/accounting/mpesa/matched?q=${tx.mpesaReceipt}`)).body.rows.find((r: any) => r.orderId === a.id);
    assert.equal((await call('front', 'POST', `/accounting/mpesa/${tx.id}/unmatch`, { reason: 'Paid by someone else', paymentId: partA.paymentId })).status, 200);
    const after = await prisma.mpesaTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    assert.equal(after.status, 'Unmatched');
    assert.equal(await owed(a.id), 3000);
    const waiting = (await call('front', 'GET', '/accounting/mpesa?status=Unmatched&pageSize=100')).body.rows.find((r: any) => r.id === tx.id);
    assert.deepEqual([waiting.allocated, waiting.left], [3000, 3000]);
  });

  it('a statement line arriving after the code was typed on several orders ties them all to it, and keeps what is left free', async () => {
    const a = await owing('0711 700 005', 'Late Payer', 3000);
    const b = await owing('0711 700 005', 'Late Payer', 4000);
    const pay = (id: number, amount: number) => call('front', 'POST', `/orders/${id}/payments`, { payments: [{ method: 'M-Pesa', amount, reference: 'QLATE00001' }] });
    assert.equal((await pay(a.id, 3000)).status, 200); // typed by hand, no statement line yet
    assert.equal((await pay(b.id, 4000)).status, 200);
    const stored = await storeReceipt({ receipt: 'QLATE00001', date: todayStr(), phone: '254711700005', name: 'Late Payer', amount: 9000, reference: 'x', kind: 'Import' }, 'test');
    assert.equal(stored?.linked, true);
    const tx = await prisma.mpesaTransaction.findUniqueOrThrow({ where: { mpesaReceipt: 'QLATE00001' }, include: { payments: true } });
    assert.equal(tx.payments.length, 2);
    assert.equal(tx.status, 'Unmatched'); // 2,000 of the 9,000 is still free
    // and a statement line equal to what was typed is fully applied
    const c = await owing('0711 700 006', 'Exact Payer', 5000);
    assert.equal((await call('front', 'POST', `/orders/${c.id}/payments`, { payments: [{ method: 'M-Pesa', amount: 5000, reference: 'QLATE00002' }] })).status, 200);
    await storeReceipt({ receipt: 'QLATE00002', date: todayStr(), phone: '254711700006', name: 'Exact Payer', amount: 5000, reference: 'x', kind: 'Import' }, 'test');
    assert.equal((await prisma.mpesaTransaction.findUniqueOrThrow({ where: { mpesaReceipt: 'QLATE00002' } })).status, 'Applied');
  });

  it('the NCBA tie-out counts only what is still on no order for a part-matched receipt', async () => {
    const a = await owing('0711 700 007', 'Ncba Payer', 4000);
    const tx = await receipt(10000, '254711700007', 'QNCBA00001');
    await prisma.ncbaNotification.create({ data: { transId: 'QNCBA00001', amount: 10000, outcome: 'Received', phone: '0711700007', payerName: 'Ncba Payer' } });
    await call('front', 'POST', `/accounting/mpesa/${tx.id}/allocate`, { allocations: [{ orderId: a.id, amount: 4000 }] });
    const day = (await call('front', 'GET', `/day-close?date=${todayStr()}&till=all`)).body;
    const row = day.ncba.notOnOrder.receipts.find((r: any) => r.receipt === 'QNCBA00001');
    assert.equal(row.amount, 6000); // the 6,000 not yet on any order
  });
});
