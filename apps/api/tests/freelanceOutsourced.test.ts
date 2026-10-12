// Freelancers: the graduated scale reaches a single KES 10 million sale (and the marginal share falls for the largest deals), a freelancer who brings an outsourced job is
// paid a share of its net gross profit as the client pays the company — never a share of the sale — and each freelancer's year is a statement for the tax return.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_FREELANCE_BANDS, bandedAmount, todayStr, weekStart, withholdingOn } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
const week = weekStart(todayStr());
let bannerId = 0;
let megaId = 0;

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
let phoneNo = 0;
const newAgent = async (name: string) => (await call('boss', 'POST', '/freelance/agents', { name, phone: `07${String(30000000 + ++phoneNo * 1013)}`, kraPin: 'A000000001Z' })).body.id as number;
const stmt = async (agent: number) => (await call('boss', 'GET', `/freelance/statement?week=${week}`)).body.statements.find((s: any) => s.agentId === agent);

let n = 0;
// an outsourced job brought by a freelancer: sold for `price` a unit and bought for `cost` a unit (both VAT included), paid `pay` of it
const outsourced = (agent: number, price: number, cost: number, qty: number, pay: number, lines?: unknown[]) =>
  call('seller', 'POST', '/orders/outsourced', {
    customerName: `FO Client ${++n}`,
    phone: `0733${String(100000 + n * 137)}`,
    staffId: ids.seller,
    freelanceAgentId: agent,
    paymentTiming: pay > 0 ? 'onAcceptance' : 'onCompletion',
    ...(pay > 0 ? { payments: [{ method: 'Cash', amount: pay }] } : {}),
    lines: lines ?? [{ serviceId: bannerId, qty, unitPrice: price, supplierCost: cost, supplierName: 'Print House', supplierVatClaimable: true }],
  });

describe('freelancers: the scale to KES 10 million, outsourced jobs, and the annual statement', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Seller (fl outsourced test)', canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Boss (fl outsourced test)', canCaptureOrders: true, canAccessFinance: true, canAccessAccounting: true, canManageCommission: true } });
    for (const [key, role] of [['seller', 'Seller (fl outsourced test)'], ['boss', 'Boss (fl outsourced test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (fl outsourced test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true, freelanceBandsJson: JSON.stringify(DEFAULT_FREELANCE_BANDS) }, create: { id: 1, enabled: true } });
    bannerId = (await prisma.service.create({ data: { name: 'Banner (fl outsourced test)', unit: 'piece', price: 2320, outsourced: true, supplierName: 'Print House' } })).id;
    megaId = (await prisma.service.create({ data: { name: 'Mega contract (fl outsourced test)', unit: 'piece', price: 10_000_000 } })).id;
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('the scale reaches a single KES 10 million sale: about 1.85% of its net, with the largest slice at 1%', async () => {
    const agent = await newAgent('Mega Agent');
    const sale = await call('seller', 'POST', '/orders/walkin', { customerName: 'Mega Client', phone: '0711999888', staffId: ids.seller, freelanceAgentId: agent, paymentTiming: 'onAcceptance', lineItems: [{ itemType: 'service', serviceId: megaId, qty: 1, unitPrice: 10_000_000 }], payments: [{ method: 'Bank Transfer', amount: 10_000_000 }] });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const s = await stmt(agent);
    assert.equal(s.qualifyingNet, 8_620_689.66); // 10,000,000 ÷ 1.16
    // 2% of 50,000 + 3% of 100,000 + 4% of 350,000 + 3% of 1,500,000 + 2% of 3,000,000 + 1% of the rest
    assert.equal(s.baseCommission, bandedAmount(DEFAULT_FREELANCE_BANDS, 8_620_689.66));
    assert.ok(Math.abs(s.baseCommission - 159_206.9) < 0.02, String(s.baseCommission));
    assert.equal(s.premiumCommission, 0);
    assert.ok(s.baseCommission / s.qualifyingNet < 0.02); // well under the 4% a flat top band would pay
    // the tax withheld comes off what is paid
    assert.equal(s.withholdingTax, withholdingOn(s.commission, s.whtRate));
    assert.equal(s.netPay, Math.round((s.commission - s.withholdingTax) * 100) / 100);
  });

  it('an outsourced job is paid on its net gross profit, as the client pays the company — nothing on the sale', async () => {
    const agent = await newAgent('Outsourcing Agent');
    // sold for 23,200 (20,000 net) and bought for 11,600 (10,000 net, VAT claimable): a 50% margin, 20% of the 10,000 profit
    const paid = await outsourced(agent, 2320, 1160, 10, 23200);
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    let s = await stmt(agent);
    assert.deepEqual([s.outsourcedCommission, s.baseCommission, s.premiumCommission, s.commission], [2000, 0, 0, 2000]);
    assert.equal(s.outsourcedJobs[0].grossProfit, 10000);
    assert.equal(s.withholdingTax, withholdingOn(2000, s.whtRate));

    // half paid: half is earned; not paid to the company at all: nothing, and the job is not in the statement
    const half = await outsourced(agent, 2320, 1160, 10, 11600);
    assert.equal(half.status, 201);
    const unpaid = await outsourced(agent, 2320, 1160, 10, 0);
    assert.equal(unpaid.status, 201);
    s = await stmt(agent);
    assert.equal(s.outsourcedCommission, 3000);
    assert.equal(s.outsourcedJobs.length, 2);
    assert.ok(!s.outsourcedJobs.some((j: any) => j.orderNo === unpaid.body.orderNo));
  });

  it('a typed-in outsourced item (no list price) is paid on its profit, not 30% of its sale', async () => {
    const agent = await newAgent('Custom Item Agent');
    // 11,600 sold for 5,800 bought, claimable: 10,000 net sale, 5,000 net cost, 50% margin → 20% of 5,000 = 1,000 (not 30% of the 8,620 sale)
    const r = await outsourced(agent, 0, 0, 0, 11600, [{ name: 'One-off acrylic stand', unit: 'piece', qty: 1, unitPrice: 11600, supplierCost: 5800, supplierName: 'Acrylic Co', supplierVatClaimable: true }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const s = await stmt(agent);
    assert.deepEqual([s.outsourcedCommission, s.premiumCommission, s.baseCommission, s.commission], [1000, 0, 0, 1000]);
  });

  it("the year's statement lists what each freelancer was paid and the tax withheld, and who is missing a KRA PIN or national ID", async () => {
    const agent = await newAgent('Annual Agent');
    assert.equal((await outsourced(agent, 2320, 1160, 10, 23200)).status, 201);
    assert.equal((await call('boss', 'POST', '/freelance/payouts/approve', { weekStart: week })).status, 200);
    const payout = await prisma.freelancePayout.findFirstOrThrow({ where: { agentId: agent } });
    assert.equal((await call('boss', 'POST', `/freelance/payouts/${payout.id}/pay`, { method: 'M-Pesa' })).status, 200);
    const year = Number(todayStr().slice(0, 4));
    const a = (await call('boss', 'GET', `/freelance/annual?year=${year}`)).body;
    const me = a.people.find((p: any) => p.agentId === agent);
    const tax = withholdingOn(2000, payout.withholdingRate);
    assert.deepEqual([me.weeks, me.gross, me.withheld, me.net, me.kraPin], [1, 2000, tax, 2000 - tax, 'A000000001Z']);
    assert.ok(a.missingId.includes('Annual Agent')); // no national ID on file
    assert.equal(a.year, year);
    assert.equal((await call('seller', 'GET', `/freelance/annual?year=${year}`)).status, 403); // for managers
    assert.equal((await call('boss', 'GET', '/freelance/annual?year=1999')).body.year, year); // a sensible year, or this one
  });
});
