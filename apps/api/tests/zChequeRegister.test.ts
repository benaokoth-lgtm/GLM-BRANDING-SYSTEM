// (Named to run last: it adds petty cash movements and expenses to the books.)
// The cheque register: cheque numbers on withdrawals and on payments, no number used twice, cleared against the bank, and where a withdrawal went.
import { todayStr } from '@glm/shared';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { allocateFifo, normChequeNo } from '../src/cheques';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const today = todayStr();

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('cheque register', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Cheque Counter', canCaptureOrders: true, canCapturePettyCash: true } });
    const u = await prisma.user.create({ data: { name: 'counter (cheque test)', role: 'Cheque Counter', pinHash: 'x' } });
    tokens.counter = signToken({ id: u.id, name: u.name, role: 'Cheque Counter' });
    const a = (await prisma.user.findFirst({ where: { role: 'Admin', active: true } })) ?? (await prisma.user.create({ data: { name: 'admin (cheque test)', role: 'Admin', pinHash: 'x' } }));
    tokens.admin = signToken({ id: a.id, name: a.name, role: 'Admin' });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('shares each payment out of the float between the top-ups made by then, oldest first', () => {
    assert.equal(normChequeNo(' 000 457 '), '000457');
    assert.equal(normChequeNo('abc12'), 'ABC12');
    const f = [
      { id: 1, date: '2026-09-01', amount: 100, source: 'Bank Withdrawal', note: '' },
      { id: 2, date: '2026-09-10', amount: 100, source: 'Bank Withdrawal', note: '' },
    ];
    const r = allocateFifo(f, [
      { date: '2026-09-02', amount: 60, label: 'Salaries', group: 'Salaries' },
      { date: '2026-09-05', amount: 60, label: 'Paper', group: 'Purchases' }, // 40 left on the first, 20 more must wait: there is no second top-up yet
      { date: '2026-09-12', amount: 150, label: 'Tea', group: 'Expenses' },
    ]);
    assert.deepEqual([r.slots[0]!.spent.Salaries, r.slots[0]!.spent.Purchases, r.slots[0]!.spent.Expenses, r.slots[0]!.left], [60, 40, 0, 0]);
    assert.deepEqual([r.slots[1]!.spent.Expenses, r.slots[1]!.left], [100, 0]);
    assert.equal(r.unallocated, 70); // 20 of the paper bought before the second top-up, and 50 more than the float had held
  });

  it('puts a cheque number on a withdrawal and on a payment, and never lets one be used twice', async () => {
    // not a bank withdrawal: no cheque
    assert.equal((await call('admin', 'POST', '/finance/petty-cash/topups', { date: today, source: 'Owner Injection', amount: 1000, chequeNo: '777' })).status, 400);
    const w = await call('admin', 'POST', '/finance/petty-cash/topups', { date: today, source: 'Bank Withdrawal', amount: 100000, note: 'salaries and purchases', chequeNo: '000 457', payee: 'Finance Head' });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    assert.equal((await call('admin', 'POST', '/finance/petty-cash/topups', { date: today, source: 'Bank Withdrawal', amount: 5000, chequeNo: '000457' })).status, 400); // already used
    assert.equal(await prisma.pettyCashTopUp.count({ where: { amount: 5000, source: 'Bank Withdrawal' } }), 0); // …and the failed one left nothing behind

    const category = (await call('admin', 'GET', `/finance/petty-cash?from=${today}&to=${today}`)).body.expenseCategories[0];
    // a payment by cheque needs its number
    const noNumber = { date: today, category, amount: 2500, note: 'Paper', method: 'Cheque', paid: true, supplier: 'Paper Ltd' };
    assert.equal((await call('admin', 'POST', '/finance/expenses', noNumber)).status, 400);
    assert.equal((await call('admin', 'POST', '/finance/expenses', { ...noNumber, method: 'Bank Transfer', chequeNo: '9' })).status, 400); // a number only goes with a cheque
    const paid = await call('admin', 'POST', '/finance/expenses', { ...noNumber, chequeNo: '000458' });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    const before = await prisma.expense.count();
    assert.equal((await call('admin', 'POST', '/finance/expenses', { ...noNumber, chequeNo: '000458' })).status, 400);
    assert.equal(await prisma.expense.count(), before); // nothing half-recorded

    const reg = await call('admin', 'GET', '/finance/cheques');
    assert.equal(reg.status, 200);
    const c457 = reg.body.cheques.find((c: any) => c.chequeNo === '000457');
    const c458 = reg.body.cheques.find((c: any) => c.chequeNo === '000458');
    assert.deepEqual([c457.kind, c457.status, c457.amount, c457.payee], ['Withdrawal', 'Issued', 100000, 'Finance Head']);
    assert.deepEqual([c458.kind, c458.amount, c458.payee, c458.expenseId], ['Payment', 2500, 'Paper Ltd', paid.body.id]);
    assert.ok(reg.body.unpresented.count >= 2);
  });

  it('is marked cleared against the bank, and a spoilt number is kept', async () => {
    const reg = (await call('admin', 'GET', '/finance/cheques')).body;
    const c = reg.cheques.find((x: any) => x.chequeNo === '000457');
    assert.equal((await call('admin', 'POST', `/finance/cheques/${c.id}/clear`, { clearedOn: '2000-01-01' })).status, 400); // before it was written
    const cleared = await call('admin', 'POST', `/finance/cheques/${c.id}/clear`, { clearedOn: today });
    assert.deepEqual([cleared.status, cleared.body.status, cleared.body.clearedOn], [200, 'Cleared', today]);
    assert.equal((await call('admin', 'GET', '/finance/cheques')).body.unpresented.count, reg.unpresented.count - 1);
    assert.equal((await call('admin', 'POST', `/finance/cheques/${c.id}/unclear`)).body.status, 'Issued');

    const spoilt = await call('admin', 'POST', '/finance/cheques', { chequeNo: '000459', date: today, note: 'spoilt, wrong date' });
    assert.equal(spoilt.status, 201);
    assert.deepEqual([spoilt.body.kind, spoilt.body.status, spoilt.body.amount], ['Cancelled', 'Cancelled', 0]);
    assert.equal((await call('admin', 'POST', `/finance/cheques/${spoilt.body.id}/clear`, { clearedOn: today })).status, 400);
    assert.equal((await call('admin', 'POST', '/finance/cheques', { chequeNo: '000459', date: today })).status, 400);
    assert.equal((await call('admin', 'DELETE', `/finance/cheques/${c.id}`)).status, 400); // a recorded withdrawal goes with its record
    assert.equal((await call('admin', 'DELETE', `/finance/cheques/${spoilt.body.id}`)).status, 204);
  });

  it('shows where a withdrawal went, and numbers an older withdrawal that has none', async () => {
    const old = await prisma.pettyCashTopUp.create({ data: { date: '2026-01-05', source: 'Bank Withdrawal', amount: 20000, note: 'before numbers were kept', authorizedByName: 'x' } });
    const reg = (await call('admin', 'GET', '/finance/cheques')).body;
    assert.ok(reg.withoutNumber >= 1);
    const w = reg.withdrawals.find((x: any) => x.chequeNo === '000457');
    assert.equal(w.amount, 100000);
    assert.equal(Math.round((w.spent + w.remaining) * 100) / 100, 100000);
    assert.equal(Math.round(Object.values(w.breakdown as Record<string, number>).reduce((a, b) => a + b, 0) * 100) / 100, w.spent);
    assert.equal(reg.withdrawals.find((x: any) => x.topUpId === old.id).chequeNo, null);
    const fix = await call('admin', 'PATCH', `/finance/petty-cash/topups/${old.id}/cheque`, { chequeNo: '000100', payee: 'Finance Head' });
    assert.equal(fix.status, 201, JSON.stringify(fix.body));
    assert.equal(fix.body.date, '2026-01-05');
    assert.equal((await call('admin', 'PATCH', `/finance/petty-cash/topups/${old.id}/cheque`, { chequeNo: '000101' })).status, 400); // it has one now
  });

  it('is Finance’s: the petty cash desk cannot see or change the register', async () => {
    assert.equal((await call('counter', 'GET', '/finance/cheques')).status, 403);
    assert.equal((await call('counter', 'POST', '/finance/cheques', { chequeNo: '1', date: today })).status, 403);
  });
});
