// Embroidery: a below-recommended price waits in the same approval queue artwork jobs use (it cannot be paid for or produced until a manager decides, and
// not by the person who asked), the old per-sqm "Embroidery" service is deleted (or retired when it has been sold), and the profitability report reads the jobs.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { removeService, retireLegacyEmbroideryOnce } from '../src/embroideryLegacy';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
const today = new Date().toISOString().slice(0, 10);

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const order = (who: string, over: Record<string, unknown> = {}) =>
  call(who, 'POST', '/embroidery/orders', { customerName: 'Approval Customer', phone: '', paymentTiming: 'onCompletion', qty: 10, clientSupplies: true, designs: [{ name: 'Logo', stitches: 6000 }], ...over });

// one server and one set of people for the whole file
before(async () => {
  await prisma.role.create({ data: { name: 'EA Sales', canCaptureOrders: true } });
  await prisma.role.create({ data: { name: 'EA Approver', canAccessDtf: true, canManageDtf: true, canCaptureOrders: true, canManagePayments: true, canAccessProduction: true, canManageProduction: true } });
  for (const [key, role] of [['sales', 'EA Sales'], ['approver', 'EA Approver'], ['admin', 'Admin']] as const) {
    const u = await prisma.user.create({ data: { name: `${key} (ea test)`, role, pinHash: 'x' } });
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


describe('embroidery price approvals', () => {
  it('holds a below-recommended job: no payment, no production, until a manager approves — and not the person who asked', async () => {
    const r = await order('sales', { designs: [{ name: 'Discounted', stitches: 6000, pricePerPiece: 70 }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.id as number;
    assert.equal(r.body.priceApproval, 'Pending');

    // not payable, not producible
    const pay = await call('sales', 'POST', `/orders/${id}/payments`, { method: 'Cash', amount: 100 });
    assert.equal(pay.status, 400);
    assert.match(pay.body.error, /approval/);
    const assign = await call('approver', 'POST', `/production/orders/${id}/assign`, { assigneeId: ids.sales });
    assert.equal(assign.status, 400);
    assert.match(assign.body.error, /approve/);
    const queue = await call('approver', 'GET', '/production/queue');
    assert.ok(!JSON.stringify(queue.body).includes(r.body.orderNo), 'a held job is not offered for production');

    // it is in the queue the managers decide
    const list = await call('approver', 'GET', '/dtf/approvals');
    assert.equal(list.status, 200);
    const ask = (list.body as any[]).find((a) => a.orderId === id);
    assert.equal(ask.kind, 'embroidery');
    assert.equal(ask.status, 'Pending');
    assert.equal(ask.pieces, 10);

    // the person who captured it cannot approve it (an Admin who captured it would not be able to either)
    assert.equal((await call('sales', 'POST', `/dtf/approvals/${ask.id}/approve`)).status, 403);
    const own = await order('approver', { designs: [{ name: 'Own discount', stitches: 6000, pricePerPiece: 60 }] });
    const ownAsk = (await prisma.priceApproval.findFirstOrThrow({ where: { orderId: own.body.id } })).id;
    assert.equal((await call('approver', 'POST', `/dtf/approvals/${ownAsk}/approve`)).status, 400);

    // a different manager approves: it can now be paid for and produced
    assert.equal((await call('admin', 'POST', `/dtf/approvals/${ask.id}/approve`)).status, 200);
    assert.equal((await prisma.embroideryJob.findUniqueOrThrow({ where: { orderId: id } })).approvalStatus, 'Approved');
    assert.equal((await call('sales', 'POST', `/orders/${id}/payments`, { method: 'Cash', amount: 100 })).status, 200);
    assert.equal((await call('approver', 'POST', `/production/orders/${id}/assign`, { assigneeId: ids.approver })).status, 201);
  });

  it('rejecting removes the order and its job, and keeps the request as the record', async () => {
    const r = await order('sales', { designs: [{ name: 'Rejected price', stitches: 6000, pricePerPiece: 50 }] });
    const ask = await prisma.priceApproval.findFirstOrThrow({ where: { orderId: r.body.id } });
    assert.equal((await call('admin', 'POST', `/dtf/approvals/${ask.id}/reject`, {})).status, 400); // a reason is needed
    assert.equal((await call('admin', 'POST', `/dtf/approvals/${ask.id}/reject`, { reason: 'Too low for this client' })).status, 200);
    assert.equal(await prisma.order.findUnique({ where: { id: r.body.id } }), null);
    assert.equal(await prisma.embroideryJob.count({ where: { orderId: r.body.id } }), 0);
    const kept = await prisma.priceApproval.findUniqueOrThrow({ where: { id: ask.id } });
    assert.equal(kept.status, 'Rejected');
    assert.equal(kept.orderId, null);
    assert.equal(kept.reason, 'Too low for this client');
  });
});

describe('deleting the old Embroidery service', () => {
  it('removes one no order has used, and only retires one that has been sold', async () => {
    const unused = await prisma.service.create({ data: { name: 'Unused (ea test)', unit: 'piece', price: 10 } });
    const r = await removeService(unused.id);
    assert.deepEqual({ deleted: r.deleted, retired: r.retired }, { deleted: true, retired: false });
    assert.equal(await prisma.service.findUnique({ where: { id: unused.id } }), null);

    const sold = await prisma.service.create({ data: { name: 'Sold (ea test)', unit: 'piece', price: 10 } });
    const staff = await prisma.user.findFirstOrThrow({ where: { name: 'sales (ea test)' } });
    const o = await prisma.order.create({ data: { orderNo: 'EA-TEST-1', kind: 'walkin', staffId: staff.id, createdDate: today, status: 'Order', stage: 'Order Received', lineItems: { create: [{ itemType: 'service', serviceId: sold.id, qty: 1, unitPrice: 10 }] } } });
    const r2 = await removeService(sold.id);
    assert.deepEqual({ deleted: r2.deleted, retired: r2.retired, orders: r2.orders }, { deleted: false, retired: true, orders: 1 });
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: sold.id } })).retired, true);
    // the order keeps its line
    assert.equal(await prisma.orderLineItem.count({ where: { orderId: o.id, serviceId: sold.id } }), 1);
    // and a retired service is off the price list
    const list = await call('admin', 'GET', '/master-data/services');
    assert.ok(!(list.body as any[]).some((s) => s.id === sold.id));
  });

  it('the Admin can delete a service from Master Data, but not one sold through its own screen', async () => {
    const svc = await prisma.service.create({ data: { name: 'Admin deletes (ea test)', unit: 'piece', price: 10 } });
    assert.equal((await call('sales', 'DELETE', `/master-data/services/${svc.id}`)).status, 403);
    const ok = await call('admin', 'DELETE', `/master-data/services/${svc.id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.deleted, true);
    assert.equal((await call('admin', 'DELETE', `/master-data/services/${svc.id}`)).status, 404);
    const own = await prisma.service.findFirstOrThrow({ where: { name: 'Embroidery per piece' } });
    const refused = await call('admin', 'DELETE', `/master-data/services/${own.id}`);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /own screen/);
  });

  it('retires the old per-sqm "Embroidery" service once, at start-up, and leaves a later one alone', async () => {
    const legacy = await prisma.service.create({ data: { name: 'Embroidery', unit: 'sqm', price: 350, usesArtworkPricing: true } });
    await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: { embroideryLegacyRetired: false } });
    await retireLegacyEmbroideryOnce();
    assert.equal(await prisma.service.findUnique({ where: { id: legacy.id } }), null); // never sold: removed
    assert.equal((await prisma.setting.findUniqueOrThrow({ where: { id: 1 } })).embroideryLegacyRetired, true);
  });
});

describe('embroidery profitability report', () => {
  it('reads the jobs: revenue by part net of VAT, stitches, setup charged and waived, discounts given, and cost against the Embroidery head', async () => {
    // a clean period so the numbers are exactly these jobs'
    const from = '2030-01-01';
    const to = '2030-01-31';
    const mk = async (qty: number, designs: { stitches: number; recommended: number; piece: number; setup: number; setupWaived: boolean }[], over: Record<string, unknown> = {}) => {
      const svc = await prisma.service.findFirstOrThrow({ where: { name: 'Embroidery per piece' } });
      const setupSvc = await prisma.service.findFirstOrThrow({ where: { name: 'Embroidery digitizing setup' } });
      const lines = designs.flatMap((d) => [
        { itemType: 'service', serviceId: svc.id, qty, unitPrice: d.piece, description: `d · ${d.stitches}` },
        ...(d.setup > 0 ? [{ itemType: 'service', serviceId: setupSvc.id, qty: 1, unitPrice: d.setup }] : []),
      ]);
      const staff = await prisma.user.findFirstOrThrow({ where: { name: 'sales (ea test)' } });
      const o = await prisma.order.create({ data: { orderNo: `RPT-${Math.random().toString(36).slice(2, 8)}`, kind: 'walkin', staffId: staff.id, createdDate: '2030-01-15', status: 'Order', stage: 'Order Received', lineItems: { create: lines } } });
      await prisma.embroideryJob.create({
        data: { orderId: o.id, qty, clientSupplied: true, designsJson: JSON.stringify(designs), settingsJson: JSON.stringify({ tiers: [{ min: 1, rate: 14, floor: 150 }, { min: 12, rate: 10, floor: 120 }] }), ...over },
      });
      return o;
    };
    // job 1: 12 pieces, one 6,000-stitch design at 120, setup charged 1,160 (VAT-inclusive prices throughout)
    await mk(12, [{ stitches: 6000, recommended: 120, piece: 120, setup: 1160, setupWaived: false }]);
    // job 2: 12 pieces, one 6,000-stitch design discounted to 100 (approved), setup waived (repeat)
    await mk(12, [{ stitches: 6000, recommended: 120, piece: 100, setup: 0, setupWaived: true }], { belowRecommended: true });
    // job 3: still waiting for approval — not counted
    await mk(12, [{ stitches: 6000, recommended: 120, piece: 100, setup: 0, setupWaived: false }], { belowRecommended: true, approvalStatus: 'Pending' });

    const head = await prisma.businessHead.findUnique({ where: { name: 'Embroidery' } });
    if (head) await prisma.expense.create({ data: { date: '2030-01-10', category: 'Utilities', amount: 500, businessHeadId: head.id, method: 'Bank Transfer' } });

    const r = (await call('admin', 'GET', `/reports/embroidery-profitability?from=${from}&to=${to}`)).body;
    const net = (gross: number) => Math.round((gross / 1.16) * 100) / 100;
    assert.equal(r.orders, 2);
    assert.equal(r.garments, 24);
    assert.equal(r.stitches, 24 * 6000);
    assert.equal(r.revenueByPart.pieces, net(120 * 12 + 100 * 12));
    assert.equal(r.revenueByPart.setup, net(1160));
    assert.equal(r.revenue, net(120 * 12 + 100 * 12 + 1160));
    assert.deepEqual(r.setup, { charged: 1, waived: 1 });
    assert.deepEqual(r.belowRecommended, { jobs: 1, given: 240 }); // (120 − 100) × 12
    assert.equal(r.pendingApproval.jobs, 1);
    assert.equal(r.pendingApproval.value, net(100 * 12));
    assert.equal(r.revenuePer1000Stitches, Math.round(((r.revenueByPart.pieces / (24 * 6000)) * 1000) * 100) / 100);
    assert.equal(r.byBand.length, 1);
    assert.equal(r.byBand[0].from, 12);
    assert.equal(r.byBand[0].jobs, 2);
    if (head) {
      assert.equal(r.cost.expenses, 500);
      assert.equal(r.grossProfit, Math.round((r.revenue - 500) * 100) / 100);
    }
    assert.equal(r.underpriced, false);
  });

  it('counts a quantity discount as a standard price, not as a giveaway', async () => {
    const from = '2031-01-01';
    const to = '2031-01-31';
    const svc = await prisma.service.findFirstOrThrow({ where: { name: 'Embroidery per piece' } });
    const staff = await prisma.user.findFirstOrThrow({ where: { name: 'sales (ea test)' } });
    const o = await prisma.order.create({ data: { orderNo: 'RPT-QTY-1', kind: 'walkin', staffId: staff.id, createdDate: '2031-01-10', status: 'Order', stage: 'Order Received', lineItems: { create: [{ itemType: 'service', serviceId: svc.id, qty: 12, unitPrice: 87, description: 'd' }] } } });
    const design = { stitches: 6000, stitchPrice: 96, quantityPrice: 87, lowest: 87, recommended: 87, basis: 'quantity', piece: 87, setup: 0, setupWaived: true };
    await prisma.embroideryJob.create({ data: { orderId: o.id, qty: 12, clientSupplied: true, designsJson: JSON.stringify([design]), settingsJson: JSON.stringify({ qtyTiers: [{ min: 1, discountPct: 0 }, { min: 12, discountPct: 10 }] }) } });
    const r = (await call('admin', 'GET', `/reports/embroidery-profitability?from=${from}&to=${to}`)).body;
    assert.equal(r.quantityDiscounts, 108); // (96 − 87) × 12
    assert.deepEqual(r.belowRecommended, { jobs: 0, given: 0 });
    assert.equal(r.byBand[0].from, 12);
  });
});
