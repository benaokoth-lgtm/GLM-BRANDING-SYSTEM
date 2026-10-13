// The market-survey sheet: everything we sell and the specification to price it, with none of our prices on it.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { readXlsx } from '../src/xlsx';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const get = (who: string) => fetch(`${base}/api/pricelists/market-survey.xlsx`, { headers: { Authorization: `Bearer ${tokens[who]}` } });

describe('market survey sheet', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Seller (survey test)', canCaptureOrders: true } });
    const u = await prisma.user.create({ data: { name: 'seller (survey test)', role: 'Seller (survey test)', pinHash: 'x' } });
    tokens.seller = signToken({ id: u.id, name: u.name, role: u.role });
    const a = (await prisma.user.findFirst({ where: { role: 'Admin', active: true } })) ?? (await prisma.user.create({ data: { name: 'admin (survey test)', role: 'Admin', pinHash: 'x' } }));
    tokens.admin = signToken({ id: a.id, name: a.name, role: 'Admin' });
    await prisma.service.create({ data: { name: 'Survey Mug Print', item: 'Survey Mug Print', description: 'Full wrap', unit: 'piece', price: 12345.67 } });
    await prisma.service.create({ data: { name: 'Survey Retired Thing', item: 'Survey Retired Thing', unit: 'piece', price: 7777, retired: true } });
    await prisma.material.create({ data: { name: 'Survey Apron — L', item: 'Survey Apron', size: 'L', unit: 'piece', price: 8765.43 } });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await prisma.service.deleteMany({ where: { name: { startsWith: 'Survey ' } } });
    await prisma.material.deleteMany({ where: { name: { startsWith: 'Survey ' } } });
    server.close();
    await prisma.$disconnect();
  });

  it('is for an Admin', async () => {
    assert.equal((await get('seller')).status, 403);
    assert.equal((await get('admin')).status, 200);
  });

  it('lists the services, the stock and the formula-priced jobs, with the specification and room for competitors — and no price of ours', async () => {
    const res = await get('admin');
    assert.match(res.headers.get('content-type') ?? '', /spreadsheetml/);
    const grid = readXlsx(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual(grid[0]!.slice(0, 3), ['No.', 'Category', 'Item / service']);
    assert.ok(grid[0]!.includes('Competitor 1 price') && grid[0]!.includes('Competitor 5 price'));
    const rows = grid.slice(1);
    const find = (item: string) => rows.find((r) => r[2] === item);
    // the price list as it is (a retired line is left out), and the stock list
    assert.deepEqual([find('Survey Mug Print')?.[1], find('Survey Mug Print')?.[3], find('Survey Mug Print')?.[5]], ['Services', 'Full wrap', 'piece']);
    assert.equal(find('Survey Retired Thing'), undefined);
    assert.deepEqual([find('Survey Apron')?.[1], find('Survey Apron')?.[4]], ['Stock items', 'L']);
    // what the system prices by formula is spelled out
    const cats = new Set(rows.map((r) => r[1]));
    for (const c of ['DTF & UV DTF', 'UV pens', 'Embroidery', 'Business cards', 'Signage', 'Eulogies', 'Company profiles', 'Brochures']) assert.ok(cats.has(c), c);
    assert.ok(find('UV-printed pen, 100 pens'));
    assert.match(find('Eulogy booklet, 8 pages, 100 copies')![6]!, /130gsm gloss/);
    // numbered, and no price anywhere: not ours, not the system's tiers
    assert.deepEqual(rows.slice(0, 3).map((r) => r[0]), ['1', '2', '3']);
    const everything = grid.flat().join('|');
    assert.ok(!everything.includes('12345.67') && !everything.includes('8765.43'));
    assert.ok(!/\b(Price|Cost)\b/i.test(grid[0]!.filter((h) => !h.startsWith('Competitor') && !h.startsWith('Compare')).join('|')));
    // the services the system sells through their own screens are not repeated as list lines
    assert.equal(rows.filter((r) => r[1] === 'Services' && /DTF Sheet|DTF Printing/.test(r[2]!)).length, 0);
  });
});
