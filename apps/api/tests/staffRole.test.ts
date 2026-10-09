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

  describe('the Edit button on a staff row: name, email, role and order taking saved together', () => {
    const edit = (who: string, id: number, body: Record<string, unknown>) => call(tokens[who]!, 'PUT', `/master-data/staff/${id}`, body);
    const base = (over: Record<string, unknown> = {}) => ({ firstName: 'Edit', middleName: '', lastName: 'Person', email: '', ...over });
    let sales = 0;
    let target = 0;

    before(async () => {
      await prisma.role.create({ data: { name: 'RoleSalesPerson', canBeAssignedOrders: true } });
      const t = await prisma.user.create({ data: { name: 'Target Person (edit test)', firstName: 'Target', lastName: 'Person (edit test)', role: 'RoleCounter', pinHash: 'x', pinLength: 4 } });
      target = t.id;
      const sp = await prisma.user.create({ data: { name: 'Sales Person (edit test)', firstName: 'Sales', lastName: 'Person (edit test)', role: 'RoleSalesPerson', pinHash: 'x', pinLength: 4 } });
      sales = sp.id;
      tokens.sales = signToken({ id: sp.id, name: sp.name, role: 'RoleSalesPerson' });
    });

    it('is for the Admin only', async () => {
      assert.equal((await edit('sales', target, base())).status, 403);
    });

    it('changes the name, email and role in one save, and signs them out because their role changed', async () => {
      const r = await edit('boss', target, base({ firstName: 'Tara', middleName: 'W', lastName: 'Getter (edit test)', email: 'Target.Edit@Test.Local', role: 'RoleCashier' }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.roleChanged, true);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: target } });
      assert.deepEqual([row.name, row.firstName, row.middleName, row.lastName, row.email, row.role], ['Tara W Getter (edit test)', 'Tara', 'W', 'Getter (edit test)', 'target.edit@test.local', 'RoleCashier']);
      assert.equal(row.tokenVersion, 1);
    });

    it('saves nothing when one field is wrong (a name or an email someone else has)', async () => {
      const before = await prisma.user.findUniqueOrThrow({ where: { id: target } });
      const dup = await edit('boss', target, base({ firstName: 'amina', lastName: '(role test)', role: 'RoleCounter' }));
      assert.equal(dup.status, 400);
      assert.match(dup.body.error, /already a staff member called/);
      await prisma.user.update({ where: { id: ids.brian! }, data: { email: 'taken.edit@test.local' } });
      const mail = await edit('boss', target, base({ firstName: 'Tara', lastName: 'Getter (edit test)', email: 'taken.edit@test.local', role: 'RoleCounter' }));
      assert.equal(mail.status, 400);
      assert.match(mail.body.error, /email/);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: target } });
      assert.deepEqual([after.name, after.email, after.role, after.tokenVersion], [before.name, before.email, before.role, before.tokenVersion]);
      assert.equal((await edit('boss', target, { firstName: '', lastName: 'X', email: '' })).status, 400); // a first name is needed
    });

    it('lets someone edit their own name and email but not their own role', async () => {
      assert.equal((await edit('boss', ids.boss!, base({ firstName: 'Boss', lastName: 'One (role test)', email: 'boss.one@test.local', role: 'Admin' }))).status, 200);
      const own = await edit('boss', ids.boss!, base({ firstName: 'Boss', lastName: 'One (role test)', role: 'RoleCounter' }));
      assert.equal(own.status, 400);
      assert.match(own.body.error, /own role/);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.boss! } })).role, 'Admin');
    });

    it('a role that needs a longer PIN makes them choose one', async () => {
      const r = await edit('boss', target, base({ firstName: 'Tara', middleName: 'W', lastName: 'Getter (edit test)', role: 'Admin' }));
      assert.equal(r.status, 200);
      assert.equal(r.body.mustChangePin, true);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target } })).mustChangePin, true);
    });

    it('switches order taking for a sales person only, and signs them out', async () => {
      const off = await edit('boss', sales, base({ firstName: 'Sales', lastName: 'Person (edit test)', orderTaking: false }));
      assert.equal(off.status, 200, JSON.stringify(off.body));
      const row = await prisma.user.findUniqueOrThrow({ where: { id: sales } });
      assert.equal(row.orderTakingOff, true);
      assert.equal(row.tokenVersion, 1);
      // not a sales person: nothing to switch
      const none = await edit('boss', ids.brian!, base({ firstName: 'Brian', lastName: '(role test)', role: 'RoleCounter', orderTaking: false }));
      assert.equal(none.status, 400);
      assert.match(none.body.error, /not a sales person/);
    });
  });
});
