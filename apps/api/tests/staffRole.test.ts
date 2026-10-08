// Changing a system user's role (Master Data → Staff & Users) — against a throwaway database.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let api: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('changing a user\'s role', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'RoleCounter', canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'RoleCashier', canCaptureOrders: true, canManagePayments: true } });
    for (const [key, role, pinLength] of [['boss', 'Admin', 6], ['boss2', 'Admin', 6], ['amina', 'RoleCounter', 4], ['brian', 'RoleCounter', 4]] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (role test)`, role, pinHash: 'x', pinLength } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    api = app.listen(0);
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  after(async () => {
    api.close();
    await prisma.$disconnect();
  });

  it('only an Admin can change a role', async () => {
    assert.equal((await call(tokens.amina!, 'PUT', `/master-data/staff/${ids.brian}/role`, { role: 'RoleCashier' })).status, 403);
    assert.equal((await call(null, 'PUT', `/master-data/staff/${ids.brian}/role`, { role: 'RoleCashier' })).status, 401);
  });

  it('moves someone to another role at once: what they may do changes, and their old session ends', async () => {
    // as a counter person, Amina cannot take payments
    assert.equal((await prisma.role.findUniqueOrThrow({ where: { name: 'RoleCounter' } })).canManagePayments, false);
    const r = await call(tokens.boss!, 'PUT', `/master-data/staff/${ids.amina}/role`, { role: 'RoleCashier' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.role, r.body.previousRole, r.body.changed], ['RoleCashier', 'RoleCounter', true]);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: ids.amina! } });
    assert.equal(row.role, 'RoleCashier');
    // her token from before is no longer good: she signs in again to get her new permissions
    assert.equal((await call(tokens.amina!, 'GET', '/orders')).status, 401);
    // and the staff list shows the new role
    assert.equal((await call(tokens.boss!, 'GET', '/master-data/staff')).body.find((u: any) => u.id === ids.amina).role, 'RoleCashier');
  });

  it('a role that needs a longer PIN makes them choose one: Admin needs six digits', async () => {
    const r = await call(tokens.boss!, 'PUT', `/master-data/staff/${ids.brian}/role`, { role: 'Admin' });
    assert.equal(r.status, 200);
    assert.equal(r.body.mustChangePin, true);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.brian! } })).mustChangePin, true);
  });

  it('refuses a role that does not exist, no change, and your own role', async () => {
    assert.equal((await call(tokens.boss!, 'PUT', `/master-data/staff/${ids.amina}/role`, { role: 'Nonsense' })).status, 400);
    assert.equal((await call(tokens.boss!, 'PUT', `/master-data/staff/${ids.amina}/role`, { role: '' })).status, 400);
    assert.equal((await call(tokens.boss!, 'PUT', `/master-data/staff/99999999/role`, { role: 'RoleCashier' })).status, 404);
    const same = await call(tokens.boss!, 'PUT', `/master-data/staff/${ids.amina}/role`, { role: 'RoleCashier' });
    assert.deepEqual([same.status, same.body.changed], [200, false]);
    const self = await call(tokens.boss!, 'PUT', `/master-data/staff/${ids.boss}/role`, { role: 'RoleCounter' });
    assert.equal(self.status, 400);
    assert.match(self.body.error, /own role/);

  });
});
