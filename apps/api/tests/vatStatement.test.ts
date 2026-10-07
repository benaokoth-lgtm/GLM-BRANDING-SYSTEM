// The VAT statement by account: Output VAT by income account, Input VAT by expense account, and outsourced work with VAT on both the sale and the
// supplier's bill.
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
const today = new Date().toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
let banner = 0;
let eulogy = 0;

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const stmt = async () => (await call('fin', 'GET', `/finance/vat?from=${today}&to=${today}`)).body;

describe('VAT statement by income and expense accounts', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Statement Finance', canAccessFinance: true, canSeeCosts: true, canCaptureOrders: true } });
    const u = await prisma.user.create({ data: { name: 'fin (statement test)', role: 'Statement Finance', pinHash: 'x' } });
    ids.fin = u.id;
    tokens.fin = signToken({ id: u.id, name: u.name, role: 'Statement Finance' });
    banner = (await prisma.service.create({ data: { name: 'Banner (statement test)', unit: 'piece', price: 1160 } })).id;
    eulogy = (await prisma.service.create({ data: { name: 'Eulogy printing (statement test)', unit: 'piece', price: 60, outsourced: true, supplierName: 'Print House', markupType: 'percent', markupValue: 50, defaultSupplierCost: 40 } })).id;
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  const order = (serviceId: number, qty: number, unitPrice: number, extra: Record<string, unknown> = {}) =>
    call('fin', 'POST', '/orders/walkin', { customerName: 'Statement Client', staffId: ids.fin, paymentTiming: 'onCompletion', lineItems: [{ itemType: 'service', serviceId, qty, unitPrice, ...extra }] });

  it('sales appear under their income account with their VAT; the accounts add up to Output VAT', async () => {
    const o = await order(banner, 1, 1160);
    assert.equal(o.status, 201);
    const s = await stmt();
    const rows = s.statement.income.rows as any[];
    const mine = rows.flatMap((r) => r.lines.map((l: any) => ({ ...l, account: r.name }))).filter((l) => l.ref === o.body.orderNo);
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0].net, mine[0].vat], [1000, 160]);
    // the statement agrees with the VAT return
    assert.equal(s.statement.income.vat, s.outputVat);
    assert.equal(r2(s.statement.income.net + s.statement.income.vat), s.statement.income.gross);
  });

  it('outsourced work: the sale carries Output VAT and the supplier bill carries Input VAT', async () => {
    const o = await order(eulogy, 200, 60, { supplierCost: 40, markupType: 'percent', markupValue: 50, supplierName: 'Print House' });
    assert.equal(o.status, 201);
    // 200 × 60 = 12,000 → 10,344.83 + 1,655.17 VAT
    // the supplier's bill, as Finance records it under Expenses, tied to the order
    await prisma.expense.create({ data: { date: new Date().toISOString().slice(0, 10), category: 'Outsourced Services', amount: 8000, supplier: 'Print House', invoiceNumber: 'PH-STMT-1', note: 'test bill', orderId: o.body.id, capturedByName: 'test', paid: true, method: 'Bank Transfer' } });

    const s = await stmt();
    const out = s.statement.outsourced;
    const sale = out.sales.rows.find((r: any) => r.orderNo === o.body.orderNo);
    assert.ok(sale, 'the outsourced sale is listed');
    assert.deepEqual([sale.net, sale.vat, sale.gross], [10344.83, 1655.17, 12000]);
    assert.equal(sale.quoted, 8000); // 200 × the supplier's 40
    assert.equal(sale.billed, 8000);
    const supplierBill = out.bills.rows.find((r: any) => r.orderNo === o.body.orderNo);
    assert.ok(supplierBill, 'the supplier bill is listed');
    assert.deepEqual([supplierBill.gross, supplierBill.net, supplierBill.vat], [8000, 6896.55, 1103.45]); // input VAT claimed back
    assert.equal(out.netVat, r2(out.sales.vat - out.bills.vat));

    // …and both flow through the accounts: the sale under an income account, the bill under an expense account with its VAT
    const incomeLine = s.statement.income.rows.flatMap((r: any) => r.lines).find((l: any) => l.ref === o.body.orderNo);
    assert.ok(incomeLine && incomeLine.vat === 1655.17);
    const expenseLine = s.statement.expenses.rows.flatMap((r: any) => r.lines).find((l: any) => l.ref === 'PH-STMT-1');
    assert.ok(expenseLine && expenseLine.vat === 1103.45 && expenseLine.net === 6896.55);
  });

  it('purchases and expenses appear under their expense account; the accounts add up to Input VAT', async () => {
    await call('fin', 'POST', '/finance/expenses', { date: today, category: 'Utilities', amount: 1160, invoiceNumber: 'UTIL-STMT-1', supplier: 'Power Co' });
    await call('fin', 'POST', '/finance/expenses', { date: today, category: 'Bank Charges', amount: 500 });
    const s = await stmt();
    const lines = s.statement.expenses.rows.flatMap((r: any) => r.lines);
    const util = lines.find((l: any) => l.ref === 'UTIL-STMT-1');
    assert.deepEqual([util.net, util.vat], [1000, 160]);
    const bank = s.statement.expenses.rows.find((r: any) => r.lines.some((l: any) => l.net === 500 && l.vat === 0));
    assert.ok(bank, 'a cost with no VAT still shows, with nil VAT');
    assert.equal(s.statement.expenses.vat, s.inputVat);
    assert.equal(r2(s.outputVat - s.statement.expenses.vat), s.netVatPayable);
  });
});
