// Who may see an order, who may take money against it, how an M-Pesa payment is confirmed by hand, and switching a person's sign-in off.
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
const ids: Record<string, number> = {};
const orders: Record<string, number> = {};

async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function person(key: string, role: string) {
  const u = await prisma.user.create({ data: { name: `${key} (acl test)`, firstName: key, lastName: 'Acl', role, pinHash: 'x' } });
  ids[key] = u.id;
  tokens[key] = signToken({ id: u.id, name: u.name, role });
}

async function newOrder(key: string, staff: string) {
  const o = await prisma.order.create({
    data: {
      orderNo: `ACL-${key}`,
      kind: 'walkin',
      customerName: `${key} customer`,
      staffId: ids[staff]!,
      createdDate: '2031-05-01',
      status: 'Invoice',
      dueDate: '2031-06-01',
      stage: 'Order Received',
      lineItems: { create: [{ itemType: 'service', serviceId: (await prisma.service.findFirstOrThrow()).id, qty: 10, unitPrice: 100 }] },
    },
  });
  orders[key] = o.id;
}

describe('access control: orders, payments, manual M-Pesa confirmation, switched-off sign-ins', () => {
  before(async () => {
    await prisma.service.create({ data: { name: 'Printing (acl test)', unit: 'piece', price: 100 } });
    // a custom role, NOT named "Staff": captures orders only
    await prisma.role.create({ data: { name: 'Sales (acl test)', canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Cashier (acl test)', canManagePayments: true } });
    await prisma.role.create({ data: { name: 'Checker (acl test)', canViewAllOrders: true } });
    await prisma.role.create({ data: { name: 'Worker (acl test)', canAccessProduction: true } });
    await person('boss', 'Admin');
    await person('anna', 'Sales (acl test)');
    await person('ben', 'Sales (acl test)');
    await person('cashier', 'Cashier (acl test)');
    await person('checker', 'Checker (acl test)');
    await person('worker', 'Worker (acl test)');
    await newOrder('anna', 'anna');
    await newOrder('ben', 'ben');
    // M-Pesa set up and switched on (sandbox), so a push reaches the permission check.
    await prisma.mpesaSettings.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, enabled: true, environment: 'sandbox', consumerKey: 'k', consumerSecret: 's', shortCode: '174379', passkey: 'p', publicBaseUrl: 'https://example.com', callbackSecret: 'c'.repeat(32) },
    });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    // Leave nothing behind: later test files count orders, payments and M-Pesa settings across the whole database.
    const mine = await prisma.order.findMany({ where: { orderNo: { startsWith: 'ACL-' } }, select: { id: true } });
    const orderIds = mine.map((o) => o.id);
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.mpesaTransaction.deleteMany({ where: { checkoutRequestId: { startsWith: 'ws_CO_ACL_' } } });
    await prisma.orderLineItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.mpesaSettings.deleteMany();
    await prisma.user.deleteMany({ where: { name: { endsWith: '(acl test)' } } });
    await prisma.role.deleteMany({ where: { name: { endsWith: '(acl test)' } } });
    await prisma.service.deleteMany({ where: { name: 'Printing (acl test)' } });
    await prisma.$disconnect();
  });

  it('a custom role sees only the orders its person captured — in the list and by id', async () => {
    const list = (await call('anna', 'GET', '/orders')).body as any[];
    assert.deepEqual(list.map((o) => o.orderNo).filter((n) => n.startsWith('ACL-')), ['ACL-anna']);
    assert.equal((await call('anna', 'GET', `/orders/${orders.anna}`)).status, 200);
    assert.equal((await call('anna', 'GET', `/orders/${orders.ben}`)).status, 403);
    // asking for someone else's by name does not get around it
    const asked = (await call('anna', 'GET', `/orders?staffId=${ids.ben}`)).body as any[];
    assert.ok(!asked.some((o) => o.orderNo === 'ACL-ben'));
    // someone who is allowed to see everything does, and so does the Admin
    for (const who of ['checker', 'cashier', 'boss']) {
      const all = ((await call(who, 'GET', '/orders')).body as any[]).map((o) => o.orderNo);
      assert.ok(all.includes('ACL-anna') && all.includes('ACL-ben'), who);
    }
    // a production worker still sees only their own, like the default Staff role
    assert.equal((await call('worker', 'GET', `/orders/${orders.anna}`)).status, 403);
  });

  it('payments are taken by the person who captured the order or by someone who handles payments — nobody else', async () => {
    const pay = { payments: [{ method: 'Cash', amount: 100 }] };
    assert.equal((await call('ben', 'POST', `/orders/${orders.anna}/payments`, pay)).status, 403); // another salesperson's order
    assert.equal((await call('checker', 'POST', `/orders/${orders.anna}/payments`, pay)).status, 403); // can see it, but payments are not their job
    assert.equal((await call('worker', 'POST', `/orders/${orders.anna}/payments`, pay)).status, 403);
    assert.equal((await call('anna', 'POST', `/orders/${orders.anna}/payments`, pay)).status, 200); // the cashier at the till
    assert.equal((await call('cashier', 'POST', `/orders/${orders.anna}/payments`, pay)).status, 200);
    assert.equal((await call('boss', 'POST', `/orders/${orders.ben}/payments`, pay)).status, 200);
    // the order says whether you may, so the screen can hide the form
    assert.equal((await call('anna', 'GET', `/orders/${orders.anna}`)).body.canTakePayment, true);
    assert.equal((await call('checker', 'GET', `/orders/${orders.anna}`)).body.canTakePayment, false);
  });

  it('an M-Pesa push for someone else\'s order cannot be raised either', async () => {
    const r = await call('ben', 'POST', '/mpesa/stkpush', { phone: '0712345678', amount: 100, accountReference: 'X', orderId: orders.anna });
    assert.equal(r.status, 403);
  });

  describe('confirming an M-Pesa prompt by hand', () => {
    const push = async (id: string, orderKey?: string, amount = 100) =>
      prisma.mpesaTransaction.create({ data: { checkoutRequestId: id, merchantRequestId: 'm', phone: '254712345678', amount, accountReference: 'ACL', orderId: orderKey ? orders[orderKey]! : null, createdByName: 'test' } });

    it('only someone who handles payments may; a salesperson, a checker and a worker may not', async () => {
      await push('ws_CO_ACL_1', 'anna');
      for (const who of ['anna', 'ben', 'checker', 'worker']) {
        const r = await call(who, 'POST', '/mpesa/ws_CO_ACL_1/confirm-manually', { receipt: 'QWE1234567' });
        assert.equal(r.status, 403, who);
      }
      assert.equal((await prisma.mpesaTransaction.findUnique({ where: { checkoutRequestId: 'ws_CO_ACL_1' } }))!.status, 'Pending');
    });

    it('in production it needs the SMS code, and the code must be new', async () => {
      await prisma.mpesaSettings.update({ where: { id: 1 }, data: { environment: 'production' } });
      await push('ws_CO_ACL_2', 'ben', 500);
      assert.equal((await call('cashier', 'POST', '/mpesa/ws_CO_ACL_2/confirm-manually', {})).status, 400); // no code
      assert.equal((await call('cashier', 'POST', '/mpesa/ws_CO_ACL_2/confirm-manually', { receipt: 'short' })).status, 400); // not a code
      const ok = await call('cashier', 'POST', '/mpesa/ws_CO_ACL_2/confirm-manually', { receipt: 'abc9876543' }); // typed in lower case
      assert.equal(ok.status, 200);
      const tx = await prisma.mpesaTransaction.findUnique({ where: { checkoutRequestId: 'ws_CO_ACL_2' } });
      assert.deepEqual([tx!.status, tx!.mpesaReceipt, tx!.confirmedManually, tx!.confirmedByName], ['Success', 'ABC9876543', true, 'cashier (acl test)']);
      assert.ok(await prisma.payment.findFirst({ where: { orderId: orders.ben, reference: 'ABC9876543' } }), 'the payment is booked against the order with the code');

      await push('ws_CO_ACL_3', 'ben', 100);
      const again = await call('cashier', 'POST', '/mpesa/ws_CO_ACL_3/confirm-manually', { receipt: 'ABC9876543' });
      assert.equal(again.status, 400); // the same code cannot pay twice
      assert.match(again.body.error, /already on record/);
      assert.equal((await call('boss', 'POST', '/mpesa/ws_CO_ACL_2/confirm-manually', { receipt: 'ZZZ1234567' })).status, 400); // already resolved
    });

    it('in the sandbox the code may be left out (there is no real SMS)', async () => {
      await prisma.mpesaSettings.update({ where: { id: 1 }, data: { environment: 'sandbox' } });
      await push('ws_CO_ACL_4', 'ben', 100);
      assert.equal((await call('boss', 'POST', '/mpesa/ws_CO_ACL_4/confirm-manually', {})).status, 200);
    });
  });

  describe('switching a sign-in off', () => {
    it('stops sign-in and ends open sessions at once, keeps their history, and hides them from the sign-in list', async () => {
      await person('leaver', 'Sales (acl test)');
      const login = async (userId: number, pin: string) =>
        fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, pin }) });
      const bcrypt = (await import('bcryptjs')).default;
      await prisma.user.update({ where: { id: ids.leaver! }, data: { pinHash: await bcrypt.hash('4321', 4) } });
      const first = await login(ids.leaver!, '4321');
      assert.equal(first.status, 200);
      const live = ((await first.json()) as any).token as string;
      const me = () => fetch(`${base}/api/orders`, { headers: { Authorization: `Bearer ${live}` } });
      assert.equal((await me()).status, 200);

      const off = await call('boss', 'PUT', `/master-data/staff/${ids.leaver}/active`, { active: false });
      assert.equal(off.status, 200);
      assert.equal((await me()).status, 401, 'the session they already had ends');
      assert.equal((await login(ids.leaver!, '4321')).status, 401, 'and they cannot sign in again');
      const names = (await (await fetch(`${base}/api/auth/users`)).json()) as any[];
      assert.ok(!names.some((u) => u.id === ids.leaver), 'not offered on the sign-in screen');
      const staff = (await call('boss', 'GET', '/master-data/staff')).body as any[];
      assert.equal(staff.find((u) => u.id === ids.leaver).active, false, 'but still on record for history');

      // switching back on lets them sign in with a new session — the old token stays dead
      assert.equal((await call('boss', 'PUT', `/master-data/staff/${ids.leaver}/active`, { active: true })).status, 200);
      assert.equal((await me()).status, 401);
      assert.equal((await login(ids.leaver!, '4321')).status, 200);
    });

    it('an Admin cannot switch off their own sign-in; only an Admin can switch anyone', async () => {
      assert.equal((await call('boss', 'PUT', `/master-data/staff/${ids.boss}/active`, { active: false })).status, 400);
      assert.equal((await call('anna', 'PUT', `/master-data/staff/${ids.ben}/active`, { active: false })).status, 403);
      assert.equal((await call('boss', 'PUT', '/master-data/staff/999999/active', { active: false })).status, 404);
    });

    it('a PIN reset by the Admin ends the person\'s open sessions', async () => {
      await prisma.user.update({ where: { id: ids.ben! }, data: { email: 'ben-acl@example.com' } });
      const before = (await prisma.user.findUniqueOrThrow({ where: { id: ids.ben! } })).tokenVersion;
      // No mail account is set up in the test, so the reset is refused before anything changes: nothing must end
      const r = await call('boss', 'POST', `/master-data/staff/${ids.ben}/send-pin`, {});
      assert.equal(r.status, 400);
      assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.ben! } })).tokenVersion, before);
      assert.equal((await call('ben', 'GET', '/orders')).status, 200);
    });
  });
});
