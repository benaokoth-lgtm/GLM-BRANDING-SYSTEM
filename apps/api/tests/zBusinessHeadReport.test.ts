// (Named to run last: it leaves a seller's orders behind, which would show up on the team statements of the commission tests.)
// Reports → Sales by Business Head: a material sold with a service counts under the service's head, DTF and UV DTF show film and artwork apart, "collected" is the money received
// in the period, and UV pens and costed print jobs sit under the heads they belong to.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PRINTING_PUBLICATIONS_HEAD, UV_DTF_HEAD, UV_PEN_SERVICE, defaultBusinessHeadName } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { alignSystemHeadsOnce } from '../src/embroideryLegacy';

let server: Server;
let base = '';
let token = '';
let svc = 0;
let mat = 0;
const today = new Date().toISOString().slice(0, 10);

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const report = async () => (await call('GET', `/reports/sales-by-business-head?from=${today}&to=${today}`)).body;
const head = (r: any, name: string) => r.heads.find((h: any) => h.name === name);

describe('Sales by Business Head', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Heads Seller', canCaptureOrders: true, canAccessDtf: true, canAccessReports: true } });
    const u = await prisma.user.create({ data: { name: 'heads seller', role: 'Heads Seller', pinHash: 'x' } });
    token = signToken({ id: u.id, name: u.name, role: 'Heads Seller' });
    const h = await prisma.businessHead.create({ data: { name: 'Heads Test Head', sortOrder: 99 } });
    svc = (await prisma.service.create({ data: { name: 'Heads Test Service', item: 'Heads Test Service', unit: 'piece', price: 1160, businessHeadId: h.id } })).id;
    mat = (await prisma.material.create({ data: { name: 'Heads Test Material', item: 'Heads Test Material', unit: 'piece', price: 580 } })).id;
    if (!(await prisma.dtfRoll.findUnique({ where: { id: 'ROLL-HD1' } }))) await prisma.dtfRoll.create({ data: { id: 'ROLL-HD1', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100 } });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('a material sold with a service counts under the service’s head, and what was collected is shown beside what was sold', async () => {
    const before = await report();
    const general = head(before, 'General Order')?.sales ?? 0;
    // 1,160 of service + 580 of material, paid in full: 1,740 = 1,500 without VAT, all under the service's head
    const o = await call('POST', '/orders/walkin', {
      customerName: 'Heads Client', staffId: (await prisma.user.findFirstOrThrow({ where: { name: 'heads seller' } })).id, paymentTiming: 'onAcceptance', payments: [{ method: 'Cash', amount: 1740 }],
      lineItems: [{ itemType: 'service', serviceId: svc, qty: 1, unitPrice: 1160 }, { itemType: 'material', materialId: mat, qty: 1, unitPrice: 580 }],
    });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    const after = await report();
    const mine = head(after, 'Heads Test Head');
    assert.deepEqual([mine.sales, mine.orders, mine.collected], [1500, 1, 1500]);
    assert.equal(head(after, 'General Order')?.sales ?? 0, general); // the material did not go to General Order
    assert.deepEqual(o.body.businessHeads, ['Heads Test Head']); // and the order is that head's in My Orders too
    // the line detail agrees
    const detail = await call('GET', `/reports/business-head-detail?head=${encodeURIComponent('Heads Test Head')}&from=${today}&to=${today}`);
    assert.deepEqual([detail.body.sales.length, detail.body.totals.sales], [2, 1500]);
    // a material sold on its own is still General Order
    const alone = await call('POST', '/orders/walkin', {
      customerName: 'Walk', staffId: (await prisma.user.findFirstOrThrow({ where: { name: 'heads seller' } })).id, paymentTiming: 'onCompletion', lineItems: [{ itemType: 'material', materialId: mat, qty: 2, unitPrice: 580 }],
    });
    assert.equal(alone.status, 201);
    assert.equal(Math.round(((head(await report(), 'General Order')?.sales ?? 0) - general) * 100) / 100, 1000);
    // …with nothing collected on it yet
    assert.equal(Math.round(((head(await report(), 'General Order')?.collected ?? 0) - (head(after, 'General Order')?.collected ?? 0)) * 100) / 100, 0);
  });

  it('DTF Printing shows its film sales and artwork sales apart', async () => {
    const f = await call('POST', '/dtf/sales', { rollId: 'ROLL-HD1', client: 'Film', metres: 10, pricePerM: 450, amountPaid: 4500 });
    assert.equal(f.status, 201, JSON.stringify(f.body));
    const r = await report();
    const dtf = head(r, 'DTF Printing');
    const film = dtf.splits.find((s: any) => s.name === 'Film sales');
    assert.ok(film && film.sales >= 3879.31 && film.orders >= 1);
    assert.ok(Math.abs(dtf.sales - dtf.splits.reduce((a: number, s: any) => a + s.sales, 0)) < 0.05); // the parts make up the head
    assert.ok(dtf.collected >= 3879.31);
    assert.ok(r.totalCollected >= 1500 + 3879.31);
  });

  it('UV pens count under UV DTF Printing and costed print jobs under Printing & Publications', async () => {
    assert.equal(defaultBusinessHeadName(UV_PEN_SERVICE), UV_DTF_HEAD);
    assert.equal(defaultBusinessHeadName('Costed job — Eulogy'), PRINTING_PUBLICATIONS_HEAD);
    assert.equal(defaultBusinessHeadName('Costed job — Indoor signage'), 'General Order'); // signage keeps its own head (Large Format Printing, set when made)
    const p = await call('POST', '/dtf/pen-orders', { pens: 100, client: 'Pens', payments: [{ method: 'Cash', amount: 1500 }] });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const pen = await prisma.service.findFirstOrThrow({ where: { name: UV_PEN_SERVICE }, include: { businessHead: true } });
    assert.equal(pen.businessHead?.name, UV_DTF_HEAD);
    // a service an earlier version put under UV Printing or General Order is moved; one an Admin put elsewhere stays
    const uvPrinting = await prisma.businessHead.upsert({ where: { name: 'UV Printing' }, update: {}, create: { name: 'UV Printing', sortOrder: 98 } });
    await prisma.service.update({ where: { id: pen.id }, data: { businessHeadId: uvPrinting.id } });
    const costed = await prisma.service.create({ data: { name: 'Costed job — Brochure', item: 'Costed job — Brochure', unit: 'piece', price: 0, soldViaDtfModule: true, outsourced: true } }).catch(() => prisma.service.findFirstOrThrow({ where: { name: 'Costed job — Brochure' } }));
    await prisma.service.update({ where: { id: costed.id }, data: { businessHeadId: null } });
    await alignSystemHeadsOnce();
    assert.equal((await prisma.service.findFirstOrThrow({ where: { id: pen.id }, include: { businessHead: true } })).businessHead?.name, UV_DTF_HEAD);
    assert.equal((await prisma.service.findFirstOrThrow({ where: { id: costed.id }, include: { businessHead: true } })).businessHead?.name, PRINTING_PUBLICATIONS_HEAD);
    const large = await prisma.businessHead.upsert({ where: { name: 'Large Format Printing' }, update: {}, create: { name: 'Large Format Printing', sortOrder: 97 } });
    await prisma.service.update({ where: { id: pen.id }, data: { businessHeadId: large.id } });
    await alignSystemHeadsOnce();
    assert.equal((await prisma.service.findFirstOrThrow({ where: { id: pen.id }, include: { businessHead: true } })).businessHead?.name, 'Large Format Printing'); // an Admin's choice is kept
    await prisma.service.update({ where: { id: pen.id }, data: { businessHeadId: (await prisma.businessHead.findFirstOrThrow({ where: { name: UV_DTF_HEAD } })).id } });
  });
});
