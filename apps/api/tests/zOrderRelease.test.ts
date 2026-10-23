// Releasing an order properly: the final payment and the handover together at the counter once the order is ready, a manager's early release with a reason, a question before a possible duplicate is
// captured, deleting a mistaken duplicate (even a film order, even one wrongly marked Completed), and the list of orders that went round the process. (Named z… because it records data.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { addDays, todayStr } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
let svc = 0;
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const line = (qty: number, unitPrice: number) => ({ itemType: 'service' as const, serviceId: svc, qty, unitPrice });
const invoice = (who: string, name: string, phone: string, lines: any[], extra: Record<string, unknown> = {}) => call(who, 'POST', '/orders/walkin', { customerName: name, phone, staffId: ids[who], paymentTiming: 'onCompletion', lineItems: lines, ...extra });
const stage = (id: number, s: string) => prisma.order.update({ where: { id }, data: { stage: s } });
const gate = (readyBeforeFinalPayment: boolean, warnDuplicateOrders: boolean) => prisma.dayCloseSettings.upsert({ where: { id: 1 }, update: { readyBeforeFinalPayment, warnDuplicateOrders }, create: { id: 1, readyBeforeFinalPayment, warnDuplicateOrders } });

describe('releasing an order, duplicates and deleting a mistaken order', () => {
  before(async () => {
    await gate(true, true);
    await prisma.role.create({ data: { name: 'Seller (release test)', canCaptureOrders: true, canAccessDtf: true } });
    await prisma.role.create({ data: { name: 'Front (release test)', canCaptureOrders: true, canAccessDtf: true, canManagePayments: true, canViewAllOrders: true } });
    await prisma.role.create({ data: { name: 'Finance (release test)', canAccessFinance: true, canViewAllOrders: true } });
    await prisma.role.create({ data: { name: 'Production lead (release test)', canManagePayments: true, canManageProduction: true, canManageDtf: true, canAccessDtf: true, canViewAllOrders: true, canCaptureOrders: true } });
    for (const [key, role] of [['seller', 'Seller (release test)'], ['front', 'Front (release test)'], ['finance', 'Finance (release test)'], ['lead', 'Production lead (release test)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (release test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    svc = (await prisma.service.create({ data: { name: 'Banner (release test)', unit: 'piece', price: 1000 } })).id;
    await prisma.dtfRoll.create({ data: { id: 'ROLL-REL', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100 } });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await gate(false, false); // later test files are about other things
    server.close();
    await prisma.$disconnect();
  });

  describe('the final payment is taken when the order is ready, with the handover', () => {
    it('a deposit is taken at any stage, but the payment that settles the order is refused until it is ready — a manager can release it with a reason, which is recorded', async () => {
      const o = (await invoice('seller', 'Gate Client', '0711 100 001', [line(2, 1000)])).body; // 2,000
      assert.equal((await call('front', 'POST', `/orders/${o.id}/payments`, { amount: 500, method: 'Cash' })).status, 200); // a deposit
      const refused = await call('front', 'POST', `/orders/${o.id}/payments`, { amount: 1500, method: 'Cash' });
      assert.equal(refused.status, 409);
      assert.deepEqual([refused.body.code, refused.body.canOverride], ['FINAL_PAYMENT_NOT_READY', false]);
      assert.match(refused.body.error, /not been produced/);
      // a manager with no reason is refused too; with a reason it goes through and is logged
      assert.equal((await call('lead', 'POST', `/orders/${o.id}/payments`, { amount: 1500, method: 'Cash' })).status, 409);
      const released = await call('lead', 'POST', `/orders/${o.id}/payments`, { amount: 1500, method: 'Cash', overrideReason: 'Customer is travelling, collecting the printed copy tomorrow' });
      assert.equal(released.status, 200, JSON.stringify(released.body));
      const log = await prisma.orderOverride.findFirstOrThrow({ where: { orderId: o.id } });
      assert.deepEqual([log.kind, log.stage, log.amount, log.byName], ['FinalPayment', 'Order Received', 1500, 'lead (release test)']);
      // it is listed on Day close for the day
      const day = (await call('front', 'GET', `/day-close?date=${todayStr()}&till=all`)).body;
      assert.ok(day.toCheck.releases.some((r: any) => r.orderNo === o.orderNo && r.kind === 'FinalPayment' && /travelling/.test(r.reason)));
      // an order that is paid in full but was never started shows as one to check — tomorrow, once the day of capture has passed
      assert.equal(day.toCheck.notProduced.some((r: any) => r.orderNo === o.orderNo), false, 'captured today: not yet');
    });

    it('once the order is ready, the final payment is taken WITH the handover — one action; paying it off separately is refused', async () => {
      const o = (await invoice('seller', 'Counter Client', '0711 100 002', [line(2, 1000)])).body; // 2,000
      await stage(o.id, 'Ready for Pickup/Delivery');
      const split = await call('front', 'POST', `/orders/${o.id}/payments`, { amount: 2000, method: 'Cash' });
      assert.equal(split.status, 409);
      assert.equal(split.body.code, 'USE_COUNTER');
      assert.equal((await call('front', 'POST', `/orders/${o.id}/payments`, { amount: 500, method: 'Cash' })).status, 200); // a part-payment is still fine

      // paying too little with no credit leaves everything as it was
      const short = await call('front', 'POST', `/orders/${o.id}/handover`, { payments: [{ method: 'Cash', amount: 1000 }] });
      assert.equal(short.status, 400);
      assert.equal(short.body.code, 'BALANCE_DUE');
      assert.equal(await prisma.payment.count({ where: { orderId: o.id } }), 1, 'nothing was recorded');
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).stage, 'Ready for Pickup/Delivery');
      // too much is refused
      assert.equal((await call('front', 'POST', `/orders/${o.id}/handover`, { payments: [{ method: 'Cash', amount: 5000 }] })).status, 400);
      // the right amount: paid and handed over together
      const done = await call('front', 'POST', `/orders/${o.id}/handover`, { payments: [{ method: 'Cash', amount: 1500 }] });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.deepEqual([done.body.stage, done.body.totals.balanceDue, done.body.handedOverOnCredit], ['Completed', 0, false]);
      assert.equal(await prisma.payment.count({ where: { orderId: o.id } }), 2);
      // someone who takes no payments cannot take them at handover
      const o2 = (await invoice('seller', 'Counter Two', '0711 100 003', [line(1, 1000)])).body;
      await stage(o2.id, 'Ready for Pickup/Delivery');
      assert.equal((await call('seller', 'POST', `/orders/${o2.id}/handover`, { payments: [{ method: 'Cash', amount: 1000 }] })).status, 200); // the person who captured it takes the payment at the till
      // and an order already paid in full is handed over with no payment
      const o3 = (await invoice('seller', 'Counter Three', '0711 100 004', [line(1, 1000)], { paymentTiming: 'onAcceptance', payments: [{ method: 'Cash', amount: 1000 }] })).body;
      await stage(o3.id, 'Ready for Pickup/Delivery');
      assert.equal((await call('front', 'POST', `/orders/${o3.id}/handover`, {})).status, 200);
    });

    it('an order cannot be handed over before it is ready — a manager can release it with a reason, which is recorded', async () => {
      const o = (await invoice('seller', 'Early Client', '0711 100 005', [line(1, 1000)], { paymentTiming: 'onAcceptance', payments: [{ method: 'Cash', amount: 1000 }] })).body;
      const early = await call('front', 'POST', `/orders/${o.id}/handover`, {});
      assert.equal(early.status, 400);
      assert.deepEqual([early.body.code, early.body.canOverride], ['NOT_READY', false]);
      assert.equal((await call('lead', 'POST', `/orders/${o.id}/handover`, {})).status, 400); // a manager needs a reason too
      const ok = await call('lead', 'POST', `/orders/${o.id}/handover`, { overrideReason: 'Urgent: customer waiting, QC done on the counter' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((await prisma.orderOverride.findFirstOrThrow({ where: { orderId: o.id, kind: 'Handover' } })).stage, 'Order Received');
    });

    it('"Mark paid" on a film sale follows the same rule', async () => {
      const made = (await call('seller', 'POST', '/dtf/sales', { rollId: 'ROLL-REL', client: 'Mark Paid Film', phone: '0766 600 001', metres: 4, pricePerM: 450, amountPaid: 0 })).body;
      const sale = { id: made.sale.id, order: made.order };
      const total = 4 * 450;
      const refused = await call('lead', 'PATCH', `/dtf/sales/${sale.id}/paid`, { amountPaid: total });
      assert.equal(refused.status, 409);
      assert.deepEqual([refused.body.code, refused.body.canOverride], ['FINAL_PAYMENT_NOT_READY', true]);
      const ok = await call('lead', 'PATCH', `/dtf/sales/${sale.id}/paid`, { amountPaid: total, overrideReason: 'Regular client, pays on collection tomorrow' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(await prisma.orderOverride.count({ where: { orderId: sale.order.id, kind: 'FinalPayment' } }), 1);
    });

    it('the rule can be switched off by an Admin, and a quotation is not handed over', async () => {
      await gate(false, true);
      const o = (await invoice('seller', 'Free Client', '0711 100 006', [line(1, 1000)])).body;
      assert.equal((await call('front', 'POST', `/orders/${o.id}/payments`, { amount: 1000, method: 'Cash' })).status, 200); // settled at any stage
      await gate(true, true);
    });
  });

  describe('a possible duplicate is asked about before it is captured', () => {
    it('the same client and total within 24 hours needs a confirmation; a different total, or no name and phone, does not', async () => {
      const first = await invoice('seller', 'Dup Client', '0722 200 001', [line(3, 1000)]);
      assert.equal(first.status, 201);
      const second = await invoice('seller', 'Dup Client', '0722 200 001', [line(3, 1000)]);
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'POSSIBLE_DUPLICATE');
      assert.equal(second.body.duplicates[0].orderNo, first.body.orderNo);
      assert.match(second.body.error, /looks like a duplicate/);
      // the same phone written another way, with another name, is the same client
      assert.equal((await invoice('seller', 'D Client', '+254 722 200 001', [line(3, 1000)])).status, 409);
      // confirmed: it goes through
      assert.equal((await invoice('seller', 'Dup Client', '0722 200 001', [line(3, 1000)], { confirmDuplicate: true })).status, 201);
      // a different total, a different client, and a walk-in with nothing to tell them by are not asked about
      assert.equal((await invoice('seller', 'Dup Client', '0722 200 001', [line(4, 1000)])).status, 201);
      assert.equal((await invoice('seller', 'Other Client', '0722 200 002', [line(3, 1000)])).status, 201);
      assert.equal((await invoice('seller', '', '', [line(3, 1000)])).status, 201);
      assert.equal((await invoice('seller', '', '', [line(3, 1000)])).status, 201);
    });

    it('a film sale is checked the same way, and the warning can be switched off', async () => {
      const film = (extra: Record<string, unknown> = {}) => call('seller', 'POST', '/dtf/sales', { rollId: 'ROLL-REL', client: 'Dup Film', phone: '0733 300 001', metres: 5, pricePerM: 450, amountPaid: 0, ...extra });
      assert.equal((await film()).status, 201);
      const again = await film();
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'POSSIBLE_DUPLICATE');
      assert.equal((await film({ confirmDuplicate: true })).status, 201);
      await gate(true, false);
      assert.equal((await film()).status, 201); // the warning is off
      await gate(true, true);
    });
  });

  describe('deleting a mistaken duplicate', () => {
    it('a duplicate film order that was never paid or produced can be deleted, and its film goes back to the roll', async () => {
      const sale = await call('seller', 'POST', '/dtf/sales', { rollId: 'ROLL-REL', client: 'Mistaken Film', phone: '0744 400 001', metres: 7, pricePerM: 450, amountPaid: 0 });
      assert.equal(sale.status, 201, JSON.stringify(sale.body));
      const orderId = sale.body.order.id;
      assert.equal(await prisma.dtfFilmSale.count({ where: { orderId } }), 1);
      const ask = (await call('seller', 'POST', `/order-changes/orders/${orderId}`, { kind: 'Delete', reason: 'Captured twice by mistake' })).body;
      assert.equal((await call('finance', 'POST', `/order-changes/requests/${ask.id}/approve`)).status, 200);
      const done = await call('seller', 'DELETE', `/order-changes/orders/${orderId}`);
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(await prisma.order.count({ where: { id: orderId } }), 0);
      assert.equal(await prisma.dtfFilmSale.count({ where: { client: 'Mistaken Film' } }), 0, 'the sale went with the order');
    });

    it('even one wrongly marked Completed can be deleted — but not one that was paid, produced, credited or has a supplier bill', async () => {
      const dup = (await invoice('seller', 'Completed Dup', '0755 500 001', [line(1, 1000)])).body;
      await prisma.order.update({ where: { id: dup.id }, data: { stage: 'Completed', handedOverOnCredit: true } });
      const info = (await call('seller', 'GET', `/order-changes/orders/${dup.id}`)).body;
      assert.match(info.amendProblem, /completed/i); // it cannot be amended
      assert.equal(info.deleteProblem, null); // but it can be deleted
      const ask = (await call('seller', 'POST', `/order-changes/orders/${dup.id}`, { kind: 'Delete', reason: 'Duplicate: customer collected the other copy' })).body;
      await call('admin', 'POST', `/order-changes/requests/${ask.id}/approve`);
      assert.equal((await call('seller', 'DELETE', `/order-changes/orders/${dup.id}`)).status, 200);

      // production has worked on it: refused
      const made = (await invoice('seller', 'Made Order', '0755 500 002', [line(1, 1000)])).body;
      await prisma.productionTask.create({ data: { orderId: made.id, status: 'Finished', unitsPlanned: 1 } });
      const refused = await call('seller', 'POST', `/order-changes/orders/${made.id}`, { kind: 'Delete', reason: 'duplicate' });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, /Production has already worked/);
      // a credit note on it: refused
      const credited = (await invoice('seller', 'Credited Order', '0755 500 003', [line(1, 1000)])).body;
      await prisma.adjustmentNote.create({ data: { number: 'CN-9998-001', type: 'Credit', date: todayStr(), party: 'x', orderId: credited.id, reason: 'test', net: 100, total: 100 } });
      assert.equal((await call('seller', 'POST', `/order-changes/orders/${credited.id}`, { kind: 'Delete', reason: 'duplicate' })).status, 400);
    });
  });

  describe('orders that went round the process are listed', () => {
    it('an order paid in full but never started, from before today, is on the Day close list; the evening summary mentions it', async () => {
      const o = await prisma.order.create({
        data: { orderNo: 'RL-OLD', kind: 'walkin', staffId: ids.seller!, createdDate: addDays(todayStr(), -2), status: 'Order', stage: 'Order Received', customerName: 'Paid Not Made', lineItems: { create: [{ itemType: 'service', serviceId: svc, qty: 1, unitPrice: 1000 }] }, payments: { create: [{ date: addDays(todayStr(), -2), amount: 1000, method: 'Cash' }] } } as any,
      });
      const day = (await call('front', 'GET', `/day-close?date=${todayStr()}&till=all`)).body;
      const hit = day.toCheck.notProduced.find((r: any) => r.orderNo === 'RL-OLD');
      assert.deepEqual([hit.daysWaiting, hit.total], [2, 1000]);
      // once it is made, it drops off
      await stage(o.id, 'In Production');
      const after = (await call('front', 'GET', `/day-close?date=${todayStr()}&till=all`)).body;
      assert.equal(after.toCheck.notProduced.some((r: any) => r.orderNo === 'RL-OLD'), false);
      // the Admin's switches
      const settings = (await call('admin', 'GET', '/day-close/settings')).body;
      assert.deepEqual([settings.readyBeforeFinalPayment, settings.warnDuplicateOrders], [true, true]);
      assert.equal((await call('front', 'PUT', '/day-close/settings', { readyBeforeFinalPayment: false })).status, 403);
      const off = await call('admin', 'PUT', '/day-close/settings', { readyBeforeFinalPayment: false, warnDuplicateOrders: false });
      assert.deepEqual([off.body.readyBeforeFinalPayment, off.body.warnDuplicateOrders], [false, false]);
      await call('admin', 'PUT', '/day-close/settings', { readyBeforeFinalPayment: true, warnDuplicateOrders: true });
    });
  });
});
