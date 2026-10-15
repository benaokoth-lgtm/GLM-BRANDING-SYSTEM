// A unit price discount on UV Pen Costing and UV Flatbed: Finance Manager, General Manager and Admin give one outright; anyone else asks, one of them approves or turns it down, and an
// approved request is used once, on the job it was asked for. (Named z… because it records orders, which the other files' totals must not see.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_PEN_TIERS, penQuote, unitDiscountAmount } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('unit price discounts that need approval', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Printer (discount test)', canAccessDtf: true } });
    await prisma.role.upsert({ where: { name: 'Finance Manager' }, update: { canAccessDtf: true }, create: { name: 'Finance Manager', canAccessDtf: true } });
    for (const [key, role] of [['staff', 'Printer (discount test)'], ['staff2', 'Printer (discount test)'], ['finance', 'Finance Manager'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (discount test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('a discount is so much off each piece or a percentage, and never as much as the price', () => {
    assert.deepEqual(unitDiscountAmount(150, { kind: 'amount', value: 10 }), { amount: 10, problem: null });
    assert.deepEqual(unitDiscountAmount(150, { kind: 'pct', value: 10 }), { amount: 15, problem: null });
    assert.deepEqual(unitDiscountAmount(150, null), { amount: 0, problem: null });
    assert.match(unitDiscountAmount(150, { kind: 'amount', value: 150 }).problem ?? '', /as much as the price/);
    assert.match(unitDiscountAmount(150, { kind: 'pct', value: 100 }).problem ?? '', /under 100/);
    assert.match(unitDiscountAmount(150, { kind: 'amount', value: -1 }).problem ?? '', /negative/);
    // pens: the discount comes off the tier's rate; 450 pens are 15/= each
    const plain = penQuote(DEFAULT_PEN_TIERS, 450);
    assert.deepEqual([plain.rate, plain.discountedRate, plain.unitDiscount, plain.total], [15, 15, 0, 6750]);
    const off = penQuote(DEFAULT_PEN_TIERS, 450, { kind: 'amount', value: 2 });
    assert.deepEqual([off.rate, off.discountedRate, off.unitDiscount, off.total, off.upsell], [15, 13, 2, 5850, null]);
    assert.equal(penQuote(DEFAULT_PEN_TIERS, 450, { kind: 'pct', value: 10 }).discountedRate, 13.5);
    assert.match(penQuote(DEFAULT_PEN_TIERS, 450, { kind: 'amount', value: 15 }).discountProblem ?? '', /as much as the price/);
  });

  it('a request is for one job and must be sensible; those who may give a discount do not need to ask', async () => {
    const ask = (who: string, body: unknown) => call(who, 'POST', '/dtf/discount-requests', body);
    assert.equal((await ask('finance', { product: 'pens', pens: 450, discount: { kind: 'amount', value: 2 } })).status, 400); // can give it themselves
    assert.equal((await ask('staff', { product: 'pens', discount: { kind: 'amount', value: 2 } })).status, 400); // which pens?
    assert.equal((await ask('staff', { product: 'pens', pens: 450, discount: { kind: 'amount', value: 0 } })).status, 400);
    assert.equal((await ask('staff', { product: 'pens', pens: 450, discount: { kind: 'amount', value: 15 } })).status, 400); // as much as the price
    assert.equal((await ask('staff', { product: 'pens', pens: 450, discount: { kind: 'pct', value: 100 } })).status, 400);
    assert.equal((await ask('staff', { product: 'flatbed', widthCm: 40, heightCm: 40, pieces: 3, discount: { kind: 'amount', value: 5 } })).status, 400); // too big for the bed
    assert.equal((await ask('staff', { product: 'flatbed', widthCm: 14.8, heightCm: 21, discount: { kind: 'amount', value: 5 } })).status, 400); // how many?
    const ok = await ask('staff', { product: 'pens', pens: 450, discount: { kind: 'amount', value: 2 } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.status, ok.body.unitBefore, ok.body.unitAfter, ok.body.spec], ['Pending', 15, 13, { pens: 450 }]);
  });

  it('those who decide see what is waiting; everyone else sees only their own requests; only they decide', async () => {
    const mine = await call('staff', 'GET', '/dtf/discount-requests?product=pens');
    assert.equal(mine.body.canApprove, false);
    assert.equal(mine.body.requests.length, 1);
    assert.equal((await call('staff2', 'GET', '/dtf/discount-requests?product=pens')).body.requests.length, 0); // not someone else's
    const fin = await call('finance', 'GET', '/dtf/discount-requests?product=pens');
    assert.equal(fin.body.canApprove, true);
    const ours = fin.body.requests.filter((r: any) => r.requestedByName === 'staff (discount test)' && r.product === 'pens');
    assert.deepEqual([ours.length, ours[0].status, ours[0].mine], [1, 'Pending', false]);
    const id = ours[0].id;
    assert.equal((await call('staff', 'POST', `/dtf/discount-requests/${id}/approve`)).status, 403);
    assert.equal((await call('staff', 'POST', `/dtf/discount-requests/${id}/reject`, { reason: 'no' })).status, 403);
    assert.equal((await call('finance', 'POST', `/dtf/discount-requests/${id}/reject`, {})).status, 400); // a reason is needed
    assert.equal((await call('finance', 'POST', '/dtf/discount-requests/99999/approve')).status, 404);
  });

  it('an approved request is used on its own job, once, by the person who asked — the discount is the request’s, not the screen’s', async () => {
    const id = (await call('finance', 'GET', '/dtf/discount-requests?product=pens')).body.requests.find((r: any) => r.requestedByName === 'staff (discount test)' && r.status === 'Pending').id;
    const order = { pens: 450, payments: [{ method: 'Cash', amount: 1000 }] };
    // not yet approved
    const early = await call('staff', 'POST', '/dtf/pen-orders', { ...order, discountRequestId: id });
    assert.equal(early.status, 400);
    assert.match(early.body.error, /pending, not approved/);
    // a discount typed on the screen without any approval is refused
    assert.equal((await call('staff', 'POST', '/dtf/pen-orders', { ...order, unitDiscount: { kind: 'amount', value: 2 } })).status, 403);

    const approved = await call('admin', 'POST', `/dtf/discount-requests/${id}/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'Approved');
    assert.equal((await call('admin', 'POST', `/dtf/discount-requests/${id}/approve`)).status, 400); // already decided

    // someone else cannot use it; nor for a different number of pens
    assert.equal((await call('staff2', 'POST', '/dtf/pen-orders', { ...order, discountRequestId: id })).status, 400);
    const other = await call('staff', 'POST', '/dtf/pen-orders', { ...order, pens: 500, discountRequestId: id });
    assert.equal(other.status, 400);
    assert.match(other.body.error, /different job/);

    // used: 450 pens at 15 − 2 = 13/= each, 5,850/= — whatever discount the screen sent
    const r = await call('staff', 'POST', '/dtf/pen-orders', { ...order, unitDiscount: { kind: 'amount', value: 9 }, discountRequestId: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.order.totals.grandTotal, 5850);
    const line = r.body.order.lineItems[0];
    assert.deepEqual([line.qty, line.unitPrice], [450, 13]);
    assert.match(line.serviceName, /2\/= off each pen/);
    const spent = await prisma.discountRequest.findUniqueOrThrow({ where: { id } });
    assert.deepEqual([spent.status, spent.orderNo], ['Used', r.body.order.orderNo]);
    // and only once
    const again = await call('staff', 'POST', '/dtf/pen-orders', { ...order, discountRequestId: id });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already been used/);
  });

  it('Finance, the General Manager and Admin give a discount outright, on pens and on the flatbed', async () => {
    const pens = await call('finance', 'POST', '/dtf/pen-orders', { pens: 450, unitDiscount: { kind: 'amount', value: 3 }, payments: [{ method: 'Cash', amount: 5400 }] });
    assert.equal(pens.status, 201, JSON.stringify(pens.body));
    assert.deepEqual([pens.body.order.totals.grandTotal, pens.body.order.lineItems[0].unitPrice], [5400, 12]); // 450 × (15 − 3)
    assert.equal((await call('finance', 'POST', '/dtf/pen-orders', { pens: 450, unitDiscount: { kind: 'amount', value: 15 } })).status, 400); // as much as the rate
    const flat = await call('admin', 'POST', '/dtf/flatbed-orders', { widthCm: 14.8, heightCm: 21, pieces: 10, unitDiscount: { kind: 'pct', value: 10 }, payments: [{ method: 'M-Pesa', amount: 1350 }] });
    assert.equal(flat.status, 201, JSON.stringify(flat.body));
    assert.equal(flat.body.order.totals.grandTotal, 1350); // 10 × (150 − 15)
  });

  it('a turned-down request cannot be used; an approved one works the same on the flatbed', async () => {
    const spec = { widthCm: 14.8, heightCm: 21, pieces: 20 };
    const first = await call('staff', 'POST', '/dtf/discount-requests', { product: 'flatbed', ...spec, discount: { kind: 'pct', value: 20 } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([first.body.unitBefore, first.body.unitAfter], [150, 120]);
    assert.equal((await call('finance', 'POST', `/dtf/discount-requests/${first.body.id}/reject`, { reason: 'Too deep for this client' })).status, 200);
    const refused = await call('staff', 'POST', '/dtf/flatbed-orders', { ...spec, discountRequestId: first.body.id });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /rejected/);
    const mine = (await call('staff', 'GET', '/dtf/discount-requests?product=flatbed')).body.requests.find((r: any) => r.id === first.body.id);
    assert.deepEqual([mine.status, mine.reason], ['Rejected', 'Too deep for this client']);

    const second = await call('staff', 'POST', '/dtf/discount-requests', { product: 'flatbed', ...spec, discount: { kind: 'amount', value: 10 } });
    assert.equal((await call('finance', 'POST', `/dtf/discount-requests/${second.body.id}/approve`)).status, 200);
    // the size has changed since it was approved
    assert.equal((await call('staff', 'POST', '/dtf/flatbed-orders', { ...spec, heightCm: 22, discountRequestId: second.body.id })).status, 400);
    const r = await call('staff', 'POST', '/dtf/flatbed-orders', { ...spec, discountRequestId: second.body.id, payments: [{ method: 'Cash', amount: 1000 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.order.totals.grandTotal, 2800); // 20 × (150 − 10); no volume discount unless Finance applies it
    assert.match(r.body.order.lineItems[0].serviceName, /10\/= off each/);
    // the volume discount stays Finance's: a request does not carry it
    assert.equal((await call('staff', 'POST', '/dtf/flatbed-orders', { ...spec, volumeDiscount: true })).status, 403);
  });
});
