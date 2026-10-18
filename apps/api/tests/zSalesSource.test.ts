// One sales menu and one price list again: the front office allocates every order to GLM (the shop) or to a sales person, a sales person may capture their own too (and the front office can be made the
// only one to capture for them), and GLM's sales and the sales persons' are listed and measured apart. (Named z… because it records orders.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { todayStr } from '@glm/shared';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
let serviceId = 0;
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
// a General Order of one line at 11,600 (VAT included): 10,000 net
const order = (who: string, extra: object = {}) => call(who, 'POST', '/orders/walkin', { paymentTiming: 'onCompletion', lineItems: [{ itemType: 'service', serviceId, qty: 1, unitPrice: 11600 }], ...extra });

describe('GLM and sales persons, allocated by the front office', () => {
  before(async () => {
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true }, create: { id: 1, enabled: true } });
    await prisma.role.create({ data: { name: 'Seller (src test)', canCaptureOrders: true, canBeAssignedOrders: true, canAccessDtf: true } });
    await prisma.role.create({ data: { name: 'Desk (src test)', canCaptureOrders: true, canCaptureForOthers: true, canAccessDtf: true, canViewAllOrders: true } });
    await prisma.role.create({ data: { name: 'Lead (src test)', canManageCommission: true, canAccessReports: true, canViewAllOrders: true, canCaptureOrders: true, canAccessDtf: true, canManageDtf: true } });
    for (const [key, role] of [['seller', 'Seller (src test)'], ['seller2', 'Seller (src test)'], ['desk', 'Desk (src test)'], ['lead', 'Lead (src test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (src test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    serviceId = (await prisma.service.create({ data: { name: 'Src Test Service', item: 'Src Test Service', unit: 'piece', price: 11600 } })).id;
    await prisma.dtfRoll.create({ data: { id: 'ROLL-SRC', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100, filmCost: 5000, inkPowderCost: 1000 } });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('the front office allocates an order to GLM or to a sales person; a sales person may capture their own', async () => {
    const glm = await order('desk'); // no sales person: the shop's
    assert.equal(glm.status, 201, JSON.stringify(glm.body));
    assert.deepEqual([glm.body.priceList, glm.body.staff.id], ['glm', ids.desk]);
    const allocated = await order('desk', { staffId: ids.seller });
    assert.equal(allocated.status, 201, JSON.stringify(allocated.body));
    assert.deepEqual([allocated.body.priceList, allocated.body.staff.id, allocated.body.capturedByName], ['freelancer', ids.seller, 'desk (src test)']);
    const own = await order('seller'); // a sales person captures their own
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.deepEqual([own.body.priceList, own.body.staff.id], ['freelancer', ids.seller]);
    // there is one price list: the film floor is GLM's whoever the sale is for
    const floor = (await call('lead', 'GET', '/dtf/data?product=dtf')).body.settings.minPricePerM;
    const sale = (who: string, price: number, extra: object = {}) => call(who, 'POST', '/dtf/sales', { rollId: 'ROLL-SRC', client: 'Src Client', metres: 1, pricePerM: price, ...extra });
    assert.equal((await sale('seller', floor - 1)).status, 400);
    assert.equal((await sale('seller', floor)).status, 201);
    assert.equal((await sale('desk', floor, { staffId: ids.seller2 })).body.order.staff.id, ids.seller2);
  });

  it('only the front office captures for a sales person when their own capture is switched off; switched on again, they capture too', async () => {
    const off = await call('lead', 'PUT', `/commission/contractors/${ids.seller2}`, { capturesOwn: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const row = (await call('lead', 'GET', '/commission/contractors')).body.people.find((p: any) => p.staffId === ids.seller2);
    assert.equal(row.capturesOwn, false);
    const blocked = await order('seller2');
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /front office captures orders for you/);
    assert.equal((await order('desk', { staffId: ids.seller2 })).status, 201); // the front office still can
    assert.equal((await call('lead', 'PUT', `/commission/contractors/${ids.seller2}`, { capturesOwn: true })).status, 200);
    assert.equal((await order('seller2')).status, 201);
  });

  it('All Orders can show GLM\'s sales, the sales persons\', or both; a client in a register is the sales person\'s', async () => {
    // a client in seller's Client Register, taken by the front office with no allocation: it is the sales person's (their client)
    const reg = await call('seller', 'POST', '/staff-clients', { name: 'Src Register Client', phone: '0733 555 666' });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const theirs = await order('desk', { customerName: 'Src Register Client', phone: '0733 555 666' });
    assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
    const glm = (await order('desk', { customerName: 'Src Shop Client' })).body.orderNo;
    const all = (await call('lead', 'GET', '/orders')).body;
    const sales = (await call('lead', 'GET', '/orders?source=sales')).body;
    const shop = (await call('lead', 'GET', '/orders?source=glm')).body;
    const names = (rows: any[]) => rows.map((o) => o.orderNo);
    assert.ok(names(sales).includes(theirs.body.orderNo));
    assert.ok(!names(shop).includes(theirs.body.orderNo));
    assert.ok(names(shop).includes(glm) && !names(sales).includes(glm));
    // together they are everything, each order once, and every row says which it is
    assert.equal(sales.length + shop.length, all.length);
    assert.ok(all.every((o: any) => o.source === 'glm' || o.source === 'sales'));
    assert.equal(all.find((o: any) => o.orderNo === glm).source, 'glm');
    assert.equal(all.find((o: any) => o.orderNo === theirs.body.orderNo).source, 'sales');
  });

  it('the performance report puts GLM\'s sales and the sales persons\' side by side, and ranks the sales persons', async () => {
    const today = todayStr();
    const q = `from=${today}&to=${today}`;
    assert.equal((await call('desk', 'GET', `/reports/sales-performance?${q}`)).status, 403); // reports are for those who may see them
    assert.equal((await call('lead', 'GET', '/reports/sales-performance')).status, 400);
    const r = (await call('lead', 'GET', `/reports/sales-performance?${q}`)).body;
    assert.deepEqual([r.from, r.to], [today, today]);
    for (const k of ['glm', 'sales'] as const) {
      for (const f of ['orders', 'sales', 'salesWithVat', 'paid', 'balance', 'avgOrder', 'clients', 'sharePct']) assert.ok(f in r[k], `${k}.${f}`);
    }
    // every sales order counted once: the two together are all the day's orders (not quotations)
    const all = (await call('lead', 'GET', '/orders')).body.filter((o: any) => o.createdDate === today && o.status !== 'Quote');
    assert.equal(r.glm.orders + r.sales.orders, all.length);
    // the ranking: seller's own, allocated and client orders, each 10,000 net at least
    const mine = r.people.find((p: any) => p.staffId === ids.seller);
    assert.ok(mine, 'the sales person is ranked');
    assert.ok(mine.orders >= 3 && mine.sales >= 30000);
    assert.equal(mine.avgOrder, Math.round((mine.sales / mine.orders) * 100) / 100);
    assert.deepEqual(r.people.map((p: any) => p.sales), [...r.people.map((p: any) => p.sales)].sort((a, b) => b - a)); // biggest first
    assert.ok(r.heads.length > 0 && r.months.length === 1);
    assert.equal(Math.round((r.glm.sharePct + r.sales.sharePct) * 10) / 10, 100);
  });
});
