// Front office: a cashier captures General, Film and Artwork orders for the sales persons (and for freelancers), and order taking can be switched off for a
// sales person. Throwaway database.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureFrontOfficeAccess } from '../src/frontOffice';

let api: Server;
let base = '';
const ids: Record<string, number> = {};
const tokens: Record<string, string> = {};
let banner = 0;
let agent = 0;

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

let n = 0;
const order = (who: string, extra: Record<string, unknown> = {}) =>
  call(tokens[who]!, 'POST', '/orders/walkin', {
    customerName: `Desk Client ${++n}`,
    phone: `07${String(30000000 + n * 173)}`,
    staffId: ids[who],
    paymentTiming: 'onAcceptance',
    lineItems: [{ itemType: 'service', serviceId: banner, qty: 2, unitPrice: 1160 }],
    payments: [{ method: 'Cash', amount: 2320 }],
    ...extra,
  });

describe('front office: capturing for the sales persons', () => {
  before(async () => {
    // the Front Office role is offered once, on a database that has none
    await prisma.setting.upsert({ where: { id: 1 }, update: { frontOfficeSeeded: false }, create: { id: 1, frontOfficeSeeded: false } });
    await ensureFrontOfficeAccess();

    await prisma.role.create({ data: { name: 'FoSales', canCaptureOrders: true, canAccessDtf: true, canAccessProduction: true, canBeAssignedOrders: true } });
    await prisma.role.create({ data: { name: 'FoPlain', canCaptureOrders: true, canAccessDtf: true } });
    const pin = await bcrypt.hash('4829', 4);
    for (const [key, role] of [['boss', 'Admin'], ['desk', 'Front Office'], ['amina', 'FoSales'], ['brian', 'FoSales'], ['carl', 'FoPlain']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (desk test)`, role, pinHash: pin, pinLength: 4 } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role, tv: 0 });
    }
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true, targetMultiplier: 0 }, create: { id: 1, enabled: true, targetMultiplier: 0 } });
    banner = (await prisma.service.create({ data: { name: 'Desk Banner', unit: 'piece', price: 1160 } })).id;
    for (const [name, unit, price] of [['DTF Sheet (per metre)', 'metre', 500], ['DTF Printing', 'piece', 70]] as const) {
      if (!(await prisma.service.findFirst({ where: { name } }))) await prisma.service.create({ data: { name, unit, price } });
    }
    await prisma.dtfRoll.create({ data: { id: 'ROLL-DESK', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 200 } });
    agent = (await prisma.freelanceAgent.create({ data: { name: 'Desk Freelancer', phone: '254711999888', status: 'Active' } })).id;
    api = app.listen(0);
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  after(async () => {
    api.close();
    await prisma.$disconnect();
  });

  it('the Front Office role exists with the right access, and is offered only once', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'Front Office' } });
    assert.deepEqual([role.canCaptureOrders, role.canAccessDtf, role.canManagePayments, role.canViewAllOrders, role.canCaptureForOthers], [true, true, true, true, true]);
    assert.deepEqual([role.canManageCommission, role.canSeeCosts, role.canAccessFinance], [false, false, false]); // no costs, no commission, no books
    // deleted on purpose, it does not come back
    await prisma.role.delete({ where: { name: 'Front Office' } }).catch(() => undefined);
    await ensureFrontOfficeAccess();
    assert.equal(await prisma.role.findUnique({ where: { name: 'Front Office' } }), null);
    await prisma.role.create({ data: { name: 'Front Office', canCaptureOrders: true, canAccessDtf: true, canManagePayments: true, canViewAllOrders: true, canCaptureForOthers: true } });
  });

  it('the front office captures a general order for a sales person: it is theirs, the cashier is recorded, and the money is the cashier\'s', async () => {
    const r = await order('desk', { staffId: ids.amina });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.staff.name, r.body.capturedByName], ['amina (desk test)', 'desk (desk test)']);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: r.body.id }, include: { payments: true } });
    assert.deepEqual([row.staffId, row.capturedById], [ids.amina, ids.desk]);
    assert.equal(row.payments[0]!.staffId, ids.desk, 'the payment was taken by the cashier');
    // Amina sees it among her orders; Brian does not; the desk sees everything
    const mine = (await call(tokens.amina!, 'GET', '/orders')).body as any[];
    assert.ok(mine.some((o) => o.id === r.body.id));
    assert.ok(!((await call(tokens.brian!, 'GET', '/orders')).body as any[]).some((o) => o.id === r.body.id));
    assert.ok(((await call(tokens.desk!, 'GET', '/orders')).body as any[]).some((o) => o.id === r.body.id));
  });

  it('a sales person capturing their own order is both people, and cannot capture in someone else\'s name', async () => {
    const own = await order('amina');
    assert.equal(own.status, 201);
    assert.equal(own.body.capturedByName, null); // nothing to show: the same person
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: own.body.id } })).capturedById, ids.amina);
    const other = await order('amina', { staffId: ids.brian });
    assert.equal(other.status, 403);
    assert.match(other.body.error, /your own name/);
  });

  it('only an active person whose role can be given orders can be named; leaving it blank is a house sale in the cashier\'s own name', async () => {
    assert.equal((await order('desk', { staffId: ids.carl })).status, 400); // FoPlain is not marked "can be assigned orders"
    assert.equal((await order('desk', { staffId: 99999999 })).status, 400);
    await prisma.user.update({ where: { id: ids.brian! }, data: { active: false } });
    assert.equal((await order('desk', { staffId: ids.brian })).status, 400);
    await prisma.user.update({ where: { id: ids.brian! }, data: { active: true } });
    const house = await order('desk', { staffId: null });
    assert.equal(house.status, 201);
    assert.deepEqual([house.body.staff.name, house.body.salesSource], ['desk (desk test)', 'house']);
  });

  it('the front office can credit a new client to the sales person (12 months), but only to the one the order is for', async () => {
    const ok = await order('desk', { staffId: ids.amina, sourcedBy: ids.amina });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.salesSource, ok.body.sourcedByStaffId], ['sourced', ids.amina]);
    assert.equal(await prisma.clientOwner.count({ where: { staffId: ids.amina!, status: 'Active' } }) > 0, true);
    const wrong = await order('desk', { staffId: ids.amina, sourcedBy: ids.brian });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /sales person the order is for/);
    // and a sales person still cannot credit a client to someone else
    assert.equal((await order('amina', { sourcedBy: ids.brian })).status, 400);
  });

  it('the front office captures for a freelancer: credited to the freelancer, no sales person, the cashier recorded', async () => {
    const r = await order('desk', { staffId: null, freelanceAgentId: agent });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.salesSource, r.body.sourcedByStaffId], ['freelance', null]);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: r.body.id } })).freelanceAgentId, agent);
  });

  it('film and artwork orders are captured for the sales person the same way', async () => {
    const film = await call(tokens.desk!, 'POST', '/dtf/sales', { rollId: 'ROLL-DESK', client: 'Desk Film', phone: '0744 100 200', metres: 5, pricePerM: 450, amountPaid: 2250, staffId: ids.amina });
    assert.equal(film.status, 201, JSON.stringify(film.body));
    const fo = await prisma.order.findUniqueOrThrow({ where: { id: film.body.order.id } });
    assert.deepEqual([fo.staffId, fo.capturedById], [ids.amina, ids.desk]);
    const job = await call(tokens.desk!, 'POST', '/dtf/jobs', { rollId: 'ROLL-DESK', client: 'Desk Print', phone: '0744 300 400', runningMetres: 2, pieces: 108, heatPressFee: 20, pricePerPiece: 80, amountPaid: 10800, staffId: ids.brian });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    const jo = await prisma.order.findUniqueOrThrow({ where: { id: job.body.order.id } });
    assert.deepEqual([jo.staffId, jo.capturedById], [ids.brian, ids.desk]);
    // a sales person cannot name someone else on a film sale
    assert.equal((await call(tokens.amina!, 'POST', '/dtf/sales', { rollId: 'ROLL-DESK', client: 'x', metres: 1, pricePerM: 450, amountPaid: 0, staffId: ids.brian })).status, 403);
  });

  it('the desk can list the sales persons to give orders to; sales persons cannot', async () => {
    const list = (await call(tokens.desk!, 'GET', '/master-data/sales-people')).body as any[];
    const names = list.map((p) => p.name);
    assert.ok(names.includes('amina (desk test)') && names.includes('brian (desk test)'));
    assert.ok(!names.includes('carl (desk test)') && !names.includes('desk (desk test)'));
    assert.equal((await call(tokens.amina!, 'GET', '/master-data/sales-people')).status, 403);
  });

  it('order taking can be switched off for a sales person: they cannot capture, they keep their other duties, and the desk still captures for them', async () => {
    assert.equal((await call(tokens.amina!, 'PUT', `/master-data/staff/${ids.brian}/order-taking`, { on: false })).status, 403); // Admin only
    const off = await call(tokens.boss!, 'PUT', `/master-data/staff/${ids.amina}/order-taking`, { on: false });
    assert.deepEqual([off.status, off.body.orderTaking], [200, false]);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.amina! } })).orderTakingOff, true);
    assert.equal((await call(tokens.boss!, 'GET', '/master-data/staff-details')).body.find((u: any) => u.id === ids.amina).orderTakingOff, true);

    // her old session ended; signing in again she gets screens without order taking, but production stays
    assert.equal((await order('amina')).status, 401);
    const login = await call(null, 'POST', '/auth/login', { userId: ids.amina, pin: '4829' });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.deepEqual([login.body.user.permissions.canCaptureOrders, login.body.user.permissions.canAccessDtf, login.body.user.permissions.canAccessProduction], [false, false, true]);
    const fresh = login.body.token as string;
    const refused = await call(fresh, 'POST', '/orders/walkin', { customerName: 'x', staffId: ids.amina, paymentTiming: 'onCompletion', lineItems: [{ itemType: 'service', serviceId: banner, qty: 1, unitPrice: 1160 }] });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /switched off/);
    assert.equal((await call(fresh, 'POST', '/dtf/sales', { rollId: 'ROLL-DESK', client: 'x', metres: 1, pricePerM: 450, amountPaid: 0 })).status, 403);
    assert.equal((await call(fresh, 'GET', '/production/queue')).status, 200); // other duties continue
    // the front desk still captures for her, and she still sees her orders
    const forHer = await order('desk', { staffId: ids.amina });
    assert.equal(forHer.status, 201);
    assert.ok(((await call(fresh, 'GET', '/orders')).body as any[]).some((o) => o.id === forHer.body.id));

    // back on
    assert.equal((await call(tokens.boss!, 'PUT', `/master-data/staff/${ids.amina}/order-taking`, { on: true })).status, 200);
    const login2 = await call(null, 'POST', '/auth/login', { userId: ids.amina, pin: '4829' });
    assert.equal(login2.body.user.permissions.canCaptureOrders, true);
    assert.equal((await call(login2.body.token, 'POST', '/orders/walkin', { customerName: 'Back', staffId: ids.amina, paymentTiming: 'onCompletion', lineItems: [{ itemType: 'service', serviceId: banner, qty: 1, unitPrice: 1160 }] })).status, 201);
  });

  it('front office always takes orders; the switch for all sales persons leaves it, and others, alone', async () => {
    const desk = await call(tokens.boss!, 'PUT', `/master-data/staff/${ids.desk}/order-taking`, { on: false });
    assert.equal(desk.status, 400);
    assert.match(desk.body.error, /always takes orders/);
    const all = await call(tokens.boss!, 'PUT', '/master-data/staff-order-taking', { on: false });
    assert.equal(all.status, 200);
    assert.ok(all.body.changed >= 2);
    const flags = Object.fromEntries((await prisma.user.findMany({ where: { id: { in: [ids.amina!, ids.brian!, ids.desk!, ids.carl!] } } })).map((u) => [u.name, u.orderTakingOff]));
    assert.deepEqual([flags['amina (desk test)'], flags['brian (desk test)'], flags['desk (desk test)'], flags['carl (desk test)']], [true, true, false, false]);
    assert.equal((await order('desk', { staffId: ids.brian })).status, 201); // the desk is unaffected
    await call(tokens.boss!, 'PUT', '/master-data/staff-order-taking', { on: true });
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: ids.amina! } })).orderTakingOff, false);
  });
});
