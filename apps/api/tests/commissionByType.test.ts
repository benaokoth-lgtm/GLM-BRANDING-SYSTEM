// Commission → where the sales come from: a salesperson's month split by the kind of sale under Sales (the screen it was captured through), with what each earned.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SALES_TYPES, SALES_TYPE_LABEL, salesTypeOf } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
let banner = 0;
const period = new Date().toISOString().slice(0, 7);

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const mine = async (who: string) => (await call(who, 'GET', `/commission/my?period=${period}`)).body.statement;
const row = (st: any, type: string) => st.byType.find((r: any) => r.type === type);

describe('commission by kind of sale', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'ByType Counter', canCaptureOrders: true, canBeAssignedOrders: true, canAccessDtf: true } });
    for (const key of ['cara', 'dan']) {
      const u = await prisma.user.create({ data: { name: `${key} (bytype test)`, role: 'ByType Counter', pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role: 'ByType Counter' });
    }
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true, targetMultiplier: 0, generalMode: 'percent' }, create: { id: 1, enabled: true, targetMultiplier: 0, generalMode: 'percent' } });
    banner = (await prisma.service.create({ data: { name: 'Banner (bytype test)', unit: 'piece', price: 1000 } })).id;
    if (!(await prisma.service.findFirst({ where: { name: 'DTF Sheet (per metre)' } }))) await prisma.service.create({ data: { name: 'DTF Sheet (per metre)', unit: 'metre', price: 500 } });
    if (!(await prisma.dtfRoll.findUnique({ where: { id: 'ROLL-BT1' } }))) await prisma.dtfRoll.create({ data: { id: 'ROLL-BT1', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100 } });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('tells a sale by the screen it came through', () => {
    const lines = (...names: string[]) => names.map((name) => ({ service: { name } }));
    assert.equal(salesTypeOf({ orderNo: 'W-7001', lineItems: lines('Banner') }), 'general');
    assert.equal(salesTypeOf({ orderNo: 'F-6001', dtfFilmSale: {}, lineItems: lines('DTF Sheet (per metre)') }), 'dtf_film');
    assert.equal(salesTypeOf({ orderNo: 'F-6002', dtfArtworkJob: {}, lineItems: lines('DTF Printing') }), 'dtf_artwork');
    assert.equal(salesTypeOf({ orderNo: 'U-6001', dtfFilmSale: {}, lineItems: lines('UV DTF Sheet (per metre)') }), 'uv_film');
    assert.equal(salesTypeOf({ orderNo: 'U-6002', dtfArtworkJob: {}, lineItems: lines('UV DTF Printing') }), 'uv_artwork');
    assert.equal(salesTypeOf({ orderNo: 'W-7002', embroideryJob: {}, lineItems: lines('Embroidery — logo') }), 'embroidery');
    assert.equal(salesTypeOf({ orderNo: 'U-6003', lineItems: lines('UV Pen Branding') }), 'uv_pens');
    assert.equal(salesTypeOf({ orderNo: 'W-7003', lineItems: lines('Costed job — Eulogy') }), 'costing');
    assert.equal(SALES_TYPES.length, Object.keys(SALES_TYPE_LABEL).length);
  });

  it('shows what was sold and earned under each kind of sale, and how the person compares with the team', async () => {
    // Cara sources two clients: a general order (1,160 paid = 1,000 net) and 450 UV pens (6,750 paid = 5,818.97 net)
    const general = await call('cara', 'POST', '/orders/walkin', {
      customerName: 'Hope Chapel', phone: '0712 000 777', staffId: ids.cara, sourcedBy: ids.cara, paymentTiming: 'onAcceptance', payments: [{ method: 'Cash', amount: 1160 }],
      lineItems: [{ itemType: 'service', serviceId: banner, qty: 1, unitPrice: 1160 }],
    });
    assert.equal(general.status, 201, JSON.stringify(general.body));
    const pens = await call('cara', 'POST', '/dtf/pen-orders', { pens: 450, client: 'Grace Mwangi', phone: '0722 000 888', sourcedBy: ids.cara, payments: [{ method: 'M-Pesa', amount: 6750 }] });
    assert.equal(pens.status, 201, JSON.stringify(pens.body));
    // Dan sells film above the base (not sourced; film earns on what was charged above 400): 10 m at 450
    const film = await call('dan', 'POST', '/dtf/sales', { rollId: 'ROLL-BT1', client: 'Film Buyer', phone: '0744 000 555', metres: 10, pricePerM: 450, amountPaid: 4500 });
    assert.equal(film.status, 201, JSON.stringify(film.body));

    const cara = await mine('cara');
    assert.deepEqual(cara.byType.map((r: any) => r.type), [...SALES_TYPES]);
    // sold = the orders' worth with VAT out; received = money in with VAT out
    assert.deepEqual([row(cara, 'general').orders, row(cara, 'general').sold, row(cara, 'general').received], [1, 1000, 1000]);
    assert.deepEqual([row(cara, 'uv_pens').orders, row(cara, 'uv_pens').sold, row(cara, 'uv_pens').received], [1, 5818.97, 5818.97]);
    assert.equal(row(cara, 'dtf_film').sold, 0);
    // the pay bands' commission is shared by the money received on each kind of sale, and adds back up
    const shared = row(cara, 'general').commission + row(cara, 'uv_pens').commission;
    assert.equal(Math.round(shared * 100) / 100, cara.general.commission);
    // …and what each earned follows what was received: pens brought in far more than the banner
    assert.ok(row(cara, 'uv_pens').commission >= row(cara, 'general').commission);

    const dan = await mine('dan');
    assert.deepEqual([row(dan, 'dtf_film').orders, row(dan, 'dtf_film').sold], [1, 3879.31]); // 4,500 ÷ 1.16
    assert.equal(row(dan, 'dtf_film').commission, dan.film.commission); // film's premium is all in this kind of sale
    assert.ok(row(dan, 'dtf_film').commission > 0);
    assert.equal(row(dan, 'general').sold, 0);

    // each person's average of the team: Cara and Dan are the team here, so the average is half of what they sold between them
    for (const t of ['general', 'uv_pens', 'dtf_film']) assert.equal(row(cara, t).teamAvgSold, row(dan, t).teamAvgSold);
    assert.ok(row(cara, 'uv_pens').teamAvgSold > 0 && row(cara, 'uv_pens').teamAvgSold < row(cara, 'uv_pens').sold + 0.01);
    // nothing sold last month in this test
    assert.equal(row(cara, 'general').soldBefore, 0);
  });
});
