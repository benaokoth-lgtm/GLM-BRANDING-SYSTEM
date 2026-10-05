// Employee details (National ID, KRA PIN, SHIF number), the company KRA PIN, and the P9 worked out from the logged payroll.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('employee details, payroll identifiers and the P9', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Employee Finance', canAccessFinance: true } });
    await prisma.role.create({ data: { name: 'Employee Plain', canCaptureOrders: true } });
    const fin = await prisma.user.create({ data: { name: 'Fin Person', firstName: 'Fin', lastName: 'Person', role: 'Employee Finance', pinHash: 'x' } });
    const a = await prisma.user.create({ data: { name: 'Amos Mutua', firstName: 'Amos', lastName: 'Mutua', role: 'Employee Plain', pinHash: 'x' } });
    const b = await prisma.user.create({ data: { name: 'Bella Chebet', firstName: 'Bella', lastName: 'Chebet', role: 'Employee Plain', pinHash: 'x' } });
    const plain = await prisma.user.create({ data: { name: 'Plain Person', firstName: 'Plain', lastName: 'Person', role: 'Employee Plain', pinHash: 'x' } });
    ids.fin = fin.id; ids.amos = a.id; ids.bella = b.id;
    tokens.fin = signToken({ id: fin.id, name: fin.name, role: 'Employee Finance' });
    tokens.plain = signToken({ id: plain.id, name: plain.name, role: 'Employee Plain' });
    const admin = await prisma.user.create({ data: { name: 'Emp Admin', firstName: 'Emp', lastName: 'Admin', role: 'Admin', pinHash: 'x' } });
    tokens.admin = signToken({ id: admin.id, name: admin.name, role: 'Admin' });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('captures National ID, KRA PIN and SHIF number, tidied; each is optional; National ID and KRA PIN are unique', async () => {
    const ok = await call('fin', 'PUT', `/finance/employees/${ids.amos}`, { nationalId: ' 12345 678 ', kraPin: 'a123456789b', shifNumber: 'shif-0012345' });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.nationalId, ok.body.kraPin, ok.body.shifNumber], ['12345678', 'A123456789B', 'SHIF-0012345']);

    assert.equal((await call('fin', 'PUT', `/finance/employees/${ids.amos}`, { nationalId: '123' })).status, 400);
    assert.equal((await call('fin', 'PUT', `/finance/employees/${ids.amos}`, { kraPin: 'nonsense' })).status, 400);
    // someone else cannot take the same ID or PIN
    const clashId = await call('fin', 'PUT', `/finance/employees/${ids.bella}`, { nationalId: '12345678' });
    assert.equal(clashId.status, 400);
    assert.match(clashId.body.error, /Amos Mutua/);
    assert.equal((await call('fin', 'PUT', `/finance/employees/${ids.bella}`, { kraPin: 'A123456789B' })).status, 400);
    // …but keeping your own is fine, and each can be cleared
    assert.equal((await call('fin', 'PUT', `/finance/employees/${ids.amos}`, { nationalId: '12345678', kraPin: 'A123456789B', shifNumber: 'SHIF-0012345' })).status, 200);
    const cleared = await call('fin', 'PUT', `/finance/employees/${ids.bella}`, {});
    assert.deepEqual([cleared.body.nationalId, cleared.body.kraPin, cleared.body.shifNumber], [null, null, null]);
    assert.equal((await call('fin', 'PUT', '/finance/employees/999999', {})).status, 404);

    const list = (await call('fin', 'GET', '/finance/employees')).body as any[];
    assert.equal(list.find((u) => u.id === ids.amos).kraPin, 'A123456789B');
  });

  it('is for Finance only', async () => {
    assert.equal((await call('plain', 'GET', '/finance/employees')).status, 403);
    assert.equal((await call('plain', 'PUT', `/finance/employees/${ids.amos}`, {})).status, 403);
    assert.equal((await call('plain', 'GET', '/finance/p9?year=2031')).status, 403);
  });

  it('the company KRA PIN is kept with the company details and checked the same way', async () => {
    assert.equal((await call('admin', 'PUT', '/master-data/settings', { kraPin: 'bad' })).status, 400);
    const ok = await call('admin', 'PUT', '/master-data/settings', { kraPin: 'p051234567z' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.kraPin, 'P051234567Z');
  });

  it('payroll rows carry the identifiers, and the P9 is worked out month by month as the payroll did', async () => {
    // Amos is paid KES 100,000 in May and again in June; a casual and someone else's year stay out of his card
    await prisma.payrollEntry.create({ data: { date: '2031-05-28', staffId: ids.amos, employeeType: 'Employee', grossPay: 100000, paymentSource: 'Bank/Cheque' } });
    await prisma.payrollEntry.create({ data: { date: '2031-06-28', staffId: ids.amos, employeeType: 'Employee', grossPay: 100000, paymentSource: 'Bank/Cheque' } });
    await prisma.payrollEntry.create({ data: { date: '2031-06-28', staffId: ids.bella, employeeType: 'Casual', grossPay: 8000, paymentSource: 'Petty Cash' } });
    await prisma.payrollEntry.create({ data: { date: '2032-01-28', staffId: ids.amos, employeeType: 'Employee', grossPay: 100000, paymentSource: 'Bank/Cheque' } });

    const payroll = (await call('fin', 'GET', '/finance/payroll?from=2031-05-01&to=2031-05-31')).body;
    const row = payroll.rows.find((r: any) => r.staffId === ids.amos);
    assert.deepEqual([row.nationalId, row.kraPin, row.shifNumber], ['12345678', 'A123456789B', 'SHIF-0012345']);

    const p9 = (await call('fin', 'GET', '/finance/p9?year=2031')).body;
    assert.equal(p9.year, '2031');
    assert.equal(p9.employer.kraPin, 'P051234567Z');
    const me = p9.employees.find((e: any) => e.staff.id === ids.amos);
    assert.ok(me, 'Amos has a card');
    assert.ok(!p9.employees.some((e: any) => e.staff.id === ids.bella), 'a casual has no P9');
    const may = me.months[4];
    // 100,000: tax by the bands = 2,400 + 2,083.25 + 20,300.10 = 24,783.35; personal relief 2,400; PAYE 22,383.35
    assert.deepEqual([may.gross, may.taxable, may.taxCharged, may.relief, may.paye], [100000, 100000, 24783.35, 2400, 22383.35]);
    assert.deepEqual([may.nssf, may.shif, may.housingLevy], [12000, 2750, 3000]);
    assert.equal(me.months[5].paye, 22383.35);
    assert.equal(me.months[0].gross, 0); // January has nothing
    assert.equal(me.totals.gross, 200000);
    assert.equal(me.totals.paye, 44766.7);
    // only his own year, and one person on request
    assert.equal((await call('fin', 'GET', `/finance/p9?year=2032&staffId=${ids.amos}`)).body.employees[0].totals.gross, 100000);
    assert.equal((await call('fin', 'GET', `/finance/p9?year=2031&staffId=${ids.bella}`)).body.employees.length, 0);
    assert.equal((await call('fin', 'GET', '/finance/p9?year=nope')).status, 400);
  });
});
