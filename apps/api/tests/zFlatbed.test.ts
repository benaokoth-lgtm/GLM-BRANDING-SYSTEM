// UV flatbed price picker (UV DTF Film Order → UV Flatbed): the artwork is priced by its area in bands, a piece never costs less than the minimum for a piece, a bigger run gets a volume
// discount, and the setup fee is added only when it is asked for. (Named z… because it records an order, which the other files' totals must not see.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_FLATBED_SETTINGS, UV_FLATBED_SERVICE, flatbedDiscountRangeLabel, flatbedQuote, flatbedRangeLabel, flatbedSettingsProblem, salesTypeOf } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const S = DEFAULT_FLATBED_SETTINGS;

describe('UV flatbed price picker', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Printer (flatbed test)', canAccessDtf: true } });
    await prisma.role.create({ data: { name: 'Lead (flatbed test)', canAccessDtf: true, canManageDtf: true } });
    await prisma.role.create({ data: { name: 'Nobody (flatbed test)' } });
    for (const [key, role] of [['printer', 'Printer (flatbed test)'], ['lead', 'Lead (flatbed test)'], ['nobody', 'Nobody (flatbed test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (flatbed test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('the starting bands: 50/= for every 150 cm², from 100/= up to 500/= for the full 30 × 50 cm', () => {
    assert.equal(flatbedSettingsProblem(S), null);
    assert.deepEqual([0, 1, 8].map((i) => flatbedRangeLabel(S.bands, i)), ['up to 300 cm²', '301–450 cm²', '1351–1500 cm²']);
    const price = (w: number, h: number) => flatbedQuote(S, w, h, 1).unitPrice;
    assert.equal(price(5, 5), 100); // a small logo
    assert.equal(price(10, 15), 100); // 150 cm²
    assert.equal(price(10, 30), 100); // exactly 300 cm² is in the first band
    assert.equal(price(10, 30.1), 150); // a little over is in the next
    assert.equal(price(14.8, 21), 150); // A5
    assert.equal(price(21, 29.7), 250); // A4
    assert.equal(price(30, 50), 500); // the full dimension
    assert.equal(price(50, 30), 500); // either way round
  });

  it('a run is priced piece by piece, with the volume discount on the whole run and no setup fee unless asked for', () => {
    const q = (w: number, h: number, n: number, setup = false) => flatbedQuote(S, w, h, n, setup);
    assert.deepEqual([q(14.8, 21, 1).total, q(14.8, 21, 10).total], [150, 1500]); // no discount under 20
    // 20 A5: 3,000 less 5%
    const twenty = q(14.8, 21, 20);
    assert.deepEqual([twenty.gross, twenty.discountPct, twenty.discount, twenty.total], [3000, 5, 150, 2850]);
    assert.equal(q(14.8, 21, 49).total, 6982.5); // 49 × 150 = 7,350 less 5%
    assert.equal(q(14.8, 21, 50).total, 6750); // 7,500 less 10%
    assert.equal(q(14.8, 21, 100).total, 12750); // 15,000 less 15%
    assert.equal(q(14.8, 21, 1000).discountPct, 15); // the last tier carries on
    assert.deepEqual([0, 1, 2, 3].map((i) => flatbedDiscountRangeLabel(S.discounts, i)), ['1–19', '20–49', '50–99', '100+']);
    // the setup fee is on the printing's total only when it is asked for, and the discount does not touch it
    assert.deepEqual([q(14.8, 21, 10, true).total, q(14.8, 21, 10, false).total], [1700, 1500]);
    const big = q(14.8, 21, 100, true);
    assert.deepEqual([big.setupFee, big.printTotal, big.total], [200, 12750, 12950]);
    assert.equal(q(14.8, 21, 100).setupFee, 0);
  });

  it('the minimum price for a piece lifts the very small artworks, and only those', () => {
    const dear = { ...S, minPiecePrice: 150 };
    const logo = flatbedQuote(dear, 5, 5, 4);
    assert.deepEqual([logo.unitPrice, logo.minApplied, logo.total], [150, true, 600]); // the band says 100
    const a5 = flatbedQuote(dear, 14.8, 21, 4);
    assert.deepEqual([a5.unitPrice, a5.minApplied], [150, false]); // already 150
    assert.equal(flatbedQuote({ ...S, minPiecePrice: 50 }, 5, 5, 1).unitPrice, 100); // a lower minimum changes nothing
    assert.equal(flatbedQuote({ ...S, minPiecePrice: 0 }, 5, 5, 1).minApplied, false);
  });

  it('points out a bigger discount close by', () => {
    // 10 pieces at 100 = 1,000; 20 pieces at 100 less 5% = 1,900: the total goes up (the screen says what it becomes)
    assert.deepEqual(flatbedQuote(S, 10, 15, 10).upsell, { qty: 20, add: 10, pct: 5, saving: -900 });
    // 49 A5 at 150 less 5% = 6,982.50; 50 less 10% = 6,750
    assert.deepEqual(flatbedQuote(S, 14.8, 21, 49).upsell, { qty: 50, add: 1, pct: 10, saving: 232.5 });
    assert.equal(flatbedQuote(S, 14.8, 21, 100).upsell, null); // already at the best
  });

  it('says why there is no price: too big, or not a size', () => {
    assert.match(flatbedQuote(S, 31, 51, 5).problem ?? '', /bigger than the largest artwork/);
    assert.match(flatbedQuote(S, 40, 40, 5).problem ?? '', /bigger/);
    assert.equal(flatbedQuote(S, 14.8, 21, 0).ok, false);
    assert.equal(flatbedQuote(S, 0, 21, 3).ok, false);
    assert.equal(flatbedQuote(S, 14.8, 21, 3).ok, true);
    // settings that cannot be saved
    assert.match(flatbedSettingsProblem({ ...S, bands: [{ upToCm2: 300, price: 100 }] }) ?? '', /largest artwork/);
    assert.match(flatbedSettingsProblem({ ...S, bands: [...S.bands, { upToCm2: 300, price: 90 }] }) ?? '', /Two bands/);
    assert.match(flatbedSettingsProblem({ ...S, minPiecePrice: -1 }) ?? '', /negative/);
    assert.match(flatbedSettingsProblem({ ...S, bands: [] }) ?? '', /at least one band/);
    assert.match(flatbedSettingsProblem({ ...S, discounts: [{ from: 5, pct: 5 }] }) ?? '', /start at 1/);
    assert.match(flatbedSettingsProblem({ ...S, discounts: [{ from: 1, pct: 0 }, { from: 20, pct: 100 }] }) ?? '', /under 100/);
    assert.match(flatbedSettingsProblem({ ...S, discounts: [{ from: 1, pct: 0 }, { from: 1, pct: 5 }] }) ?? '', /Two discounts/);
    assert.equal(flatbedSettingsProblem({ ...S, discounts: [{ from: 1, pct: 0 }] }), null); // no volume discount at all
  });

  it('the prices are kept in the system: anyone with DTF access reads them, a DTF manager changes them', async () => {
    const r = await call('printer', 'GET', '/dtf/flatbed');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.settings, S);
    assert.equal(r.body.canManage, false);
    assert.equal((await call('lead', 'GET', '/dtf/flatbed')).body.canManage, true);
    assert.equal((await call('nobody', 'GET', '/dtf/flatbed')).status, 403);

    const change = { ...S, minPiecePrice: 150, setupFee: 250, discounts: [{ from: 1, pct: 0 }, { from: 10, pct: 8 }] };
    assert.equal((await call('printer', 'PUT', '/dtf/flatbed', change)).status, 403);
    assert.equal((await call('lead', 'PUT', '/dtf/flatbed', { ...S, bands: [{ upToCm2: 300, price: 100 }] })).status, 400); // does not reach the largest artwork
    assert.equal((await call('lead', 'PUT', '/dtf/flatbed', { ...S, setupFee: -5 })).status, 400);
    assert.equal((await call('lead', 'PUT', '/dtf/flatbed', { ...S, discounts: [{ from: 3, pct: 5 }] })).status, 400);
    const saved = await call('lead', 'PUT', '/dtf/flatbed', change);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual((await call('printer', 'GET', '/dtf/flatbed')).body.settings, change); // kept, for everyone
    assert.equal(flatbedQuote(saved.body.settings, 5, 5, 10, true).total, 1630);
    // back to the starting prices
    assert.equal((await call('lead', 'PUT', '/dtf/flatbed', S)).status, 200);
    assert.deepEqual((await call('printer', 'GET', '/dtf/flatbed')).body.settings, S);
  });

  it('capture as order: the price comes from the settings on the server, and the order is an ordinary one', async () => {
    assert.equal((await call('nobody', 'POST', '/dtf/flatbed-orders', { widthCm: 14.8, heightCm: 21, pieces: 4 })).status, 403);
    assert.equal((await call('printer', 'POST', '/dtf/flatbed-orders', { widthCm: 14.8, heightCm: 21, pieces: 0 })).status, 400);
    assert.equal((await call('printer', 'POST', '/dtf/flatbed-orders', { widthCm: 40, heightCm: 40, pieces: 2 })).status, 400); // bigger than the largest artwork

    // 20 A5 diaries: 3,000 less 5% = 2,850/= — a total sent from the screen is not listened to, and there is no setup fee unless it is asked for
    const r = await call('printer', 'POST', '/dtf/flatbed-orders', { widthCm: 14.8, heightCm: 21, pieces: 20, note: '2027 diary covers', client: 'Hope Chapel', total: 5, payments: [{ method: 'Cash', amount: 600 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.order.totals.grandTotal, 2850);
    assert.equal(r.body.order.totals.balanceDue, 2250);
    assert.equal(r.body.order.customerName, 'Hope Chapel');
    assert.match(r.body.order.orderNo, /^U-/);
    const line = r.body.order.lineItems[0];
    assert.deepEqual([line.qty, line.unitPrice], [1, 2850]);
    assert.match(line.serviceName, /20 × 14\.8 × 21 cm/);
    assert.match(line.serviceName, /301–450 cm² band/);
    assert.match(line.serviceName, /5% volume discount/);
    assert.match(line.serviceName, /2027 diary covers/);
    assert.doesNotMatch(line.serviceName, /setup/);

    // with the setup fee ticked: one small logo 100 + 200
    const withSetup = await call('printer', 'POST', '/dtf/flatbed-orders', { widthCm: 5, heightCm: 5, pieces: 1, withSetup: true, payments: [{ method: 'M-Pesa', amount: 300 }] });
    assert.equal(withSetup.status, 201, JSON.stringify(withSetup.body));
    assert.deepEqual([withSetup.body.order.totals.grandTotal, withSetup.body.order.totals.balanceDue, withSetup.body.order.customerName], [300, 0, 'Walk-in']);
    assert.match(withSetup.body.order.lineItems[0].serviceName, /setup/);

    // the price list gets its own service, under UV Printing, sold only through this screen
    const svc = await prisma.service.findFirstOrThrow({ where: { name: UV_FLATBED_SERVICE }, include: { businessHead: true } });
    assert.deepEqual([svc.unit, svc.soldViaDtfModule, svc.businessHead?.name], ['job', true, 'UV Printing']);
    assert.equal(await prisma.service.count({ where: { name: UV_FLATBED_SERVICE } }), 1);
    assert.equal(salesTypeOf({ orderNo: 'U-1', lineItems: [{ service: { name: UV_FLATBED_SERVICE } }] }), 'uv_flatbed');

    // more than the total cannot be taken: a logo is 100/= without the setup fee
    assert.equal((await call('printer', 'POST', '/dtf/flatbed-orders', { widthCm: 5, heightCm: 5, pieces: 1, payments: [{ method: 'Cash', amount: 300 }] })).status, 400);
  });
});
