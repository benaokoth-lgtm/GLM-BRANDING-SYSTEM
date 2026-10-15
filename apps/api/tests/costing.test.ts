// Job costing: business cards, indoor and outdoor signage costed from supplier rates kept in Master Data (materials and services), a markup on cost, and VAT on top.
// The sample rates are those of the costing design, so its worked figures are the expected ones here. What we pay and our margin are shown only to people who may see costs.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { COSTING_DEFAULT_JOB_TYPES, COSTING_DEFAULT_RATES } from '@glm/shared';
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
const quote = (who: string, input: Record<string, unknown>) => call(who, 'POST', '/costing/quote', input);
const rateNamed = async (name: string) => (await call('admin', 'GET', '/costing/rates')).body.rates.find((r: any) => r.name === name);

describe('job costing', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Seller (costing test)', canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Finance (costing test)', canCaptureOrders: true, canAccessFinance: true, canSeeCosts: true } });
    await prisma.role.create({ data: { name: 'Nobody (costing test)' } });
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true }, create: { id: 1, enabled: true } });
    for (const [key, role] of [['seller', 'Seller (costing test)'], ['other', 'Seller (costing test)'], ['finance', 'Finance (costing test)'], ['nobody', 'Nobody (costing test)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (costing test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('starts from the sample rates of the costing design, in two lists: materials and services', async () => {
    const r = (await call('admin', 'GET', '/costing/rates')).body;
    assert.deepEqual(r.jobTypes.map((t: any) => [t.key, t.marginPct, t.wastagePct]), [['cards', 40, 0], ['indoor', 45, 10], ['outdoor', 45, 10]]);
    assert.equal(r.rates.length, COSTING_DEFAULT_RATES.length);
    assert.ok(r.rates.some((x: any) => x.kind === 'material') && r.rates.some((x: any) => x.kind === 'service'));
    assert.deepEqual(COSTING_DEFAULT_JOB_TYPES.map((t) => t.cardsPerSheet), [21, 21, 21]);
  });

  it("works out the design's figures: cards, indoor and outdoor signage, with a markup on cost and VAT on the price", async () => {
    // 500 cards, 21 to an A3 sheet + 1 spare = 25 sheets: printing 3,000 + cutting 1,000 + setup 500 = 4,500; +40% = 6,300; VAT 1,008
    const plain = (await quote('finance', { jobType: 'cards', qty: 500, finish: 'plain' })).body;
    assert.deepEqual([plain.sheets, plain.cost, plain.price, plain.vat, plain.total, plain.unitPrice], [25, 4500, 6300, 1008, 7308, 12.6]);
    assert.deepEqual(plain.lines.map((l: any) => [l.name, l.amount]), [['Printing on A3 art paper', 3000], ['Cutting', 1000], ['Design & setup', 500]]);
    const lam = (await quote('finance', { jobType: 'cards', qty: 500, finish: 'lam' })).body;
    assert.deepEqual([lam.cost, lam.price], [6000, 8400]); // + lamination 25 × 60
    const frost = (await quote('finance', { jobType: 'cards', qty: 500, finish: 'frost' })).body;
    assert.deepEqual([frost.cost, frost.price], [6750, 9450]); // + frosting 25 × 90
    // price by quantity
    assert.deepEqual(plain.tiers.map((t: any) => t.qty), [100, 250, 500, 1000, 2000]);
    assert.deepEqual([plain.tiers[0].sheets, plain.tiers[0].cost, plain.tiers[0].price], [6, 1460, 2044]);

    // indoor 1 × 2 m, wastage 10%: material 2.2 sqm × 800 + printing 2 × 700 + laminate 2 × 250 + mounting 2 × 600 + finishing 200 + installation 1,000 + setup 500
    const indoor = (await quote('finance', { jobType: 'indoor', qty: 1, widthM: 1, heightM: 2 })).body;
    assert.deepEqual([indoor.cost, indoor.price, indoor.marginPct], [6560, 9512, 45]);
    // outdoor 3 × 1 m
    const outdoor = (await quote('finance', { jobType: 'outdoor', qty: 1, widthM: 3, heightM: 1 })).body;
    assert.deepEqual([outdoor.cost, outdoor.price], [17970, 26056.5]);
    assert.equal(outdoor.lines.find((l: any) => l.name === 'Transport & permits').amount, 2000);
    assert.equal(outdoor.profit, 8086.5);
  });

  it('a salesperson sees the cost lines and the price to quote, but not our margin or profit', async () => {
    const q = (await quote('seller', { jobType: 'cards', qty: 500, finish: 'plain' })).body;
    assert.deepEqual([q.price, q.vat, q.total, q.canSeeCosts], [6300, 1008, 7308, false]);
    // the cost lines and the cost are theirs to see
    assert.deepEqual(q.lines.map((l: any) => [l.name, l.amount]), [['Printing on A3 art paper', 3000], ['Cutting', 1000], ['Design & setup', 500]]);
    assert.equal(q.cost, 4500);
    // what we make is not
    for (const hidden of ['marginPct', 'profit', 'profitOnPricePct']) assert.equal(q[hidden], undefined, hidden);
    assert.deepEqual([q.tiers[2].price, q.tiers[2].cost], [6300, 4500]);
    // a margin typed in by someone who may not see costs changes nothing
    assert.equal((await quote('seller', { jobType: 'cards', qty: 500, marginPct: 500 })).body.price, 6300);
    // the screen is told each rate and what it costs, but not the margin
    const cfg = (await call('seller', 'GET', '/costing/config')).body;
    assert.equal(cfg.canSeeCosts, false);
    assert.ok(cfg.rates.length > 0 && cfg.rates.every((r: any) => typeof r.cost === 'number'));
    assert.ok(cfg.jobTypes.every((t: any) => t.marginPct === undefined));
    const full = (await call('finance', 'GET', '/costing/config')).body;
    assert.ok(full.rates.every((r: any) => typeof r.cost === 'number') && full.jobTypes.every((t: any) => typeof t.marginPct === 'number'));
    // someone who sees costs may use another margin
    assert.equal((await quote('finance', { jobType: 'cards', qty: 500, marginPct: 100 })).body.price, 9000);
    // and the costing is for people who take orders or handle finance
    assert.equal((await quote('nobody', { jobType: 'cards', qty: 500 })).status, 403);
    assert.equal((await call('nobody', 'GET', '/costing/config')).status, 403);
  });

  it('lines can be switched off, optional extras switched on, and an unused finish adds nothing', async () => {
    const laminate = await rateNamed('Laminate (indoor)');
    const noLam = (await quote('finance', { jobType: 'indoor', qty: 1, widthM: 1, heightM: 2, off: [laminate.id] })).body;
    assert.equal(noLam.cost, 6060); // the laminate's 2 × 250 comes off
    const delivery = await rateNamed('Delivery');
    assert.equal(delivery.defaultOn, false);
    assert.equal((await rateNamed('Delivery')).cost, 0);
    assert.equal((await call('admin', 'PUT', `/costing/rates/${delivery.id}`, { kind: 'service', name: 'Delivery', basis: 'job', cost: 300, jobTypes: ['cards'], onlyFor: '', defaultOn: false })).status, 200);
    assert.equal((await quote('finance', { jobType: 'cards', qty: 500 })).body.cost, 4500); // optional: not in unless ticked
    assert.equal((await quote('finance', { jobType: 'cards', qty: 500, on: [delivery.id] })).body.cost, 4800);
    // laminating film is charged only on a laminated card
    assert.ok(!(await quote('finance', { jobType: 'cards', qty: 500, finish: 'plain' })).body.lines.some((l: any) => l.name === 'Lamination film'));
  });

  it('an Admin adds, changes and retires materials and services, and the costing follows', async () => {
    assert.equal((await call('seller', 'POST', '/costing/rates', { kind: 'service', name: 'Eyelets', basis: 'unit', cost: 50, jobTypes: ['outdoor'] })).status, 403);
    assert.equal((await call('seller', 'GET', '/costing/rates')).status, 403);
    const added = await call('admin', 'POST', '/costing/rates', { kind: 'service', name: 'Eyelets', basis: 'unit', cost: 50, jobTypes: ['outdoor'], defaultOn: true });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const id = added.body.id;
    const before = (await quote('finance', { jobType: 'outdoor', qty: 2, widthM: 3, heightM: 1 })).body;
    assert.ok(before.lines.some((l: any) => l.rateId === id && l.amount === 100)); // 2 signs × 50
    // a dearer supplier rate changes the cost
    assert.equal((await call('admin', 'PUT', `/costing/rates/${id}`, { kind: 'service', name: 'Eyelets', basis: 'unit', cost: 80, jobTypes: ['outdoor'], defaultOn: true })).status, 200);
    assert.equal((await quote('finance', { jobType: 'outdoor', qty: 2, widthM: 3, heightM: 1 })).body.cost, before.cost + 60);
    // retired: out of the costing and out of what the salesperson ticks
    assert.equal((await call('admin', 'PUT', `/costing/rates/${id}`, { kind: 'service', name: 'Eyelets', basis: 'unit', cost: 80, jobTypes: ['outdoor'], active: false })).status, 200);
    assert.equal((await quote('finance', { jobType: 'outdoor', qty: 2, widthM: 3, heightM: 1 })).body.cost, before.cost - 100); // without the eyelets' 2 × 50
    assert.ok(!(await call('seller', 'GET', '/costing/config')).body.rates.some((r: any) => r.id === id));
    assert.equal((await call('admin', 'DELETE', `/costing/rates/${id}`)).status, 204);
    assert.ok(!(await call('admin', 'GET', '/costing/rates')).body.rates.some((r: any) => r.id === id));
  });

  it('a rate must be charged in a way every kind of job it is used on allows', async () => {
    const add = (body: Record<string, unknown>) => call('admin', 'POST', '/costing/rates', { kind: 'material', name: 'Test rate', cost: 10, jobTypes: ['indoor'], ...body });
    assert.equal((await add({ basis: 'sheet' })).status, 400); // an A3 sheet is for business cards
    assert.equal((await add({ jobTypes: ['cards'], basis: 'sqm' })).status, 400);
    assert.equal((await add({ jobTypes: ['cards', 'indoor'], basis: 'sqm' })).status, 400);
    const both = await add({ jobTypes: ['cards', 'indoor'], basis: 'unit' });
    assert.equal(both.status, 201); // per unit suits both
    assert.equal((await call('admin', 'DELETE', `/costing/rates/${both.body.id}`)).status, 204);
    assert.equal((await add({ jobTypes: ['indoor'], basis: 'unit', onlyFor: 'lam' })).status, 400); // laminated-only is for business cards
    assert.equal((await add({ jobTypes: [], basis: 'unit' })).status, 400);
    assert.equal((await add({ basis: 'unit', cost: -1 })).status, 400);
    assert.equal((await add({ basis: 'unit', name: 'x' })).status, 400);
  });

  it("the margin, wastage and the cards to a sheet are each job's settings, kept by an Admin", async () => {
    assert.equal((await call('seller', 'PUT', '/costing/job-types/cards', { marginPct: 10, floorMarginPct: 5, wastagePct: 0, cardsPerSheet: 21, spareSheets: 1 })).status, 403);
    assert.equal((await call('admin', 'PUT', '/costing/job-types/nope', { marginPct: 10, floorMarginPct: 5, wastagePct: 0, cardsPerSheet: 21, spareSheets: 1 })).status, 404);
    assert.equal((await call('admin', 'PUT', '/costing/job-types/cards', { marginPct: 40, floorMarginPct: 30, wastagePct: 0, cardsPerSheet: 0, spareSheets: 1 })).status, 400);
    // 24 to a sheet and no spare: 500 cards = 21 sheets (not 25): printing 2,520 + cutting 840 + setup 500 = 3,860, +50% = 5,790
    assert.equal((await call('admin', 'PUT', '/costing/job-types/cards', { marginPct: 50, floorMarginPct: 30, wastagePct: 0, cardsPerSheet: 24, spareSheets: 0 })).status, 200);
    const q = (await quote('finance', { jobType: 'cards', qty: 500 })).body;
    assert.deepEqual([q.sheets, q.cost, q.price], [21, 3860, 5790]);
    await call('admin', 'PUT', '/costing/job-types/cards', { marginPct: 40, floorMarginPct: 30, wastagePct: 0, cardsPerSheet: 21, spareSheets: 1 });
  });
  // ── a quote that is accepted
  const save = (who: string, extra: Record<string, unknown> = {}) => call(who, 'POST', '/costing/quotes', { jobType: 'cards', qty: 500, finish: 'plain', clientName: 'Hope Chapel', phone: '0722123456', ...extra });
  const cardsFloor = 4500 * 1.3; // the cost plus the floor margin of 30%, before VAT

  it('a costing is saved as a quote with the cost lines frozen; the floor is shown as a price, the margin only to people who see costs', async () => {
    assert.equal((await save('seller', { clientName: '' })).status, 400);
    const rates = (await call('admin', 'GET', '/costing/rates')).body.rates;
    assert.equal((await save('seller', { off: rates.map((r: any) => r.id) })).status, 400); // nothing to cost
    const q = await save('seller');
    assert.equal(q.status, 201, JSON.stringify(q.body));
    assert.match(q.body.quoteNo, /^CQ-\d{4}$/);
    assert.deepEqual([q.body.status, q.body.cost, q.body.price, q.body.vat, q.body.total], ['Draft', 4500, 6300, 1008, 7308]);
    assert.equal(q.body.lines.length, 3);
    assert.deepEqual([q.body.lowestPrice, q.body.lowestTotal], [cardsFloor, Math.round(cardsFloor * 1.16 * 100) / 100]);
    for (const hidden of ['marginPct', 'floorMarginPct', 'profit']) assert.equal(q.body[hidden], undefined, hidden);
    assert.equal((await call('finance', 'GET', `/costing/quotes/${q.body.id}`)).body.marginPct, 40);
    // a later change to a supplier rate leaves the saved quote as it was
    const printing = rates.find((r: any) => r.name === 'Printing on A3 art paper');
    await call('admin', 'PUT', `/costing/rates/${printing.id}`, { kind: 'service', name: printing.name, basis: 'sheet', cost: 150, jobTypes: ['cards'], onlyFor: '', defaultOn: true });
    assert.equal((await call('seller', 'GET', `/costing/quotes/${q.body.id}`)).body.cost, 4500);
    assert.equal((await save('seller')).body.cost, 5250); // a new one uses the new rate
    await call('admin', 'PUT', `/costing/rates/${printing.id}`, { kind: 'service', name: printing.name, basis: 'sheet', cost: 120, jobTypes: ['cards'], onlyFor: '', defaultOn: true });
  });

  it('a price agreed at or above the floor goes straight through; a lower one needs a manager; below cost is refused', async () => {
    const q = (await save('seller')).body;
    const agree = (who: string, total: number) => call(who, 'POST', `/costing/quotes/${q.id}/agree`, { total });
    // 7,000 with VAT = 6,034.48 before VAT: a 34% margin, above the 30% floor
    const ok = await agree('seller', 7000);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.agreed.total, ok.body.agreed.price, ok.body.agreed.needsApproval, ok.body.approval, ok.body.status], [7000, 6034.48, false, '', 'Sent']);
    assert.equal(ok.body.agreed.marginPct, undefined); // the salesperson is not told the margin
    assert.equal((await call('finance', 'GET', `/costing/quotes/${q.id}`)).body.agreed.marginPct, 34.1);
    // below the floor (5,850 before VAT): 6,000 with VAT = 5,172.41 → waits for approval
    const low = await agree('seller', 6000);
    assert.deepEqual([low.body.agreed.needsApproval, low.body.approval], [true, 'Pending']);
    assert.equal((await call('seller', 'POST', `/costing/quotes/${q.id}/capture`, { paymentTiming: 'onCompletion' })).status, 400); // not until it is decided
    // under what the job costs us (4,500 + VAT = 5,220) is never allowed
    const below = await agree('seller', 5000);
    assert.equal(below.status, 400);
    assert.match(below.body.error, /below what the job costs/);
    assert.equal((await agree('seller', 6000)).body.approval, 'Pending');
    // the salesperson cannot decide it, and neither can the person who quoted it; Finance can
    assert.equal((await call('seller', 'POST', `/costing/quotes/${q.id}/approve`)).status, 403);
    const own = (await save('finance')).body;
    await call('finance', 'POST', `/costing/quotes/${own.id}/agree`, { total: 6000 });
    const self = await call('finance', 'POST', `/costing/quotes/${own.id}/approve`);
    assert.equal(self.status, 400);
    assert.match(self.body.error, /quoted yourself/);
    assert.equal((await call('finance', 'POST', `/costing/quotes/${q.id}/reject`, {})).status, 400); // a reason is needed
    const done = await call('finance', 'POST', `/costing/quotes/${q.id}/approve`);
    assert.deepEqual([done.status, done.body.approval, done.body.approvedByName], [200, 'Approved', 'finance (costing test)']);
    // a new agreed price starts again
    assert.equal((await agree('seller', 7308)).body.approval, '');
  });

  it('the accepted quote is captured as an order at the agreed price, credited to the salesperson, with the cost on its line', async () => {
    const q = (await save('seller')).body;
    assert.equal((await call('seller', 'POST', `/costing/quotes/${q.id}/capture`, { paymentTiming: 'onCompletion' })).status, 400); // no agreed price yet
    assert.equal((await call('seller', 'POST', `/costing/quotes/${q.id}/agree`, { total: 7000 })).status, 200);
    const cap = await call('seller', 'POST', `/costing/quotes/${q.id}/capture`, { paymentTiming: 'onAcceptance', payments: [{ method: 'Cash', amount: 7000 }], sourcedBy: ids.seller });
    assert.equal(cap.status, 201, JSON.stringify(cap.body));
    assert.match(cap.body.orderNo, /^W-\d+$/);
    assert.deepEqual([cap.body.totals.grandTotal, cap.body.totals.balanceDue, cap.body.customerName], [7000, 0, 'Hope Chapel']);
    assert.equal(cap.body.lineItems[0].serviceName, 'Costed job — Business cards — 500cards-plain'); // the job's summary rides on the line
    // the quote is now that order, and cannot be captured twice
    const after = (await call('seller', 'GET', `/costing/quotes/${q.id}`)).body;
    assert.deepEqual([after.status, after.orderNo, after.orderId], ['Ordered', cap.body.orderNo, cap.body.id]);
    assert.equal((await call('seller', 'POST', `/costing/quotes/${q.id}/capture`, { paymentTiming: 'onCompletion' })).status, 400);
    assert.equal((await call('seller', 'POST', `/costing/quotes/${q.id}/agree`, { total: 8000 })).status, 400);
    // what the job costs us (VAT included, as the supplier bills it) is on the line for Finance, not for the salesperson
    const detail = (await call('finance', 'GET', `/orders/${cap.body.id}`)).body;
    assert.equal(detail.lineItems[0].supplierCost, 5220);
    assert.equal((await call('seller', 'GET', `/orders/${cap.body.id}`)).body.lineItems[0].supplierCost, undefined);
    // the salesperson's commission is the usual rule: the money received, net of VAT, on a client they brought
    const mine = (await call('seller', 'GET', `/commission/my?period=${new Date().toISOString().slice(0, 7)}`)).body.statement;
    assert.ok(Math.abs(mine.general.netSales - 6034.48) < 0.02, String(mine.general.netSales)); // 7,000 ÷ 1.16
  });

  it('a quote belongs to the salesperson who made it; managers see them all; a lost quote needs a reason', async () => {
    const q = (await save('seller', { clientName: 'Lost Client' })).body;
    assert.equal((await call('other', 'GET', `/costing/quotes/${q.id}`)).status, 403);
    assert.ok(!(await call('other', 'GET', '/costing/quotes')).body.quotes.some((x: any) => x.id === q.id));
    assert.ok((await call('seller', 'GET', '/costing/quotes')).body.quotes.some((x: any) => x.id === q.id));
    assert.ok((await call('finance', 'GET', '/costing/quotes')).body.quotes.some((x: any) => x.id === q.id));
    assert.equal((await call('seller', 'POST', `/costing/quotes/${q.id}/status`, { status: 'Lost' })).status, 400);
    const lost = await call('seller', 'POST', `/costing/quotes/${q.id}/status`, { status: 'Lost', reason: 'Went to another printer' });
    assert.deepEqual([lost.status, lost.body.status, lost.body.lostReason], [200, 'Lost', 'Went to another printer']);
    assert.equal((await call('seller', 'POST', `/costing/quotes/${q.id}/agree`, { total: 7000 })).status, 400);
    assert.equal((await call('nobody', 'GET', '/costing/quotes')).status, 403);
  });

  it("each job's floor is an Admin's to set and is kept on a quote when it is made", async () => {
    assert.equal((await call('admin', 'PUT', '/costing/job-types/cards', { marginPct: 40, floorMarginPct: 45, wastagePct: 0, cardsPerSheet: 21, spareSheets: 1 })).status, 400); // above the usual margin
    assert.equal((await call('admin', 'PUT', '/costing/job-types/cards', { marginPct: 40, floorMarginPct: 35, wastagePct: 0, cardsPerSheet: 21, spareSheets: 1 })).status, 200);
    const q = (await save('seller')).body;
    assert.equal(q.lowestPrice, 6075); // 4,500 + 35%
    await call('admin', 'PUT', '/costing/job-types/cards', { marginPct: 40, floorMarginPct: 30, wastagePct: 0, cardsPerSheet: 21, spareSheets: 1 });
    assert.equal((await call('seller', 'GET', `/costing/quotes/${q.id}`)).body.lowestPrice, 6075); // the quote keeps the floor it was made under
  });
});
