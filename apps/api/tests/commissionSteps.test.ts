// General sales paid by pay bands: a fixed payout for the band the month's sales reached (a step, not a slice). Staying in a band keeps its payout;
// crossing into the next band moves the payout up. A month below the performance floor (120,000) is flagged for performance improvement.
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
let banner = 0;
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

describe('commission paid by pay bands', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Steps Counter', canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Steps Boss', canCaptureOrders: true, canAccessFinance: true, canAccessAccounting: true, canManageCommission: true } });
    for (const [key, role] of [['zed', 'Steps Counter'], ['edge', 'Steps Counter'], ['low', 'Steps Counter'], ['boss', 'Steps Boss']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (steps test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true, generalMode: 'steps' }, create: { id: 1, enabled: true, generalMode: 'steps' } });
    banner = (await prisma.service.create({ data: { name: 'Banner (steps test)', unit: 'piece', price: 1000 } })).id;
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  // A sourced sale paid in full at capture: `net` is what the company keeps; the customer pays 16% VAT on top.
  let n = 0;
  const sale = (who: string, net: number) =>
    call(who, 'POST', '/orders/walkin', {
      customerName: `Steps Client ${++n}`,
      phone: `073${String(1000000 + n * 137)}`,
      staffId: ids[who],
      sourcedBy: ids[who],
      paymentTiming: 'onAcceptance',
      lineItems: [{ itemType: 'service', serviceId: banner, qty: 1, unitPrice: Math.round(net * 1.16) }],
      payments: [{ method: 'Cash', amount: Math.round(net * 1.16) }],
    });

  it('starts with the agreed bands, the 120,000 performance floor and fixed payouts as the way general sales are paid', async () => {
    const cfg = (await call('boss', 'GET', '/commission/settings')).body;
    assert.equal(cfg.generalMode, 'steps');
    assert.equal(cfg.performanceFloor, 120000);
    assert.deepEqual(cfg.payBands.map((b: any) => [b.from, b.payout]), [[0, 0], [30000, 12000], [60000, 18000], [90000, 24000], [120000, 30000], [150000, 36000], [180000, 42000], [210000, 48000]]);
  });

  it('below the first band nothing is paid, and the person is flagged for performance improvement', async () => {
    assert.equal((await sale('low', 25000)).status, 201);
    const s = await mine('low');
    assert.equal(s.general.commission, 0);
    assert.equal(s.total, 0);
    assert.deepEqual([s.scheme.mode, s.scheme.sales, s.scheme.floor, s.scheme.belowFloor], ['steps', 25000, 120000, true]);
    assert.deepEqual([s.scheme.step.index, s.scheme.step.nextFrom, s.scheme.step.nextPayout, s.scheme.step.toNext], [0, 30000, 12000, 5000]);
    assert.equal(s.target.remaining, 95000); // to the performance floor
  });

  it('a band keeps its payout until the next band is reached, then the payout moves up to the new band', async () => {
    assert.equal((await sale('zed', 35000)).status, 201); // band 1
    assert.equal((await mine('zed')).general.commission, 12000);
    assert.equal((await sale('zed', 24000)).status, 201); // 59,000: still band 1 — the earlier payout continues
    let s = await mine('zed');
    assert.equal(s.general.commission, 12000);
    assert.equal(s.scheme.step.toNext, 1000);
    assert.equal((await sale('zed', 2000)).status, 201); // 61,000: band 2
    s = await mine('zed');
    assert.equal(s.general.commission, 18000);
    assert.equal(s.scheme.belowFloor, true);
    assert.equal((await sale('zed', 59000)).status, 201); // 120,000: band 4, the anchor, and out of the warning
    s = await mine('zed');
    assert.deepEqual([s.general.commission, s.scheme.step.index, s.scheme.belowFloor], [30000, 4, false]);
    assert.equal(s.total, 30000);
  });

  it('a band starts exactly at its figure', async () => {
    assert.equal((await sale('edge', 60000)).status, 201);
    const s = await mine('edge');
    assert.deepEqual([s.general.commission, s.scheme.step.index], [18000, 2]);
  });

  it('the team statement and the month-by-month report carry the payout and the flag', async () => {
    const team = (await call('boss', 'GET', `/commission/statement?period=${period}`)).body;
    const low = team.statements.find((x: any) => x.staffId === ids.low);
    assert.equal(low.scheme.belowFloor, true);
    assert.equal(team.statements.find((x: any) => x.staffId === ids.zed).total, 30000);
    const monthly = (await call('boss', 'GET', `/commission/monthly?year=${period.slice(0, 4)}`)).body;
    const row = monthly.months.find((m: any) => m.period === period).rows;
    assert.equal(row.find((r: any) => r.staffId === ids.low).belowFloor, true);
    assert.equal(row.find((r: any) => r.staffId === ids.low).band, 0);
    assert.deepEqual([row.find((r: any) => r.staffId === ids.zed).belowFloor, row.find((r: any) => r.staffId === ids.zed).commission], [false, 30000]);
  });

  it('only a manager changes the bands; they are checked, and can be switched back to percentages', async () => {
    assert.equal((await call('zed', 'PUT', '/commission/settings', {})).status, 403);
    const base = { generalBands: [{ from: 0, rate: 2 }], filmBands: [{ from: 0, rate: 10 }], artworkRatePct: 50, ownershipMonths: 12 };
    assert.equal((await call('boss', 'PUT', '/commission/settings', { ...base, payBands: [{ from: 10, payout: 5 }] })).status, 400); // must start at 0
    assert.equal((await call('boss', 'PUT', '/commission/settings', { ...base, payBands: [{ from: 0, payout: 0 }, { from: 5000, payout: -1 }] })).status, 400);
    const saved = await call('boss', 'PUT', '/commission/settings', { ...base, payBands: [{ from: 50000, payout: 9000 }, { from: 0, payout: 0 }], performanceFloor: 80000 });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.payBands, [{ from: 0, payout: 0 }, { from: 50000, payout: 9000 }]);
    assert.equal(saved.body.performanceFloor, 80000);
    assert.equal((await mine('zed')).general.commission, 9000); // the new bands apply straight away
    const back = await call('boss', 'PUT', '/commission/settings', { ...base, generalMode: 'percent', payBands: [...saved.body.payBands], performanceFloor: 120000 });
    assert.equal(back.body.generalMode, 'percent');
    assert.equal((await mine('zed')).scheme.mode, 'percent');
    // leave the shared settings as this file found them
    await call('boss', 'PUT', '/commission/settings', { ...base, generalMode: 'steps', payBands: [{ from: 0, payout: 0 }, { from: 30000, payout: 12000 }, { from: 60000, payout: 18000 }, { from: 90000, payout: 24000 }, { from: 120000, payout: 30000 }, { from: 150000, payout: 36000 }, { from: 180000, payout: 42000 }, { from: 210000, payout: 48000 }] });
  });
});
