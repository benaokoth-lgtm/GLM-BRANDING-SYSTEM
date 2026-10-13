// "Contracted out" is gone from the price list (Master Data) and the General Order: a service can no longer be marked that way, and one that was is put back to an ordinary service —
// except the services Job Costing makes for a costed job, which are sold through their own screen.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { clearContractedOutOnce } from '../src/embroideryLegacy';

let server: Server;
let base = '';
let token = '';
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('contracted-out services are gone', () => {
  before(async () => {
    const u = (await prisma.user.findFirst({ where: { role: 'Admin', active: true } })) ?? (await prisma.user.create({ data: { name: 'admin (contracted test)', role: 'Admin', pinHash: 'x' } }));
    token = signToken({ id: u.id, name: u.name, role: 'Admin' });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await prisma.service.deleteMany({ where: { name: { in: ['Eulogy booklets (co test)', 'Costed job — co test', 'Plain (co test)'] } } });
    server.close();
    await prisma.$disconnect();
  });

  it('a service cannot be made contracted out, by adding it or by editing it', async () => {
    const add = await call('POST', '/master-data/services', { name: 'Plain (co test)', unit: 'piece', price: 100, outsourced: true, supplierName: 'Acme', defaultSupplierCost: 40 });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.deepEqual([add.body.outsourced, add.body.supplierName, add.body.defaultSupplierCost], [false, '', null]);
    const edit = await call('PUT', `/master-data/services/${add.body.id}`, { price: 120, outsourced: true, markupValue: 30 });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.price, 120);
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: add.body.id } })).outsourced, false);
  });

  it('a service an earlier version had marked is put back, but a costed job’s service keeps it', async () => {
    const old = await prisma.service.create({ data: { name: 'Eulogy booklets (co test)', item: 'Eulogy booklets (co test)', unit: 'piece', price: 200, outsourced: true, supplierName: 'Acme' } });
    const costed = await prisma.service.create({ data: { name: 'Costed job — co test', item: 'Costed job — co test', unit: 'piece', price: 0, outsourced: true, soldViaDtfModule: true } });
    await clearContractedOutOnce();
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: old.id } })).outsourced, false);
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: costed.id } })).outsourced, true);
  });
});
