// Freelance sales persons: accounts made at order capture, an order credited to a freelancer and never to staff, commission only on sales at or above
// base prices, weekly marginal bands, and weekly payouts that reach the books.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ACCT, addWeeks, methodAccountCode, todayStr, weekEnd, weekStart } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { loadLedger, naturalBalance, sumByAccount } from '../src/accounting/ledger';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
const agents: Record<string, number> = {};
let banner = 0;
const week = weekStart(todayStr());
const period = todayStr().slice(0, 7);

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const stmt = async (agent: string) => (await call('boss', 'GET', `/freelance/statement?week=${week}`)).body.statements.find((s: any) => s.agentId === agents[agent]);
const staffStatement = async (who: string) => (await call(who, 'GET', `/commission/my?period=${period}`)).body.statement;

let n = 0;
const order = (who: string, lines: { qty: number; unitPrice: number }[], extra: Record<string, unknown> = {}) => {
  const total = lines.reduce((a, l) => a + l.qty * l.unitPrice, 0) * (1 - ((extra.orderDiscountPct as number) ?? 0) / 100);
  return call(who, 'POST', '/orders/walkin', {
    customerName: `Freelance Client ${++n}`,
    phone: `07${String(20000000 + n * 211)}`,
    staffId: ids[who],
    paymentTiming: 'onAcceptance',
    lineItems: lines.map((l) => ({ itemType: 'service', serviceId: banner, qty: l.qty, unitPrice: l.unitPrice })),
    payments: [{ method: 'Cash', amount: total }],
    ...extra,
  });
};

describe('freelance sales persons', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Free Counter', canCaptureOrders: true, canAccessDtf: true } });
    await prisma.role.create({ data: { name: 'Free Boss', canCaptureOrders: true, canAccessFinance: true, canAccessAccounting: true, canManageCommission: true } });
    for (const [key, role] of [['amina', 'Free Counter'], ['brian', 'Free Counter'], ['boss', 'Free Boss']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (freelance test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true, targetMultiplier: 0 }, create: { id: 1, enabled: true, targetMultiplier: 0 } });
    banner = (await prisma.service.create({ data: { name: 'Banner (freelance test)', unit: 'piece', price: 1160 } })).id;
    for (const [name, unit, price] of [['DTF Sheet (per metre)', 'metre', 500], ['DTF Printing', 'piece', 70]] as const) {
      if (!(await prisma.service.findFirst({ where: { name } }))) await prisma.service.create({ data: { name, unit, price } });
    }
    await prisma.dtfRoll.create({ data: { id: 'ROLL-FL', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 200 } });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  describe('accounts', () => {
    it('whoever captures an order can add one, but it waits for a manager; a manager\'s own is active at once', async () => {
      const mine = await call('amina', 'POST', '/freelance/agents', { name: 'Wanjiku Maina', phone: '0711 222 333', mpesaNumber: '0711 222 333', bankName: 'Equity', bankAccount: '0123456789' });
      assert.equal(mine.status, 201);
      assert.deepEqual([mine.body.status, mine.body.existing, mine.body.phoneTail], ['Pending', false, '333']);
      agents.wanjiku = mine.body.id;
      const stored = await prisma.freelanceAgent.findUniqueOrThrow({ where: { id: agents.wanjiku! } });
      assert.deepEqual([stored.phone, stored.mpesaNumber, stored.createdByName], ['254711222333', '254711222333', 'amina (freelance test)']);

      const boss = await call('boss', 'POST', '/freelance/agents', { name: 'Otieno Agency', phone: '+254 722 000 111', kraPin: 'a123456789b' });
      assert.equal(boss.status, 201);
      assert.equal(boss.body.status, 'Active');
      agents.otieno = boss.body.id;
      assert.equal((await prisma.freelanceAgent.findUniqueOrThrow({ where: { id: agents.otieno! } })).kraPin, 'A123456789B');
    });

    it('a phone number is one account: adding it again hands back the same one; bad details are refused', async () => {
      const again = await call('brian', 'POST', '/freelance/agents', { name: 'Someone Else', phone: '0711222333' });
      assert.equal(again.status, 200);
      assert.deepEqual([again.body.id, again.body.existing, again.body.name], [agents.wanjiku, true, 'Wanjiku Maina']);
      assert.equal((await call('amina', 'POST', '/freelance/agents', { name: 'X', phone: '0711222444' })).status, 400); // a name is needed
      assert.equal((await call('amina', 'POST', '/freelance/agents', { name: 'Bad Phone', phone: '12345' })).status, 400);
      assert.equal((await call('amina', 'POST', '/freelance/agents', { name: 'Bad Pin', phone: '0733 444 555', kraPin: 'nope' })).status, 400);
    });

    it('those capturing orders see names to pick from, not pay details; only managers see the accounts', async () => {
      const list = (await call('brian', 'GET', '/freelance/pickable')).body as any[];
      assert.ok(list.some((a) => a.name === 'Wanjiku Maina'));
      assert.ok(!JSON.stringify(list).includes('0123456789') && !JSON.stringify(list).includes('254711222333'));
      assert.equal((await call('brian', 'GET', '/freelance/agents')).status, 403);
      assert.equal((await call('brian', 'GET', `/freelance/statement?week=${week}`)).status, 403);
      assert.ok(((await call('boss', 'GET', '/freelance/agents')).body as any[]).some((a) => a.bankAccount === '0123456789'));
    });
  });

  describe('one order, one owner', () => {
    it('an order marked for a freelancer is credited to them alone: no staff credit, and no staff ownership of the client', async () => {
      const r = await order('amina', [{ qty: 40, unitPrice: 1160 }], { freelanceAgentId: agents.otieno });
      assert.equal(r.status, 201);
      assert.deepEqual([r.body.salesSource, r.body.sourcedByStaffId], ['freelance', null]);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: r.body.id } });
      assert.deepEqual([row.freelanceAgentId, row.sourcedByStaffId, row.freelanceQualifyingShare], [agents.otieno, null, 1]);
      assert.equal(await prisma.clientOwner.count({ where: { clientName: { startsWith: 'Freelance Client' } } }), 0, 'no staff member owns that client');
      // the client is the freelancer's now: they keep them while they keep bringing orders
      const mine = await prisma.freelanceClient.findFirstOrThrow({ where: { clientKey: row.clientKey! } });
      assert.deepEqual([mine.agentId, mine.status], [agents.otieno, 'Active']);
      assert.equal((await call('amina', 'GET', `/orders/${r.body.id}`)).body.freelanceAgentName, 'Otieno Agency');
    });

    it('it cannot also be claimed by a staff member, given to a client a staff member owns, or given to an agent who is suspended or unknown', async () => {
      const both = await order('amina', [{ qty: 1, unitPrice: 1160 }], { freelanceAgentId: agents.otieno, sourcedBy: ids.amina, customerName: 'Both Ways', phone: '0700 111 222' });
      assert.equal(both.status, 400);
      assert.match(both.body.error, /not both/);

      // a client brought in by Amina is hers for the window — a freelancer cannot also be credited for them
      const owned = await order('amina', [{ qty: 1, unitPrice: 1160 }], { sourcedBy: ids.amina, customerName: 'Owned Client', phone: '0700 333 444' });
      assert.equal(owned.status, 201);
      const clash = await order('brian', [{ qty: 1, unitPrice: 1160 }], { freelanceAgentId: agents.otieno, customerName: 'Owned Client', phone: '0700 333 444' });
      assert.equal(clash.status, 400);
      assert.match(clash.body.error, /credited to amina/);

      assert.equal((await order('amina', [{ qty: 1, unitPrice: 1160 }], { freelanceAgentId: 999999 })).status, 400);
      await call('boss', 'PUT', `/freelance/agents/${agents.wanjiku}`, { status: 'Suspended' });
      const suspended = await order('amina', [{ qty: 1, unitPrice: 1160 }], { freelanceAgentId: agents.wanjiku });
      assert.equal(suspended.status, 400);
      assert.match(suspended.body.error, /suspended/);
      assert.ok(!((await call('brian', 'GET', '/freelance/pickable')).body as any[]).some((a) => a.id === agents.wanjiku), 'a suspended agent is no longer offered');
      await call('boss', 'PUT', `/freelance/agents/${agents.wanjiku}`, { status: 'Pending' }); // back to waiting for approval
    });

    it('a freelance order earns the staff who captured it nothing — no sourcing, film or artwork commission, nothing towards a target', async () => {
      const before = await staffStatement('brian');
      const film = await call('brian', 'POST', '/dtf/sales', { rollId: 'ROLL-FL', client: 'Free Film', phone: '0744 123 456', metres: 10, pricePerM: 450, amountPaid: 4500, freelanceAgentId: agents.otieno });
      assert.equal(film.status, 201);
      const after = await staffStatement('brian');
      assert.equal(after.film.commission, before.film.commission, 'no film premium for the person who captured it');
      assert.equal(after.film.sales.length, before.film.sales.length);
      assert.equal(after.target.achieved, before.target.achieved, 'and it does not count towards a sales target');
      const s = await staffStatement('amina');
      assert.ok(!s.general.orders.some((o: any) => /Freelance Client/.test(o.customer)), 'the order the freelancer brought is not in her statement');
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: film.body.order.id } })).sourcedByStaffId, null);
    });

    it('with the commission scheme off a freelance mark is simply ignored, as a staff claim is', async () => {
      await prisma.commissionSettings.update({ where: { id: 1 }, data: { enabled: false } });
      const r = await order('amina', [{ qty: 1, unitPrice: 1160 }], { freelanceAgentId: agents.otieno });
      await prisma.commissionSettings.update({ where: { id: 1 }, data: { enabled: true } });
      assert.equal(r.status, 201);
      assert.deepEqual([r.body.salesSource], ['house']);
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: r.body.id } })).freelanceAgentId, null);
    });
  });

  describe('commission: weekly bands on sales at or above base prices', () => {
    it("the week's base-price sales are banded: 2% of the first 50,000, 3% of the next, plus 30% of what the film was charged above base", async () => {
      // the film sale above (4,500 paid) is already in; add two orders of 40,000 and 60,000 net
      assert.equal((await order('amina', [{ qty: 60, unitPrice: 1160 }], { freelanceAgentId: agents.otieno })).status, 201);
      const s = await stmt('otieno');
      // net received: 40,000 + 60,000 + (4,500 film / 1.16 = 3,879.31) = 103,879.31 — all at or above base
      assert.equal(s.qualifyingNet, 103879.31);
      assert.equal(s.belowBaseNet, 0);
      // the film sale is 4,000 at base and 500 above it (450 a metre against the 400 floor): 3,448.28 + 431.03 net
      assert.equal(s.baseNet, 103448.28);
      assert.equal(s.premiumNet, 431.03);
      assert.equal(s.baseCommission, 2603.45); // 50,000 × 2% + 53,448.28 × 3%
      assert.equal(s.premiumCommission, 129.31); // 30% of 431.03
      assert.equal(s.commission, 2732.76);
      assert.deepEqual([s.band.rate, s.band.nextRate], [3, 4]);
      assert.equal(s.orders.length, 3);
    });

    it('a line sold below its base price earns nothing; a mixed order counts only the lines at or above', async () => {
      const b = await call('boss', 'POST', '/freelance/agents', { name: 'Base Checker', phone: '0755 000 111' });
      agents.base = b.body.id;
      // listed at 1,160: priced at 900 → no commission at all
      assert.equal((await order('amina', [{ qty: 10, unitPrice: 900 }], { freelanceAgentId: agents.base })).status, 201);
      let s = await stmt('base');
      assert.deepEqual([s.qualifyingNet, s.commission, s.belowBaseNet], [0, 0, 7758.62]);

      // 11,600 at a good price and 8,000 below base: only the first counts (10,000 net)
      const mixed = await order('amina', [{ qty: 10, unitPrice: 1160 }, { qty: 10, unitPrice: 800 }], { freelanceAgentId: agents.base });
      assert.equal(mixed.status, 201);
      assert.equal(Math.round((await prisma.order.findUniqueOrThrow({ where: { id: mixed.body.id } })).freelanceQualifyingShare * 1000) / 1000, 0.592);
      s = await stmt('base');
      assert.equal(s.qualifyingNet, 10000);
      assert.equal(s.commission, 200); // 2% of 10,000
    });

    it('a discount that takes a line under its base price disqualifies it; a high enough price survives the discount', async () => {
      const d = await call('boss', 'POST', '/freelance/agents', { name: 'Discount Checker', phone: '0766 000 222' });
      agents.disc = d.body.id;
      const cut = await order('amina', [{ qty: 10, unitPrice: 1160 }], { freelanceAgentId: agents.disc, orderDiscountPct: 10 }); // 1,044 a unit after 10% off
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: cut.body.id } })).freelanceQualifyingShare, 0);
      const kept = await order('amina', [{ qty: 10, unitPrice: 1300 }], { freelanceAgentId: agents.disc, orderDiscountPct: 10 }); // 1,170 a unit after 10% off: still above 1,160
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: kept.body.id } })).freelanceQualifyingShare, 1);
    });

    it('film counts at or above its floor; an artwork job counts only at or above the recommended price', async () => {
      const f = await call('boss', 'POST', '/freelance/agents', { name: 'Film Agent', phone: '0777 000 333' });
      agents.film = f.body.id;
      const sale = await call('brian', 'POST', '/dtf/sales', { rollId: 'ROLL-FL', client: 'Floor Film', phone: '0744 555 666', metres: 5, pricePerM: 400, amountPaid: 2000, freelanceAgentId: agents.film });
      assert.equal(sale.status, 201);
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: sale.body.order.id } })).freelanceQualifyingShare, 1);

      // 2 running metres on 108 pieces → recommended 70 a piece (+ the 20 heat press fee)
      const job = (price: number | undefined, paid: number) => call('brian', 'POST', '/dtf/jobs', { rollId: 'ROLL-FL', client: 'Free Print', phone: '0744 777 888', runningMetres: 2, pieces: 108, heatPressFee: 20, pricePerPiece: price, amountPaid: paid, freelanceAgentId: agents.film });
      const atRec = await job(undefined, 9720);
      assert.equal(atRec.status, 201);
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: atRec.body.order.id } })).freelanceQualifyingShare, 1);
      const above = await job(80, 10800);
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: above.body.order.id } })).freelanceQualifyingShare, 1);
      const below = await job(50, 0); // below the recommended price: it needs a manager's approval, and it is not at base
      assert.equal(below.status, 201);
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: below.body.order.id } })).freelanceQualifyingShare, 0);
    });

    it('a refund in the week comes off what the bands apply to', async () => {
      const r = await call('boss', 'POST', '/freelance/agents', { name: 'Refund Agent', phone: '0788 000 444' });
      agents.refund = r.body.id;
      const o = await order('amina', [{ qty: 50, unitPrice: 1160 }], { freelanceAgentId: agents.refund }); // 58,000 → 50,000 net
      assert.equal((await stmt('refund')).qualifyingNet, 50000);
      assert.equal((await call('boss', 'POST', '/accounting/notes/credit', { orderId: o.body.id, reason: 'Returned', amount: 11600 })).status, 201); // 10,000 net back
      const s = await stmt('refund');
      assert.equal(s.qualifyingNet, 40000);
      assert.equal(s.commission, 800); // 2% of 40,000
    });
  });

  describe('premium share: commission never eats into the base price', () => {
    it('an order sold above base pays a small band on the base part and 30% of the extra; the base price itself carries only the small band', async () => {
      const p = await call('boss', 'POST', '/freelance/agents', { name: 'Premium Agent', phone: '0711 800 001' });
      agents.premium = p.body.id;
      // 10 banners listed at 1,160 sold at 1,392 (20% above): 13,920 paid = 12,000 net, of which 10,000 is base and 2,000 is the extra
      const o = await order('amina', [{ qty: 10, unitPrice: 1392 }], { freelanceAgentId: agents.premium });
      assert.equal(o.status, 201);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: o.body.id } });
      assert.deepEqual([row.freelanceQualifyingShare, Math.round(row.freelanceBaseShare * 1e4) / 1e4, Math.round(row.freelancePremiumShare * 1e4) / 1e4], [1, 0.8333, 0.1667]);
      const s = await stmt('premium');
      assert.deepEqual([s.baseNet, s.premiumNet], [10000, 2000]);
      assert.deepEqual([s.baseCommission, s.premiumCommission, s.commission], [200, 600, 800]);
      // the company keeps 11,200 of the 12,000 net, whereas 3/5/7% of the whole sale would have taken far more of the base margin
      assert.ok(s.commission / s.qualifyingNet < 0.07);
    });

    it('selling at base earns only the small band, with no premium', async () => {
      const p = await call('boss', 'POST', '/freelance/agents', { name: 'At Base Agent', phone: '0711 800 002' });
      agents.atBase = p.body.id;
      assert.equal((await order('amina', [{ qty: 10, unitPrice: 1160 }], { freelanceAgentId: agents.atBase })).status, 201);
      const s = await stmt('atBase');
      assert.deepEqual([s.baseNet, s.premiumNet, s.premiumCommission, s.commission], [10000, 0, 0, 200]);
    });

    it('a contracted-out service counts at a reduced weight towards the bands, and its premium is still shared in full', async () => {
      const out = await prisma.service.create({ data: { name: 'Eulogy printing (freelance test)', unit: 'piece', price: 1160, outsourced: true, supplierName: 'Print Co' } });
      const p = await call('boss', 'POST', '/freelance/agents', { name: 'Outsourced Agent', phone: '0711 800 003' });
      agents.outsourced = p.body.id;
      const o = await call('amina', 'POST', '/orders/walkin', {
        customerName: 'Freelance Client Out', phone: '0722 800 003', staffId: ids.amina, paymentTiming: 'onAcceptance',
        lineItems: [{ itemType: 'service', serviceId: out.id, qty: 10, unitPrice: 1392 }],
        payments: [{ method: 'Cash', amount: 13920 }], freelanceAgentId: agents.outsourced,
      });
      assert.equal(o.status, 201, JSON.stringify(o.body));
      const row = await prisma.order.findUniqueOrThrow({ where: { id: o.body.id } });
      assert.ok(row.freelanceLowShare > 0.83 && row.freelanceLowShare < 0.84);
      const s = await stmt('outsourced');
      // 10,000 net is base: at 50% weight 5,000 is banded (2% → 100); the 2,000 extra pays 30% (600)
      assert.deepEqual([s.baseNet, s.premiumNet, s.baseCommission, s.premiumCommission, s.commission], [5000, 2000, 100, 600, 700]);
    });

    it('the premium share and the thin-margin weight are settings a manager can change', async () => {
      const cfg = (await call('boss', 'GET', '/commission/settings')).body;
      assert.deepEqual([cfg.freelancePremiumPct, cfg.freelanceLowMarginPct], [30, 50]);
      const base = { generalBands: cfg.generalBands, filmBands: cfg.filmBands, artworkRatePct: 50, ownershipMonths: 12 };
      const put = await call('boss', 'PUT', '/commission/settings', { ...base, freelancePremiumPct: 20, freelanceLowMarginPct: 100 });
      assert.equal(put.status, 200);
      assert.deepEqual([put.body.freelancePremiumPct, put.body.freelanceLowMarginPct], [20, 100]);
      const s = await stmt('premium');
      assert.equal(s.premiumCommission, 400); // the week is recalculated at 20% of 2,000
      assert.equal((await call('boss', 'PUT', '/commission/settings', { ...base, freelancePremiumPct: 101 })).status, 400);
      await call('boss', 'PUT', '/commission/settings', { ...base, freelancePremiumPct: 30, freelanceLowMarginPct: 50 });
    });
  });

  describe('weekly payouts and the account', () => {
    it('approving the week pays only active agents; a new one is left until a manager approves them', async () => {
      await prisma.order.deleteMany({ where: { freelanceAgentId: agents.wanjiku } });
      assert.equal((await order('amina', [{ qty: 10, unitPrice: 1160 }], { freelanceAgentId: agents.wanjiku })).status, 201); // she is Pending
      const r = await call('boss', 'POST', '/freelance/payouts/approve', { weekStart: week });
      assert.equal(r.status, 200);
      const names = r.body.payouts.map((p: any) => p.agentName);
      assert.ok(names.includes('Otieno Agency'));
      assert.ok(!names.includes('Wanjiku Maina'));
      assert.ok(r.body.skipped.some((s: any) => s.agentName === 'Wanjiku Maina' && /not approved/.test(s.reason)));
      assert.equal(((await prisma.freelancePayout.findFirstOrThrow({ where: { agentId: agents.otieno } })).amount), 2732.76);
      // a manager approves her; the week can be approved again
      assert.equal((await call('boss', 'PUT', `/freelance/agents/${agents.wanjiku}`, { status: 'Active' })).status, 200);
      const again = await call('boss', 'POST', '/freelance/payouts/approve', { weekStart: week });
      assert.ok(again.body.payouts.map((p: any) => p.agentName).includes('Wanjiku Maina'));
    });

    it('paying records an expense under Freelance Commission and settles the week; a paid week cannot be withdrawn', async () => {
      const payout = await prisma.freelancePayout.findFirstOrThrow({ where: { agentId: agents.otieno } });
      const paid = await call('boss', 'POST', `/freelance/payouts/${payout.id}/pay`, { method: 'M-Pesa' });
      assert.equal(paid.status, 200);
      const expense = await prisma.expense.findUniqueOrThrow({ where: { id: paid.body.expenseId } });
      assert.deepEqual([expense.category, expense.amount, expense.supplier], ['Freelance Commission', 2732.76, 'Otieno Agency']);
      assert.equal((await call('boss', 'POST', `/freelance/payouts/${payout.id}/pay`, { method: 'M-Pesa' })).status, 400); // once
      assert.equal((await call('boss', 'DELETE', `/freelance/payouts/${payout.id}`)).status, 400);
      const wanjiku = await prisma.freelancePayout.findFirstOrThrow({ where: { agentId: agents.wanjiku } });
      assert.equal((await call('boss', 'DELETE', `/freelance/payouts/${wanjiku.id}`)).status, 204); // approved but not paid: can be taken back
      // it reaches the books: the account exists and carries the payment
      const account = await prisma.account.findFirstOrThrow({ where: { name: 'Freelance Commission' } });
      assert.equal(account.type, 'Expense');
    });

    it("an agent's account shows what has been paid, what is waiting to be paid and what is not yet approved", async () => {
      const a = await call('boss', 'GET', `/freelance/agents/${agents.otieno}/account`);
      assert.equal(a.status, 200);
      assert.equal(a.body.summary.paid, 2732.76);
      assert.equal(a.body.summary.owed, 0);
      assert.deepEqual([a.body.weeks[0].weekStart, a.body.weeks[0].status, a.body.weeks[0].paidMethod], [week, 'Paid', 'M-Pesa']);
      // the week's commission for Base Checker was approved above and is waiting to be paid
      const b = await call('boss', 'GET', `/freelance/agents/${agents.base}/account`);
      assert.deepEqual([b.body.summary.approvedToPay, b.body.summary.owed, b.body.weeks[0].status], [200, 200, 'Approved']);
      // a new agent with sales this week that have not been approved yet
      const late = await call('boss', 'POST', '/freelance/agents', { name: 'Late Agent', phone: '0799 000 555' });
      assert.equal((await order('amina', [{ qty: 10, unitPrice: 1160 }], { freelanceAgentId: late.body.id })).status, 201);
      const l = await call('boss', 'GET', `/freelance/agents/${late.body.id}/account`);
      assert.deepEqual([l.body.summary.notYetApproved, l.body.summary.owed, l.body.weeks[0].status], [200, 200, 'This week so far']);
      assert.equal((await call('brian', 'GET', `/freelance/agents/${agents.otieno}/account`)).status, 403);
    });

    it('the weeks run Monday to Sunday and can be looked at one at a time; the bands are editable', async () => {
      const s = (await call('boss', 'GET', `/freelance/statement?week=${todayStr()}`)).body; // any day gives its week
      assert.deepEqual([s.weekStart, s.weekEnd], [week, weekEnd(week)]);
      const empty = (await call('boss', 'GET', '/freelance/statement?week=2020-01-06')).body;
      assert.equal(empty.statements.length, 0);
      const cfg = (await call('boss', 'GET', '/commission/settings')).body;
      assert.deepEqual(cfg.freelanceBands, [{ from: 0, rate: 2 }, { from: 50000, rate: 3 }, { from: 150000, rate: 4 }]);
      const put = await call('boss', 'PUT', '/commission/settings', { generalBands: cfg.generalBands, filmBands: cfg.filmBands, artworkRatePct: 50, ownershipMonths: 12, freelanceBands: [{ from: 0, rate: 4 }] });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body.freelanceBands, [{ from: 0, rate: 4 }]);
      assert.equal((await call('boss', 'PUT', '/commission/settings', { generalBands: cfg.generalBands, filmBands: cfg.filmBands, artworkRatePct: 50, ownershipMonths: 12, freelanceBands: [{ from: 10, rate: 4 }] })).status, 400); // must start at 0
      await call('boss', 'PUT', '/commission/settings', { generalBands: cfg.generalBands, filmBands: cfg.filmBands, artworkRatePct: 50, ownershipMonths: 12, freelanceBands: cfg.freelanceBands });
    });
  });

  describe('a freelancer owns the client for as long as they keep bringing orders', () => {
    const monthsAgo = (n: number) => {
      const d = new Date();
      d.setMonth(d.getMonth() - n);
      return d.toISOString().slice(0, 10);
    };
    const mk = async (name: string, phone: string) => (await call('boss', 'POST', '/freelance/agents', { name, phone })).body.id as number;
    const sameClient = (who: string, extra: Record<string, unknown> = {}) => order(who, [{ qty: 10, unitPrice: 1160 }], { customerName: 'Loyal Client', phone: '0701 555 123', ...extra });
    const owned = async () => prisma.freelanceClient.findFirst({ where: { clientKey: 'p:701555123' }, orderBy: { id: 'desc' } });

    it('the order that brings a client makes them the freelancer\'s, and every later order from them is credited to the freelancer whoever captures it', async () => {
      agents.owner1 = await mk('Owner One', '0702 000 001');
      const first = await sameClient('amina', { freelanceAgentId: agents.owner1 });
      assert.equal(first.status, 201);
      const row = await owned();
      assert.deepEqual([row!.agentId, row!.status, row!.startDate], [agents.owner1, 'Active', todayStr()]);

      // another member of staff takes the next order with no mark at all: it is still the freelancer's
      const next = await sameClient('brian');
      assert.equal(next.status, 201);
      assert.deepEqual([next.body.salesSource, next.body.sourcedByStaffId], ['freelance', null]);
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: next.body.id } })).freelanceAgentId, agents.owner1);
    });

    it('a staff claim on that client changes nothing; another freelancer cannot take them', async () => {
      const claim = await sameClient('brian', { sourcedBy: ids.brian });
      assert.equal(claim.status, 201);
      assert.equal(claim.body.salesSource, 'freelance'); // the claim is ignored, as when another staff member owns the client
      assert.equal(await prisma.clientOwner.count({ where: { clientKey: 'p:701555123' } }), 0, 'no staff ownership was created');
      agents.owner2 = await mk('Owner Two', '0702 000 002');
      const rival = await sameClient('amina', { freelanceAgentId: agents.owner2 });
      assert.equal(rival.status, 400);
      assert.match(rival.body.error, /belongs to freelance sales person Owner One/);
      const look = (await call('brian', 'GET', '/commission/owner-lookup?phone=0701555123')).body;
      assert.deepEqual([look.owner, look.freelanceOwner.agentName], [null, 'Owner One']);
    });

    it('each order they bring restarts the window; it lapses only after a stretch with no order, and then the client is free', async () => {
      const row = (await owned())!;
      await prisma.freelanceClient.update({ where: { id: row.id }, data: { lastOrderDate: monthsAgo(11) } }); // nearly a year since the last order
      const renewed = await sameClient('brian');
      assert.equal(renewed.body.salesSource, 'freelance', 'still theirs');
      assert.equal((await owned())!.lastOrderDate, todayStr(), 'and the count starts again from today');

      await prisma.freelanceClient.update({ where: { id: row.id }, data: { lastOrderDate: monthsAgo(13) } }); // a year and a month with nothing
      const free = await sameClient('brian');
      assert.equal(free.body.salesSource, 'house', 'they stopped bringing orders, so the client is free');
      // the other freelancer can now take the client — and the first record is marked as lapsed
      const taken = await sameClient('amina', { freelanceAgentId: agents.owner2 });
      assert.equal(taken.status, 201);
      assert.deepEqual([(await owned())!.agentId, (await prisma.freelanceClient.findUniqueOrThrow({ where: { id: row.id } })).status], [agents.owner2, 'Lapsed']);
    });

    it('how long is a manager setting; a suspended freelancer\'s clients are not credited to them; a manager can release a client', async () => {
      const cfg = (await call('boss', 'GET', '/commission/settings')).body;
      assert.equal(cfg.freelanceOwnershipMonths, 12);
      const save = (months: number) => call('boss', 'PUT', '/commission/settings', { generalBands: cfg.generalBands, filmBands: cfg.filmBands, artworkRatePct: 50, ownershipMonths: 12, freelanceOwnershipMonths: months });
      assert.equal((await save(3)).body.freelanceOwnershipMonths, 3);
      const row = (await owned())!; // Owner Two's
      await prisma.freelanceClient.update({ where: { id: row.id }, data: { lastOrderDate: monthsAgo(4) } });
      assert.equal((await sameClient('brian')).body.salesSource, 'house', 'four months with no order is past a three-month window');
      await save(12);
      assert.equal((await sameClient('brian')).body.salesSource, 'freelance', 'a longer window keeps them');

      await call('boss', 'PUT', `/freelance/agents/${agents.owner2}`, { status: 'Suspended' });
      assert.equal((await sameClient('brian')).body.salesSource, 'house', 'a suspended freelancer earns nothing, so their clients are not credited to them');
      await call('boss', 'PUT', `/freelance/agents/${agents.owner2}`, { status: 'Active' });
      assert.equal((await sameClient('brian')).body.salesSource, 'freelance');

      const list = (await call('boss', 'GET', '/freelance/clients')).body;
      const mine = list.clients.find((c: any) => c.id === row.id);
      assert.deepEqual([mine.agentName, mine.active, mine.status], ['Owner Two', true, 'Active']);
      assert.equal((await call('brian', 'GET', '/freelance/clients')).status, 403);
      assert.equal((await call('boss', 'POST', `/freelance/clients/${row.id}/release`)).status, 200);
      assert.equal((await sameClient('brian')).body.salesSource, 'house', 'released: the client is free again');
      assert.equal((await call('boss', 'POST', `/freelance/clients/${row.id}/release`)).status, 400);
    });

    it('a freelancer\'s mark needs a client who can be recognised next time', async () => {
      const noPhone = await order('amina', [{ qty: 1, unitPrice: 1160 }], { freelanceAgentId: agents.owner1, customerName: 'No Phone Person', phone: '' });
      assert.equal(noPhone.status, 400);
      assert.match(noPhone.body.error, /name and phone/);
    });
  });

  describe('paid by any method: M-Pesa, cash, cheque, bank — nothing forces one', () => {
    let n2 = 0;
    const payoutFor = (agent: number, amount: number) => prisma.freelancePayout.create({ data: { weekStart: addWeeks(week, -(++n2) - 30), agentId: agent, amount, status: 'Approved' } });
    const pay = (id: number, body: Record<string, unknown>) => call('boss', 'POST', `/freelance/payouts/${id}/pay`, body);

    it('each freelancer has the way they like to be paid; it defaults to M-Pesa and can be anything', async () => {
      const a = await call('boss', 'POST', '/freelance/agents', { name: 'Cheque Lover', phone: '0711 400 001', payMethod: 'Cheque' });
      assert.equal(a.status, 201);
      agents.cheque = a.body.id;
      assert.equal((await prisma.freelanceAgent.findUniqueOrThrow({ where: { id: agents.cheque! } })).payMethod, 'Cheque');
      const b = await call('boss', 'POST', '/freelance/agents', { name: 'Default Pay', phone: '0711 400 002' });
      agents.defaultPay = b.body.id;
      assert.equal((await prisma.freelanceAgent.findUniqueOrThrow({ where: { id: agents.defaultPay! } })).payMethod, 'M-Pesa');
      assert.equal((await call('boss', 'PUT', `/freelance/agents/${agents.defaultPay}`, { payMethod: 'Cash' })).body.payMethod, 'Cash');
      assert.equal((await call('boss', 'POST', '/freelance/agents', { name: 'Odd Method', phone: '0711 400 003', payMethod: 'Barter' })).status, 400);
      // it comes with the weekly statement, so the pay screen can pre-select it
      await order('amina', [{ qty: 10, unitPrice: 1160 }], { freelanceAgentId: agents.cheque });
      const st = (await call('boss', 'GET', `/freelance/statement?week=${week}`)).body;
      assert.equal(st.statements.find((s: any) => s.agentId === agents.cheque).payMethod, 'Cheque');
      assert.equal(st.b2cReady, false, 'sending to a phone from here is optional — M-Pesa can be recorded by hand like any other method');
    });

    it('a payout can be settled by cheque (with its number), cash, M-Pesa by hand, bank transfer, card or petty cash', async () => {
      for (const [method, reference] of [['Cheque', 'CHQ 000123'], ['Cash', undefined], ['M-Pesa', 'QWE4567890'], ['Bank Transfer', 'EFT-77'], ['Card', undefined]] as const) {
        const p = await payoutFor(agents.cheque!, 1000);
        const r = await pay(p.id, { method, ...(reference ? { reference } : {}) });
        assert.equal(r.status, 200, method);
        const row = await prisma.freelancePayout.findUniqueOrThrow({ where: { id: p.id } });
        assert.deepEqual([row.status, row.paidMethod, row.receipt], ['Paid', method, reference ?? null]);
        const exp = await prisma.expense.findUniqueOrThrow({ where: { id: row.expenseId! } });
        assert.deepEqual([exp.category, exp.method, exp.amount], ['Freelance Commission', method, 1000]);
        if (reference) assert.match(exp.note, new RegExp(reference));
      }
      assert.equal((await pay((await payoutFor(agents.cheque!, 1000)).id, { method: 'Barter' })).status, 400); // only real payment methods
    });

    it('a cheque is posted to the bank account, cash to cash, M-Pesa to M-Pesa — so the books are right whichever way they are paid', () => {
      assert.deepEqual(['Cheque', 'Cash', 'M-Pesa', 'Bank Transfer', 'Petty Cash'].map(methodAccountCode), [ACCT.bank, ACCT.cash, ACCT.mpesa, ACCT.bank, ACCT.pettyCash]);
    });
  });

  describe('withholding tax is deducted from what they are paid', () => {
    const bal = async (code: string) => {
      const l = await loadLedger();
      return naturalBalance(l.byCode.get(code)!.type, sumByAccount(l.postings).get(l.byCode.get(code)!.id));
    };
    const thisMonth = todayStr().slice(0, 7);
    let tax: { payoutId: number };

    it('the standard rate comes off the commission: the person is paid the rest, and the week shows all three figures', async () => {
      const cfg = (await call('boss', 'GET', '/commission/settings')).body;
      assert.equal(cfg.freelanceWhtRate, 5);
      agents.tax = (await call('boss', 'POST', '/freelance/agents', { name: 'Tax Agent', phone: '0712 900 001', kraPin: 'A000000009Z', payMethod: 'Cheque' })).body.id;
      assert.equal((await order('amina', [{ qty: 100, unitPrice: 1160 }], { freelanceAgentId: agents.tax })).status, 201); // 100,000 net → 1,000 + 1,500
      const s = await stmt('tax');
      assert.deepEqual([s.commission, s.whtRate, s.withholdingTax, s.netPay], [2500, 5, 125, 2375]);
      const week = (await call('boss', 'GET', `/freelance/statement?week=${todayStr()}`)).body;
      assert.ok(week.totals.withholdingTax >= 125);
    });

    it('approving the week fixes the tax; paying by cheque books the commission as the cost, only the net as money out, and the tax as owed to KRA', async () => {
      const approved = await call('boss', 'POST', '/freelance/payouts/approve', { weekStart: weekStart(todayStr()) });
      assert.equal(approved.status, 200);
      const p = await prisma.freelancePayout.findFirstOrThrow({ where: { agentId: agents.tax } });
      assert.deepEqual([p.amount, p.withholdingRate, p.withholdingTax], [2500, 5, 125]);
      tax = { payoutId: p.id };

      const owedBefore = await bal(ACCT.whtPayable);
      const bankBefore = await bal(ACCT.bank);
      const paid = await call('boss', 'POST', `/freelance/payouts/${p.id}/pay`, { method: 'Cheque', reference: 'CHQ 556677' });
      assert.equal(paid.status, 200);
      const exp = await prisma.expense.findUniqueOrThrow({ where: { id: paid.body.expenseId } });
      assert.deepEqual([exp.category, exp.amount, exp.withholdingTax, exp.method], ['Freelance Commission', 2500, 125, 'Cheque']);
      assert.match(exp.note, /CHQ 556677/);
      assert.equal(Math.round((await bal(ACCT.whtPayable) - owedBefore) * 100) / 100, 125, 'held as a liability until it is paid over to KRA');
      assert.equal(Math.round((bankBefore - (await bal(ACCT.bank))) * 100) / 100, 2375, 'only the net leaves the bank');
    });

    it('a person can have their own rate — 0 if exempt — and the standard rate is a setting; a manager decides, not whoever adds them at the till', async () => {
      const mk = async (phone: string, whtRate: number | null | undefined, who = 'boss') => {
        const a = await call(who, 'POST', '/freelance/agents', { name: `Rate ${phone.slice(-3)}`, phone, ...(whtRate === undefined ? {} : { whtRate }) });
        return a.body.id as number;
      };
      const exempt = await mk('0712 900 010', 0);
      const ten = await mk('0712 900 011', 10);
      const byStaff = await mk('0712 900 012', 0, 'amina'); // staff cannot set a rate
      assert.equal((await prisma.freelanceAgent.findUniqueOrThrow({ where: { id: exempt } })).whtRate, 0);
      assert.equal((await prisma.freelanceAgent.findUniqueOrThrow({ where: { id: ten } })).whtRate, 10);
      assert.equal((await prisma.freelanceAgent.findUniqueOrThrow({ where: { id: byStaff } })).whtRate, null);
      for (const id of [exempt, ten, byStaff]) await order('amina', [{ qty: 100, unitPrice: 1160 }], { freelanceAgentId: id });
      const st = (await call('boss', 'GET', `/freelance/statement?week=${todayStr()}`)).body.statements;
      const by = (id: number) => st.find((x: any) => x.agentId === id);
      assert.deepEqual([by(exempt).whtRate, by(exempt).withholdingTax, by(exempt).netPay], [0, 0, 2500]);
      assert.deepEqual([by(ten).whtRate, by(ten).withholdingTax, by(ten).netPay], [10, 250, 2250]);
      assert.deepEqual([by(byStaff).whtRate, by(byStaff).withholdingTax], [5, 125]);

      const cfg = (await call('boss', 'GET', '/commission/settings')).body;
      const save = (rate: number) => call('boss', 'PUT', '/commission/settings', { generalBands: cfg.generalBands, filmBands: cfg.filmBands, artworkRatePct: 50, ownershipMonths: 12, freelanceWhtRate: rate });
      assert.equal((await save(3)).body.freelanceWhtRate, 3);
      assert.equal((await call('boss', 'GET', `/freelance/statement?week=${todayStr()}`)).body.statements.find((x: any) => x.agentId === byStaff).withholdingTax, 75); // 3% of 2,500
      assert.equal((await save(0)).status, 200); // none at all
      assert.equal((await call('boss', 'GET', `/freelance/statement?week=${todayStr()}`)).body.statements.find((x: any) => x.agentId === byStaff).withholdingTax, 0);
      assert.equal((await save(101)).status, 400);
      await save(5);
    });

    it('the report lists what was withheld in a month for KRA, with the people whose KRA PIN is missing; the account page shows the total', async () => {
      const r = (await call('boss', 'GET', `/freelance/withholding?month=${thisMonth}`)).body;
      const row = r.rows.find((x: any) => x.agentName === 'Tax Agent');
      assert.deepEqual([row.kraPin, row.gross, row.rate, row.withheld, row.net, row.method, row.reference], ['A000000009Z', 2500, 5, 125, 2375, 'Cheque', 'CHQ 556677']);
      assert.ok(r.totals.withheld >= 125);
      assert.ok(!r.missingPin.includes('Tax Agent'));
      const noPin = await prisma.freelancePayout.create({ data: { weekStart: addWeeks(weekStart(todayStr()), -40), agentId: agents.defaultPay!, amount: 1000, withholdingRate: 5, withholdingTax: 50, status: 'Paid', paidOn: todayStr(), paidMethod: 'Cash' } });
      const again = (await call('boss', 'GET', `/freelance/withholding?month=${thisMonth}`)).body;
      assert.ok(again.missingPin.includes('Default Pay'), 'someone withheld from with no KRA PIN on file is flagged');
      void noPin;
      assert.equal((await call('brian', 'GET', `/freelance/withholding?month=${thisMonth}`)).status, 403);
      const acct = (await call('boss', 'GET', `/freelance/agents/${agents.tax}/account`)).body;
      assert.deepEqual([acct.summary.paid, acct.summary.taxWithheld, acct.weeks[0].withheld], [2500, 125, 125]);
      void tax;
    });
  });
});
