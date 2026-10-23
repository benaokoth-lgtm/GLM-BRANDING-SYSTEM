// Automatic production: with the switch on, a captured order skips Production and moves on by itself — to Quality Check, or on to Ready when the quality check is automatic too. Quotes and jobs held for a
// price approval stay put, and switching it on moves on the orders already waiting. (Named z… because it records data.)
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
async function newOrder(status = 'Order') {
  const svc = await prisma.service.findFirstOrThrow();
  return prisma.order.create({ data: { orderNo: `AP-${++n}`, kind: 'walkin', customerName: 'Auto Prod', staffId: ids.lead!, createdDate: '2031-05-01', status, stage: 'Order Received', lineItems: { create: [{ itemType: 'service', serviceId: svc.id, qty: 10, unitPrice: 100 }] } } });
}
const set = (body: Record<string, boolean>) => call('admin', 'PUT', '/day-close/settings', body);
const stageOf = async (id: number) => (await prisma.order.findUniqueOrThrow({ where: { id } })).stage;

describe('automatic production', () => {
  before(async () => {
    await prisma.service.create({ data: { name: 'Printing (auto prod test)', unit: 'piece', price: 100 } });
    await prisma.role.create({ data: { name: 'Lead (auto prod)', canAccessProduction: true, canManageProduction: true, canAccessQuality: true, canViewAllOrders: true } });
    for (const [key, role] of [['lead', 'Lead (auto prod)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (auto prod)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await set({ autoProduction: false, autoQualityCheck: false });
  });
  after(async () => {
    await prisma.dayCloseSettings.update({ where: { id: 1 }, data: { autoProduction: false, autoQualityCheck: false } });
    server.close();
    await prisma.$disconnect();
  });

  it('off by default; only the Admin changes it; with it off an order waits to be assigned', async () => {
    assert.equal((await call('lead', 'PUT', '/day-close/settings', { autoProduction: true })).status, 403);
    assert.equal((await call('admin', 'GET', '/day-close/settings')).body.autoProduction, false);
    const o = await newOrder();
    await call('lead', 'GET', '/production/queue');
    assert.equal(await stageOf(o.id), 'Order Received');
  });

  it('switching it on moves on the orders already waiting — to Quality Check when the quality check is manual — but not quotes', async () => {
    const waiting = await newOrder();
    const quote = await newOrder('Quote');
    const r = await set({ autoProduction: true });
    assert.equal(r.status, 200);
    assert.ok(r.body.producedAutomatically >= 1);
    assert.equal(await stageOf(waiting.id), 'Quality Check');
    assert.equal(await stageOf(quote.id), 'Order Received');
    assert.equal(await prisma.productionTask.count({ where: { orderId: waiting.id } }), 0); // no job was made up
    assert.equal(await prisma.qualityCheck.count({ where: { orderId: waiting.id } }), 0); // and nothing was passed
  });

  it('an order captured while it is on moves on at the next request', async () => {
    const o = await newOrder();
    assert.equal((await call('lead', 'GET', '/quality/queue')).body.awaiting.some((a: any) => a.orderNo === o.orderNo), true);
    assert.equal(await stageOf(o.id), 'Quality Check');
  });

  it('with the quality check automatic too, the order goes straight to Ready, recorded as an automatic pass', async () => {
    await set({ autoQualityCheck: true });
    const o = await newOrder();
    await call('lead', 'GET', '/production/queue');
    assert.equal(await stageOf(o.id), 'Ready for Pickup/Delivery');
    const check = await prisma.qualityCheck.findFirstOrThrow({ where: { orderId: o.id } });
    assert.deepEqual([check.result, check.auto, check.taskId], ['Passed', true, null]);
  });

  it('a job held for a price approval stays put until it is approved; one being worked on by a person is left alone', async () => {
    const held = await newOrder();
    await prisma.dtfRoll.create({ data: { id: 'ROLL-AP1', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100 } });
    await prisma.dtfArtworkJob.create({ data: { orderId: held.id, rollId: 'ROLL-AP1', jobOn: '2031-05-01', runningMetres: 1, pieces: 10, approvalStatus: 'Pending' } });
    const worked = await newOrder();
    await prisma.order.update({ where: { id: worked.id }, data: { stage: 'In Production' } });
    await prisma.productionTask.create({ data: { orderId: worked.id, assigneeId: ids.lead, assignedByName: 'test', unitsPlanned: 10 } });
    await call('lead', 'GET', '/production/queue');
    assert.equal(await stageOf(held.id), 'Order Received');
    assert.equal(await stageOf(worked.id), 'In Production');
  });

  it('switching it off puts assignment back: new orders wait again', async () => {
    await set({ autoProduction: false });
    const o = await newOrder();
    await call('lead', 'GET', '/production/queue');
    assert.equal(await stageOf(o.id), 'Order Received');
  });
});
