// (Named to run last: it adds a large sale to the books, which would show up in other tests' profit figures.)
// The tax set-aside planner: what to hold back for the year's income tax, month by month, and what has been set aside. Information only.
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
const year = Number(new Date().toISOString().slice(0, 4));
const today = new Date().toISOString().slice(0, 10);

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const planner = async () => (await call('finance', 'GET', `/tax/year/${year}/set-aside`)).body;

describe('tax set-aside planner', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Set Aside Finance', canAccessFinance: true, canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Set Aside Counter', canCaptureOrders: true } });
    for (const [key, role] of [['finance', 'Set Aside Finance'], ['counter', 'Set Aside Counter']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (set aside test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    const a = (await prisma.user.findFirst({ where: { role: 'Admin', active: true } })) ?? (await prisma.user.create({ data: { name: 'admin (set aside test)', role: 'Admin', pinHash: 'x' } }));
    tokens.admin = signToken({ id: a.id, name: a.name, role: 'Admin' });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('is for people with Finance access', async () => {
    assert.equal((await call('counter', 'GET', `/tax/year/${year}/set-aside`)).status, 403);
    assert.equal((await call('counter', 'GET', '/tax/set-aside/current')).status, 403);
    assert.equal((await call('counter', 'POST', `/tax/year/${year}/set-aside`, { date: today, amount: 100 })).status, 403);
    assert.equal((await call('finance', 'GET', `/tax/year/${year}/set-aside`)).status, 200);
  });

  it('holds the tax on the year’s profit so far, shows what has been set aside, and says what to move now', async () => {
    // a big paid sale: 11,600,000 with VAT = 10,000,000 of income
    const staff = await prisma.user.findFirstOrThrow({ where: { name: 'finance (set aside test)' } });
    const svc = await prisma.service.create({ data: { name: 'Set aside service', unit: 'piece', price: 1 } });
    const sale = await call('finance', 'POST', '/orders/walkin', {
      customerName: 'Big client', staffId: staff.id, paymentTiming: 'onAcceptance', payments: [{ method: 'Bank Transfer', amount: 11600000 }],
      lineItems: [{ itemType: 'service', serviceId: svc.id, qty: 1, unitPrice: 11600000 }],
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));

    const p = await planner();
    assert.equal(p.year, year);
    assert.equal(p.regime, 'corporation');
    assert.equal(p.rate, 30);
    assert.equal(p.months.length, 12);
    assert.ok(p.ytd.profit >= 9_000_000);
    // the amount to hold is the tax on the profit so far: 30%, with the add-backs the tax working makes
    const thisMonth = p.months.find((m: any) => m.month === today.slice(0, 7));
    assert.ok(thisMonth && !thisMonth.future);
    assert.ok(p.ytd.requiredToDate > 2_500_000);
    assert.equal(p.months.filter((m: any) => m.future).length, p.months.filter((m: any) => m.month > today.slice(0, 7)).length);
    // the monthly plans add up to what is to be held
    const plans = p.months.filter((m: any) => !m.future).reduce((a: number, m: any) => a + m.planThisMonth, 0);
    assert.ok(Math.abs(plans - p.ytd.requiredToDate) < 0.05);
    assert.equal(p.moveNow, Math.max(0, Math.round((p.ytd.requiredToDate - p.ytd.setAside) * 100) / 100));
    assert.ok(p.projection.tax >= p.ytd.requiredToDate - 0.05);

    // setting some aside: it counts against what is to be held
    const before = p.moveNow;
    const add = await call('finance', 'POST', `/tax/year/${year}/set-aside`, { date: today, amount: 500000, note: 'to the tax savings' });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.equal(add.body.ytd.setAside, p.ytd.setAside + 500000);
    assert.equal(Math.round((before - add.body.moveNow) * 100) / 100, 500000);
    assert.equal(add.body.entries.at(-1).capturedByName, 'finance (set aside test)');
    assert.equal(add.body.months.find((m: any) => m.month === today.slice(0, 7)).setAside, 500000 + (thisMonth.setAside ?? 0));
    assert.equal((await call('finance', 'POST', `/tax/year/${year}/set-aside`, { date: today, amount: -5 })).status, 400);
    assert.equal((await call('finance', 'POST', `/tax/year/${year}/set-aside`, { date: 'yesterday', amount: 5 })).status, 400);

    // taking it back out
    const gone = await call('finance', 'DELETE', `/tax/set-aside/${add.body.entries.at(-1).id}`);
    assert.equal(gone.status, 200);
    assert.equal(gone.body.ytd.setAside, p.ytd.setAside);
    assert.equal((await call('finance', 'DELETE', '/tax/set-aside/99999999')).status, 404);

    // the rate is the corporation tax rate set in Compliance, and the planner for the year we are in is reachable without naming it
    assert.equal((await call('admin', 'PUT', '/tax/settings', { regime: 'corporation', corporationRate: 20, turnoverRate: 3, yearEndMonth: 12 })).status, 200);
    const twenty = await planner();
    assert.ok(Math.abs(twenty.ytd.requiredToDate / p.ytd.requiredToDate - 20 / 30) < 0.001);
    assert.equal((await call('finance', 'GET', '/tax/set-aside/current')).body.rate, 20);
    assert.equal((await call('admin', 'PUT', '/tax/settings', { regime: 'corporation', corporationRate: 30, turnoverRate: 3, yearEndMonth: 12 })).status, 200);

    // turnover tax: the rate of the year's sales instead
    assert.equal((await call('admin', 'PUT', '/tax/settings', { regime: 'turnover', corporationRate: 30, turnoverRate: 3, yearEndMonth: 12 })).status, 200);
    const t = await planner();
    assert.equal(t.regime, 'turnover');
    assert.ok(Math.abs(t.ytd.requiredToDate - t.months.filter((m: any) => !m.future).reduce((a: number, m: any) => a + m.sales, 0) * 0.03) < 0.1);
    assert.equal((await call('admin', 'PUT', '/tax/settings', { regime: 'corporation', corporationRate: 30, turnoverRate: 3, yearEndMonth: 12 })).status, 200);
  });
});
