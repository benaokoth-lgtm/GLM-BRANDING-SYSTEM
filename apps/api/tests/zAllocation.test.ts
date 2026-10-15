// Correcting who an order is credited to (the sales person forgotten at capture, or the wrong one chosen): Admin and commission managers do it outright; the front office and the people on the
// order ask, and one of them approves in the Approvals inbox; a month whose commission is already approved is closed to it; everything is kept as a trail. (Named z… because it adds orders.)
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
let orderId = 0;
let lockedOrderId = 0;
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const staffOf = async (id: number) => (await prisma.order.findUniqueOrThrow({ where: { id } })).staffId;

describe('correcting the sales person on an order', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Seller (alloc test)', canCaptureOrders: true, canBeAssignedOrders: true } });
    await prisma.role.create({ data: { name: 'Front desk (alloc test)', canCaptureOrders: true, canCaptureForOthers: true, canViewAllOrders: true } });
    await prisma.role.create({ data: { name: 'Lead (alloc test)', canViewAllOrders: true, canManageCommission: true } });
    for (const [key, role] of [['a', 'Seller (alloc test)'], ['b', 'Seller (alloc test)'], ['c', 'Seller (alloc test)'], ['outsider', 'Seller (alloc test)'], ['desk', 'Front desk (alloc test)'], ['boss', 'Lead (alloc test)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (alloc test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const make = (orderNo: string, extra: object = {}) =>
      prisma.order.create({
        data: { orderNo, kind: 'walkin', customerName: 'Hope Chapel', staffId: ids.a!, capturedById: ids.desk!, capturedByName: 'desk (alloc test)', createdDate: '2026-10-01', status: 'Invoice', stage: 'Order Received', lineItems: { create: [{ itemType: 'service', qty: 1, unitPrice: 1160 }] }, ...extra },
      });
    orderId = (await make('W-9401', { salesSource: 'sourced', sourcedByStaffId: ids.a! })).id;
    // paid in a month whose commission has already been approved
    const locked = await make('W-9402', { payments: { create: [{ date: '2026-03-05', amount: 500, method: 'Cash' }] } });
    lockedOrderId = locked.id;
    await prisma.commissionPayout.create({ data: { period: '2026-03', staffId: ids.a!, amount: 100 } });
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('shows who it is credited to, who it can be given to, and whether you correct it or ask', async () => {
    const desk = await call('desk', 'GET', `/allocation/orders/${orderId}`);
    assert.equal(desk.status, 200);
    assert.deepEqual([desk.body.current.name, desk.body.direct, desk.body.canAsk, desk.body.pending], ['a (alloc test)', false, true, null]);
    const names = desk.body.people.map((p: any) => p.name);
    assert.ok(names.includes('b (alloc test)') && !names.includes('a (alloc test)')); // not the person it is already with
    assert.ok(!names.includes('desk (alloc test)')); // nor someone who cannot be given orders
    assert.deepEqual([(await call('boss', 'GET', `/allocation/orders/${orderId}`)).body.direct, (await call('admin', 'GET', `/allocation/orders/${orderId}`)).body.direct], [true, true]);
    assert.equal((await call('outsider', 'GET', `/allocation/orders/${orderId}`)).status, 403); // someone with no part in the order
    // the person it is credited to can ask too
    assert.equal((await call('a', 'GET', `/allocation/orders/${orderId}`)).body.canAsk, true);
  });

  it('the front office asks; Admin or a commission manager approves; the order moves with its client credit, and the trail is kept', async () => {
    const ask = (body: object) => call('desk', 'POST', `/allocation/orders/${orderId}`, body);
    assert.equal((await ask({ staffId: ids.b, reason: 'x' })).status, 400); // a reason is needed
    assert.equal((await ask({ staffId: ids.desk, reason: 'Sales person forgotten' })).status, 400); // cannot be given orders
    assert.equal((await ask({ staffId: ids.a, reason: 'Sales person forgotten' })).status, 400); // already with them
    assert.equal((await call('outsider', 'POST', `/allocation/orders/${orderId}`, { staffId: ids.b, reason: 'Sales person forgotten' })).status, 403);
    const sent = await ask({ staffId: ids.b, reason: 'Sales person forgotten at capture' });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.applied, false);
    assert.equal(await staffOf(orderId), ids.a); // nothing moves until it is approved
    assert.equal((await ask({ staffId: ids.c, reason: 'Sales person forgotten' })).status, 400); // one at a time

    // it appears in the inbox of those who can decide, under the screen the order came through, and in the asker's own list
    const boss = (await call('boss', 'GET', '/approvals')).body.waiting.find((i: any) => i.source === 'allocation' && i.key === `allocation:${sent.body.requestId}`);
    assert.ok(boss);
    assert.deepEqual([boss.origin, boss.title], ['general', 'W-9401: a (alloc test) → b (alloc test)']);
    assert.equal((await call('desk', 'GET', '/approvals')).body.mine.some((i: any) => i.key === boss.key), true);
    assert.equal((await call('desk', 'GET', '/approvals')).body.waiting.some((i: any) => i.key === boss.key), false); // not their own to decide
    assert.equal((await call('desk', 'GET', `/allocation/orders/${orderId}`)).body.pending.toName, 'b (alloc test)');

    assert.equal((await call('desk', 'POST', boss.decide.approve, {})).status, 403);
    assert.equal((await call('a', 'POST', boss.decide.approve, {})).status, 403);
    assert.equal((await call('boss', 'POST', boss.decide.approve, {})).status, 200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    assert.deepEqual([order.staffId, order.sourcedByStaffId, order.capturedByName], [ids.b, ids.b, 'desk (alloc test)']); // the client credit goes with it; who keyed it does not change
    assert.equal((await call('boss', 'POST', boss.decide.approve, {})).status, 400); // decided already

    const trail = (await call('desk', 'GET', `/allocation/orders/${orderId}`)).body;
    assert.equal(trail.pending, null);
    assert.deepEqual([trail.history[0].status, trail.history[0].fromName, trail.history[0].toName, trail.history[0].decidedByName], ['Approved', 'a (alloc test)', 'b (alloc test)', 'boss (alloc test)']);
  });

  it('Admin and commission managers correct it outright; a turned-down request changes nothing; a request that is out of date cannot be approved', async () => {
    // a client owned by somebody else (not the sales person) stays theirs when the order moves
    await prisma.order.update({ where: { id: orderId }, data: { sourcedByStaffId: ids.outsider } });
    const direct = await call('boss', 'POST', `/allocation/orders/${orderId}`, { staffId: ids.c, reason: 'Wrong person was chosen' });
    assert.deepEqual([direct.status, direct.body.applied], [200, true]);
    assert.equal(await staffOf(orderId), ids.c);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).sourcedByStaffId, ids.outsider); // the client was credited to someone else than the sales person: it stays theirs

    // turned down
    const asked = await call('desk', 'POST', `/allocation/orders/${orderId}`, { staffId: ids.a, reason: 'It was Mary’s client' });
    assert.equal((await call('admin', 'POST', `/allocation/requests/${asked.body.requestId}/reject`, { reason: 'Not so' })).status, 200);
    assert.equal(await staffOf(orderId), ids.c);
    const rejected = (await call('desk', 'GET', `/allocation/orders/${orderId}`)).body.history.find((h: any) => h.id === asked.body.requestId);
    assert.equal(rejected.status, 'Rejected');

    // asked, then someone corrects it before the request is looked at: the old request no longer fits
    const stale = await call('desk', 'POST', `/allocation/orders/${orderId}`, { staffId: ids.b, reason: 'Sales person forgotten' });
    assert.equal((await call('admin', 'POST', `/allocation/orders/${orderId}`, { staffId: ids.a, reason: 'Corrected by Admin' })).status, 200);
    const late = await call('boss', 'POST', `/allocation/requests/${stale.body.requestId}/approve`, {});
    assert.equal(late.status, 400);
    assert.match(late.body.error, /changed since/);
    assert.equal(await staffOf(orderId), ids.a);
  });

  it('an order paid in a month whose commission is already approved cannot be moved', async () => {
    const problem = await call('boss', 'POST', `/allocation/orders/${lockedOrderId}`, { staffId: ids.b, reason: 'Wrong person was chosen' });
    assert.equal(problem.status, 400);
    assert.match(problem.body.error, /2026-03.*already been approved/);
    assert.equal((await call('desk', 'POST', `/allocation/orders/${lockedOrderId}`, { staffId: ids.b, reason: 'Wrong person was chosen' })).status, 400);
    assert.equal(await staffOf(lockedOrderId), ids.a);
  });
});
