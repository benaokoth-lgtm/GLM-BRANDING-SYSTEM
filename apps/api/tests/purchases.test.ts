// Purchases: multi-line purchase orders with a PO reference, receiving into the store by the store manager, and the reconciliation of
// what was requisitioned against what was bought and physically received. Also the business heads and sales by business head.
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
let caps = 0;
let polos = 0;
let reqId = 0;
let po1 = 0;
const today = new Date().toISOString().slice(0, 10);

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const stock = async (id: number) => (await prisma.material.findUniqueOrThrow({ where: { id } })).stockQty;

describe('purchases and reconciliation', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Buyer (purch test)', canAccessStock: true } });
    await prisma.role.create({ data: { name: 'Approver (purch test)', canAccessStock: true, canApproveStock: true, canAccessReports: true } });
    await prisma.role.create({ data: { name: 'Storekeeper (purch test)', canAccessStock: true, canReceiveStock: true } });
    for (const [key, role] of [['buyer', 'Buyer (purch test)'], ['boss', 'Approver (purch test)'], ['keeper', 'Storekeeper (purch test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (purch test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    const admin = await prisma.user.create({ data: { name: 'admin (purch test)', role: 'Admin', pinHash: 'x' } });
    tokens.admin = signToken({ id: admin.id, name: admin.name, role: 'Admin' });
    caps = (await prisma.material.create({ data: { name: 'Caps (purch test)', price: 400 } })).id;
    polos = (await prisma.material.create({ data: { name: 'Polo Shirts (purch test)', price: 900 } })).id;
    await prisma.pettyCashTopUp.create({ data: { date: today, source: 'Bank Withdrawal', amount: 500000, authorizedByName: 'test' } });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('a requisition carries an expected unit price on each line', async () => {
    const r = await call('buyer', 'POST', '/stock/requisitions', { note: 'Autumn stock', lines: [{ materialId: caps, qty: 100, estUnitCost: 200 }, { materialId: polos, qty: 50, estUnitCost: 600 }] });
    assert.equal(r.status, 201);
    reqId = r.body.id;
    assert.deepEqual(r.body.lines.map((l: any) => l.estUnitCost).sort(), [200, 600]);
    assert.equal((await call('boss', 'POST', `/stock/requisitions/${reqId}/approve`)).status, 200);
    const awaiting = (await call('buyer', 'GET', '/stock/requisitions/awaiting-purchase')).body.find((x: any) => x.id === reqId);
    assert.equal(awaiting.lines.length, 2);
  });

  it('a purchase order has many lines and a PO reference, and does not touch stock until it is received', async () => {
    const none = await call('buyer', 'POST', '/stock/purchases', { mode: 'new', requisitionId: reqId, invoiceNumber: 'INV-1', lines: [] });
    assert.equal(none.status, 400);

    const p = await call('buyer', 'POST', '/stock/purchases', {
      mode: 'new',
      requisitionId: reqId,
      supplier: 'Textile House',
      invoiceNumber: 'TH-5521',
      lines: [{ materialId: caps, qty: 100, unitCost: 210 }, { materialId: polos, qty: 40, unitCost: 600 }],
    });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    po1 = p.body.id;
    assert.match(p.body.poRef, /^PO-\d{4}$/);
    assert.equal(p.body.requisitionRef.startsWith('REQ-'), true);
    assert.equal(p.body.status, 'Held');
    assert.equal(p.body.totalCost, 100 * 210 + 40 * 600);
    assert.equal(p.body.lines.length, 2);
    assert.equal(await stock(caps), 0);
    assert.equal(await stock(polos), 0);
    // the whole invoice is one expense
    const exp = await prisma.expense.findFirstOrThrow({ where: { invoiceNumber: 'TH-5521' } });
    assert.equal(exp.amount, 45000);

    const second = await call('buyer', 'POST', '/stock/purchases', { mode: 'new', invoiceNumber: 'X-1', lines: [{ materialId: caps, qty: 1, unitCost: 100 }] });
    assert.notEqual(second.body.poRef, p.body.poRef);

    // those lines of the requisition are now covered
    const covered = await call('buyer', 'POST', '/stock/purchases', { mode: 'new', requisitionId: reqId, invoiceNumber: 'TH-2', lines: [{ materialId: caps, qty: 5, unitCost: 210 }] });
    assert.equal(covered.status, 400);
    assert.match(covered.body.error, /already has a purchase/);
    assert.equal((await call('buyer', 'GET', '/stock/requisitions/awaiting-purchase')).body.some((x: any) => x.id === reqId), false);
  });

  it('only the store manager (or an approver) receives, never the person who captured it, and stock goes up by what arrived', async () => {
    assert.equal((await call('buyer', 'POST', `/stock/purchases/${po1}/accept`, {})).status, 403); // no stores permission
    // the capturer cannot receive their own purchase even with the permission
    const own = await call('keeper', 'POST', '/stock/purchases', { mode: 'new', invoiceNumber: 'K-1', lines: [{ materialId: polos, qty: 2, unitCost: 600 }] });
    assert.equal((await call('keeper', 'POST', `/stock/purchases/${own.body.id}/accept`, {})).status, 400);

    const lines = (await call('keeper', 'GET', '/stock/purchases')).body.find((x: any) => x.id === po1).lines;
    const capsLine = lines.find((l: any) => l.materialId === caps);
    const poloLine = lines.find((l: any) => l.materialId === polos);
    // 100 caps were invoiced but only 92 were counted into the store
    const r = await call('keeper', 'POST', `/stock/purchases/${po1}/accept`, { lines: [{ lineId: capsLine.id, receivedQty: 92 }, { lineId: poloLine.id, receivedQty: 40 }], note: '8 caps short' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'Accepted');
    assert.equal(await stock(caps), 92);
    assert.equal(await stock(polos), 40);
    assert.equal((await call('keeper', 'POST', `/stock/purchases/${po1}/accept`, {})).status, 400); // already received
  });

  it('the reconciliation shows quantity, price and total variance per requisition and per line', async () => {
    const r = await call('boss', 'GET', '/stock/reconciliation');
    assert.equal(r.status, 200);
    const rec = r.body.requisitions.find((x: any) => x.id === reqId);
    assert.equal(rec.state, 'Received');
    assert.equal(rec.purchaseOrders.length, 1);
    const c = rec.lines.find((l: any) => l.materialId === caps);
    assert.equal(c.requisitionedQty, 100);
    assert.equal(c.purchasedQty, 100);
    assert.equal(c.receivedQty, 92);
    assert.equal(c.qtyVariance, -8); // what physically arrived against what was asked for
    assert.equal(c.shortDelivery, 8); // paid for, never arrived
    assert.equal(c.priceVarianceUnit, 10);
    assert.equal(c.priceVarianceValue, 1000);
    assert.equal(c.totalVariance, 1000);
    const p = rec.lines.find((l: any) => l.materialId === polos);
    assert.equal(p.qtyVariance, -10);
    assert.equal(p.qtyVarianceValue, -6000);
    assert.equal(p.priceVarianceValue, 0);
    assert.equal(p.totalVariance, -6000);
    // totals per requisition reference
    assert.equal(rec.totals.expectedTotal, 50000);
    assert.equal(rec.totals.actualTotal, 45000);
    assert.equal(rec.totals.totalVariance, -5000);
    assert.equal(rec.totals.priceVarianceValue + rec.totals.qtyVarianceValue, rec.totals.totalVariance);
    assert.equal(rec.totals.shortDeliveryValue, 1680);
    // purchases made with no requisition are listed apart
    assert.ok(r.body.standalone.length >= 2);
    assert.ok(r.body.standalone.every((s: any) => /^PO-\d{4}$/.test(s.poRef)));
    // and the variance-only view keeps this one
    const only = await call('boss', 'GET', '/stock/reconciliation?variance=1');
    assert.ok(only.body.requisitions.some((x: any) => x.id === reqId));
  });

  it('an already-logged expense must match the itemised lines, and a rejected purchase frees its requisition lines', async () => {
    const exp = await prisma.expense.create({ data: { date: today, category: 'Printing Materials & Consumables', amount: 3000, invoiceNumber: 'EXP-77', note: 'caps', capturedByName: 'test' } });
    const wrong = await call('buyer', 'POST', '/stock/purchases', { mode: 'existing', expenseId: exp.id, lines: [{ materialId: caps, qty: 10, unitCost: 250 }] });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /add up/);
    const right = await call('buyer', 'POST', '/stock/purchases', { mode: 'existing', expenseId: exp.id, lines: [{ materialId: caps, qty: 10, unitCost: 200 }, { materialId: polos, qty: 2, unitCost: 500 }] });
    assert.equal(right.status, 201, JSON.stringify(right.body)); // 2,000 + 1,000 = the 3,000 on the expense
    assert.equal(right.body.invoiceNumber, 'EXP-77');
    const reuse = await call('buyer', 'POST', '/stock/purchases', { mode: 'existing', expenseId: exp.id, lines: [{ materialId: caps, qty: 10, unitCost: 300 }] });
    assert.equal(reuse.status, 400);
    assert.match(reuse.body.error, /already been used/);

    // a second requisition: purchase it, reject the purchase, and the lines come back
    const r2 = await call('buyer', 'POST', '/stock/requisitions', { lines: [{ materialId: caps, qty: 20, estUnitCost: 200 }] });
    await call('boss', 'POST', `/stock/requisitions/${r2.body.id}/approve`);
    const pp = await call('buyer', 'POST', '/stock/purchases', { mode: 'new', requisitionId: r2.body.id, invoiceNumber: 'R2-1', lines: [{ materialId: caps, qty: 20, unitCost: 200 }] });
    assert.equal(pp.status, 201);
    assert.equal((await call('boss', 'POST', `/stock/purchases/${pp.body.id}/reject`, {})).status, 400); // a reason is required
    assert.equal((await call('boss', 'POST', `/stock/purchases/${pp.body.id}/reject`, { reason: 'Wrong colour' })).status, 200);
    assert.equal((await call('buyer', 'GET', '/stock/requisitions/awaiting-purchase')).body.some((x: any) => x.id === r2.body.id), true);
    assert.equal(await stock(caps), 92); // nothing was received
    // the reconciliation leaves the rejected purchase out
    const rec = (await call('boss', 'GET', '/stock/reconciliation')).body.requisitions.find((x: any) => x.id === r2.body.id);
    assert.equal(rec.state, 'Not purchased');
    assert.equal(rec.lines[0].qtyVariance, null);
  });

  it('a purchase from before this change is converted to one line with its own PO reference', async () => {
    const legacy = await prisma.purchase.create({ data: { materialId: caps, date: today, qty: 7, unitCost: 100, totalCost: 700, capturedByName: 'legacy', status: 'Accepted' } });
    const list = (await call('boss', 'GET', '/stock/purchases')).body;
    const row = list.find((x: any) => x.id === legacy.id);
    assert.match(row.poRef, /^PO-\d{4}$/);
    assert.equal(row.lines.length, 1);
    assert.equal(row.lines[0].receivedQty, 7);
  });

  it('the business heads exist, services sit under one, and sales are reported by head', async () => {
    const heads = await call('buyer', 'GET', '/master-data/business-heads');
    assert.equal(heads.status, 200);
    assert.deepEqual(heads.body.slice(0, 6).map((h: any) => h.name), ['DTF Printing', 'UV Printing', 'Laser Engraving', 'Large Format Printing', 'Embroidery', 'General Order']);

    const emb = await prisma.service.create({ data: { name: 'Embroidery — cap logo (heads test)', unit: 'piece', price: 1160 } });
    const eul = await prisma.service.create({ data: { name: 'Odd job (heads test)', unit: 'piece', price: 580 } });
    await call('buyer', 'GET', '/master-data/business-heads'); // listing gives every service a head
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: emb.id }, include: { businessHead: true } })).businessHead?.name, 'Embroidery');
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: eul.id }, include: { businessHead: true } })).businessHead?.name, 'General Order');

    // an order with one line of each; 1,160 and 580 include VAT → 1,000 and 500 net
    await prisma.order.create({
      data: {
        orderNo: 'HEADS-1', kind: 'walkin', customerName: 'Heads test', staffId: ids.buyer, createdDate: today, status: 'Order', stage: 'Order Received',
        lineItems: { create: [{ itemType: 'service', serviceId: emb.id, qty: 1, unitPrice: 1160 }, { itemType: 'service', serviceId: eul.id, qty: 1, unitPrice: 580 }] },
      },
    });
    const rep = await call('boss', 'GET', `/reports/sales-by-business-head?from=${today}&to=${today}`);
    assert.equal(rep.status, 200);
    const e = rep.body.heads.find((h: any) => h.name === 'Embroidery');
    const g = rep.body.heads.find((h: any) => h.name === 'General Order');
    assert.ok(e.sales >= 1000);
    assert.ok(e.services.some((s: any) => s.name.startsWith('Embroidery — cap logo')));
    assert.ok(g.sales >= 500);
    assert.equal(rep.body.heads.length >= 6, true);
    // (each head is rounded to the cent on its own, so the sum may differ from the total by a cent or two)
    assert.ok(Math.abs(rep.body.heads.reduce((a: number, h: any) => a + h.sales, 0) - rep.body.totalSales) < 0.1);

    // only an Admin changes the list
    assert.equal((await call('buyer', 'POST', '/master-data/business-heads', { name: 'Signage' })).status, 403);
    const added = await call('admin', 'POST', '/master-data/business-heads', { name: 'Signage' });
    assert.equal(added.status, 201);
    assert.equal((await call('admin', 'POST', '/master-data/business-heads', { name: 'Signage' })).status, 400);
    const full = (await call('admin', 'GET', '/master-data/business-heads')).body.find((h: any) => h.name === 'Embroidery');
    assert.equal((await call('admin', 'DELETE', `/master-data/business-heads/${full.id}`)).status, 400); // still has services
    assert.equal((await call('admin', 'DELETE', `/master-data/business-heads/${added.body.id}`)).status, 204);
  });

  it('purchases and expenses are tagged to business heads, and the report charges costs to them', async () => {
    const range = 'from=2033-05-01&to=2033-05-31';
    const day = '2033-05-10';
    const heads = (await call('admin', 'GET', '/master-data/business-heads')).body;
    const id = (n: string) => heads.find((h: any) => h.name === n).id as number;
    const report = async () => (await call('boss', 'GET', `/reports/sales-by-business-head?${range}`)).body;
    const head = (r: any, n: string) => r.heads.find((h: any) => h.name === n);

    await prisma.role.create({ data: { name: 'Finance (heads cost test)', canAccessFinance: true } });
    const fin = await prisma.user.create({ data: { name: 'fin (heads cost test)', role: 'Finance (heads cost test)', pinHash: 'x' } });
    tokens.fin = signToken({ id: fin.id, name: fin.name, role: 'Finance (heads cost test)' });

    // a material's usual head is set in Master Data; a purchase line starts with it and can be overridden
    const film = await prisma.material.create({ data: { name: 'DTF film (heads cost test)', price: 100, businessHeadId: id('DTF Printing') } });
    const thread = await prisma.material.create({ data: { name: 'Thread (heads cost test)', price: 10 } });
    assert.equal((await call('boss', 'PUT', `/master-data/materials/${thread.id}`, { businessHeadId: id('Embroidery') })).status, 200);
    assert.equal((await call('buyer', 'PUT', `/master-data/materials/${thread.id}`, { businessHeadId: id('Embroidery') })).status, 403);

    const po = await call('buyer', 'POST', '/stock/purchases', {
      mode: 'new', invoiceNumber: 'HC-1', date: day,
      lines: [{ materialId: film.id, qty: 10, unitCost: 500 }, { materialId: thread.id, qty: 20, unitCost: 50, businessHeadId: null }],
    });
    assert.equal(po.status, 201, JSON.stringify(po.body));
    const filmLine = po.body.lines.find((l: any) => l.materialId === film.id);
    const threadLine = po.body.lines.find((l: any) => l.materialId === thread.id);
    assert.equal(filmLine.businessHeadName, 'DTF Printing'); // the material's usual head
    assert.equal(threadLine.businessHeadName, null); // deliberately not tagged

    // expenses carry a head too
    const tagged = await call('fin', 'POST', '/finance/expenses', { date: day, category: 'Transport', amount: 2000, method: 'Bank Transfer', businessHeadId: id('UV Printing') });
    assert.equal(tagged.status, 201, JSON.stringify(tagged.body));
    const loose = await call('fin', 'POST', '/finance/expenses', { date: day, category: 'Utilities', amount: 700, method: 'Bank Transfer' });
    assert.equal(loose.body.businessHeadId, null);
    assert.equal((await call('fin', 'POST', '/finance/expenses', { date: day, category: 'Utilities', amount: 5, method: 'Bank Transfer', businessHeadId: 999999 })).status, 400);

    // a rejected purchase costs nothing
    const bad = await call('buyer', 'POST', '/stock/purchases', { mode: 'new', invoiceNumber: 'HC-2', date: day, lines: [{ materialId: film.id, qty: 1, unitCost: 9999 }] });
    assert.equal((await call('boss', 'POST', `/stock/purchases/${bad.body.id}/reject`, { reason: 'wrong item' })).status, 200);

    let r = await report();
    // the invoice's own expense (6,000) is not counted a second time on top of the purchase lines
    assert.equal(head(r, 'DTF Printing').costs.purchases, 5000);
    assert.equal(head(r, 'DTF Printing').margin, -5000); // no sales in that month
    assert.equal(head(r, 'DTF Printing').marginPct, null);
    assert.equal(head(r, 'UV Printing').costs.expenses, 2000);
    assert.deepEqual(head(r, 'UV Printing').costs.expenseCategories, [{ category: 'Transport', amount: 2000 }]);
    assert.equal(r.unassignedCosts.purchases, 1000); // the thread line
    assert.equal(r.unassignedCosts.expenses, 700);
    assert.equal(r.totalCosts, 5000 + 2000 + 1000 + 700);
    assert.equal(r.totalMargin, -8700);

    // retagging moves the cost without changing any amount
    assert.equal((await call('fin', 'PATCH', `/finance/expenses/${loose.body.id}/business-head`, { businessHeadId: id('Laser Engraving') })).status, 200);
    assert.equal((await call('buyer', 'PATCH', `/stock/purchases/lines/${threadLine.id}/business-head`, { businessHeadId: id('Embroidery') })).status, 200);
    r = await report();
    assert.equal(head(r, 'Laser Engraving').costs.expenses, 700);
    assert.equal(head(r, 'Embroidery').costs.purchases, 1000);
    assert.equal(r.unassignedCosts.total, 0);
    assert.equal(r.totalCosts, 8700);
  });
});
