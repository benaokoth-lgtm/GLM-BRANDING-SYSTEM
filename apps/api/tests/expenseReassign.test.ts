// A posted expense can be moved to the right expense head (account category) without an amendment request; the ones the system itself ties to
// something (an outsourced job's bill, freelance commission with tax withheld) cannot. Corporate clients are managed from Finance.
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
const today = new Date().toISOString().slice(0, 10);

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('reassigning an expense after posting', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Reassign Finance', canAccessFinance: true } });
    await prisma.role.create({ data: { name: 'Reassign Plain' } });
    const f = await prisma.user.create({ data: { name: 'fin (reassign test)', role: 'Reassign Finance', pinHash: 'x' } });
    const p = await prisma.user.create({ data: { name: 'plain (reassign test)', role: 'Reassign Plain', pinHash: 'x' } });
    tokens.fin = signToken({ id: f.id, name: f.name, role: 'Reassign Finance' });
    tokens.plain = signToken({ id: p.id, name: p.name, role: 'Reassign Plain' });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('moves a posted expense to another head, leaving the amount and date alone', async () => {
    const heads: string[] = (await call('fin', 'GET', `/finance/expenses?from=${today}&to=${today}`)).body.expenseCategories;
    assert.ok(heads.length >= 2);
    const [a, b] = heads as [string, string];
    const e = await call('fin', 'POST', '/finance/expenses', { date: today, category: a, amount: 500, supplier: 'S', method: 'Bank Transfer' });
    assert.equal(e.status, 201);
    const url = `/finance/expenses/${e.body.id}/category`;

    assert.equal((await call('plain', 'PATCH', url, { category: b })).status, 403); // Finance only
    assert.equal((await call('fin', 'PATCH', url, { category: 'No such head' })).status, 400);
    assert.equal((await call('fin', 'PATCH', '/finance/expenses/999999/category', { category: b })).status, 404);

    const moved = await call('fin', 'PATCH', url, { category: b });
    assert.equal(moved.status, 200);
    const row = await prisma.expense.findUniqueOrThrow({ where: { id: e.body.id } });
    assert.equal(row.category, b);
    assert.equal(row.amount, 500);
    assert.equal(row.date, today);
    // the audit trail records where it came from
    const audit = await prisma.auditLog.findFirst({ where: { path: `/api${url}` }, orderBy: { id: 'desc' } });
    assert.ok(audit?.detail.includes(a), 'the audit entry names the previous head');
  });

  it('moves a supplier bill off an outsourced job only when told to, so wrongly captured costs can be corrected', async () => {
    const heads: string[] = (await call('fin', 'GET', `/finance/expenses?from=${today}&to=${today}`)).body.expenseCategories;
    const legal = heads.find((h) => h !== 'Outsourced Services')!;
    const f = await prisma.user.findFirstOrThrow({ where: { name: 'fin (reassign test)' } });
    const order = await prisma.order.create({ data: { orderNo: 'REASSIGN-1', kind: 'walkin', staffId: f.id, createdDate: today, status: 'Order', stage: 'Design' } });
    const bill = await prisma.expense.create({ data: { date: today, category: 'Outsourced Services', amount: 1000, orderId: order.id, supplier: 'Law firm', method: 'Bank Transfer' } });
    const url = `/finance/expenses/${bill.id}/category`;
    const refused = await call('fin', 'PATCH', url, { category: legal });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /REASSIGN-1/);
    assert.equal((await prisma.expense.findUniqueOrThrow({ where: { id: bill.id } })).category, 'Outsourced Services');
    assert.equal((await call('fin', 'PATCH', url, { category: legal, detachFromJob: true })).status, 200);
    const after = await prisma.expense.findUniqueOrThrow({ where: { id: bill.id } });
    assert.equal(after.category, legal);
    assert.equal(after.orderId, null);
  });

  it('refuses expenses the system ties to something', async () => {
    const heads: string[] = (await call('fin', 'GET', `/finance/expenses?from=${today}&to=${today}`)).body.expenseCategories;
    const target = heads[1]!;
    const withheld = await prisma.expense.create({ data: { date: today, category: heads[0]!, amount: 100, withholdingTax: 5 } });
    const r = await call('fin', 'PATCH', `/finance/expenses/${withheld.id}/category`, { category: target });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /withheld/);
    assert.equal((await prisma.expense.findUniqueOrThrow({ where: { id: withheld.id } })).category, heads[0]);
  });
});

describe('corporate clients are managed from Finance', () => {
  before(async () => {
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('a finance role can add and edit one; a role without finance access cannot', async () => {
    assert.equal((await call('plain', 'POST', '/master-data/corporate-clients', { name: 'Nope Ltd (reassign test)', creditDays: 30 })).status, 403);
    const added = await call('fin', 'POST', '/master-data/corporate-clients', { name: 'Acme Corp (reassign test)', creditDays: 45, email: 'ap@acme.test' });
    assert.equal(added.status, 201);
    const edited = await call('fin', 'PUT', `/master-data/corporate-clients/${added.body.id}`, { phone: '0700 000 000' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.phone, '0700 000 000');
    assert.equal((await call('plain', 'PUT', `/master-data/corporate-clients/${added.body.id}`, { phone: 'x' })).status, 403);
  });
});
