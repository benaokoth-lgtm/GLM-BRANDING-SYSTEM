// Compliance → Corporation tax: the tax worked out from the books under the KRA rules (30% of taxable profit, four instalments + a balance, tax losses,
// turnover tax for small businesses), recorded payments, and its place in Payments due.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { NOT_DEDUCTIBLE, yearPeriod } from '../src/incomeTax';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
let staffId = 0;
let service = 0;

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const adjust = (over: Record<string, unknown> = {}) => ({ addBacks: 0, capitalAllowances: 0, lossesUsed: 0, whtCredits: 0, estimateTax: null, note: '', ...over });

describe('corporation tax (KRA rules)', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Tax Finance', canAccessFinance: true } });
    await prisma.role.create({ data: { name: 'Tax Nobody' } });
    for (const [key, role] of [['admin', 'Admin'], ['fin', 'Tax Finance'], ['nobody', 'Tax Nobody']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (tax test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
      if (key === 'fin') staffId = u.id;
    }
    service = (await prisma.service.create({ data: { name: 'Banner (tax test)', unit: 'piece', price: 1160 } })).id;
    await ensureChartOfAccounts();
    // 2038: sales of 1,000,000 (+ VAT) in February; 200,000 (+ VAT) of materials in March → a profit of 800,000 in the books
    await prisma.order.create({
      data: { orderNo: 'TAX-2038-1', kind: 'walkin', staffId, createdDate: '2038-02-10', status: 'Order', stage: 'Order Received', lineItems: { create: [{ itemType: 'service', serviceId: service, qty: 1, unitPrice: 1160000 }] } },
    });
    await prisma.expense.create({ data: { date: '2038-03-01', category: 'Printing Materials & Consumables', amount: 232000, method: 'Bank Transfer' } });
    // 2039: only a cost, so a tax loss
    await prisma.expense.create({ data: { date: '2039-05-01', category: 'Printing Materials & Consumables', amount: 116000, method: 'Bank Transfer' } });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('knows the accounting year and what the Act will not let a business deduct', () => {
    assert.deepEqual(yearPeriod(2038, 12), { start: '2038-01-01', end: '2038-12-31', startYear: 2038, startMonth: 1 });
    assert.deepEqual(yearPeriod(2038, 6), { start: '2037-07-01', end: '2038-06-30', startYear: 2037, startMonth: 7 });
    for (const n of ['Entertainment', 'Fines & penalties', 'Donations']) assert.ok(NOT_DEDUCTIBLE.test(n), n);
    for (const n of ['Rent', 'Printing Materials & Consumables', 'Salaries']) assert.equal(NOT_DEDUCTIBLE.test(n), false, n);
  });

  it('can be read by Finance, changed only by an Admin, and not seen by others', async () => {
    assert.equal((await call('nobody', 'GET', '/tax/year/2038')).status, 403);
    assert.equal((await call('fin', 'GET', '/tax/year/2038')).status, 200);
    assert.equal((await call('fin', 'PUT', '/tax/year/2038', adjust())).status, 403);
    assert.equal((await call('fin', 'POST', '/tax/year/2038/payments', { period: 'I1', date: '2038-04-20', amount: 1 })).status, 403);
    assert.equal((await call('fin', 'PUT', '/tax/settings', { regime: 'corporation', corporationRate: 30, turnoverRate: 3, yearEndMonth: 12 })).status, 403);
    assert.equal((await call('admin', 'GET', '/tax/year/abc')).status, 400);
  });

  it('works from the profit in the books to the tax: add-backs, capital allowances, losses brought forward, 30%', async () => {
    const plain = (await call('fin', 'GET', '/tax/year/2038')).body;
    assert.equal(plain.profit, 800000);
    assert.equal(plain.taxable, 800000);
    assert.equal(plain.tax, 240000); // 30%

    const r = (await call('admin', 'PUT', '/tax/year/2038', adjust({ addBacks: 50000, capitalAllowances: 100000, lossesUsed: 150000, whtCredits: 20000, estimateTax: 100000 }))).body;
    assert.equal(r.adjusted, 850000); // 800,000 + 50,000 not deductible
    assert.equal(r.taxable, 600000); // less 100,000 capital allowances and 150,000 losses brought forward
    assert.equal(r.tax, 180000);
    assert.equal(r.taxAfterCredits, 160000); // less 20,000 tax already withheld at source
    assert.equal(r.taxLoss, 0);

    // losses brought forward cannot take the taxable profit below nil
    const big = (await call('admin', 'PUT', '/tax/year/2038', adjust({ addBacks: 50000, capitalAllowances: 100000, lossesUsed: 5000000 }))).body;
    assert.equal(big.lossesUsed, 750000);
    assert.equal(big.taxable, 0);
    assert.equal(big.tax, 0);
    await call('admin', 'PUT', '/tax/year/2038', adjust({ addBacks: 50000, capitalAllowances: 100000, lossesUsed: 150000, whtCredits: 20000, estimateTax: 100000 }));
  });

  it('schedules four instalments (20th of months 4, 6, 9, 12) and the balance by the end of the 4th month after year end', async () => {
    const r = (await call('fin', 'GET', '/tax/year/2038')).body;
    assert.equal(r.estimate, 100000);
    assert.deepEqual(r.items.map((i: any) => [i.key, i.dueDate]), [['I1', '2038-04-20'], ['I2', '2038-06-20'], ['I3', '2038-09-20'], ['I4', '2038-12-20'], ['FINAL', '2039-04-30']]);
    for (const i of r.items.slice(0, 4)) assert.equal(i.amount, 20000); // (100,000 − 20,000 credits) ÷ 4
    assert.equal(r.items[4].amount, 80000); // 160,000 − 4 × 20,000
    assert.equal(r.outstanding, 160000);
    assert.equal(r.suggestedEstimate, 180000); // no prior year, so the year's own tax
  });

  it('records payments to KRA, counts them off, and removes one again', async () => {
    assert.equal((await call('admin', 'POST', '/tax/year/2038/payments', { period: 'nonsense', date: '2038-04-20', amount: 20000 })).status, 400);
    assert.equal((await call('admin', 'POST', '/tax/year/2038/payments', { period: 'I1', date: '2038-04-20', amount: 0 })).status, 400);
    const paid = (await call('admin', 'POST', '/tax/year/2038/payments', { period: 'I1', date: '2038-04-20', amount: 20000, reference: 'KRA-REF-1' })).body;
    assert.equal(paid.items[0].paid, 20000);
    assert.equal(paid.items[0].outstanding, 0);
    assert.equal(paid.outstanding, 140000);
    assert.equal(paid.payments[0].reference, 'KRA-REF-1');
    const gone = (await call('admin', 'DELETE', `/tax/payments/${paid.payments[0].id}`)).body;
    assert.equal(gone.outstanding, 160000);
    assert.equal((await call('admin', 'DELETE', '/tax/payments/99999999')).status, 404);
  });

  it('puts the instalments in Payments due, in the month before the 20th they fall on, and in the total to pay', async () => {
    const r = (await call('fin', 'GET', '/finance/statutory-due?from=2038-03-01&to=2038-03-31')).body;
    const [m] = r.months;
    assert.equal(m.month, '2038-03');
    assert.equal(m.incomeTax, 20000); // instalment 1, due 20 April
    assert.equal(r.totals.incomeTax, 20000);
    assert.ok(m.total >= 20000);
    const may = (await call('fin', 'GET', '/finance/statutory-due?from=2038-05-01&to=2038-05-31')).body.months[0];
    assert.equal(may.incomeTax, 20000); // instalment 2, due 20 June
    const quiet = (await call('fin', 'GET', '/finance/statutory-due?from=2038-07-01&to=2038-07-31')).body.months[0];
    assert.equal(quiet.incomeTax, 0);
  });

  it('a year with a loss pays no tax and records the loss to carry forward', async () => {
    const r = (await call('fin', 'GET', '/tax/year/2039')).body;
    assert.equal(r.profit, -100000);
    assert.equal(r.taxLoss, 100000);
    assert.equal(r.tax, 0);
    assert.equal(r.outstanding, 0);
  });

  it('a small business can choose Turnover Tax: 3% of the month\'s sales, due the 20th of the next month', async () => {
    const set = (await call('admin', 'PUT', '/tax/settings', { regime: 'turnover', corporationRate: 30, turnoverRate: 3, yearEndMonth: 12 })).body;
    assert.equal(set.regime, 'turnover');
    try {
      const r = (await call('fin', 'GET', '/tax/year/2038')).body;
      assert.equal(r.turnover.annual, 1000000);
      assert.equal(r.turnover.eligible, true); // KES 1M–25M
      const feb = r.turnover.months.find((m: any) => m.month === '2038-02');
      assert.equal(feb.turnover, 1000000);
      assert.equal(feb.tax, 30000);
      assert.equal(feb.dueDate, '2038-03-20');
      const row = (await call('fin', 'GET', '/finance/statutory-due?from=2038-02-01&to=2038-02-28')).body.months[0];
      assert.equal(row.incomeTax, 30000);
      await call('admin', 'POST', '/tax/year/2038/payments', { period: '2038-02', date: '2038-03-18', amount: 30000 });
      assert.equal((await call('fin', 'GET', '/finance/statutory-due?from=2038-02-01&to=2038-02-28')).body.months[0].incomeTax, 0);
    } finally {
      await call('admin', 'PUT', '/tax/settings', { regime: 'corporation', corporationRate: 30, turnoverRate: 3, yearEndMonth: 12 });
    }
  });

  it('refuses nonsense settings', async () => {
    assert.equal((await call('admin', 'PUT', '/tax/settings', { regime: 'corporation', corporationRate: 130, turnoverRate: 3, yearEndMonth: 12 })).status, 400);
    assert.equal((await call('admin', 'PUT', '/tax/settings', { regime: 'corporation', corporationRate: 30, turnoverRate: 3, yearEndMonth: 13 })).status, 400);
  });
});
