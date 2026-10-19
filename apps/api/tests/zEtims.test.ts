// KRA eTIMS, phase 1: the mapping of every business head, service and stock item to an item class code, units and an item type — proposed, checked, confirmed and
// loaded from Excel. (Named z… because it adds services and heads.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { etimsFor } from '../src/etims';
import { readXlsx, writeXlsx } from '../src/xlsx';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
let headId = 0;
let plainHeadId = 0;
let svcA = 0;
let svcB = 0;
let tee = 0;
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
async function upload(path: string, rows: (string | number | null)[][]) {
  const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${tokens.admin}` }, body: writeXlsx('x', rows) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const find = (overview: any, kind: string, id: number) => overview.items.find((i: any) => i.kind === kind && i.id === id);

describe('eTIMS item mapping', () => {
  before(async () => {
    for (const [key, role] of [['admin', 'Admin'], ['staff', 'Staff']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (etims test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    // the heads the proposal knows by name (they may already exist)
    headId = (await prisma.businessHead.findFirst({ where: { name: 'UV Printing' } }))?.id ?? (await prisma.businessHead.create({ data: { name: 'UV Printing' } })).id;
    plainHeadId = (await prisma.businessHead.create({ data: { name: 'Z Etims plain head' } })).id;
    svcA = (await prisma.service.create({ data: { name: 'Z Etims UV board', item: 'Z Etims UV board', unit: 'piece', price: 1000, businessHeadId: headId } })).id;
    svcB = (await prisma.service.create({ data: { name: 'Z Etims banner', item: 'Z Etims banner', unit: 'sqm', price: 500, businessHeadId: plainHeadId } })).id;
    tee = (await prisma.material.create({ data: { name: 'Z Etims T-Shirt', item: 'Z Etims T-Shirt', unit: 'piece', price: 800, businessHeadId: plainHeadId } })).id;
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('is for the Admin only', async () => {
    assert.equal((await call('staff', 'GET', '/etims/overview')).status, 403);
    assert.equal((await call('staff', 'PUT', '/etims/item', { kind: 'service', refId: svcA, clsCd: '82121503' })).status, 403);
  });

  it('starts with nothing mapped; every sale is VAT type B', async () => {
    const o = (await call('admin', 'GET', '/etims/overview')).body;
    assert.equal(o.taxType, 'B');
    assert.equal(find(o, 'service', svcA).state, 'missing');
    assert.equal(find(o, 'material', tee).search, 'T-shirts'); // what to look for in the KRA portal
    assert.ok(o.counts.missing >= 3);
  });

  it('proposes a code for the heads it knows, units for every line, and never overwrites', async () => {
    const r = await call('admin', 'POST', '/etims/propose');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const o = (await call('admin', 'GET', '/etims/overview')).body;
    const a = find(o, 'service', svcA);
    assert.deepEqual([a.eff.clsCd, a.eff.from, a.eff.qtyUnit, a.eff.itemType, a.state], ['82121503', 'head', 'U', 'service', 'proposed']);
    assert.equal(find(o, 'service', svcB).eff.qtyUnit, 'M2');
    assert.equal(find(o, 'service', svcB).state, 'missing'); // its head has no proposal: it needs a code
    assert.equal(find(o, 'material', tee).eff.itemType, 'finished');
    // a typed value survives another proposal run
    await call('admin', 'PUT', '/etims/item', { kind: 'service', refId: svcA, clsCd: '1234567890', qtyUnit: 'PR' });
    await call('admin', 'POST', '/etims/propose');
    const again = find((await call('admin', 'GET', '/etims/overview')).body, 'service', svcA);
    assert.deepEqual([again.eff.clsCd, again.eff.qtyUnit, again.eff.from, again.state], ['1234567890', 'PR', 'item', 'confirmed']);
    await call('admin', 'PUT', '/etims/item', { kind: 'service', refId: svcA }); // back to the head's
    await call('admin', 'POST', '/etims/propose'); // the unit it had went with the row: proposed again
    assert.equal(find((await call('admin', 'GET', '/etims/overview')).body, 'service', svcA).eff.from, 'head');
  });

  it('a line can be set by hand: checked codes, confirmed at once, cleared back to the head', async () => {
    assert.equal((await call('admin', 'PUT', '/etims/item', { kind: 'service', refId: svcB, clsCd: '12AB' })).status, 400);
    assert.equal((await call('admin', 'PUT', '/etims/item', { kind: 'service', refId: svcB, clsCd: '5059690800', itemType: 'bad' })).status, 400);
    assert.equal((await call('admin', 'PUT', '/etims/item', { kind: 'service', refId: 99999999, clsCd: '5059690800' })).status, 404);
    assert.equal((await call('admin', 'PUT', '/etims/item', { kind: 'service', refId: svcB, clsCd: '5059690800', qtyUnit: 'M2' })).status, 200);
    const b = find((await call('admin', 'GET', '/etims/overview')).body, 'service', svcB);
    assert.deepEqual([b.eff.clsCd, b.state, b.ready], ['5059690800', 'confirmed', true]);
    assert.equal(b.own.status, 'confirmed');
  });

  it('confirming a business head confirms what was proposed under it', async () => {
    const before = find((await call('admin', 'GET', '/etims/overview')).body, 'service', svcA);
    assert.equal(before.state, 'proposed');
    const r = await call('admin', 'POST', '/etims/confirm', { headId });
    assert.ok(r.body.confirmed >= 1);
    const after = find((await call('admin', 'GET', '/etims/overview')).body, 'service', svcA);
    assert.equal(after.state, 'confirmed');
    // a line with no code is not confirmed by it
    assert.equal(find((await call('admin', 'GET', '/etims/overview')).body, 'material', tee).state, 'missing');
  });

  it('what a line is sold under is available to the invoice (phase 2), and only when ready', async () => {
    assert.deepEqual(await etimsFor('service', svcA).then((r) => r && [r.clsCd, r.qtyUnit, r.from]), ['82121503', 'U', 'head']);
    assert.equal(await etimsFor('material', tee), null);
    assert.equal(await etimsFor('service', 99999999), null);
  });

  it('Excel: download, fill in the codes, check, upload', async () => {
    const res = await fetch(`${base}/api/etims/mapping.xlsx`, { headers: { Authorization: `Bearer ${tokens.admin}` } });
    assert.equal(res.status, 200);
    const grid = readXlsx(Buffer.from(await res.arrayBuffer()));
    assert.equal(grid[0]![0], 'Kind');
    const row = grid.find((r) => r[0] === 'Stock item' && Number(r[1]) === tee)!;
    assert.ok(row, 'the stock item is on the sheet');
    const HEAD = ['Kind', 'Id', 'KRA item class code', 'Quantity unit', 'Packaging unit', 'Item type', 'HS code', 'Status'];
    // a bad row refuses the whole upload and says which
    const bad = await upload('/etims/mapping', [HEAD, ['Stock item', tee, 'ABC', 'U', '', '', '', 'Confirmed'], ['Service', 99999999, '5059690800', 'U', '', '', '', '']]);
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.errors.map((e: any) => e.row), [2, 3]);
    // a check shows what would change and changes nothing
    const rows = [HEAD, ['Stock item', tee, '5359020100', 'U', 'NT', 'finished', '6109100000', 'Confirmed']];
    const dry = await upload('/etims/mapping?dryRun=1', rows);
    assert.deepEqual([dry.status, dry.body.updated, dry.body.errors.length], [200, 1, 0]);
    assert.equal(find((await call('admin', 'GET', '/etims/overview')).body, 'material', tee).state, 'missing');
    const done = await upload('/etims/mapping', rows);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const t = find((await call('admin', 'GET', '/etims/overview')).body, 'material', tee);
    assert.deepEqual([t.eff.clsCd, t.eff.pkgUnit, t.eff.hsCode, t.state], ['5359020100', 'NT', '6109100000', 'confirmed']);
    // the same sheet again changes nothing; a row marked anything but Confirmed is kept as proposed
    assert.equal((await upload('/etims/mapping', rows)).body.unchanged, 1);
    await upload('/etims/mapping', [HEAD, ['Stock item', tee, '5359020100', 'U', 'NT', 'finished', '6109100000', 'Proposed']]);
    assert.equal(find((await call('admin', 'GET', '/etims/overview')).body, 'material', tee).state, 'proposed');
    // blank columns clear the line back to its head
    await upload('/etims/mapping', [HEAD, ['Stock item', tee, '', '', '', '', '', '']]);
    assert.equal(find((await call('admin', 'GET', '/etims/overview')).body, 'material', tee).state, 'missing');
  });
});
