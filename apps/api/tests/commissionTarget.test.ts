// The sales target: before any commission is earned a person must sell 3 × their basic monthly salary (net of VAT, money received). The bands then
// start at the target. Prices at order taking are not touched — selling below the floor is still refused.
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
const today = new Date().toISOString().slice(0, 10);

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const mine = async (who: string) => (await call(who, 'GET', `/commission/my?period=${period}`)).body.statement;

const BANDS = [
  { from: 0, rate: 2 },
  { from: 100000, rate: 4 },
];
const settings = (extra: Record<string, unknown>) =>
  call('boss', 'PUT', '/commission/settings', { generalBands: BANDS, filmBands: [{ from: 0, rate: 10 }, { from: 25, rate: 25 }], artworkRatePct: 50, ownershipMonths: 12, ...extra });

describe('commission needs the sales target first', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Target Counter', canCaptureOrders: true, canAccessDtf: true } });
    await prisma.role.create({ data: { name: 'Target Boss', canCaptureOrders: true, canAccessFinance: true, canAccessAccounting: true, canManageCommission: true } });
    for (const [key, role, salary] of [['amina', 'Target Counter', 40000], ['brian', 'Target Counter', null], ['carol', 'Target Counter', null], ['dave', 'Target Counter', null], ['boss', 'Target Boss', null]] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (target test)`, role, pinHash: 'x', basicSalary: salary } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    // carol has no salary on her record, but has been paid through payroll: 30,000 a month
    await prisma.payrollEntry.create({ data: { date: '2026-01-31', staffId: ids.carol!, employeeType: 'Employee', grossPay: 30000, paymentSource: 'Bank/Cheque' } });
    // (another test file leaves the target switched off in the shared settings row, so say what is wanted)
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true, targetMultiplier: 3, targetMode: 'above' }, create: { id: 1, enabled: true, targetMultiplier: 3, targetMode: 'above' } });
    banner = (await prisma.service.create({ data: { name: 'Banner (target test)', unit: 'piece', price: 1000 } })).id;
    for (const [name, unit, price] of [['DTF Sheet (per metre)', 'metre', 500], ['DTF Printing', 'piece', 70]] as const) {
      if (!(await prisma.service.findFirst({ where: { name } }))) await prisma.service.create({ data: { name, unit, price } });
    }
    await prisma.dtfRoll.create({ data: { id: 'ROLL-TGT', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100 } });
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
      customerName: `Target Client ${++n}`,
      phone: `07${String(10000000 + n * 137)}`,
      staffId: ids[who],
      sourcedBy: ids[who],
      paymentTiming: 'onAcceptance',
      lineItems: [{ itemType: 'service', serviceId: banner, qty: 1, unitPrice: Math.round(net * 1.16) }],
      payments: [{ method: 'Cash', amount: Math.round(net * 1.16) }],
    });

  it('the target is 3 × the basic salary; below it nothing is earned and the person is told how far there is to go', async () => {
    assert.equal((await settings({})).status, 200);
    const cfg = (await call('boss', 'GET', '/commission/settings')).body;
    assert.deepEqual([cfg.targetMultiplier, cfg.targetMode], [3, 'above']);

    assert.equal((await sale('amina', 95000)).status, 201);
    const s = await mine('amina');
    assert.deepEqual([s.target.salary, s.target.required, s.target.achieved, s.target.remaining, s.target.met], [40000, 120000, 95000, 25000, false]);
    assert.equal(s.general.commission, 0);
    assert.equal(s.total, 0);
  });

  it("the bands start at the target: only what is sold above 120,000 earns, at the band's rate", async () => {
    assert.equal((await sale('amina', 55000)).status, 201); // 150,000 net in the month
    const s = await mine('amina');
    assert.deepEqual([s.target.met, s.target.eligibleSales, s.target.held], [true, 30000, false]);
    assert.equal(s.general.commission, 600); // 30,000 × 2%
    assert.equal(s.total, 600);
    assert.equal(s.general.netSales, 150000);
  });

  it("'all': once the target is met the bands apply to every shilling sold", async () => {
    assert.equal((await settings({ targetMode: 'all' })).status, 200);
    const s = await mine('amina');
    assert.equal(s.general.commission, 4000); // 100,000 × 2% + 50,000 × 4%
    assert.equal((await settings({ targetMode: 'above' })).status, 200);
    assert.equal((await mine('amina')).general.commission, 600);
  });

  it('with no salary on the record the latest payroll amount is used', async () => {
    assert.equal((await sale('carol', 100000)).status, 201);
    const s = await mine('carol');
    assert.deepEqual([s.target.salary, s.target.required, s.target.eligibleSales], [30000, 90000, 10000]);
    assert.equal(s.general.commission, 200); // 10,000 × 2%
  });

  it('with no salary anywhere the commission is held — shown, not paid — until a salary is recorded', async () => {
    // brian sells film above the 400 floor and is paid in full: 10 m at 450 → a premium of 75.43 (VAT out), as in the commission tests
    const film = await call('brian', 'POST', '/dtf/sales', { rollId: 'ROLL-TGT', client: 'Film Buyer', phone: '0744 000 555', metres: 10, pricePerM: 450, amountPaid: 4500 });
    assert.equal(film.status, 201);
    const s = await mine('brian');
    assert.deepEqual([s.target.salaryKnown, s.target.held, s.film.commission, s.total], [false, true, 0, 0]);
    assert.equal(s.heldCommission, 75.43, 'what he would be paid is shown');

    // a salary is recorded: now there is a target to measure, and he is short of it
    assert.equal((await call('boss', 'PUT', `/finance/employees/${ids.brian}`, { basicSalary: 10000 })).status, 200);
    const t = await mine('brian');
    assert.deepEqual([t.target.required, t.target.met, t.film.commission], [30000, false, 0]);
    assert.ok(t.target.remaining > 26000);

    // the target switched off: the premium is released as it always was
    assert.equal((await settings({ targetMultiplier: 0 })).status, 200);
    const u = await mine('brian');
    assert.deepEqual([u.target.applies, u.film.commission, u.heldCommission], [false, 75.43, 0]);
    assert.equal((await settings({ targetMultiplier: 3 })).status, 200);
  });

  it('film and artwork premiums are paid in full once the target is met', async () => {
    await call('boss', 'PUT', `/finance/employees/${ids.brian}`, { basicSalary: 1000 }); // a target of 3,000 — his 4,500 of film sales (3,879 net) clears it
    const s = await mine('brian');
    assert.deepEqual([s.target.met, s.film.commission], [true, 75.43]);
    await call('boss', 'PUT', `/finance/employees/${ids.brian}`, { basicSalary: null });
    assert.equal((await call('boss', 'GET', '/finance/employees')).body.find((e: any) => e.id === ids.brian).basicSalary, null);
  });

  it('artwork is the exception: the extra above the recommended price is earned even when the target is not met, and nothing is carried to the next month', async () => {
    // dave has no salary on record, so he has no target to measure: film and sourcing commission would be held, artwork is not.
    // 2 running metres on 108 pieces → recommended 70 a piece; charged 80, paid in full with the 20 heat press fee (10,800): 108 × 10 = 1,080 → 931.03 net → 50% = 465.52
    const job = await call('dave', 'POST', '/dtf/jobs', { rollId: 'ROLL-TGT', client: 'Artwork Buyer', phone: '0744 000 777', runningMetres: 2, pieces: 108, heatPressFee: 20, pricePerPiece: 80, amountPaid: 10800 });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    const film = await call('dave', 'POST', '/dtf/sales', { rollId: 'ROLL-TGT', client: 'Film Buyer Two', phone: '0744 000 888', metres: 10, pricePerM: 450, amountPaid: 4500 });
    assert.equal(film.status, 201);
    let s = await mine('dave');
    assert.deepEqual([s.target.held, s.artwork.commission, s.film.commission, s.general.commission, s.total], [true, 465.52, 0, 0, 465.52]);
    assert.equal(s.heldCommission, 75.43, 'only the film premium is held back — it is shown, never paid');

    // a salary is recorded and the target is still not met: artwork is still paid, film is not
    assert.equal((await call('boss', 'PUT', `/finance/employees/${ids.dave}`, { basicSalary: 40000 })).status, 200);
    s = await mine('dave');
    assert.deepEqual([s.target.met, s.artwork.commission, s.film.commission, s.total], [false, 465.52, 0, 465.52]);
    assert.equal((await call('boss', 'PUT', `/finance/employees/${ids.dave}`, { basicSalary: null })).status, 200);
  });

  it('prices at order taking are untouched: a film sale below the floor is still refused, so a target cannot be met by under-pricing', async () => {
    const low = await call('brian', 'POST', '/dtf/sales', { rollId: 'ROLL-TGT', client: 'Cheap', metres: 100, pricePerM: 399, amountPaid: 39900 });
    assert.equal(low.status, 400);
    assert.match(low.body.error, /below 400/);
  });

  it('an approved month records the target with the figures; only people with commission to pay are approved', async () => {
    const r = await call('boss', 'POST', '/commission/payouts/approve', { period });
    assert.equal(r.status, 200);
    const names = r.body.payouts.map((p: any) => p.staffName);
    assert.ok(names.includes('amina (target test)') && names.includes('carol (target test)'));
    assert.ok(!names.includes('brian (target test)'), 'brian is short of his target, so there is nothing to pay');
    assert.ok(names.includes('dave (target test)'), 'dave is short of his target but earned artwork commission, which is paid regardless');
    assert.equal((await prisma.commissionPayout.findUniqueOrThrow({ where: { period_staffId: { period, staffId: ids.dave! } } })).amount, 465.52);
    const payout = await prisma.commissionPayout.findUniqueOrThrow({ where: { period_staffId: { period, staffId: ids.amina! } } });
    assert.equal(payout.amount, 600);
    assert.equal(JSON.parse(payout.detailJson).target.required, 120000);
  });

  it('the settings are checked, and the employee record keeps the salary', async () => {
    assert.equal((await settings({ targetMultiplier: -1 })).status, 400);
    assert.equal((await settings({ targetMode: 'sometimes' })).status, 400);
    const emp = (await call('boss', 'GET', '/finance/employees')).body.find((e: any) => e.id === ids.amina);
    assert.equal(emp.basicSalary, 40000);
    assert.equal((await call('boss', 'PUT', `/finance/employees/${ids.amina}`, { basicSalary: 45000 })).body.basicSalary, 45000);
    assert.equal((await call('boss', 'PUT', `/finance/employees/${ids.amina}`, {})).body.basicSalary, 45000, 'left out = unchanged');
    assert.equal((await call('boss', 'PUT', `/finance/employees/${ids.amina}`, { basicSalary: 40000 })).body.basicSalary, 40000);
    void today;
  });
});
