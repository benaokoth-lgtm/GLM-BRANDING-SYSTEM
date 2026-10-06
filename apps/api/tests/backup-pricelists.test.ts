// Price lists as Excel files (download, check, upload) and backup / restore of all system data.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { readXlsx, writeXlsx } from '../src/xlsx';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-backup-test-'));

async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
async function raw(who: string, method: string, url: string, body?: Buffer) {
  const res = await fetch(`${base}/api${url}`, { method, headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${tokens[who]}` }, body });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    /* a file, not JSON */
  }
  return { status: res.status, buf, json };
}
const sheet = (rows: (string | number | null)[][]) => writeXlsx('Sheet', rows);

describe('Excel price lists, backup and restore', () => {
  before(async () => {
    process.env.BACKUP_DIR = path.join(tmp, 'backups');
    const admin = await prisma.user.create({ data: { name: 'Xl Admin', firstName: 'Xl', lastName: 'Admin', role: 'Admin', pinHash: 'x' } });
    tokens.admin = signToken({ id: admin.id, name: admin.name, role: 'Admin' });
    await prisma.role.create({ data: { name: 'Xl Plain', canCaptureOrders: true } });
    const plain = await prisma.user.create({ data: { name: 'Xl Plain', firstName: 'Xl', lastName: 'Plain', role: 'Xl Plain', pinHash: 'x' } });
    tokens.plain = signToken({ id: plain.id, name: plain.name, role: 'Xl Plain' });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the Excel codec round-trips text, symbols, accents and numbers', () => {
    const rows = [['Item', 'Price', 'Note'], ['Polo & "Tee" <A>', 1200.5, 'café — ñ'], ['', 7, 'x'], ['Last', 0, '']];
    const back = readXlsx(writeXlsx('S', rows as any));
    assert.deepEqual(back[0], ['Item', 'Price', 'Note']);
    assert.deepEqual(back[1], ['Polo & "Tee" <A>', '1200.5', 'café — ñ']);
    assert.deepEqual(back[2], ['', '7', 'x']);
    assert.equal(back[3]![0], 'Last');
    assert.throws(() => readXlsx(Buffer.from('not a spreadsheet at all, just text, long enough to scan for an end record')));
  });

  it('the stock price list downloads with its columns, and an upload is checked first, then applied', async () => {
    await call('admin', 'POST', '/master-data/materials', { item: 'Xl Polo', description: 'Cotton', variants: [{ size: 'L', price: 1200 }, { size: 'XL', price: 1300 }] });
    const dl = await raw('admin', 'GET', '/pricelists/materials.xlsx');
    assert.equal(dl.status, 200);
    const grid = readXlsx(dl.buf);
    assert.deepEqual(grid[0]!.slice(0, 7), ['Item', 'Description', 'Size', 'Unit', 'Price', 'Business head', 'Reorder level']);
    const l = grid.find((r) => r[0] === 'Xl Polo' && r[2] === 'L')!;
    assert.equal(l[4], '1200');

    const upload = sheet([
      ['Item', 'Description', 'Size', 'Unit', 'Price', 'Business head', 'Reorder level'],
      ['Xl Polo', 'Cotton pique', 'L', 'piece', 1250, '', ''], // an update
      ['Xl Polo', 'Cotton', 'XL', 'piece', 1300, '', ''], // unchanged
      ['Xl Polo', '', 'XXL', 'piece', 1400, '', 5], // a new size
      ['Xl Cap', '', '', 'piece', 450, '', ''], // a new item with no size
      ['Xl Cap', '', 'M', 'piece', 500, '', ''], // sizes cannot be mixed with the no-size line
      ['Xl Bad', '', 'S', 'piece', 0, '', ''], // no price
      ['Xl Bad2', '', 'S', 'piece', 10, 'No such head', ''],
      ['Xl Polo', '', 'L', 'piece', 9, '', ''], // twice
      [null, null, null, null, null, null, null],
    ]);
    const check = await raw('admin', 'POST', '/pricelists/materials?dryRun=1', upload);
    assert.equal(check.status, 200);
    assert.deepEqual([check.json.created, check.json.updated, check.json.unchanged, check.json.errors.length], [2, 1, 1, 4]);
    assert.equal((await prisma.material.findFirst({ where: { name: 'Xl Polo — XXL' } })), null, 'a check changes nothing');
    assert.equal((await prisma.material.findFirst({ where: { name: 'Xl Polo — L' } }))!.price, 1200);

    const applied = await raw('admin', 'POST', '/pricelists/materials', upload);
    assert.equal(applied.json.created, 2);
    const l2 = await prisma.material.findFirst({ where: { name: 'Xl Polo — L' } });
    assert.deepEqual([l2!.price, l2!.description], [1250, 'Cotton pique']);
    const xxl = await prisma.material.findFirst({ where: { name: 'Xl Polo — XXL' } });
    assert.deepEqual([xxl!.price, xxl!.reorderLevel, xxl!.item, xxl!.size], [1400, 5, 'Xl Polo', 'XXL']);
    assert.ok(await prisma.material.findFirst({ where: { name: 'Xl Cap' } }));
    assert.equal(await prisma.material.findFirst({ where: { name: 'Xl Cap — M' } }), null);
  });

  it('the service price list: download, add a sized service, update a price; only the Admin uploads', async () => {
    const dl = await raw('admin', 'GET', '/pricelists/services.xlsx');
    assert.deepEqual(readXlsx(dl.buf)[0], ['Service', 'Description', 'Size', 'Unit', 'Price', 'Business head']);
    await call('admin', 'POST', '/master-data/services', { name: 'Xl Banner', size: 'A3', unit: 'piece', price: 800 });
    const upload = sheet([
      ['Service', 'Description', 'Size', 'Unit', 'Price', 'Business head'],
      ['Xl Banner', 'Vinyl', 'A3', 'piece', 850, ''],
      ['Xl Banner', 'Vinyl', 'A2', 'piece', 1200, ''],
      ['Xl Odd', '', '', 'litre', 10, ''], // not a service unit
      ['', '', '', 'piece', 10, ''],
    ]);
    assert.equal((await raw('plain', 'POST', '/pricelists/services', upload)).status, 403);
    const res = await raw('admin', 'POST', '/pricelists/services', upload);
    assert.deepEqual([res.json.created, res.json.updated, res.json.errors.length], [1, 1, 2]);
    assert.equal((await prisma.service.findFirst({ where: { name: 'Xl Banner — A3' } }))!.price, 850);
    const a2 = await prisma.service.findFirst({ where: { name: 'Xl Banner — A2' } });
    assert.deepEqual([a2!.price, a2!.item, a2!.size, a2!.description], [1200, 'Xl Banner', 'A2', 'Vinyl']);
    assert.equal((await raw('admin', 'POST', '/pricelists/services', Buffer.from('nope'))).status, 400);
    assert.equal((await raw('admin', 'POST', '/pricelists/services', sheet([['Foo', 'Bar'], ['a', 'b']]))).status, 400); // no Service/Price header
  });

  it('a backup restores the system to how it was, ids included; the Drive secret never leaves the server', async () => {
    const before = { services: await prisma.service.count(), materials: await prisma.material.count(), users: await prisma.user.count() };
    const svc = await prisma.service.findFirst({ where: { name: 'Xl Banner — A2' } });
    const backup = await raw('admin', 'GET', '/backup/download');
    assert.equal(backup.status, 200);
    assert.equal(backup.buf[0], 0x1f); // gzip

    // Change things after the backup was taken.
    await prisma.service.delete({ where: { id: svc!.id } });
    await prisma.material.deleteMany({ where: { name: { startsWith: 'Xl Cap' } } });
    await prisma.service.create({ data: { name: 'Made After Backup', item: 'Made After Backup', unit: 'piece', price: 1 } });

    // Checking a backup reads it and changes nothing.
    const check = await raw('admin', 'POST', '/backup/restore?check=1', backup.buf);
    assert.equal(check.status, 200);
    assert.ok(check.json.rows > 0 && check.json.counts.Service === before.services);
    assert.ok(await prisma.service.findFirst({ where: { name: 'Made After Backup' } }));

    assert.equal((await raw('admin', 'POST', '/backup/restore', backup.buf)).status, 400); // not confirmed
    assert.equal((await raw('plain', 'POST', '/backup/restore?confirm=RESTORE', backup.buf)).status, 403);
    assert.equal((await raw('admin', 'POST', '/backup/restore?confirm=RESTORE', Buffer.from('garbage'))).status, 400);

    const done = await raw('admin', 'POST', '/backup/restore?confirm=RESTORE', backup.buf);
    assert.equal(done.status, 200, done.buf.toString());
    assert.equal(await prisma.service.findFirst({ where: { name: 'Made After Backup' } }), null);
    const again = await prisma.service.findFirst({ where: { name: 'Xl Banner — A2' } });
    assert.equal(again!.id, svc!.id, 'rows come back with the ids they had');
    assert.ok(await prisma.material.findFirst({ where: { name: 'Xl Cap' } }));
    assert.deepEqual({ services: await prisma.service.count(), materials: await prisma.material.count(), users: await prisma.user.count() }, before);
    // New records still get fresh ids after a restore.
    const fresh = await prisma.service.create({ data: { name: 'After Restore', item: 'After Restore', unit: 'piece', price: 2 } });
    assert.ok(fresh.id > svc!.id);
    assert.ok(done.json.savedBefore && fs.existsSync(path.join(tmp, 'backups', done.json.savedBefore)), 'the state before the restore was kept on the server');
  });

  it('a backup with no Admin is refused; settings and runs work; the Drive secret is write-only', async () => {
    const empty = Buffer.from(JSON.stringify({ format: 'glm-pos-backup', version: 1, createdAt: 'x', counts: {}, tables: { User: [{ id: 1, name: 'n', role: 'Sales' }] } }));
    const r = await raw('admin', 'POST', '/backup/restore?confirm=RESTORE', empty);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /no Admin/);

    assert.equal((await call('plain', 'GET', '/backup/status')).status, 403);
    const put = await call('admin', 'PUT', '/backup/settings', { enabled: true, intervalHours: 12, keepCount: 2, driveClientId: 'abc.apps.googleusercontent.com', driveClientSecret: 'shh-secret' });
    assert.equal(put.status, 200);
    const status = await call('admin', 'GET', '/backup/status');
    assert.deepEqual([status.body.enabled, status.body.intervalHours, status.body.keepCount, status.body.hasDriveClientSecret, status.body.driveConnected], [true, 12, 2, true, false]);
    assert.ok(!JSON.stringify(status.body).includes('shh-secret'));
    assert.equal((await call('admin', 'PUT', '/backup/settings', { intervalHours: 0 })).status, 400);

    // Connecting hands back the Google sign-in address; an unknown callback is refused.
    const url = await call('admin', 'POST', '/backup/google/connect', { redirectUri: 'https://api.example.com/api/backup/google/callback', returnUrl: 'https://pos.example.com/master-data' });
    assert.equal(url.status, 200);
    assert.match(url.body.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.match(url.body.url, /scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fdrive\.file/);
    assert.equal((await fetch(`${base}/api/backup/google/callback?state=wrong&code=x`)).status, 400);

    // Running now keeps a file on the server, and only the newest keepCount stay.
    for (let i = 0; i < 3; i++) assert.equal((await call('admin', 'POST', '/backup/run')).body.ok, true);
    const files = (await call('admin', 'GET', '/backup/status')).body.files.filter((f: any) => !f.beforeRestore);
    assert.equal(files.length, 2);
    const one = await raw('admin', 'GET', `/backup/files/${files[0].name}`);
    assert.equal(one.status, 200);
    assert.equal((await raw('admin', 'GET', '/backup/files/..%2Fsecret.json.gz')).status, 404);
  });
});
