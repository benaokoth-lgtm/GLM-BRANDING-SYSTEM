// The Outsourced Order: a contracted-out job the sales person buys and sells on. They capture the unit selling price and the unit purchasing price, see the gross margin, and are
// paid a share of the job's NET gross profit — sales without output VAT, cost without claimable input VAT — as the customer pays.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VAT_RATE, outsourcedCommission, outsourcedFigures, outsourcedRate, DEFAULT_OUTSOURCED_BANDS } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
let bannerId = 0;
let plainId = 0;
const period = new Date().toISOString().slice(0, 7);

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const mine = async (who: string) => (await call(who, 'GET', `/commission/my?period=${period}`)).body.statement;

describe('the margin and commission rules', () => {
  it('counts sales without output VAT and cost without claimable input VAT', () => {
    // sold for 23,200 incl. VAT (20,000 net), bought for 11,600 incl. VAT
    const claim = outsourcedFigures(23200, [{ qty: 1, unitCost: 11600, vatClaimable: true }], VAT_RATE);
    assert.deepEqual([claim.netSales, claim.outputVat, claim.netCost, claim.inputVatClaimed, claim.vatInCost, claim.grossProfit, claim.marginPct], [20000, 3200, 10000, 1600, 0, 10000, 50]);
    const noClaim = outsourcedFigures(23200, [{ qty: 1, unitCost: 11600, vatClaimable: false }], VAT_RATE);
    assert.deepEqual([noClaim.netCost, noClaim.inputVatClaimed, noClaim.vatInCost, noClaim.grossProfit, noClaim.marginPct], [11600, 0, 1600, 8400, 42]); // the supplier's VAT is a real cost
  });

  it('the share steps up with the job margin: nothing below 10%, then 10%, 15% and 20% of the gross profit', () => {
    for (const [margin, rate] of [[-5, 0], [0, 0], [9.99, 0], [10, 10], [19.99, 10], [20, 15], [29.99, 15], [30, 20], [60, 20]] as const) assert.equal(outsourcedRate(DEFAULT_OUTSOURCED_BANDS, margin), rate, `${margin}%`);
    const f = outsourcedFigures(23200, [{ qty: 1, unitCost: 11600, vatClaimable: true }], VAT_RATE); // 50% margin, 10,000 profit
    assert.deepEqual(outsourcedCommission(f, DEFAULT_OUTSOURCED_BANDS, 1), { ratePct: 20, full: 2000, earned: 2000 });
    assert.equal(outsourcedCommission(f, DEFAULT_OUTSOURCED_BANDS, 0.5).earned, 1000); // earned as the customer pays
    const loss = outsourcedFigures(11600, [{ qty: 1, unitCost: 11000, vatClaimable: false }], VAT_RATE);
    assert.equal(outsourcedCommission(loss, DEFAULT_OUTSOURCED_BANDS, 1).earned, 0); // a job that loses money earns nothing
  });
});

describe('the Outsourced Order', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Seller (os test)', canCaptureOrders: true, canBeAssignedOrders: true } });
    await prisma.role.create({ data: { name: 'Manager (os test)', canCaptureOrders: true, canManageCommission: true, canSeeCosts: true, canViewAllOrders: true } });
    for (const [key, role] of [['seller', 'Seller (os test)'], ['other', 'Seller (os test)'], ['mgr', 'Manager (os test)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (os test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true }, create: { id: 1, enabled: true } });
    bannerId = (await prisma.service.create({ data: { name: 'Banner (os test)', unit: 'sqm', price: 2000, outsourced: true, supplierName: 'Print House', defaultSupplierCost: 1200, markupType: 'percent', markupValue: 40 } })).id;
    plainId = (await prisma.service.create({ data: { name: 'Plain (os test)', unit: 'piece', price: 500 } })).id;
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  // a job sold for `price` a unit and bought for `cost` a unit, paid `pay` at capture
  let n = 0;
  const job = (who: string, price: number, cost: number, claimable: boolean, qty = 10, pay?: number, extra: Record<string, unknown> = {}) =>
    call(who, 'POST', '/orders/outsourced', {
      customerName: `OS Client ${++n}`,
      phone: `072${String(5000000 + n * 211)}`,
      staffId: ids[who],
      sourcedBy: ids[who],
      paymentTiming: pay ? 'onAcceptance' : 'onCompletion',
      ...(pay ? { payments: [{ method: 'Cash', amount: pay }] } : {}),
      lines: [{ serviceId: bannerId, qty, unitPrice: price, supplierCost: cost, supplierName: 'Print House', supplierVatClaimable: claimable }],
      ...extra,
    });

  it('offers only the outsourced services from the price list, with their saved supplier price, and the commission scale', async () => {
    const r = await call('seller', 'GET', '/orders/outsourced/catalog');
    assert.equal(r.status, 200);
    const names = r.body.services.map((s: any) => s.name);
    assert.ok(names.includes('Banner (os test)'));
    assert.ok(!names.includes('Plain (os test)')); // not outsourced
    const banner = r.body.services.find((s: any) => s.name === 'Banner (os test)');
    assert.deepEqual([banner.price, banner.defaultSupplierCost, banner.supplierName], [2000, 1200, 'Print House']);
    assert.equal(r.body.vatRate, VAT_RATE);
    assert.deepEqual(r.body.commission.bands, DEFAULT_OUTSOURCED_BANDS);
  });

  it('captures a job from the price list; the costing and margin are for people who can see costs, not the salesperson', async () => {
    // 10 units at 2,320 (VAT incl) bought at 1,160 (VAT incl, claimable): sale 23,200, cost 11,600
    const r = await job('seller', 2320, 1160, true, 10, 23200);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.orderNo, /^O-7\d{3}$/);
    assert.equal(r.body.channel, 'outsourced');
    assert.equal(r.body.totals.grandTotal, 23200);
    assert.equal(r.body.lineItems[0].supplierCost, undefined); // the sales person enters the purchasing price but is not shown the costing back
    const id = r.body.id;

    // the margin is for people who can see costs (Finance, the General Manager, Admin) — not the sales person it is for
    assert.equal((await call('seller', 'GET', `/orders/${id}/margin`)).status, 403);
    const m = (await call('mgr', 'GET', `/orders/${id}/margin`)).body;
    assert.deepEqual([m.saleIncl, m.netSales, m.costIncl, m.netCost, m.grossProfit, m.marginPct], [23200, 20000, 11600, 10000, 10000, 50]);
    assert.deepEqual([m.commission.ratePct, m.commission.fullAmount, m.commission.earnedSoFar, m.commission.enabled], [20, 2000, 2000, true]);
    assert.equal(m.lines[0].grossProfit, 10000);

    // the order opened by the sales person does not carry the cost; a manager who sees costs gets it
    const d = (await call('seller', 'GET', `/orders/${id}`)).body;
    assert.equal(d.lineItems[0].supplierCost, undefined);
    assert.equal((await call('other', 'GET', `/orders/${id}/margin`)).status, 403);
    assert.equal((await call('mgr', 'GET', `/orders/${id}`)).body.lineItems[0].supplierCost, 1160);
    assert.equal((await call('admin', 'GET', `/orders/${id}/margin`)).status, 200);
  });

  it('input VAT that cannot be claimed is a cost: the same job earns less', async () => {
    const r = await job('seller', 2320, 1160, false, 10, 23200);
    const m = (await call('mgr', 'GET', `/orders/${r.body.id}/margin`)).body;
    assert.deepEqual([m.netCost, m.vatInCost, m.inputVatClaimed, m.grossProfit, m.marginPct], [11600, 1600, 0, 8400, 42]);
    assert.deepEqual([m.commission.ratePct, m.commission.fullAmount], [20, 1680]);
  });

  it('an item that is not in the price list is typed in, and a job needs a buying price below its selling price', async () => {
    const custom = await call('seller', 'POST', '/orders/outsourced', {
      customerName: 'Custom Client', phone: '0725999111', staffId: ids.seller, paymentTiming: 'onCompletion',
      lines: [{ name: 'A3 gloss flyers', unit: 'piece', qty: 500, unitPrice: 20, supplierCost: 12, supplierName: 'Quick Prints', supplierVatClaimable: true }],
    });
    assert.equal(custom.status, 201, JSON.stringify(custom.body));
    assert.match(custom.body.lineItems[0].serviceName, /A3 gloss flyers \(piece\)/);
    assert.equal(custom.body.lineItems[0].outsourced, true); // it goes through production and supplier billing like any contracted-out job

    const plain = await call('seller', 'POST', '/orders/outsourced', { customerName: 'x', staffId: ids.seller, paymentTiming: 'onCompletion', lines: [{ serviceId: plainId, qty: 1, unitPrice: 500, supplierCost: 100 }] });
    assert.equal(plain.status, 400);
    assert.match(plain.body.error, /not an outsourced service/);
    const loss = await job('seller', 100, 150, true);
    assert.equal(loss.status, 400);
    assert.match(loss.body.error, /below what the supplier charges/);
    const none = await call('seller', 'POST', '/orders/outsourced', { staffId: ids.seller, paymentTiming: 'onCompletion', lines: [{ qty: 1, unitPrice: 100, supplierCost: 50 }] });
    assert.equal(none.status, 400);
  });

  it('commission is a share of the gross profit, earned as the customer pays, and the sales do not count towards the pay bands', async () => {
    // two fresh jobs for a clean person: A (claimable, 20% of 10,000 = 2,000) paid in full; B (not claimable, 1,680) half paid → 840; D loses money → nothing
    const a = await job('other', 2320, 1160, true, 10, 23200);
    const b = await job('other', 2320, 1160, false, 10, 11600);
    const d = await job('other', 1160, 1100, false, 10, 11600); // sells at 11,600 incl. (10,000 net) for a cost of 11,000: a loss before commission
    assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(d.status, 201);
    const s = await mine('other');
    assert.equal(s.outsourced.commission, 2840);
    assert.equal(s.total, 2840);
    // the sales person's own statement shows what each job earned them, not its cost, profit or margin
    assert.equal(s.outsourced.detail, false);
    const mineRows = Object.fromEntries(s.outsourced.jobs.map((j: any) => [j.orderNo, j]));
    assert.deepEqual([mineRows[a.body.orderNo].commission, mineRows[a.body.orderNo].moneyIn, mineRows[a.body.orderNo].grossProfit, mineRows[a.body.orderNo].netCost, mineRows[a.body.orderNo].marginPct, mineRows[a.body.orderNo].ratePct], [2000, 23200, null, null, null, null]);
    // a manager who sees costs has the whole of it
    const team = (await call('mgr', 'GET', `/commission/statement?period=${period}`)).body.statements.find((x: any) => x.staffId === ids.other);
    assert.equal(team.outsourced.detail, true);
    const rows = Object.fromEntries(team.outsourced.jobs.map((j: any) => [j.orderNo, j]));
    assert.deepEqual([rows[a.body.orderNo].grossProfit, rows[a.body.orderNo].marginPct, rows[a.body.orderNo].ratePct, rows[a.body.orderNo].commission], [10000, 50, 20, 2000]);
    assert.deepEqual([rows[b.body.orderNo].grossProfit, rows[b.body.orderNo].commission], [8400, 840]);
    assert.equal(rows[d.body.orderNo].commission, 0);
    // the default weight is 0: this revenue does not lift the pay bands or the floor
    assert.equal(s.general.netSales, 0);

    // a supplier bill larger than the quote is a cost too: the profit, the margin and the commission fall
    const bill = await call('mgr', 'POST', `/orders/${a.body.id}/supplier-bills`, { supplierName: 'Print House', amount: 13920, paidNow: 13920, method: 'Bank Transfer' });
    assert.equal(bill.status, 201, JSON.stringify(bill.body));
    const m = (await call('mgr', 'GET', `/orders/${a.body.id}/margin`)).body;
    assert.deepEqual([m.netCost, m.grossProfit, m.marginPct], [12000, 8000, 40]); // 13,920 incl. VAT claimed back = 12,000
    assert.equal((await mine('other')).outsourced.commission, 1600 + 840);
  });

  it('only what the client pays directly to the company counts: an unpaid job earns nothing, and commission follows the money received', async () => {
    const unpaid = await job('seller', 2320, 1160, true, 10); // the client has paid the company nothing (say they pay the supplier directly)
    assert.equal(unpaid.status, 201);
    const row = async () => (await mine('seller')).outsourced.jobs.find((j: any) => j.orderNo === unpaid.body.orderNo);
    const before = (await mine('seller')).outsourced.commission;
    assert.equal(await row(), undefined); // a 10,000 profit, but nothing received by the company → it is not in the statement at all
    let r: any;
    const paid = await call('seller', 'POST', `/orders/${unpaid.body.id}/payments`, { amount: 11600, method: 'M-Pesa', reference: 'ABC123' });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    r = await row();
    assert.deepEqual([r.moneyIn, r.commission], [11600, 1000]); // half paid to the company → half of the 2,000
    assert.equal((await mine('seller')).outsourced.commission, before + 1000);
    // the company paying its supplier is not money from the client, and changes nothing about what was received
    const bill = await call('mgr', 'POST', `/orders/${unpaid.body.id}/supplier-bills`, { supplierName: 'Print House', amount: 1160, paidNow: 1160, method: 'Bank Transfer' });
    assert.equal(bill.status, 201, JSON.stringify(bill.body));
    assert.equal((await row()).moneyIn, 11600);
  });

  it('only an Admin sets the scale, and it is checked', async () => {
    const base = { generalBands: [{ from: 0, rate: 2 }], filmBands: [{ from: 0, rate: 10 }], artworkRatePct: 50, ownershipMonths: 12 };
    assert.equal((await call('mgr', 'PUT', '/commission/settings', { ...base, outsourcedBands: [{ from: 0, rate: 5 }] })).status, 403);
    assert.equal((await call('admin', 'PUT', '/commission/settings', { ...base, outsourcedBands: [{ from: 5, rate: 5 }] })).status, 400); // must start at 0
    const ok = await call('admin', 'PUT', '/commission/settings', { ...base, outsourcedBands: [{ from: 0, rate: 5 }, { from: 40, rate: 12 }], outsourcedBandWeightPct: 25 });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.outsourcedBands, [{ from: 0, rate: 5 }, { from: 40, rate: 12 }]);
    assert.equal(ok.body.outsourcedBandWeightPct, 25);
    const cat = (await call('seller', 'GET', '/orders/outsourced/catalog')).body;
    assert.deepEqual(cat.commission.bands, [{ from: 0, rate: 5 }, { from: 40, rate: 12 }]); // the screen shows the scale in force
    await call('admin', 'PUT', '/commission/settings', { ...base, outsourcedBands: DEFAULT_OUTSOURCED_BANDS, outsourcedBandWeightPct: 0 });
  });
});
