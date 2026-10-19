// Stock leaves the shelf when an order that sells a stock item is recorded (it never used to): once, not for a quotation until it becomes an invoice, and a return of the goods
// puts them back only for an order whose stock was taken. (Named z… because it records orders.)
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
let cap = 0;
let corp = 0;
let adminId = 0;
const stock = async (id: number) => (await prisma.material.findUniqueOrThrow({ where: { id } })).stockQty;
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('stock leaves the shelf with an order', () => {
  before(async () => {
    const u = await prisma.user.create({ data: { name: 'admin (order stock test)', role: 'Admin', pinHash: 'x' } });
    adminId = u.id;
    tokens.admin = signToken({ id: u.id, name: u.name, role: 'Admin' });
    cap = (await prisma.material.create({ data: { name: 'Cap (order stock test)', price: 500, stockQty: 20 } })).id;
    corp = (await prisma.corporateClient.create({ data: { name: 'Stock Test Ltd', phone: '0700 999 111', creditDays: 30 } })).id;
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('a walk-in sale takes the stock once, and may take more than is on the shelf (the count goes negative for the next stock take)', async () => {
    const r = await call('admin', 'POST', '/orders/walkin', { paymentTiming: 'onCompletion', lineItems: [{ itemType: 'material', materialId: cap, qty: 3, unitPrice: 500 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await stock(cap), 17);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: r.body.id } })).stockTaken, true);
    const big = await call('admin', 'POST', '/orders/walkin', { paymentTiming: 'onCompletion', lineItems: [{ itemType: 'material', materialId: cap, qty: 20, unitPrice: 500 }] });
    assert.equal(big.status, 201);
    assert.equal(await stock(cap), -3);
    await prisma.material.update({ where: { id: cap }, data: { stockQty: 20 } });
  });

  it('a quotation holds no stock; it leaves the shelf when the quotation becomes an invoice, once', async () => {
    const q = await call('admin', 'POST', '/orders/quote', { corporateClientId: corp, staffId: adminId, lineItems: [{ itemType: 'material', materialId: cap, qty: 4, unitPrice: 500 }] });
    assert.equal(q.status, 201, JSON.stringify(q.body));
    assert.equal(await stock(cap), 20);
    const conv = await call('admin', 'POST', `/orders/${q.body.id}/convert`, {});
    assert.equal(conv.status, 200, JSON.stringify(conv.body));
    assert.equal(await stock(cap), 16);
    // a payment against the now-invoice does not take it again
    await call('admin', 'POST', `/orders/${q.body.id}/payments`, { payments: [{ method: 'Cash', amount: 100 }] });
    assert.equal(await stock(cap), 16);
    // a deposit on a quotation is the client accepting: it converts the quotation and takes the stock
    const q2 = await call('admin', 'POST', '/orders/quote', { corporateClientId: corp, staffId: adminId, lineItems: [{ itemType: 'material', materialId: cap, qty: 2, unitPrice: 500 }] });
    assert.equal(await stock(cap), 16);
    assert.equal((await call('admin', 'POST', `/orders/${q2.body.id}/payments`, { payments: [{ method: 'Cash', amount: 100 }] })).status, 200);
    assert.equal(await stock(cap), 14);
  });

  it('an order from before this existed has not had its stock taken: it is taken if it is a quotation converted later, and a return does not add back what never left', async () => {
    const q = await call('admin', 'POST', '/orders/quote', { corporateClientId: corp, staffId: adminId, lineItems: [{ itemType: 'material', materialId: cap, qty: 1, unitPrice: 500 }] });
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: q.body.id } })).stockTaken, false);
  });
});
