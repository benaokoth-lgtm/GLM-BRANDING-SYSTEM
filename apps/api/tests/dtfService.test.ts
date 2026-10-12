// A DTF film sale or artwork job is recorded against a price-list service. The sale must never stop because that service is missing, renamed or taken off the list.
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
let token = '';
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const filmServices = () => prisma.service.findMany({ where: { OR: [{ name: 'DTF Sheet (per metre)' }, { soldViaDtfModule: true, unit: 'metre' }] } });
const sell = async (rollId: string) => call('POST', '/dtf/sales', { rollId, client: 'Service Client', metres: 2 });

describe('the DTF film and artwork services on the price list', () => {
  let rollId = '';
  before(async () => {
    await prisma.role.create({ data: { name: 'Lead (dtf service test)', canAccessDtf: true, canManageDtf: true, canCaptureOrders: true } });
    const u = await prisma.user.create({ data: { name: 'lead (dtf service test)', role: 'Lead (dtf service test)', pinHash: 'x' } });
    token = signToken({ id: u.id, name: u.name, role: 'Lead (dtf service test)' });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const roll = await call('POST', '/dtf/rolls', { filmCost: 6000, inkPowderCost: 0 });
    rollId = roll.body.id;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('is created when the price list has none, renamed ones are used, and a retired one is brought back', async () => {
    // 1. nothing on the list (a database that was never seeded): hide every existing film service for a moment
    const existing = await filmServices();
    for (const s of existing) await prisma.service.update({ where: { id: s.id }, data: { name: `held ${s.id}`, soldViaDtfModule: false } });
    const first = await sell(rollId);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const created = await prisma.service.findFirst({ where: { name: 'DTF Sheet (per metre)' } });
    assert.ok(created, 'the service was created');
    assert.deepEqual([created!.unit, created!.soldViaDtfModule, created!.retired], ['metre', true, false]);

    // 2. renamed in Master Data: still found (as the DTF film service), and no second one is made
    await prisma.service.update({ where: { id: created!.id }, data: { name: 'DTF Film (renamed)' } });
    const second = await sell(rollId);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(await prisma.service.count({ where: { name: 'DTF Sheet (per metre)' } }), 0);
    assert.equal(await prisma.service.count({ where: { soldViaDtfModule: true, unit: 'metre' } }), 1);

    // 3. taken off the price list: it is put back
    await prisma.service.update({ where: { id: created!.id }, data: { retired: true } });
    const third = await sell(rollId);
    assert.equal(third.status, 201, JSON.stringify(third.body));
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: created!.id } })).retired, false);

    // put the price list back as it was
    await prisma.service.update({ where: { id: created!.id }, data: { name: 'DTF Sheet (per metre)' } });
    for (const s of existing) await prisma.service.update({ where: { id: s.id }, data: { name: s.name, soldViaDtfModule: s.soldViaDtfModule } });
  });
  it('the same for the artwork service ("DTF Printing"): created when missing, a renamed one is used, a retired one is brought back', async () => {
    const printServices = () => prisma.service.findMany({ where: { OR: [{ name: 'DTF Printing' }, { soldViaDtfModule: true, unit: 'sqm' }] } });
    const job = () => call('POST', '/dtf/jobs', { rollId, client: 'Artwork Client', runningMetres: 1, pieces: 36, heatPressFee: 20, amountPaid: 0 });
    const existing = await printServices();
    for (const s of existing) await prisma.service.update({ where: { id: s.id }, data: { name: `held print ${s.id}`, soldViaDtfModule: false } });

    const first = await job();
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const created = await prisma.service.findFirst({ where: { name: 'DTF Printing' } });
    assert.ok(created, 'the service was created');
    assert.deepEqual([created!.unit, created!.soldViaDtfModule, created!.chargesPressingFee, created!.retired], ['sqm', true, true, false]);

    await prisma.service.update({ where: { id: created!.id }, data: { name: 'DTF Artwork (renamed)' } });
    assert.equal((await job()).status, 201);
    assert.equal(await prisma.service.count({ where: { name: 'DTF Printing' } }), 0);
    assert.equal(await prisma.service.count({ where: { soldViaDtfModule: true, unit: 'sqm' } }), 1);

    await prisma.service.update({ where: { id: created!.id }, data: { retired: true } });
    assert.equal((await job()).status, 201);
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: created!.id } })).retired, false);

    await prisma.service.update({ where: { id: created!.id }, data: { name: 'DTF Printing' } });
    for (const s of existing) await prisma.service.update({ where: { id: s.id }, data: { name: s.name, soldViaDtfModule: s.soldViaDtfModule } });
  });
});
