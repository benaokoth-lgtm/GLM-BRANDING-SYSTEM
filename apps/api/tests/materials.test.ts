// The stock price list: Item, Description, Size, Unit, Price — an item such as a polo shirt comes in sizes, each with its own price.
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

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const names = async () => ((await call('admin', 'GET', '/master-data/materials')).body as any[]).map((m) => m.name);

describe('stock price list with sizes', () => {
  before(async () => {
    const admin = await prisma.user.create({ data: { name: 'Price Admin', firstName: 'Price', lastName: 'Admin', role: 'Admin', pinHash: 'x' } });
    tokens.admin = signToken({ id: admin.id, name: admin.name, role: 'Admin' });
    await prisma.role.create({ data: { name: 'Price Stock', canApproveStock: true } });
    await prisma.role.create({ data: { name: 'Price Plain', canCaptureOrders: true } });
    const stock = await prisma.user.create({ data: { name: 'Price Stock', firstName: 'Price', lastName: 'Stock', role: 'Price Stock', pinHash: 'x' } });
    const plain = await prisma.user.create({ data: { name: 'Price Plain', firstName: 'Price', lastName: 'Plain', role: 'Price Plain', pinHash: 'x' } });
    tokens.stock = signToken({ id: stock.id, name: stock.name, role: 'Price Stock' });
    tokens.plain = signToken({ id: plain.id, name: plain.name, role: 'Price Plain' });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('a polo shirt in L and XL becomes two lines, each with its own price, named by item and size', async () => {
    const r = await call('admin', 'POST', '/master-data/materials', { item: 'Polo Shirt (price test)', description: 'Cotton, collared', unit: 'piece', variants: [{ size: 'L', price: 1200 }, { size: 'XL', price: 1300 }] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.map((m: any) => [m.name, m.item, m.size, m.price, m.unit, m.description]), [
      ['Polo Shirt (price test) — L', 'Polo Shirt (price test)', 'L', 1200, 'piece', 'Cotton, collared'],
      ['Polo Shirt (price test) — XL', 'Polo Shirt (price test)', 'XL', 1300, 'piece', 'Cotton, collared'],
    ]);
    assert.equal(r.body[0].stockQty, 0); // each size has its own stock
    assert.ok((await names()).includes('Polo Shirt (price test) — XL'));
  });

  it('more sizes can be added later; a size cannot be entered twice; sizes must be named', async () => {
    const more = await call('admin', 'POST', '/master-data/materials', { item: 'polo shirt (price test)', variants: [{ size: 'XXL', price: 1400 }] }); // the item's name is matched ignoring capitals
    assert.equal(more.status, 201);
    assert.equal(more.body[0].name, 'polo shirt (price test) — XXL');
    const again = await call('admin', 'POST', '/master-data/materials', { item: 'Polo Shirt (price test)', variants: [{ size: 'l', price: 999 }] });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already in the price list/);
    assert.equal((await call('admin', 'POST', '/master-data/materials', { item: 'Tee (price test)', variants: [{ size: 'M', price: 500 }, { size: 'm', price: 600 }] })).status, 400);
    assert.equal((await call('admin', 'POST', '/master-data/materials', { item: 'Tee (price test)', variants: [{ size: 'M', price: 500 }, { size: '', price: 600 }] })).status, 400);
    assert.equal((await call('admin', 'POST', '/master-data/materials', { item: 'Tee (price test)', variants: [{ size: 'S', price: 0 }] })).status, 400);
    assert.equal((await call('admin', 'POST', '/master-data/materials', { item: 'Polo Shirt (price test)', variants: [{ size: '', price: 100 }] })).status, 400); // it comes in sizes
  });

  it('an item with one price and no size still works, the old way too; it cannot later grow sizes by accident', async () => {
    const cap = await call('admin', 'POST', '/master-data/materials', { name: 'Cap (price test)', price: 450 });
    assert.equal(cap.status, 201);
    assert.deepEqual([cap.body[0].name, cap.body[0].item, cap.body[0].size, cap.body[0].unit], ['Cap (price test)', 'Cap (price test)', '', 'piece']);
    const sizes = await call('admin', 'POST', '/master-data/materials', { item: 'Cap (price test)', variants: [{ size: 'L', price: 500 }] });
    assert.equal(sizes.status, 400);
    assert.match(sizes.body.error, /without a size/);
  });

  it('price, size, unit and description are edited in place; changing a size renames that line; renaming the item renames every size', async () => {
    const polo = ((await call('admin', 'GET', '/master-data/materials')).body as any[]).find((m) => m.name === 'Polo Shirt (price test) — L');
    const edited = await call('stock', 'PUT', `/master-data/materials/${polo.id}`, { price: 1250, unit: 'pair', description: 'Cotton pique' });
    assert.equal(edited.status, 200);
    assert.deepEqual([edited.body.price, edited.body.unit, edited.body.description, edited.body.name], [1250, 'pair', 'Cotton pique', 'Polo Shirt (price test) — L']);

    assert.equal((await call('stock', 'PUT', `/master-data/materials/${polo.id}`, { size: 'XL' })).status, 400); // XL exists
    const resized = await call('stock', 'PUT', `/master-data/materials/${polo.id}`, { size: 'Large' });
    assert.equal(resized.body.name, 'Polo Shirt (price test) — Large');

    const renamed = await call('stock', 'PUT', `/master-data/materials/${polo.id}`, { item: 'Golf Shirt (price test)' });
    assert.equal(renamed.status, 200);
    const all = await names();
    assert.ok(all.includes('Golf Shirt (price test) — Large') && all.includes('Golf Shirt (price test) — XL'), 'every size followed the item');
    assert.ok(!all.some((n) => n.startsWith('Polo Shirt (price test)')), 'nothing is left under the old name');
    assert.equal((await call('stock', 'PUT', `/master-data/materials/${polo.id}`, { item: 'Cap (price test)' })).status, 400); // Cap has one line with no size: it cannot take a sized line
  });

  it('lines made before sizes existed get their item filled in; only Admin adds, Stock edits, nobody else', async () => {
    const old = await prisma.material.create({ data: { name: 'Old Blank (price test)', price: 300 } });
    const list = (await call('admin', 'GET', '/master-data/materials')).body as any[];
    assert.equal(list.find((m) => m.id === old.id).item, 'Old Blank (price test)');
    assert.equal((await call('stock', 'POST', '/master-data/materials', { item: 'Nope', price: 1 })).status, 403);
    assert.equal((await call('plain', 'PUT', `/master-data/materials/${old.id}`, { price: 1 })).status, 403);
    assert.equal((await call('admin', 'PUT', '/master-data/materials/999999', { price: 5 })).status, 404);
  });
});
