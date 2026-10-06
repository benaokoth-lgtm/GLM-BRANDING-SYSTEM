// PIN rules, escalating lock-outs, the Admin sign-in code, encrypted secrets and backups, email and M-Pesa limits, the audit log, headers.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { loadMpesaConfig } from '../src/mpesaConfig';
import { loadMailConfig } from '../src/mailer';
import { open, seal } from '../src/crypto';
import { sealStoredSecrets } from '../src/secrets';

let server: Server;
let base = '';
let smtp: net.Server;
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
const orders: Record<string, number> = {};
const inbox: { to: string[]; data: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A minimal SMTP server that accepts anything and keeps every message.
function startSmtp(): Promise<net.Server> {
  const srv = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let current: { to: string[]; data: string } = { to: [], data: '' };
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buf.slice(0, end);
          inbox.push(current);
          buf = buf.slice(end + 5);
          inData = false;
          sock.write('250 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const u = line.toUpperCase();
        if (u.startsWith('EHLO') || u.startsWith('HELO')) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (u.startsWith('AUTH PLAIN')) sock.write('235 ok\r\n');
        else if (u.startsWith('MAIL FROM')) {
          current = { to: [], data: '' };
          sock.write('250 ok\r\n');
        } else if (u.startsWith('RCPT TO')) {
          current.to.push(/<([^>]+)>/.exec(line)?.[1] ?? '');
          sock.write('250 ok\r\n');
        } else if (u === 'DATA') {
          inData = true;
          sock.write('354 go\r\n');
        } else if (u === 'QUIT') {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
}

async function person(key: string, role: string, pin = '4821', extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({ data: { name: `${key} (sec2)`, firstName: key, lastName: 'Sec', role, pinHash: await bcrypt.hash(pin, 4), pinLength: pin.length, ...extra } });
  ids[key] = u.id;
  tokens[key] = signToken({ id: u.id, name: u.name, role, tv: u.tokenVersion });
  return u;
}

async function newOrder(key: string, staff: string) {
  const o = await prisma.order.create({
    data: {
      orderNo: `SEC2-${key}`,
      kind: 'walkin',
      customerName: `${key} customer`,
      staffId: ids[staff]!,
      createdDate: '2031-07-01',
      status: 'Invoice',
      dueDate: '2031-08-01',
      stage: 'Order Received',
      lineItems: { create: [{ itemType: 'service', serviceId: (await prisma.service.findFirstOrThrow()).id, qty: 10, unitPrice: 100 }] },
    },
  });
  orders[key] = o.id;
}

const login = (userId: number, pin: string) => call('', 'POST', '/auth/login', { userId, pin });

describe('security hardening', () => {
  before(async () => {
    // Other test files leave mail and M-Pesa settings behind; start from none so the SMTP_* variables below are what is used.
    await prisma.mailSettings.deleteMany();
    await prisma.mpesaSettings.deleteMany();
    await prisma.service.create({ data: { name: 'Printing (sec2 test)', unit: 'piece', price: 100 } });
    await prisma.role.create({ data: { name: 'Sales (sec2)', canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Cashier (sec2)', canManagePayments: true } });
    await person('boss', 'Admin', '739104');
    await person('anna', 'Sales (sec2)');
    await person('ben', 'Sales (sec2)');
    await newOrder('anna', 'anna');
    await newOrder('ben', 'ben');
    smtp = await startSmtp();
    const port = (smtp.address() as AddressInfo).port;
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(port);
    process.env.SMTP_USER = 'pos@test.local';
    process.env.SMTP_PASS = 'x';
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    smtp.close();
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.DATA_KEY;
    const mine = (await prisma.order.findMany({ where: { orderNo: { startsWith: 'SEC2-' } }, select: { id: true } })).map((o) => o.id);
    await prisma.payment.deleteMany({ where: { orderId: { in: mine } } });
    await prisma.mpesaTransaction.deleteMany({ where: { checkoutRequestId: { startsWith: 'ws_SEC2_' } } });
    await prisma.orderLineItem.deleteMany({ where: { orderId: { in: mine } } });
    await prisma.order.deleteMany({ where: { id: { in: mine } } });
    await prisma.mpesaSettings.deleteMany();
    await prisma.mailSettings.deleteMany();
    await prisma.setting.updateMany({ data: { requireAdminCode: false } });
    await prisma.user.deleteMany({ where: { lastName: 'Sec' } });
    await prisma.role.deleteMany({ where: { name: { contains: '(sec2)' } } });
    await prisma.service.deleteMany({ where: { name: 'Printing (sec2 test)' } });
    await prisma.$disconnect();
  });

  describe('PIN rules', () => {
    it('obvious PINs are refused, and a role that handles money needs 6 digits (so does the Admin)', async () => {
      const add = (extra: Record<string, unknown>) => call('boss', 'POST', '/master-data/staff', { lastName: 'Sec', ...extra });
      assert.match((await add({ firstName: 'W1', role: 'Sales (sec2)', pin: '1234' })).body.error, /too easy/);
      assert.match((await add({ firstName: 'W2', role: 'Cashier (sec2)', pin: '4821' })).body.error, /6-digit/);
      assert.match((await add({ firstName: 'W3', role: 'Admin', pin: '4821' })).body.error, /6-digit/);
      assert.equal((await add({ firstName: 'Ok1', role: 'Sales (sec2)', pin: '4821' })).status, 201);
      assert.equal((await add({ firstName: 'Ok2', role: 'Cashier (sec2)', pin: '739104' })).status, 201);
      assert.equal((await prisma.user.findFirstOrThrow({ where: { name: 'Ok2 Sec' } })).pinLength, 6);
      const names = ((await (await fetch(`${base}/api/auth/users`)).json()) as any[]).find((u) => u.name === 'Ok2 Sec');
      assert.equal(names.pinLength, 6, 'the sign-in screen is told how many dots to show');
    });

    it('someone whose role needs a longer PIN must change it at sign-in, and can do nothing else until they have', async () => {
      const cashier = await person('cash', 'Cashier (sec2)', '4821'); // a 4-digit PIN on a role that needs 6
      const r = await login(cashier.id, '4821');
      assert.equal(r.status, 200);
      assert.equal(r.body.user.mustChangePin, true);
      assert.equal(r.body.user.pinNeeds, 6);
      const t = r.body.token as string;
      const as = (u: string, m = 'GET', body?: unknown) => fetch(`${base}/api${u}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined });
      const blocked = await as('/orders');
      assert.equal(blocked.status, 403);
      assert.equal(((await blocked.json()) as any).code, 'MUST_CHANGE_PIN');
      const change = async (currentPin: string, newPin: string) => as('/auth/change-pin', 'POST', { currentPin, newPin });
      assert.match(((await (await change('4821', '123456')).json()) as any).error, /too easy/);
      assert.match(((await (await change('4821', '5821')).json()) as any).error, /6-digit/);
      assert.equal((await change('4821', '4821')).status, 400);
      const ok = await change('4821', '580913');
      assert.equal(ok.status, 200);
      const fresh = ((await ok.json()) as any).token as string;
      assert.equal((await as('/orders')).status, 401, 'the session from before the change ends');
      assert.equal((await fetch(`${base}/api/orders`, { headers: { Authorization: `Bearer ${fresh}` } })).status, 200, 'the new token carries on');
      const row = await prisma.user.findUniqueOrThrow({ where: { id: cashier.id } });
      assert.deepEqual([row.pinLength, row.mustChangePin], [6, false]);
      assert.equal((await login(cashier.id, '580913')).body.user.mustChangePin, false);
    });

    it('guessing the current PIN while changing it counts like a wrong PIN at sign-in', async () => {
      const guesser = await person('guess', 'Sales (sec2)', '4821');
      for (let i = 0; i < 5; i++) await call('guess', 'POST', '/auth/change-pin', { currentPin: '0001', newPin: '5821' });
      const locked = await call('guess', 'POST', '/auth/change-pin', { currentPin: '4821', newPin: '5821' });
      assert.equal(locked.status, 423);
      assert.ok((await prisma.user.findUniqueOrThrow({ where: { id: guesser.id } })).lockedUntil);
    });
  });

  describe('lock-outs that grow', () => {
    it('five wrong PINs lock for 15 minutes, the next lock for 30, and a correct PIN starts over', async () => {
      const u = await person('locker', 'Sales (sec2)', '4821');
      const wrong = async () => (await login(u.id, '0007')).body;
      for (let i = 0; i < 4; i++) assert.equal((await wrong()).error, 'Invalid PIN');
      assert.equal((await wrong()).lockedMinutes, 15);
      const refused = await login(u.id, '4821'); // even the right PIN is refused while locked
      assert.equal(refused.status, 423);
      assert.match(refused.body.error, /locked/);

      await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } }); // the 15 minutes pass
      for (let i = 0; i < 4; i++) await wrong();
      assert.equal((await wrong()).lockedMinutes, 30, 'each lock doubles');

      await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      assert.equal((await login(u.id, '4821')).status, 200);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      assert.deepEqual([row.lockCount, row.failedLoginCount, row.lockedUntil], [0, 0, null]);
    });
  });

  describe('Admin sign-in code', () => {
    it('can only be switched on by an Admin who has an email address and a working mail account', async () => {
      assert.equal((await call('anna', 'PUT', '/security/settings', { requireAdminCode: true })).status, 403);
      assert.match((await call('boss', 'PUT', '/security/settings', { requireAdminCode: true })).body.error, /email address/);
      await prisma.user.update({ where: { id: ids.boss! }, data: { email: 'boss-sec2@test.local' } });
      assert.equal((await call('boss', 'PUT', '/security/settings', { requireAdminCode: true })).status, 200);
    });

    it('after the PIN the Admin enters the emailed code: wrong ones are refused, the right one signs in once', async () => {
      inbox.length = 0;
      const first = await login(ids.boss!, '739104');
      assert.equal(first.status, 200);
      assert.equal(first.body.codeRequired, true);
      assert.ok(!first.body.token, 'no session yet');
      assert.match(first.body.sentTo, /^b•••@test\.local$/);
      const code = /\b(\d{6})\b/.exec(inbox.at(-1)!.data.replace(/=\r?\n/g, ''))![1]!;
      const step2 = (c: string, challenge = first.body.challenge) => call('', 'POST', '/auth/login-code', { challenge, code: c });
      assert.equal((await step2(code === '000000' ? '111111' : '000000')).status, 401);
      assert.equal((await step2(code, 'not-a-token')).status, 401);
      const done = await step2(code);
      assert.equal(done.status, 200);
      assert.ok(done.body.token && done.body.user.role === 'Admin');
      assert.equal((await step2(code)).status, 401, 'a code works only once');
    });

    it('if the email cannot be sent the Admin is not locked out — and that is recorded', async () => {
      const port = process.env.SMTP_PORT;
      process.env.SMTP_PORT = '1'; // nothing listens there
      const r = await login(ids.boss!, '739104');
      process.env.SMTP_PORT = port;
      assert.equal(r.status, 200);
      assert.ok(r.body.token, 'signed in on the PIN alone');
      await sleep(150);
      assert.ok(await prisma.auditLog.findFirst({ where: { action: { contains: 'LOGIN CODE NOT SENT' } } }));
      assert.equal((await call('boss', 'PUT', '/security/settings', { requireAdminCode: false })).status, 200);
    });
  });

  describe('email and M-Pesa prompts', () => {
    it('an email goes out only for an order the sender can see', async () => {
      inbox.length = 0;
      const msg = { to: 'client@test.local', subject: 'Invoice', html: '<p>hi</p>' };
      assert.equal((await call('anna', 'POST', '/email/send', msg)).status, 400); // no order named
      assert.equal((await call('anna', 'POST', '/email/send', { ...msg, orderId: orders.ben })).status, 403);
      assert.equal((await call('anna', 'POST', '/email/send', { ...msg, orderId: 999999 })).status, 404);
      assert.equal((await call('anna', 'POST', '/email/send', { ...msg, orderId: orders.anna })).status, 200);
      assert.equal(inbox.length, 1);
    });

    it('a prompt cannot ask for more than the order owes, or more than M-Pesa takes, or be sent again and again', async () => {
      await prisma.mpesaSettings.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1, enabled: true, environment: 'sandbox', consumerKey: 'k', consumerSecret: 's', shortCode: '174379', passkey: 'p', publicBaseUrl: 'https://example.com', callbackSecret: 'c'.repeat(32) },
      });
      const push = (amount: number, extra: Record<string, unknown> = {}) => call('anna', 'POST', '/mpesa/stkpush', { phone: '0712345678', amount, accountReference: 'X', ...extra });
      const over = await push(5000, { orderId: orders.anna });
      assert.equal(over.status, 400);
      assert.match(over.body.error, /still to pay/);
      assert.match((await push(300_000)).body.error, /at most/);

      const mk = (i: number, phone: string, by: string) =>
        prisma.mpesaTransaction.create({ data: { checkoutRequestId: `ws_SEC2_${phone}_${i}`, merchantRequestId: 'm', phone, amount: 10, accountReference: 'S', createdByName: by } });
      for (let i = 0; i < 3; i++) await mk(i, '254712345678', 'someone else');
      assert.equal((await push(100)).status, 429); // that number has had three already
      for (let i = 0; i < 10; i++) await mk(i, '2547100000' + (10 + i), 'anna (sec2)');
      const many = await call('anna', 'POST', '/mpesa/stkpush', { phone: '0722222222', amount: 100, accountReference: 'X' });
      assert.equal(many.status, 429);
      assert.match(many.body.error, /lot of M-Pesa prompts/);
    });
  });

  describe('audit log', () => {
    it('records changes with who, where from and a summary — secrets left out — plus refused requests and sign-in events', async () => {
      await call('boss', 'PUT', '/mpesa/settings', { consumerSecret: 'top-secret-value', shortCode: '123456' });
      await call('anna', 'GET', '/security/status'); // refused: not an Admin
      await sleep(250);
      const all = (await call('boss', 'GET', '/security/audit?limit=1000')).body.rows as any[];
      const mp = all.find((r) => r.action === 'PUT /api/mpesa/settings');
      assert.ok(mp, 'the settings change is recorded');
      assert.equal(mp.userName, 'boss (sec2)');
      assert.match(mp.detail, /consumerSecret=•••/);
      assert.match(mp.detail, /shortCode=123456/);
      assert.ok(!JSON.stringify(all).includes('top-secret-value'), 'a secret never reaches the log');
      assert.ok(all.some((r) => r.action.startsWith('GET /api/security/status') && r.action.includes('REFUSED') && r.userName === 'anna (sec2)'));
      for (const a of ['LOGIN OK', 'LOGIN FAILED — wrong PIN', 'LOCKED OUT for 15 minutes after wrong PINs', 'PIN CHANGED']) assert.ok(all.some((r) => r.action === a), a);

      const mine = (await call('boss', 'GET', '/security/audit?user=anna&q=refused')).body;
      assert.ok(mine.rows.length >= 1 && mine.rows.every((r: any) => r.userName.includes('anna')));
      assert.equal((await call('anna', 'GET', '/security/audit')).status, 403);
    });
  });

  describe('headers', () => {
    it('every API answer says: no sniffing, no framing, no referrer, no storing — except the branding, which is cached briefly', async () => {
      const h = (await call('', 'GET', '/health')).headers;
      assert.equal(h.get('x-content-type-options'), 'nosniff');
      assert.equal(h.get('x-frame-options'), 'DENY');
      assert.equal(h.get('referrer-policy'), 'no-referrer');
      assert.match(h.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
      assert.equal(h.get('cache-control'), 'no-store');
      assert.match((await call('', 'GET', '/auth/branding')).headers.get('cache-control') ?? '', /max-age=300/);
      const secure = await fetch(`${base}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
      assert.match(secure.headers.get('strict-transport-security') ?? '', /max-age=31536000/);
    });
  });

  describe('a real install refuses a weak signing secret', () => {
    it('starts on a throw-away secret only with a local SQLite database', () => {
      const run = (env: Record<string, string>) =>
        spawnSync(process.execPath, ['--import', 'tsx', '-e', "require('./src/middleware/auth'); console.log('STARTED')"], {
          cwd: path.resolve(__dirname, '..'),
          env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '', ...env },
          encoding: 'utf8',
        });
      assert.match(run({ DATABASE_URL: 'file:./x.db' }).stdout, /STARTED/);
      const pg = run({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db' });
      assert.doesNotMatch(pg.stdout, /STARTED/);
      assert.match(pg.stderr, /JWT_SECRET must be set/);
      assert.doesNotMatch(run({ NODE_ENV: 'production', DATABASE_URL: 'file:./x.db', JWT_SECRET: 'too-short' }).stdout, /STARTED/);
      assert.match(run({ NODE_ENV: 'production', DATABASE_URL: 'file:./x.db', JWT_SECRET: 'x'.repeat(40) }).stdout, /STARTED/);
    });
  });

  describe('data key: sealed secrets and encrypted backups', () => {
    it('seals and opens, leaves plain and already-sealed text alone, and refuses the wrong key', () => {
      process.env.DATA_KEY = 'a-long-random-data-key-for-the-test-run';
      const s = seal('hunter2-secret');
      assert.match(s, /^enc:v1:/);
      assert.equal(seal(s), s, 'sealing twice changes nothing');
      assert.equal(open(s), 'hunter2-secret');
      assert.equal(open('never sealed'), 'never sealed');
      assert.equal(seal(''), '');
      process.env.DATA_KEY = 'a-different-key-entirely-for-this-check';
      assert.throws(() => open(s), /could not be opened/);
      delete process.env.DATA_KEY;
      assert.throws(() => open(s), /DATA_KEY is not set/);
      assert.equal(seal('plain stays plain'), 'plain stays plain', 'with no key, nothing is sealed');
    });

    it('secrets saved in Master Data are stored sealed and never sent back; earlier plain ones are sealed at start-up', async () => {
      process.env.DATA_KEY = 'a-long-random-data-key-for-the-test-run';
      assert.equal((await call('boss', 'PUT', '/mpesa/settings', { consumerKey: 'key-123', consumerSecret: 'sekret-123', passkey: 'pass-123', shortCode: '174379' })).status, 200);
      const row = await prisma.mpesaSettings.findUniqueOrThrow({ where: { id: 1 } });
      for (const k of ['consumerKey', 'consumerSecret', 'passkey', 'callbackSecret'] as const) assert.match(row[k], /^enc:v1:/, k);
      assert.ok(!JSON.stringify(row).includes('sekret-123'));
      const cfg = await loadMpesaConfig();
      assert.deepEqual([cfg.consumerKey, cfg.consumerSecret, cfg.passkey], ['key-123', 'sekret-123', 'pass-123']);
      assert.ok(!JSON.stringify((await call('boss', 'GET', '/mpesa/settings')).body).includes('sekret-123'));

      // a mail password saved before the key existed
      await prisma.mailSettings.upsert({ where: { id: 1 }, update: { username: 'pos@test.local', outgoingHost: '127.0.0.1', password: 'plain-mail-pass' }, create: { id: 1, username: 'pos@test.local', outgoingHost: '127.0.0.1', password: 'plain-mail-pass' } });
      await sealStoredSecrets();
      assert.match((await prisma.mailSettings.findUniqueOrThrow({ where: { id: 1 } })).password, /^enc:v1:/);
      assert.equal((await loadMailConfig())!.password, 'plain-mail-pass');
    });

    it('a backup made with the key is encrypted; it opens with that key and with no other', async () => {
      process.env.DATA_KEY = 'a-long-random-data-key-for-the-test-run';
      const res = await fetch(`${base}/api/backup/download`, { headers: { Authorization: `Bearer ${tokens.boss}` } });
      const file = Buffer.from(await res.arrayBuffer());
      assert.match(res.headers.get('content-disposition') ?? '', /\.json\.gz\.enc"/);
      assert.equal(file.subarray(0, 7).toString(), 'GLMENC1');
      assert.ok(!file.includes('sekret-123'), 'nothing readable inside');
      const check = (buf: Buffer) => fetch(`${base}/api/backup/restore?check=1`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${tokens.boss}` }, body: buf }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
      assert.equal((await check(file)).status, 200);
      process.env.DATA_KEY = 'a-different-key-entirely-for-this-check';
      assert.match((await check(file)).body.error, /could not be decrypted/);
      delete process.env.DATA_KEY;
      assert.match((await check(file)).body.error, /encrypted/);
      assert.equal((await call('boss', 'GET', '/backup/status')).body.encrypted, false);
      process.env.DATA_KEY = 'a-long-random-data-key-for-the-test-run';
      assert.equal((await call('boss', 'GET', '/backup/status')).body.encrypted, true);
      const status = (await call('boss', 'GET', '/security/status')).body;
      assert.equal(status.dataKey, true);
      delete process.env.DATA_KEY;
    });
  });
});
