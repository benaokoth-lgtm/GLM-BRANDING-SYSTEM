// The production → quality → handover flow, over real HTTP against the Express app (throwaway database).
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
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json as any };
}

async function newOrder(orderNo: string, status = 'Order') {
  const svc = await prisma.service.findFirstOrThrow();
  return prisma.order.create({
    data: {
      orderNo,
      kind: 'walkin',
      customerName: 'Prod Customer',
      staffId: ids.manager!,
      createdDate: '2031-03-01',
      status,
      stage: 'Order Received',
      lineItems: { create: [{ itemType: 'service', serviceId: svc.id, qty: 40, unitPrice: 100 }] },
    },
  });
}

describe('production → quality → handover', () => {
  before(async () => {
    await prisma.service.create({ data: { name: 'Printing (prod test)', unit: 'piece', price: 100 } });
    // Three roles: a worker, a QC inspector, and a supervisor who manages production and also inspects.
    await prisma.role.create({ data: { name: 'Worker', canAccessProduction: true } });
    await prisma.role.create({ data: { name: 'Inspector', canAccessQuality: true } });
    await prisma.role.create({ data: { name: 'Lead', canAccessProduction: true, canManageProduction: true, canAccessQuality: true, canViewAllOrders: true } });
    for (const [key, role] of [['worker', 'Worker'], ['worker2', 'Worker'], ['inspector', 'Inspector'], ['manager', 'Lead']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} user`, role, pinHash: 'x' } });
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

  it('a new order waits in production; only a manager can assign it, and never a quotation', async () => {
    const order = await newOrder('P-1');
    const q = await call('manager', 'GET', '/production/queue');
    assert.equal(q.status, 200);
    assert.ok(q.body.waiting.some((o: any) => o.orderNo === 'P-1' && o.units === 40));
    assert.ok(q.body.staff.some((s: any) => s.id === ids.worker));
    assert.ok(!q.body.staff.some((s: any) => s.id === ids.inspector), 'a QC-only person is not on the production team');

    assert.equal((await call('worker', 'POST', `/production/orders/${order.id}/assign`, { assigneeId: ids.worker })).status, 403);
    assert.equal((await call('manager', 'POST', `/production/orders/${order.id}/assign`, { assigneeId: ids.inspector })).status, 400);
    const quote = await newOrder('P-Q', 'Quote');
    assert.equal((await call('manager', 'POST', `/production/orders/${quote.id}/assign`, { assigneeId: ids.worker })).status, 400);

    assert.equal((await call('manager', 'POST', `/production/orders/${order.id}/assign`, { assigneeId: ids.worker })).status, 201);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).stage, 'In Production');
  });

  it('a worker sees only their own jobs, and can only finish their own', async () => {
    const q = await call('worker', 'GET', '/production/queue');
    assert.equal(q.body.manager, false);
    assert.deepEqual(q.body.waiting, []); // the worker does not see the unassigned pile
    assert.equal(q.body.tasks.length, 1);
    assert.equal(q.body.tasks[0].orderNo, 'P-1');
    assert.equal(q.body.tasks[0].status, 'Assigned');
    const taskId = q.body.tasks[0].id;
    assert.equal((await call('worker2', 'GET', '/production/queue')).body.tasks.length, 0);
    assert.equal((await call('worker2', 'POST', `/production/tasks/${taskId}/finish`, { unitsCompleted: 40 })).status, 403);
    assert.equal((await call('worker', 'POST', `/production/tasks/${taskId}/start`)).status, 200);
    assert.equal((await call('worker', 'POST', `/production/tasks/${taskId}/start`)).status, 400); // already started
    assert.equal((await call('worker', 'POST', `/production/tasks/${taskId}/finish`, {})).status, 400); // output is required
  });

  it('finishing sends the order to quality control — it does not complete it', async () => {
    const task = await prisma.productionTask.findFirstOrThrow({ where: { order: { orderNo: 'P-1' } } });
    const r = await call('worker', 'POST', `/production/tasks/${task.id}/finish`, { unitsCompleted: 38, note: 'two spoilt' });
    assert.equal(r.status, 200);
    assert.equal(r.body.nextStage, 'Quality Check');
    const order = await prisma.order.findFirstOrThrow({ where: { orderNo: 'P-1' } });
    assert.equal(order.stage, 'Quality Check');
    assert.equal((await prisma.productionTask.findUniqueOrThrow({ where: { id: task.id } })).unitsCompleted, 38);
    // …and nobody can complete it from here: there is no stage setter any more, and handover needs QC first.
    assert.equal((await call('manager', 'PATCH', `/orders/${order.id}/stage`, { stage: 'Completed' })).status, 404);
    const early = await call('manager', 'POST', `/orders/${order.id}/handover`);
    assert.equal(early.status, 400);
    assert.match(early.body.error, /passed quality control/);
  });

  it('quality: needs the permission, cannot be done by the maker, and a fail sends it back as rework', async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { orderNo: 'P-1' } });
    assert.equal((await call('worker', 'GET', '/quality/queue')).status, 403);
    const q = await call('inspector', 'GET', '/quality/queue');
    assert.equal(q.status, 200);
    assert.equal(q.body.awaiting.length, 1);
    assert.equal(q.body.awaiting[0].producerName, 'worker user');
    assert.equal(q.body.awaiting[0].unitsCompleted, 38);

    // the maker can't inspect their own work even if given the permission
    await prisma.role.update({ where: { name: 'Worker' }, data: { canAccessQuality: true } });
    const self = await call('worker', 'POST', `/quality/orders/${order.id}/check`, { result: 'Passed' });
    assert.equal(self.status, 400);
    assert.match(self.body.error, /another person/);
    await prisma.role.update({ where: { name: 'Worker' }, data: { canAccessQuality: false } });

    assert.equal((await call('inspector', 'POST', `/quality/orders/${order.id}/check`, { result: 'Failed' })).status, 400); // must say what is wrong
    const fail = await call('inspector', 'POST', `/quality/orders/${order.id}/check`, { result: 'Failed', unitsInspected: 38, unitsRejected: 6, defects: 'Print misaligned' });
    assert.equal(fail.status, 201);
    assert.equal(fail.body.nextStage, 'In Production');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).stage, 'In Production');
    const rework = await prisma.productionTask.findFirstOrThrow({ where: { orderId: order.id, isRework: true } });
    assert.equal(rework.assigneeId, ids.worker);
    assert.equal(rework.unitsPlanned, 6); // just the rejected units
    assert.match(rework.note, /misaligned/);
    // an order that is not in Quality Check can't be inspected
    assert.equal((await call('inspector', 'POST', `/quality/orders/${order.id}/check`, { result: 'Passed' })).status, 400);
  });

  it('after rework and a pass the order is Ready — and only a handover completes it', async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { orderNo: 'P-1' } });
    const rework = await prisma.productionTask.findFirstOrThrow({ where: { orderId: order.id, isRework: true } });
    assert.equal((await call('worker', 'POST', `/production/tasks/${rework.id}/finish`, { unitsCompleted: 6 })).status, 200);
    const pass = await call('inspector', 'POST', `/quality/orders/${order.id}/check`, { result: 'Passed', unitsInspected: 6 });
    assert.equal(pass.status, 201);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).stage, 'Ready for Pickup/Delivery'); // not Completed
    const done = await call('manager', 'POST', `/orders/${order.id}/handover`);
    assert.equal(done.status, 200);
    assert.equal(done.body.stage, 'Completed');
    assert.equal((await call('manager', 'POST', `/orders/${order.id}/handover`)).status, 400); // already handed over
  });

  it('reassigning moves the job to someone else and keeps the old attempt on record', async () => {
    const order = await newOrder('P-2');
    await call('manager', 'POST', `/production/orders/${order.id}/assign`, { assigneeId: ids.worker });
    await call('manager', 'POST', `/production/orders/${order.id}/assign`, { assigneeId: ids.worker2, note: 'worker is off sick' });
    const tasks = await prisma.productionTask.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } });
    assert.deepEqual(tasks.map((t) => t.status), ['Superseded', 'Assigned']);
    assert.equal(tasks[1]!.assigneeId, ids.worker2);
    assert.equal((await call('worker', 'GET', '/production/queue')).body.tasks.length, 0);
    assert.equal((await call('worker2', 'GET', '/production/queue')).body.tasks.length, 1);
  });

  it('productivity: output, hours, first-pass quality and rework per person; a worker sees only themselves', async () => {
    const m = await call('manager', 'GET', '/production/productivity?from=2000-01-01&to=2099-12-31');
    assert.equal(m.status, 200);
    const w = m.body.rows.find((r: any) => r.assigneeId === ids.worker);
    assert.equal(w.jobsFinished, 2); // the original and the rework
    assert.equal(w.unitsCompleted, 44); // 38 + 6
    assert.equal(w.checked, 1); // quality is judged on first-time work
    assert.equal(w.passedFirstTime, 0);
    assert.equal(w.firstPassPct, 0);
    assert.equal(w.failedChecks, 1);
    assert.equal(w.rejectedUnits, 6);
    assert.ok(m.body.daily.length >= 1);
    assert.ok(m.body.recent.some((t: any) => t.orderNo === 'P-1' && t.isRework));

    const own = await call('worker', 'GET', '/production/productivity?from=2000-01-01&to=2099-12-31');
    assert.equal(own.body.manager, false);
    assert.deepEqual(own.body.rows.map((r: any) => r.assigneeId), [ids.worker]);
  });
});
