// NCBA Bank on Paybill 880100: STK prompts through NCBA's API and NCBA's payment notifications (JSON and XML), built from NCBA's two integration guides.
// A stand-in for NCBA's API answers on a local port.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
let ncba: Server;
let ncbaUrl = '';
const tokens: Record<string, string> = {};
const API_USER = 'glm-api-user';
const API_SECRET = 'api-secret-key-123';
let creds = { pushUser: '', pushPassword: '', pushSecret: '' };
let notifyPath = '';
const seen: { tokenCalls: number; initiated: any[]; querySays: string } = { tokenCalls: 0, initiated: [], querySays: 'SUCCESS' };

async function call(who: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

// NCBA's signature, written out independently of the code under test: secret + the details in order + "1", SHA-256, Base64 of the hex text.
const sign = (secret: string, f: { transType: string; transId: string; transTime: string; amount: string; account: string; billRef: string; mobile: string; name: string }) =>
  Buffer.from(createHash('sha256').update(secret + f.transType + f.transId + f.transTime + f.amount + f.account + f.billRef + f.mobile + f.name + '1').digest('hex')).toString('base64');

function notice(over: Partial<Record<string, string>> = {}) {
  const f = { transType: 'Pay Bill', transId: 'RKH7KICX13', transTime: '20260101101010', amount: '1500.00', account: '880100', billRef: '000001', mobile: '254712345678', name: 'JOHN DOE', ...over };
  return {
    TransType: f.transType, TransID: f.transId, TransTime: f.transTime, TransAmount: f.amount, BusinessShortCode: f.account, BillRefNumber: f.billRef, Mobile: f.mobile, name: f.name,
    Username: creds.pushUser, Password: creds.pushPassword, Hash: sign(creds.pushSecret, f),
  };
}
const post = (body: unknown, path = notifyPath, type = 'application/json') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('NCBA Paybill 880100', () => {
  before(async () => {
    ncba = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const json = (code: number, o: unknown) => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(o));
        };
        if (req.url === '/payments/api/v1/auth/token') {
          seen.tokenCalls++;
          const ok = req.headers.authorization === 'Basic ' + Buffer.from(`${API_USER}:${API_SECRET}`).toString('base64');
          return ok ? json(200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: 18000, status: 200 }) : json(401, { message: 'Invalid API credentials', status: '401' });
        }
        if (req.headers.authorization !== 'Bearer tok-1') return json(401, { message: 'no' });
        if (req.url === '/payments/api/v1/stk-push/initiate') {
          const b = JSON.parse(raw);
          seen.initiated.push(b);
          if (b.TelephoneNo === '254700000000') return json(200, { TransactionID: null, StatusCode: '1', StatusDescription: 'Subscriber not reachable', ReferenceID: null });
          return json(200, { TransactionID: 'TX' + seen.initiated.length, StatusCode: '0', StatusDescription: 'Accepted', ReferenceID: 'REF' + seen.initiated.length });
        }
        if (req.url === '/payments/api/v1/stk-push/query') return json(200, { status: seen.querySays, description: seen.querySays === 'SUCCESS' ? 'Success' : 'System internal error.' });
        json(404, {});
      });
    });
    await new Promise<void>((r) => ncba.listen(0, '127.0.0.1', () => r()));
    ncbaUrl = `http://127.0.0.1:${(ncba.address() as AddressInfo).port}`;
    await prisma.role.create({ data: { name: 'NCBA Plain' } }).catch(() => null);
    const a = await prisma.user.create({ data: { name: 'Admin (ncba test)', role: 'Admin', pinHash: 'x' } });
    const p = await prisma.user.create({ data: { name: 'Plain (ncba test)', role: 'NCBA Plain', pinHash: 'x' } });
    tokens.admin = signToken({ id: a.id, name: a.name, role: 'Admin' });
    tokens.plain = signToken({ id: p.id, name: p.name, role: 'NCBA Plain' });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    ncba.close();
    await prisma.$disconnect();
  });

  it('settings are Admin-only, only call NCBA, need the essentials to switch on, and never send secrets back', async () => {
    assert.equal((await call('plain', 'GET', '/ncba/settings')).status, 403);
    assert.equal((await call('admin', 'PUT', '/ncba/settings', { baseUrl: 'https://evil.example.com' })).status, 400);
    assert.equal((await call('admin', 'PUT', '/ncba/settings', { enabled: true })).status, 400); // nothing filled in yet
    const saved = await call('admin', 'PUT', '/ncba/settings', { baseUrl: ncbaUrl, apiUsername: API_USER, apiSecret: API_SECRET, accountNo: '000001', publicBaseUrl: 'https://pos.test.local/' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(!JSON.stringify(saved.body).includes(API_SECRET), 'the secret key was sent back');
    assert.equal(saved.body.hasApiSecret, true);
    assert.equal(saved.body.payBillNo, '880100');
    assert.match(saved.body.notifyUrl, /^https:\/\/pos\.test\.local\/api\/ncba\/notify\/[0-9a-f]{48}$/);
    notifyPath = new URL(saved.body.notifyUrl).pathname;
    // a wrong secret is explained; the right one works
    await call('admin', 'PUT', '/ncba/settings', { apiSecret: 'wrong' });
    const bad = await call('admin', 'POST', '/ncba/settings/test');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /did not accept/);
    await call('admin', 'PUT', '/ncba/settings', { apiSecret: API_SECRET });
    assert.equal((await call('admin', 'POST', '/ncba/settings/test')).status, 200);
    assert.equal((await call('admin', 'PUT', '/ncba/settings', { enabled: true })).status, 200);
  });

  it('makes the username, password and secret key for NCBA once, and keeps them out of later reads', async () => {
    const g = await call('admin', 'POST', '/ncba/credentials/generate');
    assert.equal(g.status, 200);
    creds = { pushUser: g.body.pushUser, pushPassword: g.body.pushPassword, pushSecret: g.body.pushSecret };
    assert.ok(creds.pushUser && creds.pushPassword.length >= 16 && creds.pushSecret.length >= 24);
    const again = await call('admin', 'GET', '/ncba/settings');
    assert.equal(again.body.hasPushCredentials, true);
    assert.ok(!JSON.stringify(again.body).includes(creds.pushPassword));
    assert.ok(!JSON.stringify(again.body).includes(creds.pushSecret));
  });

  let promptId = '';
  it('sends the prompt through NCBA with the paybill and account, and explains a refusal', async () => {
    const r = await call('plain', 'POST', '/mpesa/stkpush', { phone: '0712345678', amount: 1500, accountReference: 'ORDER-1' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.checkoutRequestId, /^NCBA-TX\d+$/);
    promptId = r.body.checkoutRequestId;
    const sent = seen.initiated.at(-1);
    assert.deepEqual({ ...sent }, { TelephoneNo: '254712345678', Amount: '1500', PayBillNo: '880100', AccountNo: '000001', Network: 'Safaricom', TransactionType: 'CustomerPayBillOnline' });
    assert.equal((await call('plain', 'GET', `/mpesa/status/${promptId}`)).body.status, 'Pending');

    const refused = await call('plain', 'POST', '/mpesa/stkpush', { phone: '0700000000', amount: 100, accountReference: 'X' });
    assert.equal(refused.status, 502);
    assert.match(refused.body.error, /not reachable/);
  });

  it('refuses a notification with a wrong address, username or password, and holds one with a wrong signature', async () => {
    assert.equal((await post(notice(), `/api/ncba/notify/${'0'.repeat(48)}`)).status, 404);
    const wrongPass = await (await post({ ...notice({ transId: 'RKH7WRONG1' }), Password: 'nope' })).json();
    assert.equal((wrongPass as any).ResultCode, '1');
    const forged = await (await post({ ...notice({ transId: 'RKH7FORGE1' }), Hash: 'Zm9yZ2Vk' })).json();
    assert.equal((forged as any).ResultCode, '0'); // answered, so NCBA does not keep re-sending it …
    assert.equal(await prisma.mpesaTransaction.findUnique({ where: { mpesaReceipt: 'RKH7FORGE1' } }), null); // … but nothing is booked
    const held = await prisma.ncbaNotification.findFirstOrThrow({ where: { transId: 'RKH7FORGE1' } });
    assert.equal(held.outcome, 'Held');
    assert.ok(!held.rawJson.includes(creds.pushPassword), 'the password was kept');
    assert.equal(JSON.parse(held.rawJson).hash, undefined);
    assert.equal((await prisma.ncbaNotification.findFirstOrThrow({ where: { transId: 'RKH7WRONG1' } })).outcome, 'Rejected');
  });

  it('a genuine notification completes the matching prompt with the M-Pesa receipt, once', async () => {
    const r = await (await post(notice())).json();
    assert.equal((r as any).ResultCode, '0');
    const status = (await call('plain', 'GET', `/mpesa/status/${promptId}`)).body;
    assert.equal(status.status, 'Success');
    assert.equal(status.mpesaReceipt, 'RKH7KICX13');
    // NCBA sending it again changes nothing
    await post(notice());
    assert.equal(await prisma.mpesaTransaction.count({ where: { mpesaReceipt: 'RKH7KICX13' } }), 1);
    assert.equal((await prisma.ncbaNotification.findMany({ where: { transId: 'RKH7KICX13' }, orderBy: { id: 'asc' } })).map((n) => n.outcome).join(), 'Matched,Duplicate');
  });

  it('a payment with no prompt (someone paying 880100 themselves) lands as a Paybill receipt to be matched to an order', async () => {
    const r = await (await post(notice({ transId: 'RKH7NOPUSH', amount: '777.00', mobile: '254799999999', billRef: 'W-1020' }))).json();
    assert.equal((r as any).ResultCode, '0');
    const tx = await prisma.mpesaTransaction.findUniqueOrThrow({ where: { mpesaReceipt: 'RKH7NOPUSH' } });
    assert.equal(tx.kind, 'C2B');
    assert.equal(tx.amount, 777);
    assert.equal(tx.accountReference, 'W-1020');
  });

  it('a phone NCBA reports as a SHA-256 hash is still matched to the prompt', async () => {
    const r = await call('plain', 'POST', '/mpesa/stkpush', { phone: '0722222222', amount: 300, accountReference: 'ORDER-2' });
    assert.equal(r.status, 201);
    const hashed = createHash('sha256').update('254722222222').digest('hex');
    await post(notice({ transId: 'RKH7HASHED', amount: '300.00', mobile: hashed }));
    assert.equal((await call('plain', 'GET', `/mpesa/status/${r.body.checkoutRequestId}`)).body.status, 'Success');
  });

  it('reads the XML (SOAP) notification and answers in XML', async () => {
    const f = { transType: 'Pay Bill', transId: 'RKH7XML001', transTime: '20260101111111', amount: '50.00', account: '880100', billRef: 'Rent-005', mobile: '254733333333', name: 'JANE DOE' };
    const xml = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><NCBAPaymentNotificationRequest>
      <User>${creds.pushUser}</User><Password>${creds.pushPassword}</Password><HashVal>${sign(creds.pushSecret, f)}</HashVal>
      <TransType>Pay Bill</TransType><TransID>RKH7XML001</TransID><TransTime>${f.transTime}</TransTime><TransAmount>50.00</TransAmount><AccountNr>880100</AccountNr>
      <Narrative>Rent-005</Narrative><PhoneNr>254733333333</PhoneNr><CustomerName>JANE DOE</CustomerName><Status>SUCCESS</Status>
      </NCBAPaymentNotificationRequest></soapenv:Body></soapenv:Envelope>`;
    const res = await post(xml, notifyPath, 'text/xml');
    assert.match(res.headers.get('content-type') ?? '', /xml/);
    assert.match(await res.text(), /<Result>OK<\/Result>/);
    const tx = await prisma.mpesaTransaction.findUniqueOrThrow({ where: { mpesaReceipt: 'RKH7XML001' } });
    assert.equal(tx.accountReference, 'Rent-005');
    assert.equal(tx.payerName, 'JANE DOE');
  });

  it('an Admin can accept a held notification after checking it, and only an Admin', async () => {
    const held = await prisma.ncbaNotification.findFirstOrThrow({ where: { transId: 'RKH7FORGE1', outcome: 'Held' } });
    assert.equal((await call('plain', 'POST', `/ncba/notifications/${held.id}/accept`)).status, 403);
    const ok = await call('admin', 'POST', `/ncba/notifications/${held.id}/accept`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await prisma.mpesaTransaction.findUniqueOrThrow({ where: { mpesaReceipt: 'RKH7FORGE1' } })).kind, 'C2B');
    assert.equal((await call('admin', 'POST', `/ncba/notifications/${held.id}/accept`)).status, 400); // already dealt with
    const list = await call('admin', 'GET', '/ncba/notifications');
    assert.ok(list.body.length >= 5);
    assert.ok(!JSON.stringify(list.body).includes(creds.pushPassword));
  });

  it('asks NCBA what became of a prompt whose notification never came, and only believes "failed" after two minutes', async () => {
    const ago = (s: number) => new Date(Date.now() - s * 1000);
    const mk = (id: string, age: number) => prisma.mpesaTransaction.create({ data: { checkoutRequestId: `NCBA-${id}`, merchantRequestId: '', phone: '254744444444', amount: 90, accountReference: 'Q', createdByName: 'x', createdAt: ago(age) } });
    await mk('QOK', 60);
    seen.querySays = 'SUCCESS';
    const ok = (await call('plain', 'GET', '/mpesa/status/NCBA-QOK')).body;
    assert.equal(ok.status, 'Success');

    await mk('QFAILSOON', 60);
    seen.querySays = 'FAILED';
    assert.equal((await call('plain', 'GET', '/mpesa/status/NCBA-QFAILSOON')).body.status, 'Pending'); // too soon to believe it
    await mk('QFAILLATE', 200);
    const late = (await call('plain', 'GET', '/mpesa/status/NCBA-QFAILLATE')).body;
    assert.equal(late.status, 'Failed');
    assert.match(late.resultDesc, /internal error/i);
  });

  it('with NCBA switched off, prompts go back to Safaricom (which is not set up here)', async () => {
    await call('admin', 'PUT', '/ncba/settings', { enabled: false });
    const r = await call('plain', 'POST', '/mpesa/stkpush', { phone: '0712345678', amount: 100, accountReference: 'X' });
    assert.equal(r.status, 501);
    assert.match(r.body.error, /M-Pesa isn't set up/);
  });

  it('the push notification service works on its own: ready, counted, and its signature check can be switched off', async () => {
    // NCBA is switched off (the STK buttons use Safaricom), yet notifications are still received
    const st = (await call('admin', 'GET', '/ncba/settings')).body;
    assert.equal(st.enabled, false);
    assert.equal(st.notificationsReady, true);
    assert.ok(st.activity.lastAt, 'the time of the last notification is shown');
    assert.ok(st.activity.held >= 0);
    const ok = await (await post(notice({ transId: 'RKH7STANDA1', amount: '25.00', mobile: '254788888888' }))).json();
    assert.equal((ok as any).ResultCode, '0');
    assert.equal((await prisma.mpesaTransaction.findUniqueOrThrow({ where: { mpesaReceipt: 'RKH7STANDA1' } })).kind, 'C2B');

    // a signature that does not match is held while the check is on ...
    const bad = { ...notice({ transId: 'RKH7NOSIG01', amount: '30.00' }), Hash: 'bm90LXRoZS1zaWduYXR1cmU=' };
    await post(bad);
    assert.equal(await prisma.mpesaTransaction.findUnique({ where: { mpesaReceipt: 'RKH7NOSIG01' } }), null);
    assert.ok((await call('admin', 'GET', '/ncba/settings')).body.activity.held >= 1);
    // ... booked when the Admin has turned the check off (the username and password are still required)
    assert.equal((await call('admin', 'PUT', '/ncba/settings', { checkHash: false })).body.checkHash, false);
    await post({ ...bad, TransID: 'RKH7NOSIG02' });
    assert.ok(await prisma.mpesaTransaction.findUnique({ where: { mpesaReceipt: 'RKH7NOSIG02' } }));
    await post({ ...bad, TransID: 'RKH7NOSIG03', Password: 'wrong' });
    assert.equal(await prisma.mpesaTransaction.findUnique({ where: { mpesaReceipt: 'RKH7NOSIG03' } }), null);
    await call('admin', 'PUT', '/ncba/settings', { checkHash: true });
  });
});
