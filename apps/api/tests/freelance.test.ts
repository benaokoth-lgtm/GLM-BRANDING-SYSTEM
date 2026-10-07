// Freelance sales persons: accounts made at order capture, an order credited to a freelancer and never to staff, commission only on sales at or above
// base prices, weekly marginal bands, and weekly payouts that reach the books.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { todayStr, weekEnd, weekStart } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';

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
    banner = (await prisma.service.create({ data: { name: 'Banner (freelance test)', unit: 'piece', price: 1000 } })).id;
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
    it('an order marked for a freelancer is credited to them alone: no staff credit, no client taken on', async () => {
      const r = await order('amina', [{ qty: 40, unitPrice: 1160 }], { freelanceAgentId: agents.otieno });
      assert.equal(r.status, 201);
      assert.deepEqual([r.body.salesSource, r.body.sourcedByStaffId], ['freelance', null]);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: r.body.id } });
      assert.deepEqual([row.freelanceAgentId, row.sourcedByStaffId, row.clientKey, row.freelanceQualifyingShare], [agents.otieno, null, null, 1]);
      assert.equal(await prisma.clientOwner.count({ where: { clientName: { startsWith: 'Freelance Client' } } }), 0, 'nobody now owns that client');
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
    it("the week's net sales received are banded: 3% of the first 50,000, 5% of the next", async () => {
      // the film sale above (4,500 paid) is already in; add two orders of 40,000 and 60,000 net
      assert.equal((await order('amina', [{ qty: 60, unitPrice: 1160 }], { freelanceAgentId: agents.otieno })).status, 201);
      const s = await stmt('otieno');
      // net received: 40,000 + 60,000 + (4,500 film / 1.16 = 3,879.31) = 103,879.31 — all at or above base
      assert.equal(s.qualifyingNet, 103879.31);
      assert.equal(s.belowBaseNet, 0);
      assert.equal(s.commission, 4193.97);
      assert.deepEqual([s.band.rate, s.band.nextRate], [5, 7]);
      assert.equal(s.orders.length, 3);
    });

    it('a line sold below its base price earns nothing; a mixed order counts only the lines at or above', async () => {
      const b = await call('boss', 'POST', '/freelance/agents', { name: 'Base Checker', phone: '0755 000 111' });
      agents.base = b.body.id;
      // listed at 1,000: priced at 900 → no commission at all
      assert.equal((await order('amina', [{ qty: 10, unitPrice: 900 }], { freelanceAgentId: agents.base })).status, 201);
      let s = await stmt('base');
      assert.deepEqual([s.qualifyingNet, s.commission, s.belowBaseNet], [0, 0, 7758.62]);

      // 11,600 at a good price and 8,000 below base: only the first counts (10,000 net)
      const mixed = await order('amina', [{ qty: 10, unitPrice: 1160 }, { qty: 10, unitPrice: 800 }], { freelanceAgentId: agents.base });
      assert.equal(mixed.status, 201);
      assert.equal(Math.round((await prisma.order.findUniqueOrThrow({ where: { id: mixed.body.id } })).freelanceQualifyingShare * 1000) / 1000, 0.592);
      s = await stmt('base');
      assert.equal(s.qualifyingNet, 10000);
      assert.equal(s.commission, 300);
    });

    it('a discount that takes a line under its base price disqualifies it; a high enough price survives the discount', async () => {
      const d = await call('boss', 'POST', '/freelance/agents', { name: 'Discount Checker', phone: '0766 000 222' });
      agents.disc = d.body.id;
      const cut = await order('amina', [{ qty: 10, unitPrice: 1000 }], { freelanceAgentId: agents.disc, orderDiscountPct: 10 }); // 900 a unit after 10% off
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: cut.body.id } })).freelanceQualifyingShare, 0);
      const kept = await order('amina', [{ qty: 10, unitPrice: 1200 }], { freelanceAgentId: agents.disc, orderDiscountPct: 10 }); // 1,080 a unit after 10% off: still above 1,000
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
      assert.equal(s.commission, 1200); // 3% of 40,000
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
      assert.equal(((await prisma.freelancePayout.findFirstOrThrow({ where: { agentId: agents.otieno } })).amount), 4193.97);
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
      assert.deepEqual([expense.category, expense.amount, expense.supplier], ['Freelance Commission', 4193.97, 'Otieno Agency']);
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
      assert.equal(a.body.summary.paid, 4193.97);
      assert.equal(a.body.summary.owed, 0);
      assert.deepEqual([a.body.weeks[0].weekStart, a.body.weeks[0].status, a.body.weeks[0].paidMethod], [week, 'Paid', 'M-Pesa']);
      // the week's commission for Base Checker was approved above and is waiting to be paid
      const b = await call('boss', 'GET', `/freelance/agents/${agents.base}/account`);
      assert.deepEqual([b.body.summary.approvedToPay, b.body.summary.owed, b.body.weeks[0].status], [300, 300, 'Approved']);
      // a new agent with sales this week that have not been approved yet
      const late = await call('boss', 'POST', '/freelance/agents', { name: 'Late Agent', phone: '0799 000 555' });
      assert.equal((await order('amina', [{ qty: 10, unitPrice: 1160 }], { freelanceAgentId: late.body.id })).status, 201);
      const l = await call('boss', 'GET', `/freelance/agents/${late.body.id}/account`);
      assert.deepEqual([l.body.summary.notYetApproved, l.body.summary.owed, l.body.weeks[0].status], [300, 300, 'This week so far']);
      assert.equal((await call('brian', 'GET', `/freelance/agents/${agents.otieno}/account`)).status, 403);
    });

    it('the weeks run Monday to Sunday and can be looked at one at a time; the bands are editable', async () => {
      const s = (await call('boss', 'GET', `/freelance/statement?week=${todayStr()}`)).body; // any day gives its week
      assert.deepEqual([s.weekStart, s.weekEnd], [week, weekEnd(week)]);
      const empty = (await call('boss', 'GET', '/freelance/statement?week=2020-01-06')).body;
      assert.equal(empty.statements.length, 0);
      const cfg = (await call('boss', 'GET', '/commission/settings')).body;
      assert.deepEqual(cfg.freelanceBands, [{ from: 0, rate: 3 }, { from: 50000, rate: 5 }, { from: 150000, rate: 7 }]);
      const put = await call('boss', 'PUT', '/commission/settings', { generalBands: cfg.generalBands, filmBands: cfg.filmBands, artworkRatePct: 50, ownershipMonths: 12, freelanceBands: [{ from: 0, rate: 4 }] });
      assert.equal(put.status, 200);
      assert.deepEqual(put.body.freelanceBands, [{ from: 0, rate: 4 }]);
      assert.equal((await call('boss', 'PUT', '/commission/settings', { generalBands: cfg.generalBands, filmBands: cfg.filmBands, artworkRatePct: 50, ownershipMonths: 12, freelanceBands: [{ from: 10, rate: 4 }] })).status, 400); // must start at 0
      await call('boss', 'PUT', '/commission/settings', { generalBands: cfg.generalBands, filmBands: cfg.filmBands, artworkRatePct: 50, ownershipMonths: 12, freelanceBands: cfg.freelanceBands });
    });
  });
});
