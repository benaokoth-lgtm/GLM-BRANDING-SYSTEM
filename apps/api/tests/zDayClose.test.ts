// Day close: the day's receipts by method, the cash-up (expected vs counted, float carried, banked), approval by someone else, locking, and what customers still owe, aged. (Named z… because it records data.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const D = '2024-03-10';
async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('day close: receipts, cash-up and outstanding', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Cashier (day close test)', canManagePayments: true } });
    await prisma.role.create({ data: { name: 'Finance (day close test)', canAccessFinance: true } });
    await prisma.role.create({ data: { name: 'Nobody (day close test)', canCaptureOrders: true } });
    const ids: Record<string, number> = {};
    for (const [key, role] of [['cashier', 'Cashier (day close test)'], ['finance', 'Finance (day close test)'], ['nobody', 'Nobody (day close test)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (day close test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    const svc = await prisma.service.create({ data: { name: 'Banner (day close test)', unit: 'piece', price: 1000 } });
    const mk = (orderNo: string, createdDate: string, dueDate: string, payments: { date: string; amount: number; method: string }[]) =>
      prisma.order.create({
        data: { orderNo, kind: 'walkin', staffId: ids.cashier!, createdDate, status: 'Invoice', dueDate, stage: 'Order Received', customerName: orderNo, lineItems: { create: [{ itemType: 'service', serviceId: svc.id, qty: 1, unitPrice: 1000 }] }, payments: { create: payments.map((p) => ({ ...p, staffId: ids.cashier! })) } } as any,
      });
    // A is raised today and part-paid in cash; B is a month overdue, paid a little earlier and a little today by M-Pesa
    const a = await mk('DC-A', D, '2024-03-17', [{ date: D, amount: 400, method: 'Cash' }]);
    await mk('DC-B', '2024-02-01', '2024-02-08', [{ date: '2024-02-01', amount: 100, method: 'Cash' }, { date: D, amount: 200, method: 'M-Pesa' }]);
    await prisma.adjustmentNote.create({ data: { number: 'CN-9999-001', type: 'Credit', date: D, party: 'DC-A', orderId: a.id, reason: 'test', net: 50, total: 50, creditAmt: 50, refundAmt: 50, refundMethod: 'Cash' } });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('shows the day: receipts by method and person, expected cash, and what is outstanding in ageing bands', async () => {
    assert.equal((await call('nobody', 'GET', `/day-close?date=${D}`)).status, 403);
    assert.equal((await call(null, 'GET', `/day-close?date=${D}`)).status, 401);
    const r = await call('cashier', 'GET', `/day-close?date=${D}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = Object.fromEntries(r.body.byMethod.map((x: any) => [x.method, [x.count, x.amount]]));
    assert.deepEqual([m['Cash'], m['M-Pesa']], [[1, 400], [1, 200]]);
    assert.equal(r.body.received, 600);
    assert.deepEqual(r.body.cash, { openingFloat: 0, received: 400, refunds: 50, expected: 350 });
    assert.deepEqual(r.body.byPerson.map((p: any) => [p.person, p.cash, p.other]), [['cashier (day close test)', 400, 200]]);
    // owed at the end of the day: A 600 (not yet due) and B 700 (31 days overdue); it was 900 the day before (B only), 1000 was raised and 600 received
    const o = r.body.outstanding;
    assert.deepEqual([o.opening, o.raisedToday, o.receivedToday, o.otherChanges, o.closing], [900, 1000, 600, 0, 1300]);
    assert.deepEqual(o.bands.map((b: any) => [b.label, b.count, b.amount]), [['Not yet due', 1, 600], ['1–7 days overdue', 0, 0], ['8–30 days', 0, 0], ['31–60 days', 1, 700], ['Over 60 days', 0, 0]]);
    assert.equal(o.invoices[0].orderNo, 'DC-B'); // the most overdue first
    assert.equal(r.body.close, null);
  });

  it('the cash-up: notes and coins must add up, the variance and the banked amount are worked out, and a different person approves', async () => {
    const bad = await call('cashier', 'POST', '/day-close', { date: D, counted: 350, floatCarried: 100, denominations: { '200': 1, '100': 1 } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /add up/);
    assert.equal((await call('cashier', 'POST', '/day-close', { date: D, counted: 350, floatCarried: 500 })).status, 400); // more float than cash
    assert.equal((await call('cashier', 'POST', '/day-close', { date: '2099-01-01', counted: 1, floatCarried: 0 })).status, 400); // not yet happened

    // counted 340: ten short
    const short = await call('cashier', 'POST', '/day-close', { date: D, counted: 340, floatCarried: 100, note: 'Ten short' });
    assert.equal(short.status, 201, JSON.stringify(short.body));
    assert.deepEqual([short.body.expectedCash, short.body.variance, short.body.banked, short.body.status], [350, -10, 240, 'Submitted']);
    // counted again, right, by notes and coins
    const ok = await call('cashier', 'POST', '/day-close', { date: D, counted: 350, floatCarried: 100, denominations: { '200': 1, '100': 1, '50': 1 } });
    assert.deepEqual([ok.body.variance, ok.body.banked, ok.body.denominations], [0, 250, { '200': 1, '100': 1, '50': 1 }]);

    // the person who counted cannot approve (and a cashier has no approval right at all); Finance can
    assert.equal((await call('cashier', 'POST', `/day-close/${D}/approve`)).status, 403);
    const approved = await call('finance', 'POST', `/day-close/${D}/approve`);
    assert.equal(approved.status, 200);
    assert.deepEqual([approved.body.status, approved.body.approvedByName], ['Approved', 'finance (day close test)']);
    // locked: a second submission is refused until an Admin reopens the day
    assert.equal((await call('cashier', 'POST', '/day-close', { date: D, counted: 350, floatCarried: 100 })).status, 409);
    assert.equal((await call('finance', 'POST', `/day-close/${D}/reopen`)).status, 403);
    assert.equal((await call('admin', 'POST', `/day-close/${D}/reopen`)).body.status, 'Submitted');
    assert.equal((await call('cashier', 'POST', '/day-close', { date: D, counted: 350, floatCarried: 100 })).status, 201);
    assert.equal((await call('admin', 'POST', `/day-close/${D}/approve`)).status, 200);
  });

  it('a payment added after the close is flagged, and the next day opens with the float left in the drawer', async () => {
    const A = await prisma.order.findFirstOrThrow({ where: { orderNo: 'DC-A' } });
    await prisma.payment.create({ data: { orderId: A.id, date: D, amount: 25, method: 'Cash' } });
    const day = (await call('finance', 'GET', `/day-close?date=${D}`)).body;
    assert.equal(day.close.changedSince, true);
    assert.equal(day.close.expectedCash, 350); // as it was at the close
    assert.equal(day.cash.expected, 375); // as it is now
    const next = (await call('cashier', 'GET', '/day-close?date=2024-03-11')).body;
    assert.deepEqual([next.cash.openingFloat, next.cash.expected], [100, 100]);
  });

  it('the month shows each day’s receipts and whether it was closed; a day with payments and no close is the exception', async () => {
    const A = await prisma.order.findFirstOrThrow({ where: { orderNo: 'DC-A' } });
    await prisma.payment.create({ data: { orderId: A.id, date: '2024-03-08', amount: 90, method: 'Cash' } });
    const m = (await call('finance', 'GET', '/day-close/month?month=2024-03')).body;
    const by = Object.fromEntries(m.days.map((d: any) => [d.date, d]));
    assert.equal(by[D].status, 'Approved');
    assert.equal(by['2024-03-08'].status, 'Not closed');
    assert.equal(by['2024-03-08'].cash, 90);
    assert.equal(m.notClosed, 1);
    assert.equal(m.totalBanked, 250);
  });
});
