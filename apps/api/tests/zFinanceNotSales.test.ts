// Capturing orders does not make someone a sales person: only a role marked "can be assigned orders" earns commission. A Finance officer who is given order taking makes GLM sales
// (house orders) and has no statement of their own; a sales person still does. (Named z… because it records orders.)
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
const period = new Date().toISOString().slice(0, 7);
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('order taking does not make Finance a sales person', () => {
  let svc = 0;
  before(async () => {
    await prisma.role.create({ data: { name: 'Seller (fin-not-sales test)', canCaptureOrders: true, canBeAssignedOrders: true } });
    await prisma.role.create({ data: { name: 'Finance (fin-not-sales test)', canCaptureOrders: true, canAccessFinance: true } });
    await prisma.role.create({ data: { name: 'Boss (fin-not-sales test)', canManageCommission: true, canAccessFinance: true } });
    for (const [key, role] of [['seller', 'Seller (fin-not-sales test)'], ['fin', 'Finance (fin-not-sales test)'], ['boss', 'Boss (fin-not-sales test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (fin-not-sales test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true, targetMultiplier: 0, generalMode: 'percent' }, create: { id: 1, enabled: true, targetMultiplier: 0, generalMode: 'percent' } });
    svc = (await prisma.service.create({ data: { name: 'Banner (fin-not-sales test)', unit: 'piece', price: 1000 } })).id;
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('a Finance officer’s orders are GLM’s own and earn no commission; the team statement lists only sales persons', async () => {
    const order = (who: string, name: string, phone: string) =>
      call(who, 'POST', '/orders/walkin', { customerName: name, phone, staffId: ids[who], paymentTiming: 'onAcceptance', lineItems: [{ itemType: 'service', serviceId: svc, qty: 1, unitPrice: 464000 }], payments: [{ method: 'Cash', amount: 464000 }] });
    assert.equal((await order('fin', 'Finance Client', '0722 100 200')).status, 201);
    assert.equal((await order('seller', 'Seller Client', '0733 100 200')).status, 201);

    const team = (await call('boss', 'GET', `/commission/statement?period=${period}`)).body.statements as { staffId: number }[];
    assert.ok(!team.some((s) => s.staffId === ids.fin), 'Finance has no statement');
    assert.ok(team.some((s) => s.staffId === ids.seller), 'the sales person has one');
    // and they earn nothing of their own
    const mine = (await call('fin', 'GET', `/commission/my?period=${period}`)).body.statement;
    assert.equal(mine.total ?? 0, 0);
  });
});
