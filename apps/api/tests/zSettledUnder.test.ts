// An order whose total has cents, paid in whole shillings, is paid: under Ksh 1 left counts as settled, the order is handed over without "credit", and the books write the cents off. (Named z… because it records data.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { computeOrderTotals, fmtKshCents, owingAfter } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { buildReceivablesAging } from '../src/accounting/reports';
import { loadLedger, naturalBalance, sumByAccount } from '../src/accounting/ledger';

let server: Server;
let base = '';
let token = '';
let staffId = 0;
let svc = 0;
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const bal = async (code: string) => {
  const l = await loadLedger();
  const a = l.byCode.get(code)!;
  return naturalBalance(a.type, sumByAccount(l.postings).get(a.id));
};
const invoice = (name: string, price: number) => call('POST', '/orders/walkin', { customerName: name, phone: '0700 123 456', staffId, paymentTiming: 'onCompletion', lineItems: [{ itemType: 'service', serviceId: svc, qty: 1, unitPrice: price }] });

describe('under Ksh 1 left on an order counts as paid', () => {
  before(async () => {
    await prisma.dayCloseSettings.upsert({ where: { id: 1 }, update: { readyBeforeFinalPayment: false, warnDuplicateOrders: false }, create: { id: 1, readyBeforeFinalPayment: false, warnDuplicateOrders: false } });
    await prisma.role.create({ data: { name: 'Front (settled test)', canCaptureOrders: true, canManagePayments: true, canViewAllOrders: true } });
    const u = await prisma.user.create({ data: { name: 'front (settled test)', role: 'Front (settled test)', pinHash: 'x' } });
    staffId = u.id;
    token = signToken({ id: u.id, name: u.name, role: 'Front (settled test)' });
    svc = (await prisma.service.create({ data: { name: 'Print (settled test)', unit: 'piece', price: 1000 } })).id;
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('the rule in the totals: a few cents left after a payment is not owed; nothing paid means nothing is written off; a shilling or more is still owed', () => {
    assert.equal(owingAfter(4689.6, 4689), 0);
    assert.equal(Math.round(owingAfter(4689.6, 4688) * 100) / 100, 1.6);
    assert.equal(owingAfter(0.6, 0), 0.6); // nothing paid: the 60 cents are owed
    const t = computeOrderTotals({ lineItems: [{ itemType: 'service', serviceId: 1, materialId: null, qty: 1, unitPrice: 4689.6, discountPct: 0, discountAmt: 0 }], orderDiscountPct: 0, orderDiscountAmt: 0 }, [{ date: '2026-10-01', amount: 4689, method: 'M-Pesa' }]);
    assert.deepEqual([t.balanceDue, Math.round(t.roundedOff * 100) / 100, t.paidPct], [0, 0.6, 100]);
    assert.equal(fmtKshCents(4689.6), 'Ksh 4,689.60');
    assert.equal(fmtKshCents(4689), 'Ksh 4,689');
    assert.equal(fmtKshCents(0.4), 'Ksh 0.40');
  });

  it('an order paid to within a shilling is handed over as paid — no credit, no invoice — and its cents are written off in the books and left out of the receivables', async () => {
    const o = (await invoice('Cents Client', 1000.6)).body;
    assert.equal(o.totals.grandTotal, 1000.6);
    await prisma.order.update({ where: { id: o.id }, data: { stage: 'Ready for Pickup/Delivery' } });
    const done = await call('POST', `/orders/${o.id}/handover`, { payments: [{ method: 'M-Pesa', amount: 1000, reference: 'QCENTS001' }] });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([done.body.stage, done.body.totals.balanceDue, done.body.handedOverOnCredit], ['Completed', 0, false]);
    assert.equal(Math.round(done.body.totals.roundedOff * 100) / 100, 0.6);
    // the books: 60 cents of rounding, and nothing left open for this order
    assert.equal(Math.round((await bal('5210')) * 100) / 100, 0.6);
    const aging = await buildReceivablesAging('9999-12-31');
    assert.equal(aging.rows.some((r) => r.orderId === o.id), false);
  });

  it('a shilling or more left is still owed: it needs credit, and it stays open', async () => {
    const o = (await invoice('Short Client', 1000.6)).body;
    await prisma.order.update({ where: { id: o.id }, data: { stage: 'Ready for Pickup/Delivery' } });
    const short = await call('POST', `/orders/${o.id}/handover`, { payments: [{ method: 'Cash', amount: 999 }] }); // 1.60 left
    assert.equal(short.status, 400);
    assert.equal(short.body.code, 'BALANCE_DUE');
    assert.equal(await prisma.payment.count({ where: { orderId: o.id } }), 0);
    const credit = await call('POST', `/orders/${o.id}/handover`, { onCredit: true, payments: [{ method: 'Cash', amount: 999 }] });
    assert.equal(credit.status, 200);
    assert.equal(credit.body.handedOverOnCredit, true);
    const aging = await buildReceivablesAging('9999-12-31');
    const row = aging.rows.find((r) => r.orderId === o.id);
    assert.equal(row?.outstanding, 1.6);
  });
});
