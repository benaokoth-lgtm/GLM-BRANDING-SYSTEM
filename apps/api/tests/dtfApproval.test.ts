// Artwork jobs: the heat press fee is mandatory; a price below the recommended one is allowed (down to the per-piece floor) but is a
// discount that has to be approved by a DTF manager before the job can be paid for or produced.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
const ROLL = 'ROLL-APPR';

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
// 2 running metres over 108 pieces: recommended 30 + 2160 × 2 ÷ 108 = 70 a piece
const job = (who: string, extra: Record<string, unknown>) =>
  call(who, 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Approval Client', runningMetres: 2, pieces: 108, ...extra });

describe('artwork job approvals', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Printer (appr test)', canAccessDtf: true, canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Lead (appr test)', canAccessDtf: true, canManageDtf: true, canCaptureOrders: true, canManageProduction: true, canAccessProduction: true } });
    await prisma.role.create({ data: { name: 'Worker (appr test)', canAccessProduction: true } });
    for (const [key, role] of [['printer', 'Printer (appr test)'], ['lead', 'Lead (appr test)'], ['lead2', 'Lead (appr test)'], ['worker', 'Worker (appr test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (appr test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.service.create({ data: { name: 'DTF Printing', unit: 'piece', price: 70 } }).catch(() => null);
    await prisma.service.create({ data: { name: 'DTF Sheet (per metre)', unit: 'metre', price: 500 } }).catch(() => null);
    await prisma.dtfRoll.create({ data: { id: ROLL, installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100, filmCost: 6000, inkPowderCost: 4000 } });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('no artwork job is processed without the heat press fee', async () => {
    const none = await job('printer', {});
    assert.equal(none.status, 400);
    assert.match(none.body.error, /heat press fee/);
    const zero = await job('printer', { heatPressFee: 0 });
    assert.equal(zero.status, 400);
    const ok = await job('printer', { heatPressFee: 20, amountPaid: 9720 });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.approval, null); // at the recommended price: no approval needed
    assert.equal(ok.body.order.totals.grandTotal, 70 * 108 + 20 * 108);
  });

  it('a lower price is allowed down to the per-piece floor, and it is a discount that has to be approved first', async () => {
    // below the 30 floor: refused outright
    const floor = await job('printer', { heatPressFee: 20, pricePerPiece: 25 });
    assert.equal(floor.status, 400);
    assert.match(floor.body.error, /minimum of 30/);

    // taking payment up front is refused: it is taken once approved
    const paid = await job('printer', { heatPressFee: 20, pricePerPiece: 60, amountPaid: 100 });
    assert.equal(paid.status, 400);
    assert.match(paid.body.error, /approval first/);

    const low = await job('printer', { heatPressFee: 20, pricePerPiece: 60 });
    assert.equal(low.status, 201, JSON.stringify(low.body));
    assert.equal(low.body.approval, 'Pending');
    assert.equal(low.body.order.priceApproval, 'Pending');
    assert.equal(low.body.order.totals.grandTotal, 60 * 108 + 20 * 108); // the lower price, plus the heat press fee — no other discount
    const request = await prisma.priceApproval.findFirstOrThrow({ where: { orderNo: low.body.order.orderNo } });
    assert.equal(request.status, 'Pending');
    assert.equal(request.shortfall, 1080); // 10 a piece × 108
    assert.equal(request.systemPerPiece, 70);
    assert.equal(request.chargedPerPiece, 60);
    const j = await prisma.dtfArtworkJob.findFirstOrThrow({ where: { orderId: low.body.order.id } });
    assert.equal(j.approvalStatus, 'Pending');
    assert.equal(j.chargedPerPiece, 60);
    (globalThis as any).__lowOrder = low.body.order.id;
    (globalThis as any).__lowRequest = request.id;
  });

  it('a job waiting for approval cannot be paid for, queued or assigned', async () => {
    const orderId = (globalThis as any).__lowOrder as number;
    const pay = await call('printer', 'POST', `/orders/${orderId}/payments`, { amount: 100, method: 'Cash' });
    assert.equal(pay.status, 400);
    assert.match(pay.body.error, /approval/);
    const queue = await call('lead', 'GET', '/production/queue');
    assert.equal(queue.body.waiting.some((w: any) => w.orderId === orderId), false);
    const assign = await call('lead', 'POST', `/production/orders/${orderId}/assign`, { assigneeId: ids.worker });
    assert.equal(assign.status, 400);
    assert.match(assign.body.error, /approve the price/);
  });

  it('only a DTF manager decides, never the person who captured it', async () => {
    const id = (globalThis as any).__lowRequest as number;
    assert.equal((await call('printer', 'GET', '/dtf/approvals')).status, 403);
    assert.equal((await call('printer', 'POST', `/dtf/approvals/${id}/approve`)).status, 403);
    const list = (await call('lead', 'GET', '/dtf/approvals')).body;
    assert.ok(list.find((r: any) => r.id === id && r.pctBelow === 14.3));

    // a manager who captured the job cannot approve their own price
    const own = await job('lead', { heatPressFee: 20, pricePerPiece: 55 });
    assert.equal(own.body.approval, 'Pending');
    const ownReq = await prisma.priceApproval.findFirstOrThrow({ where: { orderNo: own.body.order.orderNo } });
    assert.equal((await call('lead', 'POST', `/dtf/approvals/${ownReq.id}/approve`)).status, 400);
    assert.equal((await call('lead2', 'POST', `/dtf/approvals/${ownReq.id}/approve`)).status, 200);
  });

  it('approving releases the job: it can be paid for and produced, and its revenue counts on the roll', async () => {
    const id = (globalThis as any).__lowRequest as number;
    const orderId = (globalThis as any).__lowOrder as number;
    // before approval the roll holds the job's film but not its revenue
    const before = (await call('lead', 'GET', '/dtf/data')).body;
    const jobId = (await prisma.dtfArtworkJob.findFirstOrThrow({ where: { orderId } })).id;
    assert.equal(before.jobs.find((j: any) => j.id === jobId)?.approvalStatus, 'Pending');
    assert.ok(before.pendingApprovals >= 1);

    assert.equal((await call('lead2', 'POST', `/dtf/approvals/${id}/approve`)).status, 200);
    assert.equal((await call('lead2', 'POST', `/dtf/approvals/${id}/approve`)).status, 400); // decided once

    assert.equal((await prisma.dtfArtworkJob.findFirstOrThrow({ where: { orderId } })).approvalStatus, 'Approved');
    const pay = await call('printer', 'POST', `/orders/${orderId}/payments`, { amount: 3000, method: 'Cash' });
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    assert.equal(pay.body.priceApproval, null);
    const queue = await call('lead', 'GET', '/production/queue');
    assert.equal(queue.body.waiting.some((w: any) => w.orderId === orderId), true);
    assert.equal((await call('lead', 'POST', `/production/orders/${orderId}/assign`, { assigneeId: ids.worker })).status, 201); // (created: the job is now on the worker)
  });

  it('rejecting removes the order and the job, keeps the record, and gives the film back to the roll', async () => {
    const used = async () => (await prisma.dtfArtworkJob.findMany({ where: { rollId: ROLL } })).reduce((a, j) => a + j.runningMetres, 0);
    const before = await used();
    const low = await job('printer', { heatPressFee: 25, pricePerPiece: 50 });
    assert.equal(low.body.approval, 'Pending');
    assert.equal(await used(), before + 2); // the metres are reserved while it waits
    const req = await prisma.priceApproval.findFirstOrThrow({ where: { orderNo: low.body.order.orderNo } });

    assert.equal((await call('lead', 'POST', `/dtf/approvals/${req.id}/reject`, {})).status, 400); // a reason is required
    assert.equal((await call('lead', 'POST', `/dtf/approvals/${req.id}/reject`, { reason: 'Too low for this client' })).status, 200);

    assert.equal(await prisma.order.findUnique({ where: { id: low.body.order.id } }), null);
    assert.equal(await prisma.dtfArtworkJob.count({ where: { orderId: low.body.order.id } }), 0);
    assert.equal(await used(), before); // the film is back on the roll
    const after = await prisma.priceApproval.findUniqueOrThrow({ where: { id: req.id } });
    assert.equal(after.status, 'Rejected');
    assert.equal(after.reason, 'Too low for this client');
    assert.equal(after.orderId, null);
    assert.equal(after.decidedByName, 'lead (appr test)');
  });
});
