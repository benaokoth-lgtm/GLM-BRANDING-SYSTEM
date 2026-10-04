// DTF day-by-day roll-ups (artwork jobs and film sales, with the orders behind each day) and the business-head detail report.
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
const ROLL = 'ROLL-DAILY';
const today = new Date().toISOString().slice(0, 10);
const day = `from=${today}&to=${today}`;

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('DTF daily roll-ups and business head detail', () => {
  const orderNos: Record<string, string> = {};
  before(async () => {
    await prisma.role.create({ data: { name: 'Printer (daily test)', canAccessDtf: true, canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Lead (daily test)', canAccessDtf: true, canManageDtf: true, canAccessReports: true } });
    for (const [key, role] of [['printer', 'Printer (daily test)'], ['lead', 'Lead (daily test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (daily test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.service.create({ data: { name: 'DTF Printing', unit: 'piece', price: 70 } }).catch(() => null);
    await prisma.service.create({ data: { name: 'DTF Sheet (per metre)', unit: 'metre', price: 500 } }).catch(() => null);
    await prisma.dtfRoll.create({ data: { id: ROLL, installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100, filmCost: 6000, inkPowderCost: 4000 } });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // artwork: 2 m / 108 pcs (recommended 70) at the recommended price, paid in full; 1 m / 36 pcs (recommended 90) charged 100, part paid
    const j1 = await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Daily One', runningMetres: 2, pieces: 108, heatPressFee: 20, amountPaid: 9720 });
    const j2 = await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Daily Two', runningMetres: 1, pieces: 36, pricePerPiece: 100, heatPressFee: 20, amountPaid: 1000 });
    // film: 10 m at 450 paid in full; 5 m at 500 with 1,000 paid
    const s1 = await call('printer', 'POST', '/dtf/sales', { rollId: ROLL, client: 'Film One', metres: 10, pricePerM: 450, amountPaid: 4500 });
    const s2 = await call('printer', 'POST', '/dtf/sales', { rollId: ROLL, client: 'Film Two', metres: 5, pricePerM: 500, amountPaid: 1000 });
    for (const [k, r] of [['j1', j1], ['j2', j2], ['s1', s1], ['s2', s2]] as const) {
      assert.equal(r.status, 201, `${k}: ${JSON.stringify(r.body)}`);
      orderNos[k] = r.body.order.orderNo;
    }
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('artwork jobs roll up by date: count, averages, money and metres, with the orders behind the day', async () => {
    const r = await call('lead', 'GET', `/dtf/daily?kind=jobs&${day}`);
    assert.equal(r.status, 200);
    const d = r.body.days.find((x: any) => x.date === today);
    // every job today in the shared test database counts; ours are among them
    const ours = d.orders.filter((o: any) => o.rollId === ROLL);
    assert.equal(ours.length, 2);
    assert.deepEqual(ours.map((o: any) => o.orderNo).sort(), [orderNos.j1, orderNos.j2].sort());
    const one = ours.find((o: any) => o.orderNo === orderNos.j1);
    assert.equal(one.recommendedPerPiece, 70);
    assert.equal(one.finalPerPiece, 70);
    assert.equal(one.total, 9720); // 70 × 108 plus the heat press fee of 20 × 108
    assert.equal(one.paid, 9720);
    assert.equal(one.balance, 0);
    const two = ours.find((o: any) => o.orderNo === orderNos.j2);
    assert.equal(two.recommendedPerPiece, 90);
    assert.equal(two.finalPerPiece, 100);
    assert.equal(two.total, 4320);
    assert.equal(two.paid, 1000);
    assert.equal(two.balance, 3320);

    // the figures for the day are the sum of its orders
    const sum = (k: string) => Math.round(d.orders.filter((o: any) => o.approval !== 'Pending').reduce((a: number, o: any) => a + o[k], 0) * 100) / 100;
    assert.equal(d.count, d.orders.filter((o: any) => o.approval !== 'Pending').length);
    assert.equal(d.total, sum('total'));
    assert.equal(d.paid, sum('paid'));
    assert.equal(d.balance, sum('balance'));
    assert.equal(d.pieces, d.orders.reduce((a: number, o: any) => a + o.pieces, 0));
    assert.equal(d.metres, Math.round(d.orders.reduce((a: number, o: any) => a + o.runningMetres, 0) * 100) / 100);
    assert.equal(d.avgPricePerJob, Math.round((d.total / d.count) * 100) / 100);
    assert.ok(d.avgRecommendedPerPiece > 0 && d.avgFinalPerPiece > 0);
  });

  it('a day with only our jobs gives exactly the expected averages', async () => {
    // (dated one day back so nothing else in the shared database is on it)
    await prisma.dtfArtworkJob.updateMany({ where: { rollId: ROLL }, data: { jobOn: '2033-06-01' } });
    const d = (await call('lead', 'GET', '/dtf/daily?kind=jobs&from=2033-06-01&to=2033-06-01')).body.days[0];
    assert.equal(d.count, 2);
    assert.equal(d.pieces, 144);
    assert.equal(d.metres, 3);
    assert.equal(d.avgPricePerJob, 7020); // (9,720 + 4,320) ÷ 2
    assert.equal(d.avgRecommendedPerPiece, 75); // (70 × 108 + 90 × 36) ÷ 144
    assert.equal(d.avgFinalPerPiece, 77.5); // (70 × 108 + 100 × 36) ÷ 144
    assert.equal(d.total, 14040);
    assert.equal(d.paid, 10720);
    assert.equal(d.balance, 3320);
  });

  it('film sales roll up by date: metres, average price per metre and the money, with the orders behind the day', async () => {
    await prisma.dtfFilmSale.updateMany({ where: { rollId: ROLL }, data: { soldOn: '2033-06-02' } });
    const r = await call('lead', 'GET', '/dtf/daily?kind=sales&from=2033-06-02&to=2033-06-02');
    assert.equal(r.status, 200);
    const d = r.body.days[0];
    assert.equal(d.count, 2);
    assert.equal(d.metres, 15);
    assert.equal(d.avgPricePerM, 466.67); // (10 × 450 + 5 × 500) ÷ 15
    assert.equal(d.total, 7000);
    assert.equal(d.paid, 5500);
    assert.equal(d.balance, 1500);
    assert.deepEqual(d.orders.map((o: any) => o.orderNo).sort(), [orderNos.s1, orderNos.s2].sort());
    const two = d.orders.find((o: any) => o.orderNo === orderNos.s2);
    assert.equal(two.balance, 1500);
    assert.equal(two.pricePerM, 500);
    // a payment taken later through the order shows up in the day's paid and balance
    await call('lead', 'PATCH', `/dtf/sales/${two.saleId}/paid`, { amountPaid: 2500 });
    const after = (await call('lead', 'GET', '/dtf/daily?kind=sales&from=2033-06-02&to=2033-06-02')).body.days[0];
    assert.equal(after.paid, 7000);
    assert.equal(after.balance, 0);
  });

  it('is for DTF managers only', async () => {
    assert.equal((await call('printer', 'GET', `/dtf/daily?kind=jobs&${day}`)).status, 403);
  });

  it('a business head opens into its sales lines, purchases and expenses', async () => {
    await call('lead', 'GET', '/master-data/business-heads'); // gives every service its head
    const r = await call('lead', 'GET', '/reports/business-head-detail?head=DTF%20Printing&from=2033-06-01&to=2033-06-30');
    assert.equal(r.status, 200);
    // the orders were created today, not in June 2033: none of them are in that window
    assert.equal(r.body.sales.length, 0);
    const now = await call('lead', 'GET', `/reports/business-head-detail?head=DTF%20Printing&${day}`);
    const mine = now.body.sales.filter((l: any) => [orderNos.j1, orderNos.j2, orderNos.s1, orderNos.s2].includes(l.orderNo));
    assert.equal(mine.length, 4);
    // 9,720 including VAT → 8,379.31 net, whatever the line
    const j1 = mine.find((l: any) => l.orderNo === orderNos.j1);
    assert.equal(j1.sales, Math.round((9720 / 1.16) * 100) / 100);
    assert.equal(j1.item, 'DTF Printing');
    assert.equal(now.body.totals.sales, Math.round(now.body.sales.reduce((a: number, l: any) => a + l.sales, 0) * 100) / 100);
    assert.equal((await call('lead', 'GET', `/reports/business-head-detail?head=Nonexistent&${day}`)).status, 404);
    assert.equal((await call('lead', 'GET', `/reports/business-head-detail?head=__shared__&${day}`)).status, 200);
  });

  it('Accounts Receivable is no longer a report here', async () => {
    assert.equal((await call('lead', 'GET', '/reports/accounts-receivable')).status, 404);
  });
});
