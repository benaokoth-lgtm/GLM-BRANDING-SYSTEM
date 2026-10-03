// Staff sales commission: clients are credited to the staff member who sourced them (12 months, never shared), general commission is
// banded on net sales RECEIVED, film earns a premium above the 400 base with no ceiling, artwork earns only on what was charged above
// the recommended price, and an approved month is paid out as an expense on the books.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { loadLedger, naturalBalance, sumByAccount } from '../src/accounting/ledger';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
let banner = 0;
const period = new Date().toISOString().slice(0, 7);

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
const mine = async (who: string) => (await call(who, 'GET', `/commission/my?period=${period}`)).body.statement;

describe('staff sales commission', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Commission Counter', canCaptureOrders: true, canAccessDtf: true } });
    await prisma.role.create({ data: { name: 'Commission Boss', canCaptureOrders: true, canAccessFinance: true, canAccessAccounting: true, canManageCommission: true } });
    for (const [key, role] of [['amina', 'Commission Counter'], ['brian', 'Commission Counter'], ['boss', 'Commission Boss']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (commission test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    banner = (await prisma.service.create({ data: { name: 'Banner (commission test)', unit: 'piece', price: 1000 } })).id;
    await prisma.service.create({ data: { name: 'DTF Sheet (per metre)', unit: 'metre', price: 500 } });
    await prisma.service.create({ data: { name: 'DTF Printing', unit: 'piece', price: 70 } });
    await prisma.dtfRoll.create({ data: { id: 'ROLL-001', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100 } });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  const walkin = (who: string, customer: string, phone: string, price: number, extra: Record<string, unknown> = {}) =>
    call(who, 'POST', '/orders/walkin', {
      customerName: customer,
      phone,
      staffId: ids[who],
      paymentTiming: 'onCompletion',
      lineItems: [{ itemType: 'service', serviceId: banner, qty: 1, unitPrice: price }],
      ...extra,
    });

  it('a sourced client is credited to the staff member who sourced them, and nobody else can take them', async () => {
    const a = await walkin('amina', 'Grace Mwangi', '0712 000 111', 1000, { sourcedBy: ids.amina });
    assert.equal(a.status, 201);
    assert.equal(a.body.salesSource, 'sourced');
    assert.equal(a.body.sourcedByStaffId, ids.amina);

    // The same person comes back (the phone number written differently) and another staff member captures and claims her.
    const b = await walkin('brian', 'Grace M', '+254712000111', 1000, { sourcedBy: ids.brian });
    assert.equal(b.status, 201);
    assert.equal(b.body.sourcedByStaffId, ids.amina, 'the order is still credited to the owner');
    assert.equal(await prisma.clientOwner.count({ where: { clientKey: 'p:712000111' } }), 1, 'no second owner was created');

    // Without a claim a brand-new client is a house order.
    const house = await walkin('brian', 'Walk Inn', '0799 888 777', 1000);
    assert.equal(house.body.salesSource, 'house');
    assert.equal(house.body.sourcedByStaffId, null);

    const lookup = await call('brian', 'GET', '/commission/owner-lookup?phone=0712000111');
    assert.equal(lookup.body.owner.staffName, 'amina (commission test)');
    assert.equal(lookup.body.owner.mine, false);
  });

  it('claiming a client needs a way to recognise them again, and only for yourself', async () => {
    const noPhone = await walkin('amina', 'Someone', '', 1000, { sourcedBy: ids.amina });
    assert.equal(noPhone.status, 400);
    assert.match(noPhone.body.error, /phone number/);
    const forOther = await walkin('brian', 'Other Person', '0700 123 456', 1000, { sourcedBy: ids.amina });
    assert.equal(forOther.status, 400);
    assert.match(forOther.body.error, /for yourself/);
  });

  it('general commission is banded on net sales received — an unpaid order earns nothing', async () => {
    // KES 464,000 paid in full at capture = 400,000 net → 150k..300k at 2% (3,000) + 300k..400k at 3.5% (3,500)
    const paid = await walkin('amina', 'Big Corporate Ltd', '0722 000 333', 464000, { sourcedBy: ids.amina, paymentTiming: 'onAcceptance', payments: [{ method: 'Cash', amount: 464000 }] });
    assert.equal(paid.status, 201);
    assert.equal((await mine('amina')).general.commission, 6500);

    // Raised but not paid: nothing yet.
    const unpaid = await walkin('amina', 'Slow Payer', '0733 000 444', 116000, { sourcedBy: ids.amina });
    assert.equal((await mine('amina')).general.commission, 6500);
    // Half is paid (58,000 → 50,000 net) → 450,000 net: 3,000 + 150k × 3.5% = 8,250
    const pay = await call('amina', 'POST', `/orders/${unpaid.body.id}/payments`, { amount: 58000, method: 'M-Pesa' });
    assert.equal(pay.status, 200);
    assert.equal((await mine('amina')).general.commission, 8250);

    // The paid order is later credited (KES 116,000 refunded): 406,000 received → 350,000 net → 3,000 + 50k × 3.5%
    const note = await call('boss', 'POST', '/accounting/notes/credit', { orderId: paid.body.id, reason: 'Returned goods', amount: 116000 });
    assert.equal(note.status, 201);
    assert.equal((await mine('amina')).general.commission, 4750);
    // Brian sourced nothing, so the general bands earn him nothing.
    assert.equal((await mine('brian')).general.commission, 0);
  });

  it('film earns a premium above the 400 base, with no 500 ceiling, as it is paid', async () => {
    const low = await call('brian', 'POST', '/dtf/sales', { rollId: 'ROLL-001', client: 'Cheap', metres: 1, pricePerM: 399, amountPaid: 399 });
    assert.equal(low.status, 400);
    assert.match(low.body.error, /below 400/);

    // 450/m: premium 50 → 25×10% + 25×25% = 8.75/m; 10 m = 87.50, VAT out = 75.43
    const s1 = await call('brian', 'POST', '/dtf/sales', { rollId: 'ROLL-001', client: 'Film Buyer', phone: '0744 000 555', metres: 10, pricePerM: 450, amountPaid: 4500 });
    assert.equal(s1.status, 201);
    // 520/m is allowed now: premium 120 → 2.5 + 6.25 + 10 + 45×50% = 41.25/m; 5 m = 206.25 → 177.80
    const s2 = await call('brian', 'POST', '/dtf/sales', { rollId: 'ROLL-001', client: 'Premium Buyer', metres: 5, pricePerM: 520, amountPaid: 2600 });
    assert.equal(s2.status, 201);
    // At the base price there is no premium
    const s3 = await call('brian', 'POST', '/dtf/sales', { rollId: 'ROLL-001', client: 'Base Buyer', metres: 20, pricePerM: 400, amountPaid: 8000 });
    assert.equal(s3.status, 201);

    const st = await mine('brian');
    assert.equal(st.film.commission, 253.23);
    assert.equal(st.film.sales.length, 2);
    assert.equal(st.productivity.filmMetres, 35);
    assert.equal(st.productivity.filmSales, 3);
    // (10×450 + 5×520 + 20×400) / 35
    assert.equal(st.productivity.filmAvgPricePerM, 431.43);
  });

  it('a film sale on credit earns its premium only as the money comes in', async () => {
    const s = await call('brian', 'POST', '/dtf/sales', { rollId: 'ROLL-001', client: 'Credit Buyer', metres: 10, pricePerM: 450, amountPaid: 0 });
    assert.equal(s.status, 201);
    assert.equal((await mine('brian')).film.commission, 253.23);
    await call('brian', 'POST', `/orders/${s.body.order.id}/payments`, { amount: 2250, method: 'Cash' }); // half
    assert.equal((await mine('brian')).film.commission, 290.95);
  });

  it('artwork earns only on the price charged above the recommended one', async () => {
    // 2 running metres, 108 pieces → recommended 30 + 2160×2/108 = 70 per piece
    const job = (price: number | undefined, paid: number) => call('amina', 'POST', '/dtf/jobs', { rollId: 'ROLL-001', client: 'Print Client', runningMetres: 2, pieces: 108, pricePerPiece: price, amountPaid: paid });

    const tooLow = await job(60, 0);
    assert.equal(tooLow.status, 400);
    assert.match(tooLow.body.error, /recommended 70/);

    // At the recommended price: no commission line at all
    const plain = await job(undefined, 7560);
    assert.equal(plain.status, 201);
    assert.equal((await mine('amina')).artwork.commission, 0);

    // 80 per piece, half paid: 108 × 10 = 1,080 → 931.03 net → 50% = 465.52 → half is 232.76
    const high = await job(80, 4320);
    assert.equal(high.status, 201);
    assert.equal(high.body.order.totals.grandTotal, 8640);
    assert.equal((await mine('amina')).artwork.commission, 232.76);
    await call('amina', 'POST', `/orders/${high.body.order.id}/payments`, { amount: 4320, method: 'Cash' });
    assert.equal((await mine('amina')).artwork.commission, 465.52);
    assert.equal((await mine('amina')).productivity.artworkExtraCharged, 1080);
  });

  it('only managers see everyone, change the rates, and handle ownership', async () => {
    assert.equal((await call('amina', 'GET', `/commission/statement?period=${period}`)).status, 403);
    assert.equal((await call('amina', 'PUT', '/commission/settings', {})).status, 403);
    assert.equal((await call('amina', 'GET', '/commission/clients')).status, 403);
    // everyone can read the scheme they are paid under
    assert.equal((await call('amina', 'GET', '/commission/settings')).status, 200);

    const all = await call('boss', 'GET', `/commission/statement?period=${period}`);
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.statements.map((s: any) => s.staffName).sort(), ['amina (commission test)', 'brian (commission test)']);

    const bad = await call('boss', 'PUT', '/commission/settings', { generalBands: [{ from: 10, rate: 1 }], filmBands: [{ from: 0, rate: 5 }], artworkRatePct: 50, ownershipMonths: 12 });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /start at 0/);

    // Nobody shares a client: assigning an owned client fails; releasing frees them for the next person
    const clash = await call('boss', 'POST', '/commission/clients', { staffId: ids.brian, phone: '0712 000 111' });
    assert.equal(clash.status, 409);
    const owned = (await call('boss', 'GET', '/commission/clients')).body.find((c: any) => c.clientKey === 'p:712000111');
    assert.equal((await call('boss', 'POST', `/commission/clients/${owned.id}/release`)).status, 200);
    const next = await walkin('brian', 'Grace Mwangi', '0712000111', 1000, { sourcedBy: ids.brian });
    assert.equal(next.body.sourcedByStaffId, ids.brian);
    const now = await prisma.clientOwner.findMany({ where: { clientKey: 'p:712000111' }, orderBy: { id: 'asc' } });
    assert.deepEqual(now.map((r) => r.status), ['Released', 'Active']);
    // The window is the configured 12 months
    assert.equal(now[1]!.endDate, `${Number(now[1]!.startDate.slice(0, 4)) + 1}${now[1]!.startDate.slice(4)}`);
  });

  it('an approved month is paid out as Sales Commission on the books', async () => {
    const before = await bal('5020');
    const stmt = (await call('boss', 'GET', `/commission/statement?period=${period}`)).body.statements.find((s: any) => s.staffId === ids.amina);
    assert.ok(stmt.total > 0);

    const approved = await call('boss', 'POST', '/commission/payouts/approve', { period });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.payouts.find((p: any) => p.staffId === ids.amina).amount, stmt.total);

    const row = (await call('boss', 'GET', `/commission/payouts?period=${period}`)).body.find((p: any) => p.staffId === ids.amina);
    assert.equal(row.status, 'Approved');
    assert.equal(row.generalAmount + row.artworkAmount + row.filmAmount, stmt.total);

    const paid = await call('boss', 'POST', `/commission/payouts/${row.id}/pay`, { method: 'Bank Transfer' });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.status, 'Paid');
    const exp = await prisma.expense.findUniqueOrThrow({ where: { id: paid.body.expenseId } });
    assert.equal(exp.category, 'Sales Commission');
    assert.equal(exp.amount, stmt.total);
    assert.equal(round2((await bal('5020')) - before), stmt.total);

    // paying twice, or withdrawing a paid commission, is refused
    assert.equal((await call('boss', 'POST', `/commission/payouts/${row.id}/pay`, { method: 'Cash' })).status, 400);
    assert.equal((await call('boss', 'DELETE', `/commission/payouts/${row.id}`)).status, 400);
    // and approving again leaves a paid month alone
    const again = await call('boss', 'POST', '/commission/payouts/approve', { period });
    assert.equal(again.body.payouts.find((p: any) => p.staffId === ids.amina).status, 'Paid');
    assert.equal(await prisma.expense.count({ where: { category: 'Sales Commission', note: { contains: 'amina' } } }), 1);
  });
});

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
