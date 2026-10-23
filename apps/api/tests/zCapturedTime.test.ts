// The time an order is captured is recorded when it is keyed in and shown beside its date. (Named z… because it records orders.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fmtDateTime, fmtTime } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
let token = '';
let staffId = 0;
let svc = 0;
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('the time an order is captured', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Seller (captured time test)', canCaptureOrders: true, canViewAllOrders: true } });
    const u = await prisma.user.create({ data: { name: 'seller (captured time test)', role: 'Seller (captured time test)', pinHash: 'x' } });
    staffId = u.id;
    token = signToken({ id: u.id, name: u.name, role: 'Seller (captured time test)' });
    svc = (await prisma.service.create({ data: { name: 'Banner (captured time test)', unit: 'piece', price: 500 } })).id;
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('shows the time in Nairobi, next to the date, and nothing for an order captured before it was recorded', () => {
    assert.equal(fmtTime('2026-10-23T11:32:00.000Z'), '14:32'); // UTC+3 whatever zone the machine is in
    assert.equal(fmtTime('2026-10-22T21:05:00.000Z'), '00:05'); // just after midnight in Nairobi
    assert.equal(fmtTime(null), '');
    assert.equal(fmtTime('not a time'), '');
    assert.equal(fmtDateTime('2026-10-23', '2026-10-23T11:32:00.000Z'), '23/10/2026 14:32');
    assert.equal(fmtDateTime('2026-10-23', null), '23/10/2026');
  });

  it('is recorded when a General order is captured, and is in the list, the order and the PDF', async () => {
    const before = Date.now();
    const r = await call('POST', '/orders/walkin', { customerName: 'Time Customer', phone: '0712 000 999', staffId, paymentTiming: 'onCompletion', lineItems: [{ itemType: 'service', serviceId: svc, qty: 1, unitPrice: 500 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.capturedAt, 'the new order carries its capture time');
    const t = Date.parse(r.body.capturedAt);
    assert.ok(t >= before - 1000 && t <= Date.now() + 1000);
    assert.equal((await call('GET', `/orders/${r.body.id}`)).body.capturedAt, r.body.capturedAt);
    assert.equal((await call('GET', '/orders')).body.find((o: any) => o.id === r.body.id).capturedAt, r.body.capturedAt);
    const pdf = await fetch(`${base}/api/orders/${r.body.id}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(pdf.status, 200);
    // an order from before the time was recorded has none
    const old = await prisma.order.create({ data: { orderNo: 'TM-OLD', kind: 'walkin', staffId, createdDate: '2024-01-01', status: 'Order', stage: 'Order Received', customerName: 'Old', lineItems: { create: [{ itemType: 'service', serviceId: svc, qty: 1, unitPrice: 500 }] } } as any });
    assert.equal((await call('GET', `/orders/${old.id}`)).body.capturedAt, null);
  });
});
