// Putting a wrong M-Pesa / NCBA match right (move the receipt to the right order, or take it off), and amending or deleting an order after it has been approved. (Named z… because it records data.)
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
const ids: Record<string, number> = {};
let svc = 0;
let mat = 0;
async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const line = (qty: number, unitPrice: number) => ({ itemType: 'service' as const, serviceId: svc, qty, unitPrice });
// an order left unpaid (an invoice) so it can take a payment
const invoice = (who: string, name: string, lines: any[], extra: Record<string, unknown> = {}) => call(who, 'POST', '/orders/walkin', { customerName: name, phone: '0712 000 111', staffId: ids[who], paymentTiming: 'onCompletion', lineItems: lines, ...extra });

describe('wrong M-Pesa matches, and amending or deleting an order', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Seller (order change test)', canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Front (order change test)', canCaptureOrders: true, canManagePayments: true, canViewAllOrders: true } });
    await prisma.role.create({ data: { name: 'Finance (order change test)', canAccessFinance: true, canViewAllOrders: true } });
    for (const [key, role] of [['seller', 'Seller (order change test)'], ['seller2', 'Seller (order change test)'], ['front', 'Front (order change test)'], ['finance', 'Finance (order change test)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (order change test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    svc = (await prisma.service.create({ data: { name: 'Banner (order change test)', unit: 'piece', price: 1000 } })).id;
    mat = (await prisma.material.create({ data: { name: 'Mug (order change test)', price: 500, stockQty: 10 } })).id;
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  describe('a payment matched to the wrong order', () => {
    it('can be moved to the right order or taken off it, by the front office; each needs a reason and is logged', async () => {
      const x = (await invoice('seller', 'Wrong Client', [line(1, 1000)])).body; // 1,000 owed
      const y = (await invoice('seller', 'Right Client', [line(1, 800)])).body; // 800 owed
      const small = (await invoice('seller', 'Small Client', [line(1, 100)])).body; // 100 owed
      const tx = await prisma.mpesaTransaction.create({ data: { checkoutRequestId: 'IMPORT-RM1', merchantRequestId: '', phone: '0712000111', amount: 500, accountReference: x.orderNo, status: 'Unmatched', mpesaReceipt: 'QRM0001', kind: 'C2B', payerName: 'A Payer', receivedOn: '2024-06-01', createdByName: 'test' } });
      assert.equal((await call('front', 'POST', `/accounting/mpesa/${tx.id}/apply`, { orderId: x.id })).status, 200); // matched to the wrong order

      // the front office finds it; someone with no payment duties cannot
      assert.equal((await call('seller', 'GET', '/accounting/mpesa/matched')).status, 403);
      const found = (await call('front', 'GET', '/accounting/mpesa/matched?q=QRM0001')).body.rows;
      assert.deepEqual([found.length, found[0].orderNo, found[0].amount, found[0].canUnmatch], [1, x.orderNo, 500, true]);

      // refused: no reason, an order that owes less than the payment, the order it is already on
      assert.equal((await call('front', 'POST', `/accounting/mpesa/${tx.id}/rematch`, { orderId: y.id, reason: '' })).status, 400);
      const tooSmall = await call('front', 'POST', `/accounting/mpesa/${tx.id}/rematch`, { orderId: small.id, reason: 'wrong order' });
      assert.equal(tooSmall.status, 400);
      assert.match(tooSmall.body.error, /only owes/);
      assert.equal((await call('front', 'POST', `/accounting/mpesa/${tx.id}/rematch`, { orderId: x.id, reason: 'same' })).status, 400);

      // moved to the right one
      const moved = await call('front', 'POST', `/accounting/mpesa/${tx.id}/rematch`, { orderId: y.id, reason: 'Customer paid for the Right Client job' });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.deepEqual([moved.body.from, moved.body.to], [x.orderNo, y.orderNo]);
      const owed = async (id: number) => (await call('admin', 'GET', `/orders/${id}`)).body.totals.balanceDue;
      assert.deepEqual([await owed(x.id), await owed(y.id)], [1000, 300]);
      const payment = await prisma.payment.findFirstOrThrow({ where: { mpesaTransactionId: tx.id } });
      assert.equal(payment.orderId, y.id);
      assert.equal((await prisma.mpesaTransaction.findUniqueOrThrow({ where: { id: tx.id } })).orderId, y.id);
      const log = (await call('front', 'GET', '/accounting/mpesa/matched?q=QRM0001')).body.rows[0];
      assert.deepEqual([log.orderNo, log.changes[0].from, log.changes[0].to, log.changes[0].by], [y.orderNo, x.orderNo, y.orderNo, 'front (order change test)']);

      // taken off altogether: back to the waiting list, the order owes again
      assert.equal((await call('front', 'POST', `/accounting/mpesa/${tx.id}/unmatch`, { reason: '' })).status, 400);
      assert.equal((await call('front', 'POST', `/accounting/mpesa/${tx.id}/unmatch`, { reason: 'It was paid by someone else' })).status, 200);
      assert.equal((await prisma.mpesaTransaction.findUniqueOrThrow({ where: { id: tx.id } })).status, 'Unmatched');
      assert.equal(await prisma.payment.count({ where: { mpesaTransactionId: tx.id } }), 0);
      assert.equal(await owed(y.id), 800);
      assert.equal((await call('front', 'POST', `/accounting/mpesa/${tx.id}/unmatch`, { reason: 'again' })).status, 400); // nothing on an order any more
      // and it can be matched again in the usual way
      assert.equal((await call('front', 'POST', `/accounting/mpesa/${tx.id}/apply`, { orderId: y.id })).status, 200);
    });

    it('a payment from a push we sent cannot be taken off its order, only moved', async () => {
      const a = (await invoice('seller', 'Push Client', [line(1, 700)])).body;
      const b = (await invoice('seller', 'Push Right', [line(1, 700)])).body;
      const tx = await prisma.mpesaTransaction.create({ data: { checkoutRequestId: 'NCBA-RM2', merchantRequestId: '', phone: '0712000111', amount: 300, accountReference: a.orderNo, status: 'Success', mpesaReceipt: 'QRM0002', kind: 'STK', orderId: a.id, createdByName: 'test' } });
      await prisma.payment.create({ data: { orderId: a.id, date: '2024-06-02', amount: 300, method: 'M-Pesa', reference: 'QRM0002', mpesaTransactionId: tx.id } });
      const list = (await call('front', 'GET', '/accounting/mpesa/matched?q=QRM0002')).body.rows[0];
      assert.equal(list.canUnmatch, false);
      assert.equal((await call('front', 'POST', `/accounting/mpesa/${tx.id}/unmatch`, { reason: 'x' })).status, 400);
      assert.equal((await call('front', 'POST', `/accounting/mpesa/${tx.id}/rematch`, { orderId: b.id, reason: 'The push was for the other order' })).status, 200);
    });
  });

  describe('amending an order after it is approved', () => {
    it('needs a request, a decision by someone else, and then the person who asked makes the change — once', async () => {
      const o = (await invoice('seller', 'Amend Client', [{ itemType: 'material' as const, materialId: mat, qty: 2, unitPrice: 500 }, line(1, 1000)])).body; // 2,000
      assert.equal((await prisma.material.findUniqueOrThrow({ where: { id: mat } })).stockQty, 8); // 2 mugs left the shelf

      const change = { customerName: 'Amend Client Ltd', phone: '0700 111 222', lineItems: [{ itemType: 'material' as const, materialId: mat, qty: 3, unitPrice: 500 }, line(2, 1000)], orderDiscountPct: 0, orderDiscountAmt: 0 };
      // no approved request yet
      const early = await call('seller', 'PUT', `/order-changes/orders/${o.id}/amend`, change);
      assert.equal(early.status, 403);
      assert.match(early.body.error, /no approved request/);

      // asking: needs a reason, and only someone who may open the order can ask
      assert.equal((await call('seller', 'POST', `/order-changes/orders/${o.id}`, { kind: 'Amend', reason: '' })).status, 400);
      assert.equal((await call('seller2', 'POST', `/order-changes/orders/${o.id}`, { kind: 'Amend', reason: 'not my order' })).status, 403);
      const ask = await call('seller', 'POST', `/order-changes/orders/${o.id}`, { kind: 'Amend', reason: 'Customer added a mug and a banner' });
      assert.equal(ask.status, 201, JSON.stringify(ask.body));
      assert.equal(ask.body.status, 'Pending');
      assert.equal((await call('seller', 'POST', `/order-changes/orders/${o.id}`, { kind: 'Delete', reason: 'second request' })).status, 409); // one at a time

      // still pending: cannot amend; the person who asked cannot decide; a role without Finance cannot either
      assert.equal((await call('seller', 'PUT', `/order-changes/orders/${o.id}/amend`, change)).status, 403);
      assert.equal((await call('seller', 'POST', `/order-changes/requests/${ask.body.id}/approve`)).status, 403);
      assert.equal((await call('front', 'POST', `/order-changes/requests/${ask.body.id}/approve`)).status, 403);

      // it is in the approvers' inbox and in the requester's own list
      const inbox = (await call('finance', 'GET', '/approvals')).body;
      assert.ok(inbox.waiting.some((i: any) => i.key === `orderchange:${ask.body.id}`), 'waiting for Finance');
      assert.ok((await call('seller', 'GET', '/approvals')).body.mine.some((i: any) => i.key === `orderchange:${ask.body.id}`));

      assert.equal((await call('finance', 'POST', `/order-changes/requests/${ask.body.id}/approve`)).body.status, 'Approved');
      assert.equal((await call('seller2', 'PUT', `/order-changes/orders/${o.id}/amend`, change)).status, 403); // someone else cannot use it

      // paid more than the new total would be refused: pay 3,500 first, then amend down to 3,000
      const amended = await call('seller', 'PUT', `/order-changes/orders/${o.id}/amend`, change);
      assert.equal(amended.status, 200, JSON.stringify(amended.body));
      assert.deepEqual([amended.body.customerName, amended.body.totals.grandTotal, amended.body.lineItems.length], ['Amend Client Ltd', 3500, 2]);
      assert.equal((await prisma.material.findUniqueOrThrow({ where: { id: mat } })).stockQty, 7); // 3 mugs now out: the 2 went back and 3 were taken
      // used once
      assert.equal((await call('seller', 'PUT', `/order-changes/orders/${o.id}/amend`, change)).status, 403);
      // the trail on the order
      const trail = (await call('seller', 'GET', `/order-changes/orders/${o.id}`)).body.requests[0];
      assert.deepEqual([trail.status, trail.decidedByName], ['Done', 'finance (order change test)']);
      const stored = await prisma.orderChange.findUniqueOrThrow({ where: { id: ask.body.id } });
      assert.equal(JSON.parse(stored.beforeJson).total, 2000);
      assert.equal(JSON.parse(stored.afterJson).total, 3500);
    });

    it('cannot take the total below what the customer has paid, and a rejected or withdrawn request gives no right to change', async () => {
      const o = (await invoice('seller', 'Paid Client', [line(2, 1000)])).body; // 2,000
      assert.equal((await call('front', 'POST', `/orders/${o.id}/payments`, { amount: 1500, method: 'Cash' })).status, 200);
      const ask = (await call('seller', 'POST', `/order-changes/orders/${o.id}`, { kind: 'Amend', reason: 'Make it smaller' })).body;
      await call('admin', 'POST', `/order-changes/requests/${ask.id}/approve`);
      const low = await call('seller', 'PUT', `/order-changes/orders/${o.id}/amend`, { lineItems: [line(1, 1000)] }); // 1,000 < 1,500 paid
      assert.equal(low.status, 400);
      assert.match(low.body.error, /already paid/);
      assert.equal((await call('seller', 'PUT', `/order-changes/orders/${o.id}/amend`, { lineItems: [line(2, 900)] })).status, 200); // 1,800 ≥ 1,500

      const o2 = (await invoice('seller', 'Rejected Client', [line(1, 1000)])).body;
      const r2 = (await call('seller', 'POST', `/order-changes/orders/${o2.id}`, { kind: 'Delete', reason: 'Duplicate' })).body;
      assert.equal((await call('finance', 'POST', `/order-changes/requests/${r2.id}/reject`, { note: 'It is not a duplicate' })).body.status, 'Rejected');
      assert.equal((await call('seller', 'DELETE', `/order-changes/orders/${o2.id}`)).status, 403);
      const r3 = (await call('seller', 'POST', `/order-changes/orders/${o2.id}`, { kind: 'Delete', reason: 'Really a duplicate' })).body; // a new request after a rejection
      assert.equal((await call('seller', 'POST', `/order-changes/requests/${r3.id}/cancel`)).status, 200);
      assert.equal((await call('seller', 'DELETE', `/order-changes/orders/${o2.id}`)).status, 403);
    });
  });

  describe('deleting an order after it is approved', () => {
    it('is done by the person who asked, only once approved, only with no payments on it, and puts the stock back', async () => {
      const o = (await invoice('seller', 'Delete Client', [{ itemType: 'material' as const, materialId: mat, qty: 2, unitPrice: 500 }])).body;
      const stockWith = (await prisma.material.findUniqueOrThrow({ where: { id: mat } })).stockQty;
      assert.equal((await call('seller', 'DELETE', `/order-changes/orders/${o.id}`)).status, 403); // not approved
      const ask = (await call('seller', 'POST', `/order-changes/orders/${o.id}`, { kind: 'Delete', reason: 'Wrongly captured' })).body;
      assert.equal((await call('finance', 'POST', `/order-changes/requests/${ask.id}/approve`)).status, 200);

      // a payment on it stops the deletion until it is moved or refunded
      assert.equal((await call('front', 'POST', `/orders/${o.id}/payments`, { amount: 400, method: 'Cash' })).status, 200);
      const blocked = await call('seller', 'DELETE', `/order-changes/orders/${o.id}`);
      assert.equal(blocked.status, 400);
      assert.match(blocked.body.error, /payment/);
      await prisma.payment.deleteMany({ where: { orderId: o.id } }); // refunded / moved, as the message asks

      const done = await call('seller', 'DELETE', `/order-changes/orders/${o.id}`);
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(await prisma.order.count({ where: { id: o.id } }), 0);
      assert.equal((await prisma.material.findUniqueOrThrow({ where: { id: mat } })).stockQty, stockWith + 2); // the 2 mugs are back on the shelf
      const kept = await prisma.orderChange.findUniqueOrThrow({ where: { id: ask.id } });
      assert.equal(kept.status, 'Done');
      assert.equal(JSON.parse(kept.beforeJson).lines[0].item, 'Mug (order change test)'); // the record outlives the order
      assert.equal((await call('seller', 'DELETE', `/order-changes/orders/${o.id}`)).status, 404);
    });

    it('is refused for a completed order and for a film order', async () => {
      const o = (await invoice('seller', 'Done Client', [line(1, 1000)])).body;
      await prisma.order.update({ where: { id: o.id }, data: { stage: 'Completed' } });
      const refused = await call('seller', 'POST', `/order-changes/orders/${o.id}`, { kind: 'Delete', reason: 'too late' });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, /completed/i);
    });
  });
});
