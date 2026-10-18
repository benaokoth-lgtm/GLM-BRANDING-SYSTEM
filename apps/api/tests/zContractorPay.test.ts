// Sales persons paid as contractors (Commission → Pay details): from the month an Admin sets, a sales person's month — the pay bands, the film and artwork premium and the commission — is one
// total, with withholding tax taken off it, paid outside payroll (by hand or to their M-Pesa phone); the tax withheld is held and reported; freelance accounts are retired. Before that month
// nothing changes. (Named z… because it records orders and payouts and changes the commission settings, which it puts back.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { todayStr } from '@glm/shared';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const PERIOD = '2026-01';
const NEXT = '2026-02';
const uniq = String(Date.now()).slice(-7); // (ids and PINs are unique among staff, so each run uses its own)
const statementOf = async (period: string) => (await call('lead', 'GET', `/commission/statement?period=${period}`)).body.statements.find((s: any) => s.staffId === ids.seller);
const putSettings = async (extra: object) => {
  const cur = (await call('lead', 'GET', '/commission/settings')).body;
  return call('admin', 'PUT', '/commission/settings', {
    generalBands: cur.generalBands, filmBands: cur.filmBands, artworkRatePct: cur.artworkRatePct, ownershipMonths: cur.ownershipMonths, ...extra,
  });
};

describe('sales persons paid as contractors', () => {
  before(async () => {
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true }, create: { id: 1, enabled: true } });
    await prisma.role.create({ data: { name: 'Seller (cp test)', canCaptureOrders: true, canBeAssignedOrders: true, canAccessDtf: true } });
    await prisma.role.create({ data: { name: 'Lead (cp test)', canManageCommission: true, canCaptureOrders: true } });
    for (const [key, role] of [['seller', 'Seller (cp test)'], ['lead', 'Lead (cp test)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (cp test)`, role, pinHash: 'x', paidOnBands: key === 'seller', createdAt: new Date('2025-01-01') } }); // (on the books before the months tested)
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    // January: a Freelancer Sales order of the seller's was paid 116,000 (100,000 net of VAT) — from the contractor month every Freelancer Sales order is theirs, client or not
    await prisma.order.create({
      data: {
        orderNo: 'CP-JAN-1', kind: 'walkin', priceList: 'freelancer', staffId: ids.seller!, createdDate: `${PERIOD}-10`, status: 'Order', stage: 'Completed',
        lineItems: { create: [{ itemType: 'service', qty: 1, unitPrice: 116000 }] },
        payments: { create: [{ date: `${PERIOD}-15`, amount: 116000, method: 'Cash' }] },
      },
    });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await putSettings({ generalMode: 'steps' }); // (the pay-bands scheme the month is worked out under)
  });
  after(async () => {
    await putSettings({ contractorFrom: '' });
    server.close();
    await prisma.$disconnect();
  });

  it('before the month is set nothing changes: the seller is on the payroll scheme as flagged', async () => {
    const before = await statementOf(PERIOD);
    assert.ok(before, 'the seller has a statement');
    assert.equal(before.pay.contractor ?? false, false);
    assert.equal(before.pay.onBands, true); // paid on the bands, through payroll, as before
  });

  it('only an Admin sets the month; from it the seller is a contractor: one total, tax off it, no payroll', async () => {
    assert.equal((await call('lead', 'PUT', '/commission/settings', { generalBands: [{ from: 0, rate: 0 }], filmBands: [{ from: 0, rate: 10 }], artworkRatePct: 50, ownershipMonths: 12, contractorFrom: PERIOD })).status, 403);
    assert.equal((await putSettings({ contractorFrom: '2026-13' })).status, 400);
    assert.equal((await putSettings({ contractorFrom: PERIOD })).status, 200);
    const cfg = (await call('lead', 'GET', '/commission/settings')).body;
    assert.equal(cfg.contractorFrom, PERIOD);
    const s = await statementOf(PERIOD);
    assert.equal(s.pay.contractor, true);
    assert.equal(s.pay.onBands, false); // not through payroll, though flagged
    assert.ok(s.pay.amount > 0);
    assert.equal(s.pay.whtRate, cfg.freelanceWhtRate); // the standard rate
    assert.equal(s.pay.withholdingTax, r2((s.pay.amount * cfg.freelanceWhtRate) / 100));
    assert.equal(s.pay.net, r2(s.pay.amount - s.pay.withholdingTax));
    assert.equal(s.pay.amount, s.total); // no top-up unless switched on for the person
  });

  it('approving the month records the gross and the tax; paying by hand books Sales Commission with the tax withheld, and the report shows it', async () => {
    const s = await statementOf(PERIOD);
    const approved = await call('lead', 'POST', '/commission/payouts/approve', { period: PERIOD });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const row = (await call('lead', 'GET', `/commission/payouts?period=${PERIOD}`)).body.find((p: any) => p.staffId === ids.seller);
    assert.ok(row, 'a payout was made');
    assert.deepEqual([row.contractor, row.amount, row.withholdingTax, row.net, row.status], [true, s.pay.amount, s.pay.withholdingTax, s.pay.net, 'Approved']);
    const paid = await call('lead', 'POST', `/commission/payouts/${row.id}/pay`, { method: 'Bank Transfer', reference: 'BANK-REF-1' });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.deepEqual([paid.body.status, paid.body.receipt], ['Paid', 'BANK-REF-1']);
    const exp = await prisma.expense.findUniqueOrThrow({ where: { id: paid.body.expenseId } });
    assert.deepEqual([exp.category, exp.amount, exp.withholdingTax, exp.supplier], ['Sales Commission', s.pay.amount, s.pay.withholdingTax, 'seller (cp test)']);
    // the month's tax-withheld report lists it (the month it was paid)
    const month = todayStr().slice(0, 7);
    const rep = (await call('lead', 'GET', `/freelance/withholding?month=${month}`)).body;
    const mine = rep.rows.find((r: any) => r.agentName === 'seller (cp test)');
    assert.ok(mine);
    assert.deepEqual([mine.kind, mine.gross, mine.withheld, mine.period], ['Sales person', s.pay.amount, s.pay.withholdingTax, PERIOD]);
    const annual = (await call('lead', 'GET', `/freelance/annual?year=${todayStr().slice(0, 4)}`)).body;
    assert.ok(annual.people.some((p: any) => p.agentName === 'seller (cp test)' && p.kind === 'Sales person' && p.withheld === s.pay.withholdingTax));
    // paid: it cannot be paid again or withdrawn
    assert.equal((await call('lead', 'POST', `/commission/payouts/${row.id}/pay`, { method: 'Cash' })).status, 400);
    assert.equal((await call('lead', 'DELETE', `/commission/payouts/${row.id}`)).status, 400);
  });

  it('pay details: rate and minimum-wage switch per person, the M-Pesa number, KRA PIN; only managers', async () => {
    assert.equal((await call('seller', 'GET', '/commission/contractors')).status, 403);
    const list = (await call('lead', 'GET', '/commission/contractors')).body;
    const me = list.people.find((p: any) => p.staffId === ids.seller);
    assert.ok(me);
    assert.deepEqual(me.missing, ['KRA PIN', 'National ID', 'M-Pesa number']);
    assert.equal(me.effectiveWhtRate, list.standardWhtRate);
    assert.equal((await call('lead', 'PUT', `/commission/contractors/${ids.seller}`, { mpesaNumber: '12345' })).status, 400);
    assert.equal((await call('lead', 'PUT', `/commission/contractors/${ids.seller}`, { kraPin: 'nonsense' })).status, 400);
    const ok = await call('lead', 'PUT', `/commission/contractors/${ids.seller}`, { mpesaNumber: '0712 345 678', kraPin: `a${uniq.padStart(9, '3')}z`, nationalId: `9${uniq}`, whtRate: 0, minWageFloor: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after = (await call('lead', 'GET', '/commission/contractors')).body.people.find((p: any) => p.staffId === ids.seller);
    assert.deepEqual([after.mpesaNumber, after.kraPin, after.nationalId, after.whtRate, after.effectiveWhtRate, after.minWageFloor, after.missing], ['254712345678', `A${uniq.padStart(9, '3')}Z`, `9${uniq}`, 0, 0, true, []]);
    // a month with no sales: with the switch on the seller is in it at the minimum wage (topped up), tax at their own rate (0 = exempt)
    const cfg = (await call('lead', 'GET', '/commission/settings')).body;
    const empty = await statementOf(NEXT);
    assert.ok(empty, 'in every month with the switch on');
    assert.deepEqual([empty.pay.amount, empty.pay.topUp, empty.pay.withholdingTax, empty.pay.net], [cfg.minimumWage, cfg.minimumWage, 0, cfg.minimumWage]);
    // the switch off again: nothing for a month without sales
    await call('lead', 'PUT', `/commission/contractors/${ids.seller}`, { minWageFloor: false, whtRate: null });
    assert.equal(await statementOf(NEXT), undefined);
  });

  it('sending to the phone: refused until M-Pesa pay-outs are set up; freelance accounts are retired from the month', async () => {
    const row = await prisma.commissionPayout.create({ data: { period: '2025-12', staffId: ids.seller!, amount: 5000, contractor: true, withholdingRate: 5, withholdingTax: 250, status: 'Approved', approvedByName: 'test' } });
    const sent = await call('lead', 'POST', `/commission/payouts/${row.id}/send-mpesa`, {});
    assert.equal(sent.status, 400);
    assert.match(sent.body.error, /not set up|M-Pesa/);
    assert.equal((await prisma.commissionPayout.findUniqueOrThrow({ where: { id: row.id } })).status, 'Approved'); // still waiting to be paid
    // freelance accounts: none can be added, none credited, no later week approved
    const agent = await prisma.freelanceAgent.create({ data: { name: 'Old Freelancer (cp test)', phone: '254700000771', status: 'Active' } });
    const add = await call('lead', 'POST', '/freelance/agents', { name: 'New One', phone: '0700000772' });
    assert.equal(add.status, 400);
    assert.match(add.body.error, /retired/);
    const order = await call('seller', 'POST', '/orders/walkin', { paymentTiming: 'onCompletion', freelanceAgentId: agent.id, lineItems: [{ itemType: 'service', serviceId: (await prisma.service.create({ data: { name: 'CP Test Service', item: 'CP Test Service', unit: 'piece', price: 100 } })).id, qty: 1, unitPrice: 100 }] });
    assert.equal(order.status, 400);
    assert.match(order.body.error, /retired/);
    assert.equal((await call('lead', 'POST', '/freelance/payouts/approve', { weekStart: '2026-03-02' })).status, 400); // a week inside the contractor months
    assert.equal((await call('lead', 'GET', '/auth/features')).body.contractors, true);
    // and with the month not set, none of that applies
    assert.equal((await putSettings({ contractorFrom: '' })).status, 200);
    assert.equal((await call('lead', 'GET', '/auth/features')).body.contractors, false);
  });
});
