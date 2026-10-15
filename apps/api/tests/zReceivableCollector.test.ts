// Accounts Receivable: who is responsible for collecting the balance — the sales person the sale is credited to (even when someone else keyed it), unless Accounting hands it to another person.
// (Named z… because it adds orders other files' totals must not see.)
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
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const mine = async () => (await call('books', 'GET', '/accounting/receivables?asOf=2026-12-31')).body.rows.find((r: any) => r.orderId === orderId);

describe('who collects what a customer owes', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Books (collector test)', canAccessAccounting: true } });
    await prisma.role.create({ data: { name: 'Seller (collector test)', canCaptureOrders: true } });
    for (const [key, role] of [['books', 'Books (collector test)'], ['seller', 'Seller (collector test)'], ['desk', 'Seller (collector test)'], ['other', 'Seller (collector test)'], ['gone', 'Seller (collector test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (collector test)`, role, pinHash: 'x', active: key !== 'gone' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // sold on credit, credited to "seller" but keyed by "desk" (the front office)
    const o = await prisma.order.create({
      data: {
        orderNo: 'W-9301', kind: 'walkin', customerName: 'Hope Chapel', staffId: ids.seller!, capturedById: ids.desk!, capturedByName: 'desk (collector test)', createdDate: '2026-09-01', dueDate: '2026-09-15', status: 'Invoice', stage: 'Order Received',
        lineItems: { create: [{ itemType: 'service', qty: 1, unitPrice: 1160 }] },
      },
    });
    orderId = o.id;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('is the sales person the sale is credited to, even when someone else keyed it', async () => {
    const r = await mine();
    assert.equal(r.outstanding, 1160);
    assert.deepEqual([r.responsibleName, r.salesPersonName, r.reassigned], ['seller (collector test)', 'seller (collector test)', false]);
    const ar = (await call('books', 'GET', '/accounting/receivables?asOf=2026-12-31')).body;
    const person = ar.byPerson.find((p: any) => p.id === ids.seller);
    assert.deepEqual([person.count >= 1, person.total >= 1160, person.overdue >= 1160], [true, true, true]); // due on 15 September: overdue by the year end
    assert.ok(!ar.byPerson.some((p: any) => p.id === ids.desk)); // the person who keyed it is not responsible
    assert.ok(ar.staff.some((p: any) => p.id === ids.other));
    assert.ok(!ar.staff.some((p: any) => p.id === ids.gone)); // nobody who has left can be chosen
  });

  it('Accounting can hand the collection to someone else, and back', async () => {
    assert.equal((await call('seller', 'PUT', `/accounting/receivables/${orderId}/collector`, { staffId: ids.other })).status, 403); // not the sales person's own call
    assert.equal((await call('books', 'PUT', `/accounting/receivables/${orderId}/collector`, { staffId: ids.gone })).status, 400);
    assert.equal((await call('books', 'PUT', `/accounting/receivables/${orderId}/collector`, { staffId: 999999 })).status, 400);
    assert.equal((await call('books', 'PUT', '/accounting/receivables/999999/collector', { staffId: ids.other })).status, 404);
    assert.equal((await call('books', 'PUT', `/accounting/receivables/${orderId}/collector`, { staffId: ids.other })).status, 200);
    const handed = await mine();
    assert.deepEqual([handed.responsibleName, handed.salesPersonName, handed.reassigned], ['other (collector test)', 'seller (collector test)', true]);
    const ar = (await call('books', 'GET', '/accounting/receivables?asOf=2026-12-31')).body;
    assert.ok(ar.byPerson.find((p: any) => p.id === ids.other).total >= 1160);
    // handing it back to the sales person is the default again
    assert.equal((await call('books', 'PUT', `/accounting/receivables/${orderId}/collector`, { staffId: ids.seller })).status, 200);
    assert.equal((await mine()).reassigned, false);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).collectorId, null);
    // reset
    await call('books', 'PUT', `/accounting/receivables/${orderId}/collector`, { staffId: ids.other });
    assert.equal((await call('books', 'PUT', `/accounting/receivables/${orderId}/collector`, { staffId: null })).status, 200);
    assert.deepEqual([(await mine()).responsibleName, (await mine()).reassigned], ['seller (collector test)', false]);
  });

  it('if the person it was handed to leaves, it is back with the sales person', async () => {
    await prisma.order.update({ where: { id: orderId }, data: { collectorId: ids.gone } });
    assert.equal((await mine()).responsibleName, 'gone (collector test)'); // a leaver still has the balance until Accounting moves it
    await prisma.order.update({ where: { id: orderId }, data: { collectorId: 987654 } });
    const r = await mine();
    assert.deepEqual([r.responsibleName, r.reassigned], ['seller (collector test)', false]); // a person who no longer exists cannot collect
  });
});
