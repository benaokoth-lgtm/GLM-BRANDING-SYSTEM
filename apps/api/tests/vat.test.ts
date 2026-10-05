// The VAT return (Compliance → VAT) is worked out from the books, automatically: Output VAT on every sale, Input VAT on every purchase and
// expense whose head carries VAT, and the difference is what is payable to KRA (or carried forward). Nothing is claimed by hand.
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
const r2 = (n: number) => Math.round(n * 100) / 100;

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
  const expense = (category: string, amount: number, invoiceNumber?: string) =>
    call('fin', 'POST', '/finance/expenses', { date: today, category, amount, invoiceNumber, supplier: 'Supplier' });

  it('every sale feeds Output VAT — including a corporate order that has already moved past Invoice', async () => {
    const b0 = await vat();
    const o = await walkin();
    assert.equal(o.status, 201);
    const b1 = await vat();
    assert.equal(r2(b1.outputVat - b0.outputVat), 160); // 1,160 inclusive → 1,000 + 160
    assert.equal(r2(b1.walkinSales - b0.walkinSales), 1160);

    // An older corporate invoice that was paid in full became an "Order" — still a sale, still taxed (it used to be dropped).
    await prisma.order.update({ where: { id: o.body.id }, data: { kind: 'corporate', status: 'Order' } });
    const b2 = await vat();
    assert.equal(r2(b2.outputVat - b0.outputVat), 160);
    assert.equal(r2(b2.corporateSales - b0.corporateSales), 1160);
    assert.equal(r2(b2.walkinSales - b0.walkinSales), 0);
  });

  it('purchases and expenses feed Input VAT on their own, by expense head, and the difference is what is payable', async () => {
    const b0 = await vat();
    // materials carry VAT: 5,800 includes 800 — nothing is ticked or claimed
    assert.equal((await expense('Printing Materials & Consumables', 5800, 'INV-AUTO-1')).status, 201);
    // bank charges and casual labour do not
    await expense('Bank Charges', 1160);
    await expense('Casual Labour', 2320);
    // no invoice number is still counted (and flagged on the page)
    await expense('Utilities', 1160);

    const b1 = await vat();
    assert.equal(r2(b1.inputVat - b0.inputVat), 960); // 800 + 160
    assert.equal(r2(b1.netVatPayable - b0.netVatPayable), -960);
    const byCat = (c: string) => b1.purchases.filter((p: any) => p.category === c);
    assert.ok(byCat('Printing Materials & Consumables').some((p: any) => p.invoiceNumber === 'INV-AUTO-1' && p.vatAmount === 800));
    assert.ok(byCat('Bank Charges').every((p: any) => p.vatAmount === 0));
    assert.ok(byCat('Casual Labour').every((p: any) => p.vatAmount === 0));
    assert.ok(byCat('Utilities').some((p: any) => p.vatAmount === 160 && !p.invoiceNumber));
  });

  it('the treatment of an expense head is set once and every expense under it follows, past and future', async () => {
    const heads = (await vat()).heads as { id: number; name: string; applicable: boolean; isDefault: boolean }[];
    const bank = heads.find((h) => h.name === 'Bank Charges')!;
    assert.equal(bank.applicable, false);
    assert.equal(bank.isDefault, true);
    const b0 = await vat();
    const changed = await call('fin', 'PATCH', `/finance/expense-heads/${bank.id}/vat`, { applicable: true });
    assert.equal(changed.body.applicable, true);
    assert.equal(changed.body.isDefault, false);
    const b1 = await vat();
    assert.ok(b1.inputVat > b0.inputVat, 'bank charges already recorded now carry VAT');
    // back to the standing answer
    const back = await call('fin', 'PATCH', `/finance/expense-heads/${bank.id}/vat`, { applicable: null });
    assert.equal(back.body.applicable, false);
    assert.equal(r2((await vat()).inputVat), r2(b0.inputVat));
  });

  it('the books stay balanced, the cost is shown without the VAT, and the VAT account carries it', async () => {
    const ledger = await loadLedger();
    const dr = ledger.postings.reduce((a, p) => a + p.debit, 0);
    const cr = ledger.postings.reduce((a, p) => a + p.credit, 0);
    assert.ok(Math.abs(dr - cr) < 0.01, `debits ${dr} vs credits ${cr}`);
    const mine = ledger.postings.filter((p) => p.source === 'Expense' && p.ref === 'INV-AUTO-1');
    const vatAcct = ledger.byCode.get('2100')!;
    assert.equal(mine.find((p) => p.accountId === vatAcct.id)?.debit, 800);
    assert.equal(mine.filter((p) => p.accountId !== vatAcct.id).reduce((a, p) => a + p.debit, 0), 5000);
  });

  it('is for Finance only', async () => {
    await prisma.role.create({ data: { name: 'VAT Outsider', canCaptureOrders: true } });
    const u = await prisma.user.create({ data: { name: 'out (vat test)', role: 'VAT Outsider', pinHash: 'x' } });
    tokens.out = signToken({ id: u.id, name: u.name, role: 'VAT Outsider' });
    assert.equal((await call('out', 'GET', `/finance/vat?${day}`)).status, 403);
    assert.equal((await call('out', 'PATCH', '/finance/expense-heads/1/vat', { applicable: true })).status, 403);
  });
});
