// People paid on the sales pay bands: approving a closed month puts their pay into payroll automatically — what they earned, or the minimum wage if that is more —
// instead of paying a commission expense, and never twice.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { computePay } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
let banner = 0;
let topUpId = 0;
const PERIOD = '2024-05';
const DAY = '2024-05-31';
const MIN = 16113.75;

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const approve = async () => (await call('boss', 'POST', '/commission/payouts/approve', { period: PERIOD })).body.payouts as { staffId: number; amount: number; status: string; topUp?: number; inPayroll?: boolean }[];
const entries = (staffId: number) => prisma.payrollEntry.findMany({ where: { staffId, salesPeriod: PERIOD } });

describe('pay-band staff go into payroll automatically', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'PayBand Counter', canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'PayBand Boss', canCaptureOrders: true, canAccessFinance: true, canAccessAccounting: true, canManageCommission: true } });
    const old = new Date('2024-01-01T00:00:00Z');
    for (const [key, role, flag] of [['idle', 'PayBand Counter', true], ['low', 'PayBand Counter', true], ['high', 'PayBand Counter', true], ['plain', 'PayBand Counter', false], ['boss', 'PayBand Boss', false]] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (payband test)`, role, pinHash: 'x', paidOnBands: flag, createdAt: old } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true, generalMode: 'steps', minimumWage: MIN }, create: { id: 1, enabled: true, generalMode: 'steps', minimumWage: MIN } });
    banner = (await prisma.service.create({ data: { name: 'Banner (payband test)', unit: 'piece', price: 1000 } })).id;
    // May 2024 (a closed month): low sells 35,000 net (band 1 = 12,000, under the minimum wage); high and plain sell 60,000 net (band 2 = 18,000)
    let n = 0;
    for (const [who, net] of [['low', 35000], ['high', 60000], ['plain', 60000]] as const) {
      const gross = Math.round(net * 1.16);
      await prisma.order.create({
        data: {
          orderNo: `PB-${who}-${++n}`,
          kind: 'walkin',
          staffId: ids[who]!,
          sourcedByStaffId: ids[who]!,
          createdDate: '2024-05-10',
          status: 'Order',
          stage: 'Order Received',
          lineItems: { create: [{ itemType: 'service', serviceId: banner, qty: 1, unitPrice: gross }] },
          payments: { create: [{ date: '2024-05-12', amount: gross, method: 'Cash' }] },
        },
      });
    }
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    // leave nothing behind that other test files' petty cash and payroll figures could trip over
    await prisma.payrollEntry.deleteMany({ where: { salesPeriod: PERIOD } });
    if (topUpId) await prisma.pettyCashTopUp.delete({ where: { id: topUpId } }).catch(() => null);
    await prisma.order.deleteMany({ where: { orderNo: { startsWith: 'PB-' } } });
    server.close();
    await prisma.$disconnect();
  });

  it('the statement shows each person on the bands with their pay: what they earned, or the minimum wage', async () => {
    const st = (await call('boss', 'GET', `/commission/statement?period=${PERIOD}`)).body.statements as any[];
    const by = (k: string) => st.find((x) => x.staffId === ids[k])!;
    assert.deepEqual([by('idle').pay.amount, by('idle').pay.topUp, by('idle').pay.onBands], [MIN, MIN, true]); // no sales at all: still listed, paid the minimum
    assert.deepEqual([by('low').total, by('low').pay.amount, by('low').pay.topUp], [12000, MIN, 4113.75]);
    assert.deepEqual([by('high').total, by('high').pay.amount, by('high').pay.topUp], [18000, 18000, 0]);
    assert.deepEqual([by('plain').total, by('plain').pay.onBands, by('plain').pay.amount], [18000, false, 18000]);
    assert.equal(by('idle').scheme.belowFloor, true);
  });

  it('a month that is not over cannot be put into payroll', async () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const r = (await call('boss', 'POST', '/commission/payouts/approve', { period: thisMonth })).body.payouts as any[];
    for (const p of r.filter((x) => x.inPayroll)) assert.equal(p.status, 'Waiting');
    assert.equal(await prisma.payrollEntry.count({ where: { salesPeriod: thisMonth } }), 0);
  });

  it('wages come out of petty cash, so with the float short nobody goes into payroll', async () => {
    const out = await approve();
    const mine = out.filter((p) => [ids.idle, ids.low, ids.high].includes(p.staffId));
    assert.equal(mine.length, 3);
    for (const p of mine) assert.equal(p.status, 'Petty cash short');
    assert.equal((await entries(ids.high!)).length, 0);
  });

  it('approving the month puts pay into payroll — earned pay, or the minimum wage — and pays the payout through payroll, with no commission expense', async () => {
    topUpId = (await prisma.pettyCashTopUp.create({ data: { date: '2024-05-01', source: 'Bank Withdrawal', amount: 500000, authorizedByName: 'test' } })).id;
    const out = await approve();
    const by = (k: string) => out.find((p) => p.staffId === ids[k])!;
    for (const k of ['idle', 'low', 'high']) assert.deepEqual([by(k).status, by(k).inPayroll], ['Paid', true], k);
    assert.deepEqual([by('idle').amount, by('low').amount, by('high').amount], [MIN, MIN, 18000]);
    assert.equal(by('low').topUp, 4113.75);

    const low = (await entries(ids.low!))[0]!;
    assert.deepEqual([low.grossPay, low.date, low.employeeType, low.paymentSource], [MIN, DAY, 'Employee', 'Petty Cash']);
    assert.equal((await entries(ids.high!))[0]!.grossPay, 18000);
    assert.equal((await entries(ids.idle!))[0]!.grossPay, MIN);

    const payout = await prisma.commissionPayout.findUnique({ where: { period_staffId: { period: PERIOD, staffId: ids.low! } } });
    assert.deepEqual([payout?.status, payout?.paidMethod, payout?.amount, payout?.expenseId], ['Paid', 'Payroll', MIN, null]);
    assert.equal(await prisma.expense.count({ where: { supplier: { in: [`low (payband test)`, `high (payband test)`, `idle (payband test)`] } } }), 0);

    // everyone else is still paid the old way: approved, then paid as a Sales Commission expense
    const plain = out.find((p) => p.staffId === ids.plain)!;
    assert.deepEqual([plain.status, plain.amount, plain.inPayroll], ['Approved', 18000, undefined]);
    assert.equal((await entries(ids.plain!)).length, 0);
  });

  it('its statutory deductions fall in that month of Payments due', async () => {
    const r = (await call('boss', 'GET', `/finance/statutory-due?from=${PERIOD}-01&to=${DAY}`)).body;
    const pay = computePay(18000, 'Employee', DAY);
    assert.ok(r.months[0].nssfEmployer >= pay.nssfEmployer);
    assert.ok(r.months[0].shif >= pay.shif);
  });

  it('approving again changes nothing: one payroll entry each, and a paid month stays as it was', async () => {
    const out = await approve();
    for (const k of ['idle', 'low', 'high']) assert.equal(out.find((p) => p.staffId === ids[k])!.status, 'Paid');
    for (const k of ['idle', 'low', 'high']) assert.equal((await entries(ids[k]!)).length, 1, k);
    // and the payout can no longer be withdrawn
    const payout = await prisma.commissionPayout.findUnique({ where: { period_staffId: { period: PERIOD, staffId: ids.low! } } });
    assert.equal((await call('boss', 'DELETE', `/commission/payouts/${payout!.id}`)).status, 400);
  });

  it('a salary cannot also be keyed in by hand for someone paid on the bands', async () => {
    const r = await call('boss', 'POST', '/finance/payroll', { employeeType: 'Employee', date: '2024-06-30', staffId: ids.high, grossPay: 20000 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /pay bands/);
  });

  it('the employee record carries the flag, and only changes it when told', async () => {
    const emp = (await call('boss', 'GET', '/finance/employees')).body.find((e: any) => e.id === ids.plain);
    assert.equal(emp.paidOnBands, false);
    const on = (await call('boss', 'PUT', `/finance/employees/${ids.plain}`, { paidOnBands: true })).body;
    assert.equal(on.paidOnBands, true);
    const kept = (await call('boss', 'PUT', `/finance/employees/${ids.plain}`, { basicSalary: 30000 })).body;
    assert.equal(kept.paidOnBands, true);
    await call('boss', 'PUT', `/finance/employees/${ids.plain}`, { paidOnBands: false });
  });

  it('the minimum wage is a setting', async () => {
    const base = { generalBands: [{ from: 0, rate: 2 }], filmBands: [{ from: 0, rate: 10 }], artworkRatePct: 50, ownershipMonths: 12 };
    const r = await call('boss', 'PUT', '/commission/settings', { ...base, minimumWage: 20000 });
    assert.equal(r.body.minimumWage, 20000);
    assert.equal((await call('boss', 'PUT', '/commission/settings', { ...base, minimumWage: -1 })).status, 400);
    await call('boss', 'PUT', '/commission/settings', { ...base, minimumWage: MIN });
  });
});
