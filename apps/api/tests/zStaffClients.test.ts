// The staff client register: each sales person's clients (name and phone), kept by the sales person, the front office and commission managers, offered on the order screens once the sales person is
// chosen. It is the register commission already uses for clients credited to a staff member, so a client in it is recognised on their next order. (Named z… because it adds clients.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { clientKeyFor } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { activeOwner } from '../src/commission';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('staff client register', () => {
  before(async () => {
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true }, create: { id: 1, enabled: true } });
    await prisma.role.create({ data: { name: 'Seller (register test)', canCaptureOrders: true, canBeAssignedOrders: true } });
    await prisma.role.create({ data: { name: 'Desk (register test)', canCaptureOrders: true, canCaptureForOthers: true } });
    await prisma.role.create({ data: { name: 'Lead (register test)', canManageCommission: true } });
    for (const [key, role] of [['a', 'Seller (register test)'], ['b', 'Seller (register test)'], ['desk', 'Desk (register test)'], ['boss', 'Lead (register test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (register test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('a sales person adds a client to their own register and picks them back with name and phone', async () => {
    assert.equal((await call('a', 'POST', '/staff-clients', { name: '', phone: '0712 345 678' })).status, 400); // a name is needed
    assert.equal((await call('a', 'POST', '/staff-clients', { name: 'Hope Chapel Church', phone: '071234' })).status, 400); // and a phone number
    const added = await call('a', 'POST', '/staff-clients', { name: 'Hope Chapel Church', phone: '0712 345 678' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.deepEqual([added.body.name, added.body.phone, added.body.staffId], ['Hope Chapel Church', '0712 345 678', ids.a]);
    const mine = await call('a', 'GET', '/staff-clients');
    assert.deepEqual(mine.body.map((c: any) => [c.name, c.phone]), [['Hope Chapel Church', '0712 345 678']]);
    // the same register is what commission credits: the next order from this phone is recognised
    const owner = await activeOwner(prisma, clientKeyFor({ phone: '+254 712 345 678', name: '' })!);
    assert.equal(owner?.staffId, ids.a);
    // one sales person at a time
    const dup = await call('a', 'POST', '/staff-clients', { name: 'Hope Chapel', phone: '0712345678' });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already in the register/);
    const other = await call('b', 'POST', '/staff-clients', { name: 'Hope Chapel Church', phone: '0712345678' });
    assert.equal(other.status, 409);
    assert.match(other.body.error, /already credited to a \(register test\)/);
  });

  it('the front office and commission managers keep anyone’s register; nobody else sees another’s', async () => {
    const forB = await call('desk', 'POST', '/staff-clients', { staffId: ids.b, name: 'Amani Pharmacy Ltd', phone: '0722 000 111' });
    assert.equal(forB.status, 201, JSON.stringify(forB.body));
    assert.deepEqual((await call('desk', 'GET', `/staff-clients?staffId=${ids.a}`)).body.map((c: any) => c.name), ['Hope Chapel Church']); // the desk picks the sales person, then the client
    assert.deepEqual((await call('boss', 'GET', `/staff-clients?staffId=${ids.b}`)).body.map((c: any) => c.phone), ['0722 000 111']);
    assert.equal((await call('b', 'GET', `/staff-clients?staffId=${ids.a}`)).status, 403);
    assert.equal((await call('b', 'POST', '/staff-clients', { staffId: ids.a, name: 'Some One Else', phone: '0733 111 222' })).status, 403);
    // somebody who cannot be given orders cannot have a register kept for them by the desk
    assert.equal((await call('desk', 'POST', '/staff-clients', { staffId: ids.boss, name: 'Some One Else', phone: '0733 111 222' })).status, 400);
    const people = (await call('desk', 'GET', '/staff-clients/people')).body;
    assert.equal(people.all, true);
    assert.ok(people.people.some((p: any) => p.id === ids.a) && people.people.some((p: any) => p.id === ids.b));
    const mineOnly = (await call('a', 'GET', '/staff-clients/people')).body;
    assert.deepEqual([mineOnly.all, mineOnly.people.length], [false, 1]);
  });

  it('a client can be corrected, a corporate account is picked by its own details, and older rows show a phone', async () => {
    const list = (await call('a', 'GET', '/staff-clients')).body;
    const id = list[0].id;
    assert.equal((await call('a', 'PUT', `/staff-clients/${id}`, { name: 'Hope Chapel Church', phone: '0722 000 111' })).status, 409); // that number is b's client
    const fixed = await call('a', 'PUT', `/staff-clients/${id}`, { name: 'Hope Chapel Church Kilimani', phone: '0712 345 679' });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.deepEqual([fixed.body.name, fixed.body.phone], ['Hope Chapel Church Kilimani', '0712 345 679']);
    assert.equal((await call('b', 'PUT', `/staff-clients/${id}`, { name: 'x y z', phone: '0712 345 680' })).status, 403);

    const corp = await prisma.corporateClient.create({ data: { name: 'Kileleshwa Pharmacy', phone: '0700 123 456' } });
    const added = await call('a', 'POST', '/staff-clients', { corporateClientId: corp.id });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.deepEqual([added.body.name, added.body.phone, added.body.corporate], ['Kileleshwa Pharmacy', '0700 123 456', true]);

    // a row from before phones were kept: the phone is rebuilt from the key
    await prisma.clientOwner.create({ data: { clientKey: 'p:733555666', clientName: 'Older Client Name', staffId: ids.a!, startDate: '2026-01-01', endDate: '2099-01-01', createdByName: 'old' } });
    const older = (await call('a', 'GET', '/staff-clients')).body.find((c: any) => c.name === 'Older Client Name');
    assert.equal(older.phone, '0733555666');
    // a client whose time has run out, or who was let go, is no longer offered
    await prisma.clientOwner.create({ data: { clientKey: 'p:744111222', clientName: 'Expired Client One', phone: '0744 111 222', staffId: ids.a!, startDate: '2020-01-01', endDate: '2021-01-01', createdByName: 'old' } });
    assert.ok(!(await call('a', 'GET', '/staff-clients')).body.some((c: any) => c.name === 'Expired Client One'));
  });

  it('it needs commission switched on', async () => {
    await prisma.commissionSettings.update({ where: { id: 1 }, data: { enabled: false } });
    const off = await call('a', 'GET', '/staff-clients');
    assert.equal(off.status, 403);
    assert.match(off.body.error, /switched off/);
    await prisma.commissionSettings.update({ where: { id: 1 }, data: { enabled: true } });
    assert.equal((await call('a', 'GET', '/staff-clients')).status, 200);
  });
});
