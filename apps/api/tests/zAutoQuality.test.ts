// Automatic quality check: with no one to inspect, a finished job goes straight to Ready for Pickup/Delivery, recorded as an automatic pass that is left out of the pass rates; switching it back off
// puts inspection back; switching it on moves on whatever is already waiting in Quality Check. (Named z… because it records data.)
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
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
let n = 0;
async function newOrder() {
  const svc = await prisma.service.findFirstOrThrow();
  return prisma.order.create({ data: { orderNo: `AQ-${++n}`, kind: 'walkin', customerName: 'Auto QC', staffId: ids.lead!, createdDate: '2031-04-01', status: 'Order', stage: 'Order Received', lineItems: { create: [{ itemType: 'service', serviceId: svc.id, qty: 10, unitPrice: 100 }] } } });
}
const setAuto = (on: boolean) => call('admin', 'PUT', '/day-close/settings', { autoQualityCheck: on });
// assigns the order to the worker, who starts and finishes it
async function produce(orderId: number) {
  assert.equal((await call('lead', 'POST', `/production/orders/${orderId}/assign`, { assigneeId: ids.worker })).status, 201);
  const task = await prisma.productionTask.findFirstOrThrow({ where: { orderId, status: 'Assigned' } });
  assert.equal((await call('worker', 'POST', `/production/tasks/${task.id}/start`)).status, 200);
  return call('worker', 'POST', `/production/tasks/${task.id}/finish`, { unitsCompleted: 10 });
}

describe('automatic quality check', () => {
  before(async () => {
    await prisma.service.create({ data: { name: 'Printing (auto qc test)', unit: 'piece', price: 100 } });
    await prisma.role.create({ data: { name: 'Worker (auto qc)', canAccessProduction: true } });
    await prisma.role.create({ data: { name: 'Lead (auto qc)', canAccessProduction: true, canManageProduction: true, canAccessQuality: true, canViewAllOrders: true } });
    for (const [key, role] of [['worker', 'Worker (auto qc)'], ['lead', 'Lead (auto qc)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (auto qc)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('only the Admin can change the switch, and it is on by default', async () => {
    assert.equal((await call('lead', 'PUT', '/day-close/settings', { autoQualityCheck: false })).status, 403);
    await prisma.dayCloseSettings.deleteMany({});
    const s = await call('admin', 'GET', '/day-close/settings');
    assert.equal(s.body.autoQualityCheck, true);
  });

  it('with it on, finishing a job sends the order straight to Ready, recorded as an automatic pass', async () => {
    assert.equal((await setAuto(true)).status, 200);
    const order = await newOrder();
    const done = await produce(order.id);
    assert.equal(done.status, 200);
    assert.equal(done.body.nextStage, 'Ready for Pickup/Delivery');
    assert.equal(done.body.automatic, true);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).stage, 'Ready for Pickup/Delivery');
    const check = await prisma.qualityCheck.findFirstOrThrow({ where: { orderId: order.id } });
    assert.deepEqual([check.result, check.auto, check.inspectorId], ['Passed', true, ids.worker]);
    // it is not an inspection: the Quality history and pass rate leave it out, and the person's first-pass rate is not flattered
    const q = (await call('lead', 'GET', '/quality/queue?from=2000-01-01&to=2099-12-31')).body;
    assert.equal(q.awaiting.length, 0);
    assert.ok(!q.history.some((h: any) => h.orderNo === order.orderNo));
    assert.equal(q.stats.checked, await prisma.qualityCheck.count({ where: { auto: false } })); // only real inspections are counted
  });

  it('with it off, finishing sends the order to Quality Check as before', async () => {
    assert.equal((await setAuto(false)).status, 200);
    const order = await newOrder();
    const done = await produce(order.id);
    assert.equal(done.body.nextStage, 'Quality Check');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).stage, 'Quality Check');
    assert.equal(await prisma.qualityCheck.count({ where: { orderId: order.id } }), 0);
    assert.equal((await call('lead', 'GET', '/quality/queue')).body.awaiting.length, 1);
  });

  it('switching it on moves on whatever is already waiting in Quality Check', async () => {
    const waiting = await prisma.order.findFirstOrThrow({ where: { stage: 'Quality Check' } });
    const on = await setAuto(true);
    assert.equal(on.status, 200);
    assert.ok(on.body.movedOn >= 1);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: waiting.id } })).stage, 'Ready for Pickup/Delivery');
    const check = await prisma.qualityCheck.findFirstOrThrow({ where: { orderId: waiting.id } });
    assert.equal(check.auto, true);
    assert.equal((await call('lead', 'GET', '/quality/queue')).body.awaiting.length, 0);
  });

  it('rework that is finished while it is on also passes on, and a real failure still sends work back', async () => {
    assert.equal((await setAuto(false)).status, 200);
    const order = await newOrder();
    await produce(order.id);
    assert.equal((await call('lead', 'POST', `/quality/orders/${order.id}/check`, { result: 'Failed', defects: 'misprint', unitsInspected: 10, unitsRejected: 4 })).status, 201);
    assert.equal((await setAuto(true)).status, 200);
    const rework = await prisma.productionTask.findFirstOrThrow({ where: { orderId: order.id, isRework: true } });
    assert.equal((await call('worker', 'POST', `/production/tasks/${rework.id}/start`)).status, 200);
    const done = await call('worker', 'POST', `/production/tasks/${rework.id}/finish`, { unitsCompleted: 4 });
    assert.equal(done.body.nextStage, 'Ready for Pickup/Delivery');
    // the real failure is still counted (it was a genuine inspection)
    assert.equal(await prisma.qualityCheck.count({ where: { orderId: order.id, result: 'Failed', auto: false } }), 1);
  });
});
