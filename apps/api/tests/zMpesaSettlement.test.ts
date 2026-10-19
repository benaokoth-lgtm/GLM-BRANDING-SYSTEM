// NCBA settles the Paybill into the bank every day: each settlement moves money from the M-Pesa account to the Bank account (a charge NCBA takes is Bank Charges), and can be reversed.
// (Named z… because it adds money to the M-Pesa account and journals to the books.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ACCT, todayStr } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { loadLedger, naturalBalance, sumByAccount } from '../src/accounting/ledger';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const bal = async (code: string) => {
  const l = await loadLedger();
  const a = l.byCode.get(code)!;
  return naturalBalance(a.type, sumByAccount(l.postings, () => true).get(a.id));
};

describe('M-Pesa settled to the bank', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Cashier (settle test)', canManagePayments: true } });
    await prisma.role.create({ data: { name: 'Accountant (settle test)', canAccessAccounting: true } });
    for (const [key, role] of [['admin', 'Admin'], ['cashier', 'Cashier (settle test)'], ['acct', 'Accountant (settle test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (settle test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // 10,000 reached the Paybill today (booked to M-Pesa when it arrived)
    await call('admin', 'GET', '/accounting/accounts'); // makes sure the chart exists
    await prisma.mpesaTransaction.create({ data: { checkoutRequestId: 'SETTLE-C2B-1', merchantRequestId: '', kind: 'C2B', status: 'Unmatched', phone: '254712345678', amount: 10000, mpesaReceipt: 'SETTLE0001', receivedOn: todayStr(), accountReference: 'X', createdByName: 'test' } });
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('is for people who keep the books, not for a cashier', async () => {
    assert.equal((await call('cashier', 'GET', '/accounting/mpesa/settlements')).status, 403);
    assert.equal((await call('cashier', 'POST', '/accounting/mpesa/settlements', { date: todayStr(), amount: 100 })).status, 403);
    assert.equal((await call('acct', 'GET', '/accounting/mpesa/settlements')).status, 200);
  });

  it('shows what is in M-Pesa, and what came in each day', async () => {
    const r = (await call('acct', 'GET', '/accounting/mpesa/settlements')).body;
    assert.equal(r.balance, await bal(ACCT.mpesa));
    assert.ok(r.balance >= 10000);
    const today = r.days.find((d: any) => d.date === todayStr());
    assert.ok(today.received >= 10000);
  });

  it('a settlement moves the money to the bank, with the charge as Bank Charges, and shows by day', async () => {
    const mBefore = await bal(ACCT.mpesa);
    const bBefore = await bal(ACCT.bank);
    const cBefore = await bal('5200');
    const r = await call('acct', 'POST', '/accounting/mpesa/settlements', { date: todayStr(), amount: 4000, charges: 25, reference: 'NCBA-S-001', note: 'daily' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.ref, /^STL-\d{8}-01$/);
    assert.equal(await bal(ACCT.mpesa), mBefore - 4025);
    assert.equal(await bal(ACCT.bank), bBefore + 4000);
    assert.equal(await bal('5200'), cBefore + 25);
    const list = (await call('acct', 'GET', '/accounting/mpesa/settlements')).body;
    assert.deepEqual([list.settlements[0].amount, list.settlements[0].charges], [4000, 25]);
    assert.match(list.settlements[0].memo, /ref NCBA-S-001/);
    assert.equal(list.days.find((d: any) => d.date === todayStr()).settled, 4025);
    // a second one the same day gets its own number
    const again = await call('acct', 'POST', '/accounting/mpesa/settlements', { date: todayStr(), amount: 1000 });
    assert.match(again.body.ref, /^STL-\d{8}-02$/);
  });

  it('refuses more than is in M-Pesa, a future date, and nonsense', async () => {
    const balance = (await call('acct', 'GET', '/accounting/mpesa/settlements')).body.balance;
    const over = await call('acct', 'POST', '/accounting/mpesa/settlements', { date: todayStr(), amount: balance + 1 });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /is in the M-Pesa account/);
    assert.equal((await call('acct', 'POST', '/accounting/mpesa/settlements', { date: '2999-01-01', amount: 10 })).status, 400);
    assert.equal((await call('acct', 'POST', '/accounting/mpesa/settlements', { date: todayStr(), amount: 0 })).status, 400);
    assert.equal((await call('acct', 'POST', '/accounting/mpesa/settlements', { date: todayStr(), amount: 5, charges: -1 })).status, 400);
  });

  it('is reversed from the journals, by an Admin, and the books go back', async () => {
    const list = (await call('acct', 'GET', '/accounting/mpesa/settlements')).body;
    const first = list.settlements.find((s: any) => s.charges === 25);
    const mBefore = await bal(ACCT.mpesa);
    const bBefore = await bal(ACCT.bank);
    assert.equal((await call('acct', 'DELETE', `/accounting/journals/${first.id}`)).status, 403);
    assert.equal((await call('admin', 'DELETE', `/accounting/journals/${first.id}`)).status, 204);
    assert.equal(await bal(ACCT.mpesa), mBefore + 4025);
    assert.equal(await bal(ACCT.bank), bBefore - 4000);
  });
});
