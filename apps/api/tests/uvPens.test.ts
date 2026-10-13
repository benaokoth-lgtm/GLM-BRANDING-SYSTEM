// UV pen branding price picker (UV DTF Film Order → UV Pen Costing): the whole order is charged at one rate chosen by the number of pens, with an upsell to a cheaper tier close by.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_PEN_TIERS, penQuote, penRangeLabel, penTiersProblem } from '@glm/shared';
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

describe('UV pen branding price picker', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Printer (pen test)', canAccessDtf: true } });
    await prisma.role.create({ data: { name: 'Lead (pen test)', canAccessDtf: true, canManageDtf: true } });
    await prisma.role.create({ data: { name: 'Nobody (pen test)' } });
    for (const [key, role] of [['printer', 'Printer (pen test)'], ['lead', 'Lead (pen test)'], ['nobody', 'Nobody (pen test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (pen test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it("charges the whole order at the one rate for its quantity: 1–99 at 20, 100–499 at 15, 500–1000 at 12, 1001+ at 10", () => {
    const t = DEFAULT_PEN_TIERS;
    const q = (n: number) => penQuote(t, n);
    assert.deepEqual([q(0).tier, q(0).rate, q(0).total], [null, 0, 0]); // no pens, no tier
    assert.deepEqual([q(1).rate, q(1).total], [20, 20]);
    assert.deepEqual([q(99).rate, q(99).total], [20, 1980]);
    assert.deepEqual([q(100).rate, q(100).total], [15, 1500]); // 100 itself is in the 15 tier
    assert.deepEqual([q(499).rate, q(499).total], [15, 7485]);
    assert.deepEqual([q(500).rate, q(500).total], [12, 6000]); // so is 500 at 12
    assert.deepEqual([q(1000).rate, q(1000).total], [12, 12000]);
    assert.deepEqual([q(1001).rate, q(1001).total], [10, 10010]);
    assert.deepEqual([q(1500).rate, q(1500).total], [10, 15000]);
    assert.deepEqual([0, 1, 2, 3].map((i) => penRangeLabel(t, i)), ['1–99', '100–499', '500–1000', '1001+']);
    // not a number of pens: nothing
    assert.equal(q(-5).qty, 0);
    assert.equal(q(Number.NaN).total, 0);
  });

  it('points out a cheaper tier close by: add so many pens and the customer pays less overall', () => {
    const t = DEFAULT_PEN_TIERS;
    assert.equal(penQuote(t, 0).upsell, null);
    // 90 pens at 20 = 1,800; 100 pens at 15 = 1,500
    assert.deepEqual(penQuote(t, 90).upsell, { qty: 100, add: 10, rate: 15, newTotal: 1500, saving: 300 });
    // 450 at 15 = 6,750; 500 at 12 = 6,000
    assert.deepEqual(penQuote(t, 450).upsell, { qty: 500, add: 50, rate: 12, newTotal: 6000, saving: 750 });
    // 400 at 15 = 6,000 and 500 at 12 = 6,000: the same total for more pens
    assert.equal(penQuote(t, 400).upsell?.saving, 0);
    // 30 at 20 = 600; 100 at 15 = 1,500: the total goes up (the callout says what it becomes)
    assert.deepEqual(penQuote(t, 30).upsell, { qty: 100, add: 70, rate: 15, newTotal: 1500, saving: -900 });
    // already at the cheapest tier
    assert.equal(penQuote(t, 1001).upsell, null);
    assert.equal(penQuote(t, 5000).upsell, null);
    // a tier that is not cheaper is not an upsell
    assert.equal(penQuote([{ from: 1, rate: 10 }, { from: 100, rate: 12 }], 50).upsell, null);
  });

  it('the tiers must start at 1 pen and climb', () => {
    assert.equal(penTiersProblem(DEFAULT_PEN_TIERS), null);
    assert.match(penTiersProblem([]) ?? '', /at least one/);
    assert.match(penTiersProblem([{ from: 2, rate: 20 }]) ?? '', /start at 1/);
    assert.match(penTiersProblem([{ from: 1, rate: 20 }, { from: 1, rate: 15 }]) ?? '', /Two tiers/);
    assert.match(penTiersProblem([{ from: 1, rate: -1 }]) ?? '', /negative/);
    assert.match(penTiersProblem([{ from: 1.5, rate: 5 }]) ?? '', /whole number/);
  });

  it('the rates are kept in the system: anyone with DTF access reads them, a DTF manager changes them', async () => {
    const r = await call('printer', 'GET', '/dtf/pen-tiers');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tiers, DEFAULT_PEN_TIERS);
    assert.equal(r.body.canManage, false);
    assert.equal((await call('lead', 'GET', '/dtf/pen-tiers')).body.canManage, true);
    assert.equal((await call('nobody', 'GET', '/dtf/pen-tiers')).status, 403);

    const change = { tiers: [{ from: 1, rate: 20 }, { from: 100, rate: 14 }, { from: 500, rate: 12 }, { from: 1000, rate: 9 }] };
    assert.equal((await call('printer', 'PUT', '/dtf/pen-tiers', change)).status, 403);
    assert.equal((await call('lead', 'PUT', '/dtf/pen-tiers', { tiers: [{ from: 2, rate: 20 }] })).status, 400); // must start at 1
    assert.equal((await call('lead', 'PUT', '/dtf/pen-tiers', { tiers: [{ from: 1, rate: 20 }, { from: 1, rate: 15 }] })).status, 400);
    assert.equal((await call('lead', 'PUT', '/dtf/pen-tiers', { tiers: [{ from: 1, rate: -2 }] })).status, 400);
    const saved = await call('lead', 'PUT', '/dtf/pen-tiers', change);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual((await call('printer', 'GET', '/dtf/pen-tiers')).body.tiers, change.tiers); // kept, for everyone
    assert.deepEqual([penQuote(saved.body.tiers, 100).rate, penQuote(saved.body.tiers, 1000).rate], [14, 9]);
    // back to the owner's rates
    assert.equal((await call('lead', 'PUT', '/dtf/pen-tiers', { tiers: DEFAULT_PEN_TIERS })).status, 200);
    assert.deepEqual((await call('printer', 'GET', '/dtf/pen-tiers')).body.tiers, DEFAULT_PEN_TIERS);
  });
});
