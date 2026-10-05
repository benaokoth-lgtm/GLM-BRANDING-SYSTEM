// The VAT return (Compliance → VAT) is worked out from the books: Output VAT on every sale, Input VAT claimed on purchases and expenses,
// and the difference is what is payable to KRA.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { loadLedger } from '../src/accounting/ledger';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
const today = new Date().toISOString().slice(0, 10);
const day = `from=${today}&to=${today}`;
let service = 0;

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const vat = async () => (await call('fin', 'GET', `/finance/vat?${day}`)).body;

describe('VAT return', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'VAT Finance', canAccessFinance: true, canCaptureOrders: true } });
    const u = await prisma.user.create({ data: { name: 'fin (vat test)', role: 'VAT Finance', pinHash: 'x' } });
    ids.fin = u.id;
    tokens.fin = signToken({ id: u.id, name: u.name, role: 'VAT Finance' });
    service = (await prisma.service.create({ data: { name: 'Banner (vat test)', unit: 'piece', price: 1160 } })).id;
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  const walkin = () =>
    call('fin', 'POST', '/orders/walkin', {
      customerName: 'VAT Customer',
      phone: '',
      staffId: ids.fin,
      paymentTiming: 'onCompletion',
      lineItems: [{ itemType: 'service', serviceId: service, qty: 1, unitPrice: 1160 }],
    });

  it('every sale feeds Output VAT — including a corporate order that has already moved past Invoice', async () => {
    const b0 = await vat();
    const o = await walkin();
    assert.equal(o.status, 201);
    const b1 = await vat();
    assert.equal(Math.round((b1.outputVat - b0.outputVat) * 100) / 100, 160); // 1,160 inclusive → 1,000 + 160
    assert.equal(Math.round((b1.walkinSales - b0.walkinSales) * 100) / 100, 1160);

    // An older corporate invoice that was paid in full became an "Order" — still a sale, still taxed (it used to be dropped).
    await prisma.order.update({ where: { id: o.body.id }, data: { kind: 'corporate', status: 'Order' } });
    const b2 = await vat();
    assert.equal(Math.round((b2.outputVat - b0.outputVat) * 100) / 100, 160);
    assert.equal(Math.round((b2.corporateSales - b0.corporateSales) * 100) / 100, 1160);
    assert.equal(Math.round((b2.walkinSales - b0.walkinSales) * 100) / 100, 0);
  });

  it('purchases and expenses feed Input VAT, and the difference is what is payable', async () => {
    const b0 = await vat();
    // ticked at entry: 5,800 includes 800 VAT
    const e1 = await call('fin', 'POST', '/finance/expenses', { date: today, category: 'Printing Materials & Consumables', amount: 5800, invoiceNumber: 'INV-VAT-1', supplier: 'Paper Co', includesVat: true });
    assert.equal(e1.status, 201);
    assert.equal(e1.body.vatAmount, 800);
    // not ticked: nothing is claimed
    const e2 = await call('fin', 'POST', '/finance/expenses', { date: today, category: 'Printing Materials & Consumables', amount: 1160, invoiceNumber: 'INV-VAT-2', supplier: 'Ink Co' });
    assert.equal(e2.body.vatAmount, 0);

    const b1 = await vat();
    assert.equal(Math.round((b1.inputVat - b0.inputVat) * 100) / 100, 800);
    assert.equal(Math.round((b1.netVatPayable - b0.netVatPayable) * 100) / 100, -800);
    const row = b1.purchases.find((p: any) => p.id === e1.body.id);
    assert.equal(row.vatAmount, 800);
    assert.ok(b1.unclaimedWithInvoice.count >= 1, 'the second expense could still be claimed');

    // one row by hand
    assert.equal((await call('fin', 'PATCH', `/finance/expenses/${e2.body.id}/vat`, { claim: true })).body.vatAmount, 160);
    assert.equal(Math.round(((await vat()).inputVat - b0.inputVat) * 100) / 100, 960);
    assert.equal((await call('fin', 'PATCH', `/finance/expenses/${e2.body.id}/vat`, { claim: false })).body.vatAmount, 0);
    assert.equal(Math.round(((await vat()).inputVat - b0.inputVat) * 100) / 100, 800);

    // everything with a supplier invoice number, in one go
    const claimed = await call('fin', 'POST', '/finance/expenses/claim-vat', { from: today, to: today });
    assert.equal(claimed.status, 200);
    assert.ok(claimed.body.claimed >= 1);
    assert.equal((await vat()).unclaimedWithInvoice.count, 0);
    assert.equal(Math.round(((await vat()).inputVat - b0.inputVat) * 100) / 100 >= 960, true);
  });

  it('the books stay balanced, the cost is shown without the VAT, and the VAT account carries the claim', async () => {
    const ledger = await loadLedger();
    const dr = ledger.postings.reduce((a, p) => a + p.debit, 0);
    const cr = ledger.postings.reduce((a, p) => a + p.credit, 0);
    assert.ok(Math.abs(dr - cr) < 0.01, `debits ${dr} vs credits ${cr}`);
    const e = await prisma.expense.findFirstOrThrow({ where: { invoiceNumber: 'INV-VAT-1' } });
    const mine = ledger.postings.filter((p) => p.source === 'Expense' && p.ref === 'INV-VAT-1');
    const vatAcct = ledger.byCode.get('2100')!;
    assert.equal(mine.find((p) => p.accountId === vatAcct.id)?.debit, 800);
    const costDebit = mine.filter((p) => p.accountId !== vatAcct.id).reduce((a, p) => a + p.debit, 0);
    assert.equal(costDebit, e.amount - 800);
  });

  it('is for Finance only', async () => {
    await prisma.role.create({ data: { name: 'VAT Outsider', canCaptureOrders: true } });
    const u = await prisma.user.create({ data: { name: 'out (vat test)', role: 'VAT Outsider', pinHash: 'x' } });
    tokens.out = signToken({ id: u.id, name: u.name, role: 'VAT Outsider' });
    assert.equal((await call('out', 'GET', `/finance/vat?${day}`)).status, 403);
    assert.equal((await call('out', 'PATCH', '/finance/expenses/1/vat', { claim: true })).status, 403);
  });
});
