// The two heaviest reads are kept short so the screens open fast: All Orders can ask for the last N days plus everything still open (GET /orders?days=N), and the DTF order screens ask
// only for the open rolls and what is on them (GET /dtf/data?scope=order). Without those words both return everything, as before. (Named z… because it records orders and rolls.)
import { addDays, todayStr } from '@glm/shared';
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
async function call(who: string, path: string) {
  const res = await fetch(`${base}/api${path}`, { headers: { Authorization: `Bearer ${tokens[who]}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const daysAgo = (n: number) => addDays(todayStr(), -n);

describe('short lists', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Lead (windows test)', canAccessDtf: true, canManageDtf: true, canViewAllOrders: true, canCaptureOrders: true } });
    for (const [key, role] of [['lead', 'Lead (windows test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (windows test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    const order = (orderNo: string, createdDate: string, status: string, stage: string, extra: object = {}) =>
      prisma.order.create({ data: { orderNo, kind: 'walkin', staffId: ids.lead!, createdDate, status, stage, ...extra } });
    await order('WIN-RECENT-DONE', daysAgo(10), 'Order', 'Completed'); // recent: in
    await order('WIN-OLD-DONE', daysAgo(400), 'Order', 'Completed'); // old and finished: out
    await order('WIN-OLD-OPEN', daysAgo(400), 'Order', 'In Production'); // old but still open: in
    await order('WIN-OLD-QUOTE', daysAgo(400), 'Quote', 'In Production'); // an old quotation is not an open order: out
    await order('WIN-OLD-CREDIT', daysAgo(400), 'Invoice', 'Completed', { handedOverOnCredit: true }); // handed over on credit, a balance to collect: in
    // DTF: one open roll and one closed, each with a film sale
    for (const [id, status] of [['ROLL-WIN-OPEN', 'open'], ['ROLL-WIN-CLOSED', 'closed']] as const) {
      await prisma.dtfRoll.create({ data: { id, installedOn: '2026-01-01', status, createdByName: 'test', rollLengthM: 100, filmCost: 1000, inkPowderCost: 500 } });
      await prisma.dtfFilmSale.create({ data: { rollId: id, soldOn: '2026-01-02', client: id, metres: 2, pricePerM: 500, stdPriceAtSale: 500, minPriceAtSale: 400, amountPaid: 0 } });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('All Orders: the last N days and everything still open; without days, everything', async () => {
    const all = (await call('lead', '/orders')).body.map((o: any) => o.orderNo);
    for (const n of ['WIN-RECENT-DONE', 'WIN-OLD-DONE', 'WIN-OLD-OPEN', 'WIN-OLD-QUOTE', 'WIN-OLD-CREDIT']) assert.ok(all.includes(n), n);
    const recent = (await call('lead', '/orders?days=120')).body.map((o: any) => o.orderNo);
    assert.ok(recent.includes('WIN-RECENT-DONE'));
    assert.ok(recent.includes('WIN-OLD-OPEN'));
    assert.ok(recent.includes('WIN-OLD-CREDIT'));
    assert.ok(!recent.includes('WIN-OLD-DONE'));
    assert.ok(!recent.includes('WIN-OLD-QUOTE'));
    assert.ok(recent.length < all.length);
    // nonsense is ignored: the whole list
    assert.equal((await call('lead', '/orders?days=abc')).body.length, all.length);
    // the summaries are the same shape as before (totals, heads, who captured)
    const one = (await call('lead', '/orders?days=120')).body.find((o: any) => o.orderNo === 'WIN-RECENT-DONE');
    assert.deepEqual([one.staff.name, one.totals.grandTotal, Array.isArray(one.businessHeads)], ['lead (windows test)', 0, true]);
  });

  it('DTF order screens: only the open rolls and what is on them; the manager screens still get all', async () => {
    const full = (await call('lead', '/dtf/data')).body;
    assert.ok(full.rolls.some((r: any) => r.id === 'ROLL-WIN-CLOSED'));
    assert.ok(full.sales.some((s: any) => s.rollId === 'ROLL-WIN-CLOSED'));
    const slim = (await call('lead', '/dtf/data?scope=order')).body;
    assert.ok(slim.rolls.some((r: any) => r.id === 'ROLL-WIN-OPEN'));
    assert.ok(!slim.rolls.some((r: any) => r.id === 'ROLL-WIN-CLOSED'));
    assert.ok(slim.sales.some((s: any) => s.rollId === 'ROLL-WIN-OPEN'));
    assert.ok(!slim.sales.some((s: any) => s.rollId === 'ROLL-WIN-CLOSED'));
    assert.ok(slim.settings && typeof slim.settings.fixedChargePerMetre === 'number');
  });
});
