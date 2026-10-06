// The service price list: Description and Size — a service such as a banner comes in sizes, each its own line with its own price.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
let token = '';

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('service price list: description and size', () => {
  before(async () => {
    const admin = await prisma.user.create({ data: { name: 'Svc Admin', firstName: 'Svc', lastName: 'Admin', role: 'Admin', pinHash: 'x' } });
    token = signToken({ id: admin.id, name: admin.name, role: 'Admin' });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('a service with a description and size is named by service and size; the same service can have another size', async () => {
    const a3 = await call('POST', '/master-data/services', { name: 'Banner (svc test)', description: 'Vinyl, eyelets', size: 'A3', unit: 'piece', price: 800 });
    assert.equal(a3.status, 201);
    assert.deepEqual([a3.body.name, a3.body.item, a3.body.size, a3.body.description], ['Banner (svc test) — A3', 'Banner (svc test)', 'A3', 'Vinyl, eyelets']);
    const a2 = await call('POST', '/master-data/services', { name: 'Banner (svc test)', description: 'Vinyl, eyelets', size: 'A2', unit: 'piece', price: 1200 });
    assert.equal(a2.status, 201);
    assert.equal(a2.body.name, 'Banner (svc test) — A2');
    const dup = await call('POST', '/master-data/services', { name: 'banner (svc test)', size: 'a3', unit: 'piece', price: 5 });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /already in the service price list/);
  });

  it('a service with no size keeps its plain name; description and size are edited in place', async () => {
    const plain = await call('POST', '/master-data/services', { name: 'Sticker (svc test)', unit: 'piece', price: 50 });
    assert.equal(plain.body.name, 'Sticker (svc test)');
    assert.equal(plain.body.size, '');
    const sized = await call('PUT', `/master-data/services/${plain.body.id}`, { size: 'Small', description: 'Gloss' });
    assert.equal(sized.status, 200);
    assert.deepEqual([sized.body.name, sized.body.size, sized.body.description], ['Sticker (svc test) — Small', 'Small', 'Gloss']);
    const cleared = await call('PUT', `/master-data/services/${plain.body.id}`, { size: '' });
    assert.equal(cleared.body.name, 'Sticker (svc test)');
    const other = await call('POST', '/master-data/services', { name: 'Sticker (svc test)', size: 'Large', unit: 'piece', price: 90 });
    assert.equal((await call('PUT', `/master-data/services/${other.body.id}`, { size: '' })).status, 400); // that name is taken
  });

  it('services made before sizes existed get their item filled in; the DTF services keep their names', async () => {
    const old = await prisma.service.create({ data: { name: 'Old Service (svc test)', unit: 'piece', price: 10 } });
    const list = (await call('GET', '/master-data/services')).body as any[];
    assert.equal(list.find((s) => s.id === old.id).item, 'Old Service (svc test)');
    const dtf = await prisma.service.create({ data: { name: 'DTF Svc Test', item: 'DTF Svc Test', unit: 'sqm', price: 100, soldViaDtfModule: true } });
    assert.equal((await call('PUT', `/master-data/services/${dtf.id}`, { size: 'A4' })).status, 400);
    assert.equal((await call('PUT', `/master-data/services/${dtf.id}`, { description: 'Film' })).status, 200);
  });
});
