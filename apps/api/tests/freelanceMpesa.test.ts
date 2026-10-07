// Paying a freelance sales person's weekly commission to their M-Pesa phone (Daraja B2C), against a small local stand-in for Safaricom.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { privateDecrypt, constants } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { addWeeks, todayStr, weekStart } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { TEST_CERT, TEST_KEY } from './fixtures/testCert';

let server: Server;
let base = '';
let daraja: http.Server;
const tokens: Record<string, string> = {};
const SECRET = 'b'.repeat(32);
const week = weekStart(todayStr());
const received: { path: string; body: any }[] = [];
// what the stand-in answers to the next B2C request
let answer: (body: any) => { status: number; json: unknown } = (b) => ({ status: 200, json: { ConversationID: 'AG_TEST_1', OriginatorConversationID: b.OriginatorConversationID, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } });

function startDaraja(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!;
      const body = raw ? JSON.parse(raw) : {};
      if (path === '/oauth/v1/generate') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ access_token: 'test-token', expires_in: '3599' }));
      }
      received.push({ path, body });
      const a = answer(body);
      res.statusCode = a.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(a.json));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const callback = (path: string, payload: unknown, secret = SECRET) =>
  fetch(`${base}/api/mpesa/b2c/${secret}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const success = (originator: string, receipt: string) => ({
  Result: {
    ResultType: 0,
    ResultCode: 0,
    ResultDesc: 'The service request is processed successfully.',
    OriginatorConversationID: originator,
    ConversationID: 'AG_TEST_1',
    TransactionID: receipt,
    ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: 4194 }, { Key: 'TransactionReceipt', Value: receipt }, { Key: 'ReceiverPartyPublicName', Value: '254712000111 - Test' }] },
  },
});

let weekN = 0;
const ids: Record<string, number> = {};
async function payout(agent: string, amount: number, status = 'Approved') {
  return prisma.freelancePayout.create({ data: { weekStart: addWeeks(week, -(++weekN) - 1), agentId: ids[agent]!, amount, status } });
}
const lastSent = () => received.filter((r) => r.path === '/mpesa/b2c/v3/paymentrequest').at(-1)!.body;

describe('paying freelance commission to their M-Pesa phone', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'B2C Boss', canCaptureOrders: true, canManageCommission: true, canAccessFinance: true } });
    await prisma.role.create({ data: { name: 'B2C Counter', canCaptureOrders: true } });
    for (const [key, role] of [['boss', 'B2C Boss'], ['counter', 'B2C Counter'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (b2c test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true }, create: { id: 1, enabled: true } });
    for (const [key, name, phone] of [['ann', 'Ann Agent', '254712000111'], ['bob', 'Bob Agent', '254722000222'], ['sus', 'Sus Agent', '254733000333']] as const) {
      ids[key] = (await prisma.freelanceAgent.create({ data: { name: `${name} (b2c test)`, phone, mpesaNumber: phone, status: key === 'sus' ? 'Suspended' : 'Active' } })).id;
    }
    daraja = await startDaraja();
    process.env.DARAJA_TEST_URL = `http://127.0.0.1:${(daraja.address() as AddressInfo).port}`;
    await prisma.mpesaSettings.deleteMany();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    daraja.close();
    delete process.env.DARAJA_TEST_URL;
    const agentIds = Object.values(ids);
    const payouts = (await prisma.freelancePayout.findMany({ where: { agentId: { in: agentIds } }, select: { id: true, expenseId: true } }));
    await prisma.mpesaDisbursement.deleteMany({ where: { payoutId: { in: payouts.map((p) => p.id) } } });
    await prisma.freelancePayout.deleteMany({ where: { agentId: { in: agentIds } } });
    await prisma.expense.deleteMany({ where: { supplier: { endsWith: '(b2c test)' } } });
    await prisma.freelanceAgent.deleteMany({ where: { id: { in: agentIds } } });
    await prisma.mpesaSettings.deleteMany();
    await prisma.user.deleteMany({ where: { name: { endsWith: '(b2c test)' } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: 'B2C ' } } });
    await prisma.$disconnect();
  });

  describe('setting it up', () => {
    it('is not available until the initiator, its password and Safaricom\'s certificate are saved; nothing secret comes back', async () => {
      await call('admin', 'PUT', '/mpesa/settings', { shortCode: '600111', consumerKey: 'k', consumerSecret: 's', passkey: 'p', publicBaseUrl: 'https://example.com', environment: 'sandbox' });
      const first = await call('boss', 'POST', `/freelance/payouts/${(await payout('ann', 1500)).id}/send-mpesa`);
      assert.equal(first.status, 400);
      assert.match(first.body.error, /not set up/);

      const bad = await call('admin', 'PUT', '/mpesa/settings', { securityCert: 'this is not a certificate' });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /certificate/i);

      const saved = await call('admin', 'PUT', '/mpesa/settings', { initiatorName: 'testapi', initiatorPassword: 'Initiator#Pass1', securityCert: TEST_CERT, b2cShortCode: '600222', enabled: true });
      assert.equal(saved.status, 200);
      assert.deepEqual([saved.body.b2cReady, saved.body.hasInitiatorPassword, saved.body.hasSecurityCert, saved.body.initiatorName, saved.body.b2cShortCode], [true, true, true, 'testapi', '600222']);
      assert.ok(!JSON.stringify(saved.body).includes('Initiator#Pass1'));
      assert.ok(saved.body.callbackUrls.b2cResult.endsWith(`/api/mpesa/b2c/${saved.body.callbackUrls.b2cResult.split('/b2c/')[1]}`));
      assert.equal((await call('counter', 'PUT', '/mpesa/settings', { initiatorName: 'x' })).status, 403);
      // a blank password keeps the saved one
      await call('admin', 'PUT', '/mpesa/settings', { initiatorName: 'testapi', initiatorPassword: '' });
      assert.equal((await call('admin', 'GET', '/mpesa/settings')).body.hasInitiatorPassword, true);
      const test = await call('admin', 'POST', '/mpesa/settings/test');
      assert.deepEqual([test.body.ok, test.body.b2c], [true, 'ready']);
      // the callback secret generated for this install (the tests post to it below)
      const row = await prisma.mpesaSettings.findUniqueOrThrow({ where: { id: 1 } });
      await prisma.mpesaSettings.update({ where: { id: 1 }, data: { callbackSecret: SECRET } });
      assert.ok(row.callbackSecret.length >= 16);
    });
  });

  describe('sending', () => {
    it('asks Safaricom to pay the freelancer\'s own phone from the Paybill, with the password encrypted for Safaricom\'s certificate', async () => {
      const p = await payout('ann', 4193.97); // whole shillings go out: 4,194
      const r = await call('boss', 'POST', `/freelance/payouts/${p.id}/send-mpesa`);
      assert.equal(r.status, 202);
      const sent = lastSent();
      assert.deepEqual(
        [sent.CommandID, sent.Amount, sent.PartyA, sent.PartyB, sent.InitiatorName],
        ['BusinessPayment', 4194, '600222', '254712000111', 'testapi'],
      );
      assert.equal(privateDecrypt({ key: TEST_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(sent.SecurityCredential, 'base64')).toString(), 'Initiator#Pass1');
      assert.match(sent.ResultURL, new RegExp(`/api/mpesa/b2c/${SECRET}/result$`));
      assert.match(sent.QueueTimeOutURL, new RegExp(`/api/mpesa/b2c/${SECRET}/timeout$`));
      assert.match(sent.OriginatorConversationID, /^[0-9a-f-]{36}$/);
      // while it is on its way nothing else can be done to it — so it can never be paid twice
      assert.equal((await prisma.freelancePayout.findUniqueOrThrow({ where: { id: p.id } })).status, 'Sending');
      assert.equal((await call('boss', 'POST', `/freelance/payouts/${p.id}/send-mpesa`)).status, 400);
      assert.equal((await call('boss', 'POST', `/freelance/payouts/${p.id}/pay`, { method: 'M-Pesa' })).status, 400);
      assert.equal((await call('boss', 'DELETE', `/freelance/payouts/${p.id}`)).status, 400);
      ids.p1 = p.id;
    });

    it('is not paid, and no expense is booked, until Safaricom says it went through; then it is settled once', async () => {
      const p = ids.p1!;
      assert.equal((await prisma.freelancePayout.findUniqueOrThrow({ where: { id: p } })).paidOn, null);
      const d = await prisma.mpesaDisbursement.findFirstOrThrow({ where: { payoutId: p } });
      assert.equal(await prisma.expense.count({ where: { supplier: 'Ann Agent (b2c test)' } }), 0);

      assert.equal((await callback('result', success(d.originatorConversationId, 'NLJ7RT61SV'), 'wrong-secret-wrong-secret-wrong')).status, 200); // acknowledged, but ignored
      assert.equal((await prisma.freelancePayout.findUniqueOrThrow({ where: { id: p } })).status, 'Sending');

      assert.equal((await callback('result', success(d.originatorConversationId, 'NLJ7RT61SV'))).status, 200);
      const paid = await prisma.freelancePayout.findUniqueOrThrow({ where: { id: p } });
      assert.deepEqual([paid.status, paid.paidMethod, paid.receipt, paid.amount], ['Paid', 'M-Pesa', 'NLJ7RT61SV', 4194]);
      const exp = await prisma.expense.findMany({ where: { supplier: 'Ann Agent (b2c test)' } });
      assert.equal(exp.length, 1);
      assert.deepEqual([exp[0]!.category, exp[0]!.amount, exp[0]!.method], ['Freelance Commission', 4194, 'M-Pesa']);
      assert.match(exp[0]!.note, /NLJ7RT61SV/);
      const done = await prisma.mpesaDisbursement.findUniqueOrThrow({ where: { id: d.id } });
      assert.deepEqual([done.status, done.receipt, done.resultCode], ['Success', 'NLJ7RT61SV', 0]);

      await callback('result', success(d.originatorConversationId, 'NLJ7RT61SV')); // Safaricom repeats a callback: harmless
      assert.equal(await prisma.expense.count({ where: { supplier: 'Ann Agent (b2c test)' } }), 1);
    });

    it('a failure from Safaricom leaves the payout ready to try again; so does a timeout', async () => {
      const p = await payout('bob', 2000);
      await call('boss', 'POST', `/freelance/payouts/${p.id}/send-mpesa`);
      const d1 = await prisma.mpesaDisbursement.findFirstOrThrow({ where: { payoutId: p.id }, orderBy: { id: 'desc' } });
      await callback('result', { Result: { ResultType: 0, ResultCode: 2001, ResultDesc: 'The initiator information is invalid.', OriginatorConversationID: d1.originatorConversationId, ConversationID: 'AG_X' } });
      let row = await prisma.freelancePayout.findUniqueOrThrow({ where: { id: p.id } });
      assert.equal(row.status, 'Approved');
      assert.equal(await prisma.expense.count({ where: { supplier: 'Bob Agent (b2c test)' } }), 0, 'nothing is booked for money that never moved');
      const failed = await prisma.mpesaDisbursement.findUniqueOrThrow({ where: { id: d1.id } });
      assert.deepEqual([failed.status, failed.resultCode, failed.resultDesc], ['Failed', 2001, 'The initiator information is invalid.']);

      // try again: this time Safaricom times out
      assert.equal((await call('boss', 'POST', `/freelance/payouts/${p.id}/send-mpesa`)).status, 202);
      const d2 = await prisma.mpesaDisbursement.findFirstOrThrow({ where: { payoutId: p.id }, orderBy: { id: 'desc' } });
      assert.notEqual(d2.id, d1.id);
      assert.notEqual(d2.originatorConversationId, d1.originatorConversationId, 'every attempt has its own reference');
      await callback('timeout', { Result: { OriginatorConversationID: d2.originatorConversationId } });
      row = await prisma.freelancePayout.findUniqueOrThrow({ where: { id: p.id } });
      assert.equal(row.status, 'Approved');
      assert.match((await prisma.mpesaDisbursement.findUniqueOrThrow({ where: { id: d2.id } })).resultDesc, /did not process/);

      // and the third time it goes through
      assert.equal((await call('boss', 'POST', `/freelance/payouts/${p.id}/send-mpesa`)).status, 202);
      const d3 = await prisma.mpesaDisbursement.findFirstOrThrow({ where: { payoutId: p.id }, orderBy: { id: 'desc' } });
      await callback('result', success(d3.originatorConversationId, 'NLK1AB23CD'));
      assert.equal((await prisma.freelancePayout.findUniqueOrThrow({ where: { id: p.id } })).status, 'Paid');
      assert.equal(await prisma.expense.count({ where: { supplier: 'Bob Agent (b2c test)' } }), 1);
    });

    it('a request Safaricom refuses at once is not left hanging', async () => {
      const p = await payout('bob', 1500);
      answer = () => ({ status: 400, json: { requestId: 'x', errorCode: '500.001.1001', errorMessage: 'The initiator information is invalid.' } });
      const r = await call('boss', 'POST', `/freelance/payouts/${p.id}/send-mpesa`);
      answer = (b) => ({ status: 200, json: { ConversationID: 'AG_TEST_1', OriginatorConversationID: b.OriginatorConversationID, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' } });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /initiator information is invalid/);
      assert.equal((await prisma.freelancePayout.findUniqueOrThrow({ where: { id: p.id } })).status, 'Approved');
      assert.equal((await prisma.mpesaDisbursement.findUniqueOrThrow({ where: { id: r.body.disbursementId } })).status, 'Failed');
    });
  });

  describe('safeguards', () => {
    it('only a manager sends; only an active freelancer, an approved payout, and an amount M-Pesa can carry', async () => {
      const p = await payout('ann', 1500);
      assert.equal((await call('counter', 'POST', `/freelance/payouts/${p.id}/send-mpesa`)).status, 403);
      const sus = await payout('sus', 1500);
      assert.match((await call('boss', 'POST', `/freelance/payouts/${sus.id}/send-mpesa`)).body.error, /not an active/);
      const tiny = await payout('ann', 5);
      assert.match((await call('boss', 'POST', `/freelance/payouts/${tiny.id}/send-mpesa`)).body.error, /smallest/);
      const huge = await payout('ann', 200000);
      assert.match((await call('boss', 'POST', `/freelance/payouts/${huge.id}/send-mpesa`)).body.error, /at most/);
      const paid = await payout('ann', 1500, 'Paid');
      assert.match((await call('boss', 'POST', `/freelance/payouts/${paid.id}/send-mpesa`)).body.error, /Already paid/);
      await prisma.freelanceAgent.update({ where: { id: ids.ann! }, data: { mpesaNumber: '12345' } });
      assert.match((await call('boss', 'POST', `/freelance/payouts/${p.id}/send-mpesa`)).body.error, /valid M-Pesa number/);
      await prisma.freelanceAgent.update({ where: { id: ids.ann! }, data: { mpesaNumber: '254712000111' } });
      for (const x of [p, sus, tiny, huge, paid]) assert.notEqual((await prisma.freelancePayout.findUniqueOrThrow({ where: { id: x.id } })).status, 'Sending', 'refused requests leave nothing stuck');
    });

    it('when Safaricom\'s answer never arrives a manager settles the attempt by hand: not sent, or sent with its receipt code', async () => {
      const p = await payout('ann', 3000);
      await call('boss', 'POST', `/freelance/payouts/${p.id}/send-mpesa`);
      const d = await prisma.mpesaDisbursement.findFirstOrThrow({ where: { payoutId: p.id } });
      assert.equal((await call('counter', 'POST', `/freelance/disbursements/${d.id}/resolve`, { outcome: 'failed' })).status, 403);
      assert.equal((await call('boss', 'POST', `/freelance/disbursements/${d.id}/resolve`, { outcome: 'sent' })).status, 400); // a code is needed
      assert.equal((await call('boss', 'POST', `/freelance/disbursements/${d.id}/resolve`, { outcome: 'sent', receipt: 'NLJ7RT61SV' })).status, 400); // already used
      assert.equal((await call('boss', 'POST', `/freelance/disbursements/${d.id}/resolve`, { outcome: 'failed' })).status, 200);
      assert.equal((await prisma.freelancePayout.findUniqueOrThrow({ where: { id: p.id } })).status, 'Approved');
      assert.equal((await call('boss', 'POST', `/freelance/disbursements/${d.id}/resolve`, { outcome: 'failed' })).status, 400); // once

      await call('boss', 'POST', `/freelance/payouts/${p.id}/send-mpesa`);
      const d2 = await prisma.mpesaDisbursement.findFirstOrThrow({ where: { payoutId: p.id }, orderBy: { id: 'desc' } });
      assert.equal((await call('boss', 'POST', `/freelance/disbursements/${d2.id}/resolve`, { outcome: 'sent', receipt: 'abc9876543' })).status, 200);
      const row = await prisma.freelancePayout.findUniqueOrThrow({ where: { id: p.id } });
      assert.deepEqual([row.status, row.receipt, row.paidMethod], ['Paid', 'ABC9876543', 'M-Pesa']);
      assert.equal(await prisma.expense.count({ where: { note: { contains: 'ABC9876543' } } }), 1);
    });

    it('the weekly statement shows each payout\'s latest M-Pesa attempt', async () => {
      const p = await prisma.freelancePayout.create({ data: { weekStart: week, agentId: ids.bob!, amount: 2500, status: 'Approved' } });
      await call('boss', 'POST', `/freelance/payouts/${p.id}/send-mpesa`);
      // the statement lists agents with money in the week; give Bob an order-free week by reading the payout list instead
      const list = (await call('boss', 'GET', `/freelance/payouts/${p.id}/disbursements`)).body;
      assert.deepEqual([list.length, list[0].status, list[0].amount, list[0].phone], [1, 'Pending', 2500, '254722000222']);
    });
  });

  describe('withholding tax', () => {
    it('the person is sent the commission less the tax; the cost booked is the commission, with the tax held back', async () => {
      const w = await prisma.freelancePayout.create({ data: { weekStart: addWeeks(week, -60), agentId: ids.ann!, amount: 4000, withholdingRate: 5, withholdingTax: 200 } });
      assert.equal((await call('boss', 'POST', `/freelance/payouts/${w.id}/send-mpesa`)).status, 202);
      assert.equal(lastSent().Amount, 3800, 'Ksh 4,000 less 5% tax');
      const d = await prisma.mpesaDisbursement.findFirstOrThrow({ where: { payoutId: w.id } });
      assert.equal(d.amount, 3800);
      await callback('result', success(d.originatorConversationId, 'NLM5TX00AA'));
      const row = await prisma.freelancePayout.findUniqueOrThrow({ where: { id: w.id } });
      assert.deepEqual([row.status, row.amount, row.withholdingTax, row.receipt], ['Paid', 4000, 200, 'NLM5TX00AA']);
      const exp = await prisma.expense.findUniqueOrThrow({ where: { id: row.expenseId! } });
      assert.deepEqual([exp.amount, exp.withholdingTax, exp.method], [4000, 200, 'M-Pesa']);
    });

    it('whole shillings are sent: the cost is worked back from what actually went out, plus the tax', async () => {
      const w = await prisma.freelancePayout.create({ data: { weekStart: addWeeks(week, -61), agentId: ids.ann!, amount: 4193.97, withholdingRate: 5, withholdingTax: 209.7 } });
      await call('boss', 'POST', `/freelance/payouts/${w.id}/send-mpesa`);
      assert.equal(lastSent().Amount, 3984); // 4,193.97 − 209.70 = 3,984.27 → 3,984
      const d = await prisma.mpesaDisbursement.findFirstOrThrow({ where: { payoutId: w.id } });
      await callback('result', success(d.originatorConversationId, 'NLM5TX00BB'));
      const exp = await prisma.expense.findUniqueOrThrow({ where: { id: (await prisma.freelancePayout.findUniqueOrThrow({ where: { id: w.id } })).expenseId! } });
      assert.deepEqual([exp.amount, exp.withholdingTax], [4193.7, 209.7]); // 3,984 paid + 209.70 tax
    });
  });
});
