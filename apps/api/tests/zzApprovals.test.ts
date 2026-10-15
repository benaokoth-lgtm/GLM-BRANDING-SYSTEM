// The approvals inbox: one list of everything waiting for somebody's decision (a quote's price, a price below recommended, a unit price discount, an expense correction, a deletion, a stock
// requisition, leave), with the paths to decide it; how a person's own requests went; the badge numbers; and who is emailed. (Named zz… because it adds data other files must not see, and
// because it runs after them: it looks only at its own requests, since the others leave theirs behind.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { approverRecipients } from '../src/approvals';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
/** The keys of the requests this file made, by kind. */
const mineKeys: Record<string, string> = {};
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const ours = (list: any[]) => list.filter((i) => Object.values(mineKeys).includes(i.key));
const kinds = (list: any[]) => ours(list).map((i) => i.source).sort();

describe('approvals inbox', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Rep (approvals test)', canAccessDtf: true, canCaptureOrders: true, canAccessHr: true } });
    await prisma.role.upsert({
      where: { name: 'Finance Manager' },
      update: { canAccessDtf: true, canManageDtf: true, canAccessFinance: true, canSeeCosts: true, canApproveStock: true, canAccessStock: true, canManageHr: true, canAccessHr: true },
      create: { name: 'Finance Manager', canAccessDtf: true, canManageDtf: true, canAccessFinance: true, canSeeCosts: true, canApproveStock: true, canAccessStock: true, canManageHr: true, canAccessHr: true },
    });
    for (const [key, role, email] of [['rep', 'Rep (approvals test)', null], ['rep2', 'Rep (approvals test)', null], ['fin', 'Finance Manager', 'fin.approvals@example.com'], ['fin2', 'Finance Manager', null], ['admin', 'Admin', 'admin.approvals@example.com']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (approvals test)`, role, pinHash: 'x', email } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // one of each kind of request
    const quote = await prisma.costingQuote.create({
      data: { quoteNo: 'CQ-9101', createdDate: '2026-10-01', validUntil: '2026-10-31', clientName: 'Hope Chapel', staffId: ids.rep!, staffName: 'rep (approvals test)', jobType: 'cards', inputJson: '{}', summary: '1000cards-laminated', linesJson: '[]', cost: 1000, marginPct: 30, floorMarginPct: 20, price: 1300, agreedPrice: 1100, approval: 'Pending' },
    });
    mineKeys.costing = `costing:${quote.id}`;
    const sales = await call('rep', 'POST', '/dtf/discount-requests', { product: 'pens', pens: 451, discount: { kind: 'amount', value: 2 } });
    assert.equal(sales.status, 201, JSON.stringify(sales.body));
    mineKeys.discount = `discount:${sales.body.id}`;
    const art = await prisma.priceApproval.create({
      data: { orderNo: 'F-9001', client: 'Acme', pieces: 100, systemPerPiece: 40, chargedPerPiece: 30, shortfall: 1000, valueAtRecommended: 4000, valueAtCharged: 3000, requestedById: ids.rep!, requestedByName: 'rep (approvals test)' },
    });
    mineKeys.artwork = `artwork:${art.id}`;
    const expense = await prisma.expense.create({ data: { date: '2026-10-05', category: 'Refreshments', amount: 1500 } });
    const am = await prisma.expenseAmendment.create({ data: { expenseId: expense.id, proposedDate: '2026-10-05', proposedCategory: 'Refreshments', proposedAmount: 1350, reason: 'Receipt shows 1,350', requestedByName: 'fin2 (approvals test)' } });
    mineKeys.amend = `amend:${am.id}`;
    const del = await prisma.deletionRequest.create({ data: { recordType: 'Expense', recordId: expense.id, summary: 'Refreshments 1,500', reason: 'Entered twice', requestedByName: 'fin2 (approvals test)' } });
    mineKeys.deletion = `deletion:${del.id}`;
    const req = await prisma.stockRequisition.create({ data: { ref: 'REQ-9101', note: 'Running low', requestedByName: 'fin2 (approvals test)' } });
    mineKeys.requisition = `requisition:${req.id}`;
    await call('fin', 'GET', '/hr/config'); // the kinds of leave exist
    const type = await prisma.leaveType.findFirstOrThrow();
    const lv = await prisma.leaveRequest.create({ data: { staffId: ids.rep!, leaveTypeId: type.id, startDate: '2026-11-02', endDate: '2026-11-04', days: 3, reason: 'Family' } });
    mineKeys.leave = `leave:${lv.id}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('those who can decide see every kind of request in one list; the person who asked does not see their own as waiting', async () => {
    const fin = await call('fin', 'GET', '/approvals');
    assert.equal(fin.status, 200);
    assert.deepEqual(kinds(fin.body.waiting), ['amend', 'artwork', 'costing', 'deletion', 'discount', 'leave', 'requisition']);
    // each says who, what and how to decide it
    const costing = fin.body.waiting.find((i: any) => i.key === mineKeys.costing);
    assert.match(costing.title, /CQ-9101 — Hope Chapel/);
    assert.match(costing.detail, /1000cards-laminated/);
    const qid = costing.key.split(':')[1];
    assert.deepEqual(costing.decide, { approve: `/costing/quotes/${qid}/approve`, reject: `/costing/quotes/${qid}/reject`, needsReason: true });
    assert.equal(fin.body.waiting.find((i: any) => i.key === mineKeys.leave).decide, null); // leave is decided on the HR page
    assert.equal(fin.body.waiting.find((i: any) => i.key === mineKeys.amend).decide.needsReason, false);
    assert.equal(typeof fin.body.emailOn, 'boolean');

    // the requester sees nothing waiting for them to decide, and their own requests
    const rep = await call('rep', 'GET', '/approvals');
    assert.deepEqual(rep.body.waiting, []);
    assert.deepEqual(kinds(rep.body.mine), ['artwork', 'costing', 'discount', 'leave']);
    // someone who asked for things themselves does not decide them: fin2 raised three, so those are not in their waiting list
    const fin2 = await call('fin2', 'GET', '/approvals');
    assert.deepEqual(kinds(fin2.body.waiting), ['artwork', 'costing', 'discount', 'leave']);
    assert.deepEqual(kinds(fin2.body.mine), ['amend', 'deletion', 'requisition']);
    // a person with no part in any of it has an empty inbox
    const rep2 = await call('rep2', 'GET', '/approvals');
    assert.deepEqual([rep2.body.waiting.length, rep2.body.mine.length], [0, 0]);
  });

  it('the menu badge counts what waits for you; decisions on your own requests are counted until you have seen them', async () => {
    assert.ok((await call('fin', 'GET', '/approvals/summary')).body.waiting >= 7);
    assert.deepEqual((await call('rep', 'GET', '/approvals/summary')).body, { waiting: 0, decided: [] });
    assert.equal((await call('rep2', 'GET', '/approvals/summary')).body.waiting, 0);
  });

  it('deciding from the inbox uses each request’s own endpoint, with its own rules', async () => {
    const before = (await call('fin', 'GET', '/approvals/summary')).body.waiting as number;
    const fin = (await call('fin', 'GET', '/approvals')).body.waiting as any[];
    const item = (s: string) => fin.find((i) => i.key === mineKeys[s]);
    // a price needs a reason to be turned down; approved, it shows to the person who quoted it
    const q = item('costing');
    assert.equal((await call('fin', 'POST', q.decide.reject, {})).status, 400);
    assert.equal((await call('fin', 'POST', q.decide.approve, {})).status, 200);
    // a discount request: not by its own requester
    const d = item('discount');
    assert.equal((await call('rep', 'POST', d.decide.approve, {})).status, 403);
    assert.equal((await call('admin', 'POST', d.decide.reject, { reason: 'Too deep' })).status, 200);
    // a correction and a requisition: no reason needed
    assert.equal((await call('fin', 'POST', item('amend').decide.approve, {})).status, 200);
    assert.equal((await call('fin', 'POST', item('requisition').decide.reject, {})).status, 200);
    // the decisions are now the requesters' news; they are no longer waiting
    assert.equal((await call('fin', 'GET', '/approvals/summary')).body.waiting, before - 4);
    assert.deepEqual(kinds((await call('fin', 'GET', '/approvals')).body.waiting), ['artwork', 'deletion', 'leave']);
    const rep = (await call('rep', 'GET', '/approvals')).body;
    const mine = (s: string) => rep.mine.find((i: any) => i.key === mineKeys[s]);
    assert.deepEqual([mine('costing').status, mine('costing').decidedByName], ['Approved', 'fin (approvals test)']);
    assert.deepEqual([mine('discount').status, mine('discount').note], ['Rejected', 'Too deep']);
    assert.equal((await call('rep', 'GET', '/approvals/summary')).body.decided.length, 2);
    assert.equal((await call('fin2', 'GET', '/approvals/summary')).body.decided.length, 2); // the correction and the requisition
  });

  it('the email to approvers: who gets it, and the switch under Approvals', async () => {
    const mineIds = Object.values(ids);
    const emails = async (...args: Parameters<typeof approverRecipients>) => (await approverRecipients(...args)).filter((u) => mineIds.includes(u.id)).map((u) => u.email).sort();
    assert.deepEqual(await emails('discount'), ['admin.approvals@example.com', 'fin.approvals@example.com']); // only those with an address
    // not the one who asked
    assert.deepEqual(await emails('discount', { id: ids.fin }), ['admin.approvals@example.com']);
    // leave goes to those who manage HR; a rep never gets one
    assert.ok(!(await approverRecipients('leave')).some((u) => u.id === ids.rep));
    // someone who has left is not emailed
    await prisma.user.update({ where: { id: ids.admin }, data: { active: false } });
    assert.deepEqual(await emails('costing'), ['fin.approvals@example.com']);
    await prisma.user.update({ where: { id: ids.admin }, data: { active: true } });

    assert.equal((await call('fin', 'PUT', '/approvals/email', { on: false })).status, 403); // an Admin's switch
    assert.equal((await call('admin', 'PUT', '/approvals/email', { on: false })).status, 200);
    assert.equal((await call('fin', 'GET', '/approvals')).body.emailOn, false);
    assert.equal((await call('admin', 'PUT', '/approvals/email', { on: true })).status, 200);
    assert.equal((await call('fin', 'GET', '/approvals')).body.emailOn, true);
  });
});
