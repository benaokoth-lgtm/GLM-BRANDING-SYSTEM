// Outsourced (contracted-out) services: staff are blocked from costs, the supplier quote is captured per job, supplier bills with a
// deposit become cost of sales and Accounts Payable, and the job goes to the supplier and back through Quality Control.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VAT_RATE, splitGross } from '@glm/shared';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { loadLedger, naturalBalance, sumByAccount } from '../src/accounting/ledger';
import { buildPayablesAging, buildTrialBalance } from '../src/accounting/reports';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
let eulogy = 0;
let inhouse = 0;

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const bal = async (code: string) => {
  const l = await loadLedger();
  const a = l.byCode.get(code)!;
  return naturalBalance(a.type, sumByAccount(l.postings).get(a.id));
};

describe('outsourced services', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Counter', canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Costing', canCaptureOrders: true, canSeeCosts: true, canAccessProduction: true, canManageProduction: true } });
    await prisma.role.create({ data: { name: 'Checker', canAccessQuality: true } });
    for (const [key, role] of [['counter', 'Counter'], ['boss', 'Costing'], ['checker', 'Checker']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (outsourced test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    // eulogy printing: supplier quotes one VAT-inclusive price (paper + printing); we add 50%
    eulogy = (await prisma.service.create({ data: { name: 'Eulogy printing', unit: 'piece', price: 60, outsourced: true, supplierName: 'Print House', markupType: 'percent', markupValue: 50, defaultSupplierCost: 40 } })).id;
    inhouse = (await prisma.service.create({ data: { name: 'Heat press (in-house)', unit: 'piece', price: 100 } })).id;
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  const walkin = (who: string, line: Record<string, unknown>) =>
    call(who, 'POST', '/orders/walkin', { customerName: 'Mourning family', staffId: ids[who], paymentTiming: 'onCompletion', lineItems: [{ itemType: 'service', serviceId: eulogy, qty: 200, unitPrice: 60, ...line }] });

  it('the price list hides the supplier price and mark-up from anyone who cannot see costs', async () => {
    const staff = await call('counter', 'GET', '/master-data/services');
    const row = staff.body.find((s: any) => s.id === eulogy);
    assert.equal(row.outsourced, true);
    assert.equal(row.price, 60); // the selling price is for everyone
    assert.ok(!('defaultSupplierCost' in row) && !('markupValue' in row) && !('markupType' in row), 'costs leaked to staff');
    const boss = (await call('boss', 'GET', '/master-data/services')).body.find((s: any) => s.id === eulogy);
    assert.equal(boss.defaultSupplierCost, 40);
    assert.equal(boss.markupValue, 50);
    assert.equal(boss.markupType, 'percent');
  });

  it('staff can sell an outsourced service, but any cost they send is ignored and never shown back', async () => {
    const r = await walkin('counter', { supplierCost: 5, markupType: 'percent', markupValue: 900, supplierName: 'Cheap Print' });
    assert.equal(r.status, 201);
    const line = r.body.lineItems[0];
    assert.equal(line.outsourced, true);
    assert.equal(line.needsCosting, true); // nobody has entered the supplier's quote yet
    assert.ok(!('supplierCost' in line) && !('markupValue' in line), 'costs shown to staff');
    const stored = await prisma.orderLineItem.findFirstOrThrow({ where: { orderId: r.body.id } });
    assert.equal(stored.supplierCost, null); // what staff sent was dropped
    assert.equal(stored.markupValue, null);
  });

  it('someone who can see costs captures the supplier quote on the line, and staff still cannot read it', async () => {
    const r = await walkin('boss', { supplierCost: 40, markupType: 'percent', markupValue: 50, supplierName: 'Print House' });
    assert.equal(r.status, 201);
    const asBoss = await call('boss', 'GET', `/orders/${r.body.id}`);
    assert.equal(asBoss.body.lineItems[0].supplierCost, 40);
    assert.equal(asBoss.body.lineItems[0].needsCosting, false);
    // staff who may open orders (their own) never see it — here the order is the boss's, so use the stored line + a staff-owned order
    const mine = await walkin('counter', {});
    await prisma.orderLineItem.updateMany({ where: { orderId: mine.body.id }, data: { supplierCost: 40, markupType: 'percent', markupValue: 50 } });
    const asStaff = await call('counter', 'GET', `/orders/${mine.body.id}`);
    assert.equal(asStaff.status, 200);
    assert.ok(!('supplierCost' in asStaff.body.lineItems[0]) && !('markupValue' in asStaff.body.lineItems[0]), 'the cost reached staff');
  });

  it('costing endpoints are closed to staff; a manager can cost a job after the fact and sees the profit', async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { customerName: 'Mourning family' }, orderBy: { id: 'asc' }, include: { lineItems: true } });
    assert.equal((await call('counter', 'GET', `/orders/${order.id}/costing`)).status, 403);
    assert.equal((await call('counter', 'PUT', `/orders/${order.id}/costing`, { lines: [{ lineId: order.lineItems[0]!.id, supplierCost: 1 }] })).status, 403);
    assert.equal((await call('counter', 'GET', '/orders/outsourced/jobs')).status, 403);

    const put = await call('boss', 'PUT', `/orders/${order.id}/costing`, { lines: [{ lineId: order.lineItems[0]!.id, supplierCost: 40, markupType: 'percent', markupValue: 50, supplierName: 'Print House' }] });
    assert.equal(put.status, 200);
    assert.equal(put.body.estimatedCost, 8000); // 200 × 40
    assert.equal(put.body.sale, 12000); // 200 × 60
    assert.equal(put.body.costBasis, 'quote (no bill recorded yet)');
    assert.equal(put.body.margin.grossProfit, 4000);
    assert.equal(put.body.margin.markupPct, 50);
    assert.equal(put.body.margin.marginPct, 33.33);
    assert.equal(put.body.margin.bookProfit, 3448.28); // the books take VAT out of the sale (10,344.83) and out of the supplier's bill (6,896.55) — their VAT is claimed back
    // a non-outsourced line can't be "costed"
    const other = await prisma.order.create({ data: { orderNo: 'W-OTHER', kind: 'walkin', staffId: ids.boss!, createdDate: '2031-04-01', status: 'Invoice', stage: 'Order Received', lineItems: { create: [{ itemType: 'service', serviceId: inhouse, qty: 1, unitPrice: 100 }] } }, include: { lineItems: true } });
    assert.equal((await call('boss', 'PUT', `/orders/${other.id}/costing`, { lines: [{ lineId: other.lineItems[0]!.id, supplierCost: 5 }] })).status, 400);
  });

  it('a supplier bill with a deposit: cost of sales in full, the balance owed to the supplier', async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { customerName: 'Mourning family' }, orderBy: { id: 'asc' } });
    assert.equal((await call('counter', 'POST', `/orders/${order.id}/supplier-bills`, { supplierName: 'Print House', amount: 8000 })).status, 403);
    assert.equal((await call('boss', 'POST', `/orders/${order.id}/supplier-bills`, { supplierName: 'Print House', amount: 8000, paidNow: 9000 })).status, 400); // more than the bill

    const cosBefore = await bal('5000');
    const bankBefore = await bal('1050');
    const r = await call('boss', 'POST', `/orders/${order.id}/supplier-bills`, { supplierName: 'Print House', amount: 8000, paidNow: 3000, method: 'Bank Transfer', invoiceNumber: 'PH-114' });
    assert.equal(r.status, 201);
    assert.equal(r.body.billed, 8000);
    assert.equal(r.body.paid, 3000);
    assert.equal(r.body.owing, 5000);
    assert.equal(r.body.costBasis, 'supplier bills');

    // the bill is cost of sales as soon as the supplier takes the job — without its VAT, which is claimed back as input VAT (Compliance → VAT)
    assert.equal(Math.round(((await bal('5000')) - cosBefore) * 100) / 100, Math.round((8000 - splitGross(8000, VAT_RATE).vat) * 100) / 100);
    const ap = await buildPayablesAging('9999-12-31');
    assert.equal(ap.rows.find((x) => x.supplier === 'Print House')?.outstanding, 5000); // the balance is owed to the supplier
    assert.equal(Math.round(((await bal('1050')) - bankBefore) * 100) / 100, -3000); // the deposit left the bank (rounded: other test files share this database)

    // a second bill paid in full is a plain paid expense
    const full = await call('boss', 'POST', `/orders/${order.id}/supplier-bills`, { supplierName: 'Print House', amount: 1000, paidNow: 1000, method: 'M-Pesa' });
    assert.equal(full.body.billed, 9000);
    assert.equal(full.body.owing, 5000);
    assert.equal((await buildTrialBalance('9999-12-31')).balanced, true);
  });

  it('the outsourced jobs list shows each job’s sale, bills and what is still owing', async () => {
    await walkin('counter', {}); // a fresh job nobody has costed yet
    const r = await call('boss', 'GET', '/orders/outsourced/jobs');
    assert.equal(r.status, 200);
    assert.ok(r.body.jobs.length >= 3);
    const costed = r.body.jobs.find((j: any) => j.billed === 9000);
    assert.ok(costed);
    assert.deepEqual(costed.suppliers, ['Print House']);
    assert.ok(r.body.totals.needCosting >= 1); // the order staff captured has no supplier quote yet
    assert.equal(r.body.totals.owing >= 5000, true);
  });

  it('a contracted-out order goes to its supplier, comes back, and is checked before it can go to the customer', async () => {
    const o = await walkin('boss', { supplierCost: 40, markupType: 'percent', markupValue: 50 });
    const queue = await call('boss', 'GET', '/production/queue');
    const waiting = queue.body.waiting.find((w: any) => w.orderNo === o.body.orderNo);
    assert.equal(waiting.outsourced, true);
    assert.equal(waiting.supplierHint, 'Print House');
    // an in-house worker has nothing to do with it
    assert.equal((await call('counter', 'POST', `/production/orders/${o.body.id}/send-to-supplier`, { supplierName: 'Print House' })).status, 403);
    assert.equal((await call('boss', 'POST', `/production/orders/${o.body.id}/send-to-supplier`, {})).status, 400); // a supplier is required

    const sent = await call('boss', 'POST', `/production/orders/${o.body.id}/send-to-supplier`, { supplierName: 'Print House', note: 'collect Friday' });
    assert.equal(sent.status, 201);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o.body.id } })).stage, 'In Production');
    const task = await prisma.productionTask.findFirstOrThrow({ where: { orderId: o.body.id } });
    assert.equal(task.assigneeId, null);
    assert.equal(task.supplierName, 'Print House');
    const q2 = await call('boss', 'GET', '/production/queue');
    assert.equal(q2.body.tasks.find((t: any) => t.orderNo === o.body.orderNo).supplierName, 'Print House');

    // "receive" it: the same finish action; it goes to Quality Control, not to Completed
    const got = await call('boss', 'POST', `/production/tasks/${task.id}/finish`, { unitsCompleted: 198, note: '2 short' });
    assert.equal(got.status, 200);
    assert.equal(got.body.nextStage, 'Quality Check');
    const qc = await call('checker', 'GET', '/quality/queue');
    const waitingQc = qc.body.awaiting.find((a: any) => a.orderNo === o.body.orderNo);
    assert.equal(waitingQc.producerName, 'Supplier: Print House');
    assert.equal(waitingQc.canInspect, true);

    // QC fails it: it goes back to the SUPPLIER, as rework
    const fail = await call('checker', 'POST', `/quality/orders/${o.body.id}/check`, { result: 'Failed', unitsRejected: 12, defects: 'colour off' });
    assert.equal(fail.status, 201);
    const rework = await prisma.productionTask.findFirstOrThrow({ where: { orderId: o.body.id, isRework: true } });
    assert.equal(rework.assigneeId, null);
    assert.equal(rework.supplierName, 'Print House');
    assert.equal(rework.unitsPlanned, 12);

    // received again, QC passes, ready — and still not completed
    await call('boss', 'POST', `/production/tasks/${rework.id}/finish`, { unitsCompleted: 12 });
    assert.equal((await call('checker', 'POST', `/quality/orders/${o.body.id}/check`, { result: 'Passed' })).status, 201);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o.body.id } })).stage, 'Ready for Pickup/Delivery');
  });

  it('supplier jobs are left out of per-person productivity but shown among recent jobs', async () => {
    const r = await call('boss', 'GET', '/production/productivity?from=2000-01-01&to=2099-12-31');
    assert.equal(r.status, 200);
    assert.ok(r.body.rows.every((row: any) => row.assigneeId != null));
    assert.ok(r.body.recent.some((t: any) => String(t.assigneeName).startsWith('Supplier: Print House')));
  });
});
