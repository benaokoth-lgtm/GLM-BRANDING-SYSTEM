// The Profit & Loss dashboard (revenue accrual, revenue cash received, gross profit, net profit — with the comparison to the period
// before and a six-month trend) now lives in Accounting and is built from the ledger. Anyone with the P&L permission may open it.
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
let staffId = 0;
let service = 0;

async function call(who: string, path: string) {
  const res = await fetch(`${base}/api${path}`, { headers: { Authorization: `Bearer ${tokens[who]}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function sale(orderNo: string, date: string, price: number, paidOn: string | null) {
  await prisma.order.create({
    data: {
      orderNo,
      kind: 'walkin',
      customerName: 'P&L dashboard test',
      staffId,
      createdDate: date,
      status: 'Order',
      stage: 'Order Received',
      lineItems: { create: [{ itemType: 'service', serviceId: service, qty: 1, unitPrice: price }] },
      payments: paidOn ? { create: [{ date: paidOn, amount: price, method: 'Cash' }] } : undefined,
    },
  });
}

describe('profit & loss dashboard', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'PnL only (dash test)', canAccessPnl: true } });
    await prisma.role.create({ data: { name: 'Nobody (dash test)' } });
    staffId = (await prisma.user.create({ data: { name: 'dash tester', role: 'Admin', pinHash: 'x' } })).id;
    // Each token belongs to a real user holding that role (a token's role is read from the database, not trusted from the token).
    for (const [key, role] of [['pnl', 'PnL only (dash test)'], ['nobody', 'Nobody (dash test)'], ['admin', 'Admin']] as const) {
      const u = key === 'admin' ? { id: staffId } : await prisma.user.create({ data: { name: key + ' (dash test)', role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: key, role });
    }
    service = (await prisma.service.create({ data: { name: 'Banner (dash test)', unit: 'piece', price: 100 } })).id;
    await ensureChartOfAccounts();
    // A February sale (the period before) and a March sale, the March one paid in April: accrual and cash differ.
    await sale('DASH-1', '2034-02-10', 580, '2034-02-10');
    await sale('DASH-2', '2034-03-05', 1160, '2034-04-02');
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('shows revenue on an accrual basis and as cash received, and the profit figures, from the ledger', async () => {
    const r = await call('admin', '/accounting/profit-loss?from=2034-03-01&to=2034-03-31');
    assert.equal(r.status, 200);
    assert.equal(r.body.income.total, 1000); // 1,160 less its VAT
    assert.equal(r.body.grossProfit, 1000);
    assert.equal(r.body.netProfit, 1000);
    // nothing was received in March: the sale was only paid in April
    assert.equal(r.body.dashboard.cashReceived, 0);
    const april = await call('admin', '/accounting/profit-loss?from=2034-04-01&to=2034-04-30');
    assert.equal(april.body.dashboard.cashReceived, 1160); // money received, VAT included
    assert.equal(april.body.income.total, 0);
  });

  it('compares with the period of the same length just before it, and gives a six-month trend', async () => {
    const r = await call('admin', '/accounting/profit-loss?from=2034-03-01&to=2034-03-31');
    const d = r.body.dashboard;
    // the 31-day period before March ends on 28 Feb and holds the February sale (net 500)
    assert.equal(d.priorTo, '2034-02-28');
    assert.equal(d.revChangePct, 100); // 1,000 against 500
    assert.equal(d.profitChangePct, 100);
    assert.equal(d.trend.length, 6);
    assert.equal(d.trend[5].label, '03/34');
    assert.equal(d.trend[5].revenue, 1000);
    assert.equal(d.trend[4].revenue, 500); // February
    assert.equal(d.trend[5].netProfit, 1000);
    // a period with nothing before it has nothing to compare with
    const first = await call('admin', '/accounting/profit-loss?from=2034-02-01&to=2034-02-28');
    assert.equal(first.body.dashboard.revChangePct, null);
  });

  it('is open to anyone with the P&L permission, and to nobody without it', async () => {
    assert.equal((await call('pnl', '/accounting/profit-loss?from=2034-03-01&to=2034-03-31')).status, 200);
    assert.equal((await call('nobody', '/accounting/profit-loss?from=2034-03-01&to=2034-03-31')).status, 403);
    // the P&L permission opens only that statement, not the rest of Accounting
    assert.equal((await call('pnl', '/accounting/trial-balance')).status, 403);
    // the old Finance P&L endpoint is gone
    assert.equal((await call('admin', '/pnl?from=2034-03-01&to=2034-03-31')).status, 404);
  });
});
