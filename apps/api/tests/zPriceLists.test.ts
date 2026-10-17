// The two price lists: GLM Sales and Freelancer Sales. The Freelancer list is the GLM list less one default percentage (rounded), a price typed by hand wins, and every order records the list it was
// captured under. A sales person captures under Freelancer Sales only, the front office under both and must say which sales person; a client in a sales person's register is not captured under
// GLM Sales. (Named z… because it changes the shared settings and records orders; it puts the settings back.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const ROLL = 'ROLL-PRICELIST';

describe('price lists', () => {
  before(async () => {
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true }, create: { id: 1, enabled: true } });
    await prisma.role.create({ data: { name: 'Seller (pl test)', canCaptureOrders: true, canAccessDtf: true, canBeAssignedOrders: true } });
    await prisma.role.create({ data: { name: 'Desk (pl test)', canCaptureOrders: true, canAccessDtf: true, canCaptureForOthers: true } });
    await prisma.role.create({ data: { name: 'Glm staff (pl test)', canCaptureOrders: true, canAccessDtf: true } });
    await prisma.role.create({ data: { name: 'Lead (pl test)', canAccessDtf: true, canManageDtf: true, canCaptureOrders: true } });
    for (const [key, role] of [['seller', 'Seller (pl test)'], ['desk', 'Desk (pl test)'], ['glm', 'Glm staff (pl test)'], ['lead', 'Lead (pl test)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (pl test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.dtfRoll.create({ data: { id: ROLL, installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100, filmCost: 5000, inkPowderCost: 1000 } });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await call('admin', 'PUT', '/master-data/settings', { freelancerDiscountPct: 0, freelancerRoundTo: 5 });
    await call('lead', 'PUT', '/dtf/settings?priceList=freelancer', { stdPricePerM: null, minPricePerM: null, fixedChargePerMetre: null });
    server.close();
    await prisma.$disconnect();
  });

  it('without a percentage the Freelancer list is the GLM list; with one it is that much less, rounded, and a price typed by hand wins', async () => {
    const svc = await prisma.service.create({ data: { name: 'PL Test Banner', item: 'PL Test Banner', unit: 'piece', price: 1234 } });
    const mat = await prisma.material.create({ data: { name: 'PL Test Mug', item: 'PL Test Mug', unit: 'piece', price: 1000 } });
    const find = async (list: string, name: string) => (await call('admin', 'GET', `/master-data/${list}`)).body.find((x: any) => x.name === name);
    assert.equal((await find('services', 'PL Test Banner')).freelancerPrice, 1234); // no percentage yet: the same
    assert.equal((await call('seller', 'PUT', '/master-data/settings', { freelancerDiscountPct: 10 })).status, 403); // Admin only
    assert.equal((await call('admin', 'PUT', '/master-data/settings', { freelancerDiscountPct: 95 })).status, 400);
    const set = await call('admin', 'PUT', '/master-data/settings', { freelancerDiscountPct: 10, freelancerRoundTo: 5 });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual([set.body.freelancerDiscountPct, set.body.freelancerRoundTo], [10, 5]);
    assert.equal((await find('services', 'PL Test Banner')).freelancerPrice, 1110); // 1,234 less 10% = 1,110.6, to the nearest 5
    assert.equal((await find('materials', 'PL Test Mug')).freelancerPrice, 900);
    // typed by hand for one item
    assert.equal((await call('admin', 'PUT', `/master-data/services/${svc.id}`, { freelancerOverride: 1000 })).status, 200);
    const typed = await find('services', 'PL Test Banner');
    assert.deepEqual([typed.freelancerPrice, typed.freelancerOverride, typed.price], [1000, 1000, 1234]);
    // GLM price changes: an item without an override follows, one with an override keeps its own
    assert.equal((await call('admin', 'PUT', `/master-data/services/${svc.id}`, { price: 2000 })).status, 200);
    assert.equal((await find('services', 'PL Test Banner')).freelancerPrice, 1000);
    // …and null goes back to the percentage
    assert.equal((await call('admin', 'PUT', `/master-data/services/${svc.id}`, { freelancerOverride: null })).status, 200);
    assert.equal((await find('services', 'PL Test Banner')).freelancerPrice, 1800);
    assert.equal((await call('admin', 'PUT', `/master-data/materials/${mat.id}`, { freelancerOverride: 850 })).status, 200);
    assert.equal((await find('materials', 'PL Test Mug')).freelancerPrice, 850);
  });

  it('DTF rates on the Freelancer list: the GLM rate less the percentage, or typed by hand', async () => {
    const glm = (await call('lead', 'GET', '/dtf/data?product=dtf')).body;
    const fl = (await call('lead', 'GET', '/dtf/data?product=dtf&priceList=freelancer')).body;
    assert.equal(fl.priceList, 'freelancer');
    assert.equal(fl.settings.minPricePerM, Math.round((glm.settings.minPricePerM * 0.9) / 5) * 5); // 400 → 360
    assert.ok(fl.settings.stdPricePerM < glm.settings.stdPricePerM);
    assert.equal(fl.settings.rollLengthM, glm.settings.rollLengthM); // roll size is the same
    assert.equal(fl.freelancerManual.fixedChargePerMetre, false);
    // typed by hand
    assert.equal((await call('lead', 'PUT', '/dtf/artwork-rate', { product: 'dtf', priceList: 'freelancer', pricePerMetre: 3000 })).status, 200);
    const typed = (await call('lead', 'GET', '/dtf/data?product=dtf&priceList=freelancer')).body;
    assert.equal(typed.settings.fixedChargePerMetre, 3000);
    assert.equal(typed.freelancerManual.fixedChargePerMetre, true);
    assert.equal((await call('lead', 'GET', '/dtf/data?product=dtf')).body.settings.fixedChargePerMetre, glm.settings.fixedChargePerMetre); // GLM untouched
    assert.equal((await call('lead', 'PUT', '/dtf/settings?priceList=freelancer&product=dtf', { fixedChargePerMetre: null })).status, 200); // back to following
    assert.equal((await call('lead', 'GET', '/dtf/data?product=dtf&priceList=freelancer')).body.freelancerManual.fixedChargePerMetre, false);
    assert.equal((await call('seller', 'PUT', '/dtf/settings?priceList=freelancer', { stdPricePerM: 400 })).status, 403);
  });

  it('who captures under which list: a sales person under Freelancer only, the front office under both and must name the sales person', async () => {
    const fl = (await call('lead', 'GET', '/dtf/data?product=dtf&priceList=freelancer')).body.settings;
    const sale = (who: string, extra: object) => call(who, 'POST', '/dtf/sales', { rollId: ROLL, client: 'PL Client', metres: 2, ...extra });
    // a sales person: Freelancer Sales at the Freelancer floor (below GLM's 400), recorded as such
    const ok = await sale('seller', { priceList: 'freelancer', pricePerM: fl.minPricePerM });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.order.priceList, 'freelancer');
    assert.equal(ok.body.order.totals.grandTotal, fl.minPricePerM * 2);
    // the same price is under GLM's floor on the GLM list
    const glmFloor = (await call('lead', 'GET', '/dtf/data?product=dtf')).body.settings.minPricePerM;
    assert.ok(fl.minPricePerM < glmFloor);
    assert.equal((await sale('glm', { priceList: 'glm', pricePerM: fl.minPricePerM })).status, 400);
    assert.equal((await sale('glm', { priceList: 'glm', pricePerM: glmFloor })).body.order.priceList, 'glm');
    // a sales person cannot use GLM Sales; GLM's own staff cannot use Freelancer Sales (they are not a sales person)
    const noGlm = await sale('seller', { priceList: 'glm', pricePerM: glmFloor });
    assert.equal(noGlm.status, 400);
    assert.match(noGlm.body.error, /Freelancer Sales, not GLM Sales/);
    assert.equal((await sale('glm', { priceList: 'freelancer', pricePerM: fl.minPricePerM })).status, 400);
    // the front office: Freelancer Sales needs the sales person named; named, the order is theirs
    const noName = await sale('desk', { priceList: 'freelancer', pricePerM: fl.minPricePerM });
    assert.equal(noName.status, 400);
    assert.match(noName.body.error, /choose who this order is for/);
    const named = await sale('desk', { priceList: 'freelancer', pricePerM: fl.minPricePerM, staffId: ids.seller });
    assert.equal(named.status, 201, JSON.stringify(named.body));
    assert.equal(named.body.order.staff.id, ids.seller);
    // GLM Sales is not credited to a sales person
    const glmToSeller = await sale('desk', { priceList: 'glm', pricePerM: glmFloor, staffId: ids.seller });
    assert.equal(glmToSeller.status, 400);
    assert.match(glmToSeller.body.error, /not credited to a sales person/);
    // an older screen that says nothing: the list follows who it is credited to
    assert.equal((await sale('seller', { pricePerM: 500 })).body.order.priceList, 'freelancer');
    assert.equal((await sale('glm', { pricePerM: 500 })).body.order.priceList, 'glm');
  });

  it('a client in a sales person\'s register is not captured under GLM Sales', async () => {
    const reg = await call('seller', 'POST', '/staff-clients', { name: 'Register Client Ltd', phone: '0722 111 222' });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const glmFloor = (await call('lead', 'GET', '/dtf/data?product=dtf')).body.settings.minPricePerM;
    const blocked = await call('glm', 'POST', '/dtf/sales', { rollId: ROLL, client: 'Register Client Ltd', phone: '0722 111 222', metres: 1, pricePerM: glmFloor, priceList: 'glm' });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /Client Register — capture the order under Freelancer Sales/);
    // another client is fine
    assert.equal((await call('glm', 'POST', '/dtf/sales', { rollId: ROLL, client: 'Someone Else', phone: '0733 000 111', metres: 1, pricePerM: glmFloor, priceList: 'glm' })).status, 201);
    // and the general order records the list too
    const svc = await prisma.service.findFirstOrThrow({ where: { name: 'PL Test Banner' } });
    const general = await call('seller', 'POST', '/orders/walkin', { paymentTiming: 'onCompletion', priceList: 'freelancer', lineItems: [{ itemType: 'service', serviceId: svc.id, qty: 1, unitPrice: 1800 }] });
    assert.equal(general.status, 201, JSON.stringify(general.body));
    assert.equal(general.body.priceList, 'freelancer');
    const listed = (await call('admin', 'GET', '/orders')).body.find((o: any) => o.orderNo === general.body.orderNo);
    assert.equal(listed.priceList, 'freelancer');
    const blockedGeneral = await call('seller', 'POST', '/orders/walkin', { paymentTiming: 'onCompletion', priceList: 'glm', lineItems: [{ itemType: 'service', serviceId: svc.id, qty: 1, unitPrice: 2000 }] });
    assert.equal(blockedGeneral.status, 400);
  });
});
