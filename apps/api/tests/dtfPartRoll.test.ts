// Installing a roll that is already part-used — the system is starting up while a roll is still in use. The roll is tracked from the metres left, and its cost is the share
// that matches those metres, so profit, cost per metre and wastage are not distorted by metres sold before the system started.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { summariseRoll } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';

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
const data = async () => (await call('lead', 'GET', '/dtf/data')).body;

describe('installing a roll that is already part-used', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Printer (part-roll test)', canAccessDtf: true, canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Lead (part-roll test)', canAccessDtf: true, canManageDtf: true, canCaptureOrders: true } });
    for (const [key, role] of [['printer', 'Printer (part-roll test)'], ['lead', 'Lead (part-roll test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (part-roll test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.service.create({ data: { name: 'DTF Printing', unit: 'piece', price: 70 } }).catch(() => null);
    await prisma.service.create({ data: { name: 'DTF Sheet (per metre)', unit: 'metre', price: 500 } }).catch(() => null);
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it("keeps only the metres left and the matching share of the roll's cost, and tracks sales from there", async () => {
    const full = (await data()).settings.rollLengthM as number;
    const left = full * 0.6;
    const r = await call('lead', 'POST', '/dtf/rolls', { filmCost: 10000, inkPowderCost: 2000, metresLeft: left });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.rollLengthM, r.body.carriedInUsedM], [left, full - left]);
    assert.equal(r.body.filmCost, 6000); // 60% of the whole roll's film cost
    assert.equal(r.body.inkPowderCost, 1200);

    const sold = await call('printer', 'POST', '/dtf/sales', { rollId: r.body.id, client: 'Part Roll Client', metres: 10 });
    assert.equal(sold.status, 201, JSON.stringify(sold.body));
    const d = await data();
    const sum = summariseRoll(d.settings, d.rolls.find((x: any) => x.id === r.body.id), d.sales, d.jobs);
    assert.equal(sum.remainingM, left - 10); // what the shelf should hold: the metres left less what has been sold since
    assert.equal(sum.rollCost, 7200);
    // closing it writes off only what was left on the system's roll, at the same cost per metre as the full roll (120 per metre)
    const closed = await call('lead', 'POST', `/dtf/rolls/${r.body.id}/close`, {});
    assert.equal(closed.status, 200);
    const d2 = await data();
    const sum2 = summariseRoll(d2.settings, d2.rolls.find((x: any) => x.id === r.body.id), d2.sales, d2.jobs);
    assert.equal(sum2.wastageM, left - 10);
    assert.equal(sum2.wastageKes, (left - 10) * 120);
  });

  it('is an ordinary full roll when no metres left are given, and a part-used roll cannot be as long as a full one', async () => {
    const full = (await data()).settings.rollLengthM as number;
    const plain = await call('lead', 'POST', '/dtf/rolls', { filmCost: 5000, inkPowderCost: 1000 });
    assert.equal(plain.status, 201);
    assert.deepEqual([plain.body.rollLengthM, plain.body.carriedInUsedM, plain.body.filmCost], [full, 0, 5000]);
    const tooLong = await call('lead', 'POST', '/dtf/rolls', { filmCost: 5000, inkPowderCost: 1000, metresLeft: full });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /less than a full roll/);
    assert.equal((await call('lead', 'POST', '/dtf/rolls', { filmCost: 5000, inkPowderCost: 1000, metresLeft: 0 })).status, 400);
    assert.equal((await call('printer', 'POST', '/dtf/rolls', { filmCost: 1, inkPowderCost: 1, metresLeft: 10 })).status, 403); // DTF managers only
  });
  it('the metres left can be corrected, costs follow, but not below what has been sold and not on an ordinary roll', async () => {
    const full = (await data()).settings.rollLengthM as number;
    const r = await call('lead', 'POST', '/dtf/rolls', { filmCost: 10000, inkPowderCost: 2000, metresLeft: full * 0.5 });
    assert.equal(r.status, 201);
    assert.equal((await call('printer', 'POST', '/dtf/sales', { rollId: r.body.id, client: 'Part Roll Client', metres: 20 })).status, 201);
    const bad = await call('lead', 'PUT', `/dtf/rolls/${r.body.id}`, { metresLeft: 10 });
    assert.equal(bad.status, 400); // 20 m have already been sold
    assert.match(bad.body.error, /already been sold/);
    const ok = await call('lead', 'PUT', `/dtf/rolls/${r.body.id}`, { metresLeft: full * 0.8 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.rollLengthM, ok.body.carriedInUsedM], [full * 0.8, full * 0.2]);
    assert.deepEqual([ok.body.filmCost, ok.body.inkPowderCost], [8000, 1600]); // 80% of the whole roll's 10,000 and 2,000
    assert.equal((await call('lead', 'PUT', `/dtf/rolls/${r.body.id}`, { metresLeft: full })).status, 400);

    const plain = await call('lead', 'POST', '/dtf/rolls', { filmCost: 5000, inkPowderCost: 0 });
    assert.equal((await call('lead', 'PUT', `/dtf/rolls/${plain.body.id}`, { metresLeft: 40 })).status, 400);
    assert.equal((await call('lead', 'PUT', `/dtf/rolls/${plain.body.id}`, { filmCost: 5500 })).status, 200); // costs of an ordinary roll still edit as before
  });
});
