// Compliance → Payments due: month by month, everything the business must remit (PAYE, NSSF both shares, SHIF, housing levy both shares, VAT, withholding tax)
// with the total to write one cheque for.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { computePay } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
let staffId = 0;
let casualId = 0;
let service = 0;
const r2 = (n: number) => Math.round(n * 100) / 100;

async function call(who: string, path: string) {
  const res = await fetch(`${base}/api${path}`, { headers: { Authorization: `Bearer ${tokens[who]}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('statutory payments due, month by month', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Due Finance', canAccessFinance: true } });
    await prisma.role.create({ data: { name: 'Due Nobody' } });
    for (const [key, role] of [['fin', 'Due Finance'], ['nobody', 'Due Nobody']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (due test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
      if (key === 'fin') staffId = u.id;
    }
    casualId = (await prisma.user.create({ data: { name: 'Casual (due test)', role: 'Due Nobody', pinHash: 'x' } })).id;
    service = (await prisma.service.create({ data: { name: 'Banner (due test)', unit: 'piece', price: 1160 } })).id;
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  const sale = (date: string, price: number) =>
    prisma.order.create({
      data: { orderNo: `DUE-${date}-${price}`, kind: 'walkin', staffId, createdDate: date, status: 'Order', stage: 'Order Received', lineItems: { create: [{ itemType: 'service', serviceId: service, qty: 1, unitPrice: price }] } },
    });

  it('is for Finance only, and needs a date range', async () => {
    assert.equal((await call('nobody', '/finance/statutory-due?from=2037-03-01&to=2037-04-30')).status, 403);
    assert.equal((await call('fin', '/finance/statutory-due')).status, 400);
  });

  it('adds up each month: payroll deductions with both shares, VAT after any credit brought forward, and withholding tax', async () => {
    const mar = '2037-03-25';
    const apr = '2037-04-25';
    await prisma.payrollEntry.createMany({
      data: [
        { date: mar, staffId, employeeType: 'Employee', grossPay: 100000, paymentSource: 'Bank/Cheque' },
        { date: apr, staffId, employeeType: 'Employee', grossPay: 100000, paymentSource: 'Bank/Cheque' },
        { date: apr, staffId: casualId, employeeType: 'Casual', grossPay: 3000, daysWorked: 3, rate: 1000, paymentSource: 'Bank/Cheque' }, // a casual has no statutory deductions
      ],
    });
    await prisma.expense.create({ data: { date: '2037-03-10', category: 'Sales Commission', amount: 5000, withholdingTax: 250, method: 'Bank Transfer' } });
    // March buys more VAT than it sells (a credit of 160); April sells 160 + 320 of VAT
    await prisma.expense.create({ data: { date: '2037-03-15', category: 'Printing Materials & Consumables', amount: 1160, method: 'Bank Transfer' } });
    await sale('2037-04-05', 1160);
    await sale('2037-04-06', 2320);

    const r = (await call('fin', '/finance/statutory-due?from=2037-03-10&to=2037-04-20')).body; // whole months: March and April
    assert.deepEqual(r.months.map((m: any) => m.month), ['2037-03', '2037-04']);
    const pay = computePay(100000, 'Employee', mar);
    const [m3, m4] = r.months;

    assert.equal(m3.paye, r2(pay.paye));
    assert.equal(m3.nssfEmployee, r2(pay.nssf));
    assert.equal(m3.nssfEmployer, r2(pay.nssfEmployer));
    assert.equal(m3.shif, r2(pay.shif));
    assert.equal(m3.housingEmployee, r2(pay.housingLevy));
    assert.equal(m3.housingEmployer, r2(pay.housingLevyEmployer));
    assert.equal(m3.wht, 250);
    // March: more input than output, so nothing to pay and a credit carried
    assert.equal(m3.vatPayable, 0);
    assert.equal(m3.vatCreditCarried, 160);
    assert.equal(m3.total, r2(pay.paye + pay.nssf + pay.nssfEmployer + pay.shif + pay.housingLevy + pay.housingLevyEmployer + 250));

    // April: the same payroll (the casual adds nothing), and VAT 480 less the 160 credit brought forward
    assert.equal(m4.paye, r2(pay.paye));
    assert.equal(m4.outputVat, 480);
    assert.equal(m4.vatCreditBf, 160);
    assert.equal(m4.vatPayable, 320);
    assert.equal(m4.wht, 0);
    assert.equal(m4.total, r2(pay.paye + pay.nssf + pay.nssfEmployer + pay.shif + pay.housingLevy + pay.housingLevyEmployer + 320));

    // the total at the end is the cheque: every column and the grand total add up the months
    assert.equal(r.totals.total, r2(m3.total + m4.total));
    assert.equal(r.totals.paye, r2(m3.paye + m4.paye));
    assert.equal(r.totals.vatPayable, 320);
    assert.equal(r.totals.wht, 250);
    assert.equal(r.totals.employerShare, r2(m3.nssfEmployer + m3.housingEmployer + m4.nssfEmployer + m4.housingEmployer));
  });

  it('shows what the books say is still owing today on each account', async () => {
    const r = (await call('fin', '/finance/statutory-due?from=2037-03-01&to=2037-03-31')).body;
    const all = await prisma.payrollEntry.findMany();
    const paye = r2(all.reduce((a, e) => a + computePay(e.grossPay, e.employeeType as 'Employee' | 'Casual', e.date).paye, 0));
    assert.equal(r.owing.paye, paye); // no remittance has been journalled, so everything ever deducted is still owing
    assert.equal(r.owing.total, r2(r.owing.paye + r.owing.nssf + r.owing.shif + r.owing.housing + r.owing.vat + r.owing.wht));
  });

  it('a range with no months, or with nothing in it, gives zeros rather than an error', async () => {
    const r = (await call('fin', '/finance/statutory-due?from=2040-01-01&to=2040-02-28')).body;
    assert.equal(r.months.length, 2);
    assert.equal(r.totals.total, 0);
  });
});
