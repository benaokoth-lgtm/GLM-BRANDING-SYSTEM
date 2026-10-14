// (Named to run last: it adds petty cash movements, which other tests' float checks would otherwise see.)
// The petty cash desk: the front office sees the float and logs what is spent from it, with no other Finance access.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_ROLE_PERMISSIONS } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensurePettyCashAccess } from '../src/frontOffice';
import { ensureChartOfAccounts } from '../src/accounting/chart';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const today = new Date().toISOString().slice(0, 10);

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('petty cash desk', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Petty Desk', canCapturePettyCash: true, canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'No Petty Desk', canCaptureOrders: true } });
    for (const [key, role] of [['desk', 'Petty Desk'], ['plain', 'No Petty Desk']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (petty test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    const a = (await prisma.user.findFirst({ where: { role: 'Admin', active: true } })) ?? (await prisma.user.create({ data: { name: 'admin (petty test)', role: 'Admin', pinHash: 'x' } }));
    tokens.admin = signToken({ id: a.id, name: a.name, role: 'Admin' });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('the front office has it by default, and a database that pre-dates it is given it once', async () => {
    assert.equal(DEFAULT_ROLE_PERMISSIONS['Front Office']!.canCapturePettyCash, true);
    assert.equal(DEFAULT_ROLE_PERMISSIONS.Staff!.canCapturePettyCash, false);
    await prisma.role.create({ data: { name: 'Old Front Office (petty test)', canCaptureForOthers: true } });
    await prisma.setting.upsert({ where: { id: 1 }, update: { pettyCashAccessSeeded: false }, create: { id: 1, pettyCashAccessSeeded: false } });
    await ensurePettyCashAccess();
    assert.equal((await prisma.role.findUniqueOrThrow({ where: { name: 'Old Front Office (petty test)' } })).canCapturePettyCash, true);
    // …and an Admin who then takes it away is not overruled at the next start
    await prisma.role.update({ where: { name: 'Old Front Office (petty test)' }, data: { canCapturePettyCash: false } });
    await ensurePettyCashAccess();
    assert.equal((await prisma.role.findUniqueOrThrow({ where: { name: 'Old Front Office (petty test)' } })).canCapturePettyCash, false);
  });

  it('sees the float and logs petty cash expenses, and nothing else in Finance', async () => {
    // Finance feeds the float
    assert.equal((await call('admin', 'POST', '/finance/petty-cash/topups', { date: today, source: 'Owner Injection', amount: 10000, note: 'float' })).status, 201);

    const view = await call('desk', 'GET', `/finance/petty-cash?from=${today}&to=${today}`);
    assert.equal(view.status, 200);
    assert.ok(view.body.balance >= 10000);
    assert.equal(view.body.cashSalesInPeriod, 0); // the till is Finance's to see
    assert.ok(view.body.expenseCategories.length > 0);

    const category = view.body.expenseCategories[0];
    const log = await call('desk', 'POST', '/finance/expenses', { date: today, category, amount: 1500, note: 'Tea and sugar for the office', method: 'Petty Cash', paid: true });
    assert.equal(log.status, 201, JSON.stringify(log.body));
    assert.equal(log.body.capturedByName, 'desk (petty test)');
    assert.equal(Math.round((view.body.balance - (await call('desk', 'GET', `/finance/petty-cash?from=${today}&to=${today}`)).body.balance) * 100) / 100, 1500);

    // not bills on credit, not other ways of paying, not an amount the float cannot cover
    assert.equal((await call('desk', 'POST', '/finance/expenses', { date: today, category, amount: 100, method: 'Petty Cash', paid: false, supplier: 'X' })).status, 403);
    assert.equal((await call('desk', 'POST', '/finance/expenses', { date: today, category, amount: 100, method: 'M-Pesa', paid: true })).status, 403);
    assert.equal((await call('desk', 'POST', '/finance/expenses', { date: today, category, amount: 99999999, method: 'Petty Cash', paid: true })).status, 400);

    // everything else in Finance is closed to them
    assert.equal((await call('desk', 'GET', `/finance/expenses?from=${today}&to=${today}`)).status, 403);
    assert.equal((await call('desk', 'POST', '/finance/petty-cash/topups', { date: today, source: 'Owner Injection', amount: 500 })).status, 403);
    assert.equal((await call('desk', 'GET', `/finance/payroll?from=${today}&to=${today}`)).status, 403);
    assert.equal((await call('desk', 'GET', `/finance/vat?from=${today}&to=${today}`)).status, 403);
    assert.equal((await call('desk', 'POST', '/finance/deletion-requests', { recordType: 'Expense', recordId: 1, reason: 'x' })).status, 403);

    // a role without the desk cannot even see the float
    assert.equal((await call('plain', 'GET', `/finance/petty-cash?from=${today}&to=${today}`)).status, 403);
    assert.equal((await call('plain', 'POST', '/finance/expenses', { date: today, category, amount: 100, method: 'Petty Cash', paid: true })).status, 403);
  });
});
