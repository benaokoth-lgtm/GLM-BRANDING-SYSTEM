// Day close, part two: a cash-up for each till, the reminder for days not closed, the NCBA tie-out on the day sheet, and the evening WhatsApp summary (against a stand-in for Meta). (Named z… because it records data.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { addDays, todayStr } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { nairobiNow, parseNumbers, runScheduledSummary, summaryDue } from '../src/daySummary';

const Y = addDays(todayStr(), -1); // yesterday: inside the reminder's week
const N = '2024-05-10'; // the NCBA day
let server: Server;
let meta: http.Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
const metaSeen: { url: string; body: any }[] = [];
let till2 = 0;

async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('day close: tills, reminder, NCBA tie-out and the evening summary', () => {
  before(async () => {
    meta = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: any = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* not json */ }
        metaSeen.push({ url: req.url ?? '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.SUM' + metaSeen.length }] }));
      });
    });
    await new Promise<void>((resolve) => meta.listen(0, '127.0.0.1', () => resolve()));
    process.env.WHATSAPP_TEST_URL = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;

    await prisma.role.create({ data: { name: 'Cashier (tills test)', canManagePayments: true } });
    await prisma.role.create({ data: { name: 'Finance (tills test)', canAccessFinance: true } });
    for (const [key, role] of [['c1', 'Cashier (tills test)'], ['c2', 'Cashier (tills test)'], ['finance', 'Finance (tills test)'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (tills test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    const svc = await prisma.service.create({ data: { name: 'Banner (tills test)', unit: 'piece', price: 1000 } });
    const order = await prisma.order.create({
      data: { orderNo: 'TL-A', kind: 'walkin', staffId: ids.c1!, createdDate: '2024-05-01', status: 'Invoice', dueDate: '2024-05-08', stage: 'Order Received', customerName: 'Tills Customer', lineItems: { create: [{ itemType: 'service', serviceId: svc.id, qty: 20, unitPrice: 1000 }] } } as any,
    });
    const pay = (date: string, amount: number, method: string, staff: number, reference?: string) => prisma.payment.create({ data: { orderId: order.id, date, amount, method, staffId: staff, reference: reference ?? null } });
    // yesterday: c1 takes 300 cash, c2 takes 200 cash and 50 M-Pesa
    await pay(Y, 300, 'Cash', ids.c1!);
    await pay(Y, 200, 'Cash', ids.c2!);
    await pay(Y, 50, 'M-Pesa', ids.c2!, 'QYY000');
    // the NCBA day: NCBA sent 500 (QAA111, on no order), 700 (QAA222, on an order) and a duplicate; a 300 M-Pesa payment carries a code NCBA never sent
    for (const n of [['QAA111', 500, 'Received'], ['QAA222', 700, 'Matched'], ['QAA333', 700, 'Duplicate']] as const) {
      await prisma.ncbaNotification.create({ data: { receivedAt: new Date(`${N}T09:00:00.000Z`), transId: n[0], amount: n[1], outcome: n[2], phone: '0700000000', payerName: 'Payer ' + n[0] } });
    }
    await pay(N, 700, 'M-Pesa', ids.c1!, 'QAA222');
    await pay(N, 300, 'M-Pesa', ids.c1!, 'QZZ999');
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    meta.close();
    delete process.env.WHATSAPP_TEST_URL;
    await prisma.$disconnect();
  });

  it('the Admin sets up tills and assigns people; the main till cannot be switched off, nor a till that still has people', async () => {
    const first = (await call('admin', 'GET', '/day-close/tills')).body;
    assert.ok(first.tills.some((t: any) => t.isMain && t.name === 'Main till'));
    assert.equal((await call('finance', 'POST', '/day-close/tills', { name: 'X' })).status, 403);
    const made = await call('admin', 'POST', '/day-close/tills', { name: 'Kisumu till (tills test)' });
    assert.equal(made.status, 201);
    till2 = made.body.id;
    assert.equal((await call('admin', 'POST', '/day-close/tills', { name: 'Kisumu till (tills test)' })).status, 400); // same name
    assert.equal((await call('admin', 'PUT', '/day-close/tills/assign', { userId: ids.c2, tillId: till2 })).status, 200);
    assert.equal((await call('admin', 'PUT', `/day-close/tills/${till2}`, { active: false })).status, 400); // has a person
    const main = first.tills.find((t: any) => t.isMain);
    assert.equal((await call('admin', 'PUT', `/day-close/tills/${main.id}`, { active: false })).status, 400);
    assert.equal((await call('finance', 'GET', '/day-close/tills')).body.people.length, 0); // only the Admin sees the people
  });

  it('each till has its own receipts, expected cash and cash-up; all tills together add up', async () => {
    const main = (await call('c1', 'GET', `/day-close?date=${Y}`)).body; // no till given = the main till
    assert.equal(main.byPerson.find((p: any) => p.person === 'c1 (tills test)').cash, 300); // others' payments from other tests may share the main till
    assert.equal(main.byMethod.find((m: any) => m.method === 'M-Pesa').amount, 0);
    const k = (await call('c1', 'GET', `/day-close?date=${Y}&till=${till2}`)).body;
    assert.deepEqual([k.cash.received, k.byMethod.find((m: any) => m.method === 'M-Pesa').amount, k.received], [200, 50, 250]);
    const all = (await call('c1', 'GET', `/day-close?date=${Y}&till=all`)).body;
    assert.equal(all.cash.received, all.tills.reduce((a: number, x: any) => a + x.received, 0)); // all tills together add up
    assert.ok(all.cash.received >= 500);
    assert.deepEqual(all.tills.map((t: any) => [t.name, t.received]).filter((t: any) => /Main|Kisumu/.test(t[0])), [['Main till', 300], ['Kisumu till (tills test)', 200]]);
    assert.equal((await call('c1', 'GET', `/day-close?date=${Y}&till=999999`)).status, 400);

    // closing one till leaves the other open; each has its own float and approval
    const mainExpected = main.cash.expected;
    const a = await call('c1', 'POST', '/day-close', { date: Y, counted: mainExpected, floatCarried: 50 });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual([a.body.variance, a.body.banked], [0, mainExpected - 50]);
    const b = await call('c2', 'POST', '/day-close', { date: Y, tillId: till2, counted: 190, floatCarried: 0, note: 'Ten short' });
    assert.deepEqual([b.body.variance, b.body.banked], [-10, 190]);
    assert.equal((await call('finance', 'POST', `/day-close/${Y}/approve`, { tillId: till2 })).status, 200);
    const view = (await call('finance', 'GET', `/day-close?date=${Y}&till=all`)).body;
    const st = Object.fromEntries(view.tills.map((t: any) => [t.name, t.close?.status ?? null]));
    assert.deepEqual([st['Main till'], st['Kisumu till (tills test)']], ['Submitted', 'Approved']);
    // tomorrow each till opens with its own float
    const next = (day: string, till: string) => call('c1', 'GET', `/day-close?date=${day}&till=${till}`);
    assert.equal((await next(todayStr(), 'all')).body.tills.find((t: any) => t.name === 'Main till').openingFloat, 50);
    assert.equal((await next(todayStr(), String(till2))).body.cash.openingFloat, 0);
  });

  it('the reminder lists past days a till took cash and was not closed, and cash-ups waiting for approval', async () => {
    // a day further back with cash at the Kisumu till and no close
    const order = await prisma.order.findFirstOrThrow({ where: { orderNo: 'TL-A' } });
    const earlier = addDays(todayStr(), -3);
    await prisma.payment.create({ data: { orderId: order.id, date: earlier, amount: 120, method: 'Cash', staffId: ids.c2! } });
    const r = (await call('c1', 'GET', '/day-close/reminder')).body;
    assert.ok(r.unclosed.some((u: any) => u.date === earlier && u.tillName === 'Kisumu till (tills test)' && u.cash === 120));
    assert.ok(!r.unclosed.some((u: any) => u.date === Y && u.tillName === 'Kisumu till (tills test)'), 'closed, so not listed');
    assert.ok(r.awaiting.some((u: any) => u.date === Y && u.tillName === 'Main till')); // submitted, not approved
    assert.equal((await call(null, 'GET', '/day-close/reminder')).status, 401);
    // the month marks it too, naming the till
    const m = (await call('finance', 'GET', `/day-close/month?month=${earlier.slice(0, 7)}`)).body;
    const day = m.days.find((d: any) => d.date === earlier);
    assert.equal(day.status, 'Not closed');
    assert.ok(day.notClosedTills.includes('Kisumu till (tills test)'));
  });

  it('the NCBA tie-out: what NCBA sent, what is on orders, what is not, and M-Pesa payments NCBA never sent', async () => {
    const n = (await call('finance', 'GET', `/day-close?date=${N}&till=all`)).body.ncba;
    assert.equal(n.active, true);
    assert.deepEqual([n.sent.count, n.sent.amount], [2, 1200]); // the duplicate is not counted
    assert.deepEqual([n.onOrders.count, n.onOrders.amount], [1, 700]);
    assert.deepEqual([n.notOnOrder.count, n.notOnOrder.amount, n.notOnOrder.receipts[0].receipt], [1, 500, 'QAA111']);
    assert.deepEqual([n.otherMpesa.count, n.otherMpesa.amount, n.otherMpesa.payments[0].reference], [1, 300, 'QZZ999']);
    assert.equal(n.duplicatesOrRejected, 1);
    assert.equal(n.expectedBankSettlement, 1200);
  });

  it('the evening summary: a preview, a plain message when there is no template, the template with five values when there is, and a log', async () => {
    assert.equal((await call('finance', 'GET', `/day-close/summary/preview?date=${N}`)).status, 403);
    const pre = (await call('admin', 'GET', `/day-close/summary/preview?date=${N}`)).body;
    assert.equal(pre.params.length, 5);
    assert.match(pre.text, /NCBA sent Ksh 1,200; 1 receipt \(Ksh 500\) not on an order; 1 M-Pesa payment NCBA did not send/);
    assert.match(pre.params[1], /^Ksh 1,000 \(Cash Ksh 0, M-Pesa Ksh 1,000\)$/);

    assert.equal((await call('admin', 'PUT', '/day-close/settings', { enabled: true, numbers: 'nonsense' })).status, 400);
    assert.equal((await call('admin', 'PUT', '/day-close/settings', { enabled: true })).status, 400); // no numbers yet
    const saved = await call('admin', 'PUT', '/day-close/settings', { enabled: true, time: '18:30', numbers: '0712 345 678, 0722 111 222, 0712345678' });
    assert.deepEqual(saved.body.recipients, ['254712345678', '254722111222']);
    // WhatsApp switched off (an earlier test file may have left it on)
    await call('admin', 'PUT', '/whatsapp/settings', { enabled: false });
    const none = await call('admin', 'POST', '/day-close/summary/send', { date: N });
    assert.equal(none.status, 502);
    assert.match(none.body.error, /Master Data → WhatsApp/);

    assert.equal((await call('admin', 'PUT', '/whatsapp/settings', { phoneNumberId: '109876543210987', accessToken: 'EAAG-summary-token', enabled: true })).status, 200);
    let before = metaSeen.length;
    const plain = await call('admin', 'POST', '/day-close/summary/send', { date: N });
    assert.deepEqual([plain.status, plain.body.sent], [200, ['254712345678', '254722111222']]);
    const texts = metaSeen.slice(before).filter((m) => m.body?.type === 'text');
    assert.equal(texts.length, 2);
    assert.match(texts[0]!.body.text.body, /GLM Branding — .*\nReceived: Ksh 1,000/);

    await call('admin', 'PUT', '/day-close/settings', { template: 'glm_day_summary' });
    before = metaSeen.length;
    await call('admin', 'POST', '/day-close/summary/send', { date: N });
    const tpl = metaSeen.slice(before).find((m) => m.body?.type === 'template')!.body.template;
    assert.equal(tpl.name, 'glm_day_summary');
    assert.equal(tpl.components.length, 1); // a text body only, no header
    assert.equal(tpl.components[0].parameters.length, 5);
    const recent = (await call('admin', 'GET', '/whatsapp/recent')).body;
    assert.ok(recent.filter((r: any) => r.fileName === 'Daily summary').length >= 4);
  });

  it('the schedule: due after the set time (Nairobi), once a day, with a failed day tried again every half hour up to three times', async () => {
    const base = { summaryEnabled: true, summaryTime: '18:30', summaryNumbers: '0712345678', summaryLastDate: '', summaryAttempts: 0, summaryLastTryAt: null as Date | null, summaryLastStatus: '' };
    const evening = new Date('2026-10-22T16:00:00Z'); // 19:00 in Nairobi
    const afternoon = new Date('2026-10-22T14:00:00Z'); // 17:00
    assert.deepEqual(nairobiNow(evening), { date: '2026-10-22', time: '19:00' });
    assert.equal(summaryDue(base, afternoon), false);
    assert.equal(summaryDue(base, evening), true);
    assert.equal(summaryDue({ ...base, summaryEnabled: false }, evening), false);
    assert.equal(summaryDue({ ...base, summaryNumbers: '' }, evening), false);
    assert.equal(summaryDue({ ...base, summaryLastDate: '2026-10-22', summaryLastStatus: 'Sent' }, evening), false);
    assert.equal(summaryDue({ ...base, summaryLastDate: '2026-10-21', summaryLastStatus: 'Sent' }, evening), true); // yesterday's is not today's
    const failed = { ...base, summaryLastDate: '2026-10-22', summaryAttempts: 1, summaryLastStatus: 'Failed: x' };
    assert.equal(summaryDue({ ...failed, summaryLastTryAt: new Date(evening.getTime() - 10 * 60_000) }, evening), false);
    assert.equal(summaryDue({ ...failed, summaryLastTryAt: new Date(evening.getTime() - 40 * 60_000) }, evening), true);
    assert.equal(summaryDue({ ...failed, summaryAttempts: 3, summaryLastTryAt: new Date(evening.getTime() - 40 * 60_000) }, evening), false);
    assert.deepEqual(parseNumbers('0712 345 678;0722111222\n12'), ['254712345678', '254722111222']);

    // run it for real: it sends once and records that it did
    await call('admin', 'PUT', '/day-close/settings', { enabled: true, time: '18:30', numbers: '0712 345 678' });
    await prisma.dayCloseSettings.update({ where: { id: 1 }, data: { summaryLastDate: '', summaryAttempts: 0, summaryLastStatus: '' } });
    const r = await runScheduledSummary(evening);
    assert.equal(r?.ok, true);
    const s = await prisma.dayCloseSettings.findUniqueOrThrow({ where: { id: 1 } });
    assert.deepEqual([s.summaryLastDate, s.summaryLastStatus, s.summaryAttempts], ['2026-10-22', 'Sent', 1]);
    assert.equal(await runScheduledSummary(evening), null); // not twice
  });
});
