// Staff names are captured as first name, optional middle name and surname — first name and surname compulsory.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureStaffNames } from '../src/staffNames';

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

describe('staff names in three parts', () => {
  before(async () => {
    const admin = await prisma.user.create({ data: { name: 'Name Admin', firstName: 'Name', lastName: 'Admin', role: 'Admin', pinHash: 'x' } });
    tokens.admin = signToken({ id: admin.id, name: admin.name, role: 'Admin' });
    await prisma.role.upsert({ where: { name: 'Staff' }, update: {}, create: { name: 'Staff' } });
    const plain = await prisma.user.create({ data: { name: 'Name Plain', firstName: 'Name', lastName: 'Plain', role: 'Staff', pinHash: 'x' } });
    tokens.plain = signToken({ id: plain.id, name: plain.name, role: 'Staff' });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  const add = (extra: Record<string, unknown>) => call('admin', 'POST', '/master-data/staff', { role: 'Staff', pin: '1234', ...extra });

  it('first name and surname are compulsory; the middle name is optional', async () => {
    const noFirst = await add({ lastName: 'Otieno' });
    assert.equal(noFirst.status, 400);
    assert.match(noFirst.body.error, /First name/);
    const noLast = await add({ firstName: 'Amina' });
    assert.equal(noLast.status, 400);
    assert.match(noLast.body.error, /Surname/);
    assert.equal((await add({ firstName: '  ', lastName: 'Otieno' })).status, 400); // blanks do not count
    assert.equal((await add({ firstName: 'Amina', lastName: '   ' })).status, 400);

    const three = await add({ firstName: 'Amina', middleName: 'Wanjiru', lastName: 'Otieno' });
    assert.equal(three.status, 201);
    assert.equal(three.body.name, 'Amina Wanjiru Otieno'); // the full name follows from the three
    const two = await add({ firstName: ' Brian ', lastName: ' Kimani ' });
    assert.equal(two.status, 201);
    assert.equal(two.body.name, 'Brian Kimani');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: two.body.id } });
    assert.deepEqual([row.firstName, row.middleName, row.lastName], ['Brian', '', 'Kimani']);
  });

  it('two people cannot have the same full name', async () => {
    const dup = await add({ firstName: 'amina', middleName: 'wanjiru', lastName: 'OTIENO' });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /already a staff member/);
  });

  it('an Admin can correct a name; the same rules apply; it shows in the staff details', async () => {
    const made = await add({ firstName: 'Lucy', lastName: 'Njeri' });
    const id = made.body.id;
    assert.equal((await call('admin', 'PUT', `/master-data/staff/${id}/name`, { firstName: 'Lucy', lastName: '' })).status, 400);
    assert.equal((await call('admin', 'PUT', `/master-data/staff/${id}/name`, { firstName: '', lastName: 'Njeri' })).status, 400);
    assert.equal((await call('admin', 'PUT', `/master-data/staff/${id}/name`, { firstName: 'Brian', lastName: 'Kimani' })).status, 400); // taken
    const ok = await call('admin', 'PUT', `/master-data/staff/${id}/name`, { firstName: 'Lucy', middleName: 'Muthoni', lastName: 'Njeri' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.name, 'Lucy Muthoni Njeri');
    const details = (await call('admin', 'GET', '/master-data/staff-details')).body as any[];
    const me = details.find((d) => d.id === id);
    assert.deepEqual([me.firstName, me.middleName, me.lastName, me.name], ['Lucy', 'Muthoni', 'Njeri', 'Lucy Muthoni Njeri']);
    // keeping your own name is not a clash with yourself
    assert.equal((await call('admin', 'PUT', `/master-data/staff/${id}/name`, { firstName: 'Lucy', middleName: 'Muthoni', lastName: 'Njeri' })).status, 200);
    assert.equal((await call('admin', 'PUT', '/master-data/staff/999999/name', { firstName: 'No', lastName: 'One' })).status, 404);
  });

  it('only an Admin can add or rename staff', async () => {
    assert.equal((await call('plain', 'POST', '/master-data/staff', { firstName: 'X', lastName: 'Y', role: 'Staff', pin: '1234' })).status, 403);
    assert.equal((await call('plain', 'PUT', '/master-data/staff/1/name', { firstName: 'X', lastName: 'Y' })).status, 403);
  });

  it('staff who only have a full name are split into parts once; a one-word name still needs its surname', async () => {
    const three = await prisma.user.create({ data: { name: 'Grace Njeri Kamau', role: 'Staff', pinHash: 'x' } });
    const one = await prisma.user.create({ data: { name: 'Solo', role: 'Staff', pinHash: 'x' } });
    const done = await prisma.user.create({ data: { name: 'Already Done', firstName: 'Already', middleName: 'X', lastName: 'Done', role: 'Staff', pinHash: 'x' } });
    await ensureStaffNames();
    const get = async (id: number) => prisma.user.findUniqueOrThrow({ where: { id } });
    const a = await get(three.id);
    assert.deepEqual([a.firstName, a.middleName, a.lastName], ['Grace', 'Njeri', 'Kamau']);
    const b = await get(one.id);
    assert.deepEqual([b.firstName, b.lastName], ['Solo', '']);
    const c = await get(done.id);
    assert.deepEqual([c.firstName, c.middleName, c.lastName], ['Already', 'X', 'Done']); // left as it was
  });
});
