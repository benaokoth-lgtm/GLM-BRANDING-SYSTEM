// Email settings (Master Data → Email) and emailing login PINs, against a tiny fake SMTP server (throwaway database).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

// A minimal SMTP server: accepts AUTH PLAIN for one mailbox and keeps every message it is given.
const USER = 'pos@test.local';
const PASS = 'correct horse';
const inbox: { to: string[]; data: string }[] = [];
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
        else if (u.startsWith('AUTH PLAIN')) {
          const [, user, pass] = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString().split('\0');
          sock.write(user === USER && pass === PASS ? '235 ok\r\n' : '535 5.7.8 bad credentials\r\n');
        } else if (u.startsWith('MAIL FROM')) {
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

let api: Server;
let smtp: net.Server;
let smtpPort = 0;
let base = '';
let admin = '';
let adminId = 0;
let staffId = 0;
let staff = '';

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('email settings and emailing login PINs', () => {
  before(async () => {
    smtp = await startSmtp();
    smtpPort = (smtp.address() as AddressInfo).port;
    const a = await prisma.user.create({ data: { name: 'Admin (mail test)', role: 'Admin', pinHash: 'x' } });
    adminId = a.id;
    admin = signToken({ id: a.id, name: a.name, role: 'Admin' });
    await prisma.role.create({ data: { name: 'Staff', canCaptureOrders: true } }).catch(() => null);
    const s = await prisma.user.create({ data: { name: 'Wanjiru (mail test)', role: 'Staff', pinHash: '$2a$10$placeholderplaceholderplaceholderplaceholderplaceholde' } });
    staffId = s.id;
    staff = signToken({ id: s.id, name: s.name, role: 'Staff' });
    api = app.listen(0);
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  after(async () => {
    api.close();
    smtp.close();
    await prisma.$disconnect();
  });

  it('is Admin-only, starts not set up, and never sends the password back', async () => {
    assert.equal((await call(staff, 'GET', '/master-data/mail')).status, 403);
    const first = await call(admin, 'GET', '/master-data/mail');
    assert.equal(first.body.configured, false);
    assert.equal(first.body.smtpPort, 465); // the recommended SSL/TLS defaults
    assert.equal(first.body.imapPort, 993);
    assert.equal(first.body.pop3Port, 995);

    assert.equal((await call(admin, 'PUT', '/master-data/mail', { username: 'not-an-email' })).status, 400);
    const saved = await call(admin, 'PUT', '/master-data/mail', {
      username: USER,
      password: PASS,
      outgoingHost: '127.0.0.1',
      smtpPort: smtpPort,
      incomingHost: 'mail.test.local',
      fromName: 'GLM Branding POS',
      loginUrl: 'https://pos.test.local/',
    });
    assert.equal(saved.status, 200);
    assert.ok(!JSON.stringify(saved.body).includes(PASS), 'the password was sent back');
    assert.equal(saved.body.configured, true);
    assert.equal(saved.body.hasPassword, true);
    assert.equal(saved.body.loginUrl, 'https://pos.test.local'); // trailing slash dropped
    // leaving the password blank on a later save keeps it
    await call(admin, 'PUT', '/master-data/mail', { password: '', fromName: 'GLM POS' });
    assert.equal((await prisma.mailSettings.findUniqueOrThrow({ where: { id: 1 } })).password, PASS);
  });

  it('sends a test email, and explains a failure in plain words', async () => {
    const ok = await call(admin, 'POST', '/master-data/mail/test', { to: 'owner@test.local' });
    assert.equal(ok.status, 200);
    assert.ok(inbox.some((m) => m.to.includes('owner@test.local') && /test message/i.test(m.data)));
    assert.ok(inbox.some((m) => /From: .*pos@test\.local/i.test(m.data)), 'sent from the mailbox username');

    await call(admin, 'PUT', '/master-data/mail', { password: 'wrong password' });
    const bad = await call(admin, 'POST', '/master-data/mail/test', { to: 'owner@test.local' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /username or password/);
    await call(admin, 'PUT', '/master-data/mail', { password: PASS, smtpPort: 1 });
    const down = await call(admin, 'POST', '/master-data/mail/test', { to: 'owner@test.local' });
    assert.equal(down.status, 400);
    assert.match(down.body.error, /Could not connect to 127\.0\.0\.1 on port 1/);
    await call(admin, 'PUT', '/master-data/mail', { smtpPort });
  });

  it('staff emails are Admin-only, unique, and must exist before a PIN can be sent', async () => {
    assert.equal((await call(staff, 'GET', '/master-data/staff-details')).status, 403);
    assert.equal((await call(admin, 'POST', `/master-data/staff/${staffId}/send-pin`)).status, 400); // no email yet
    assert.equal((await call(admin, 'PUT', `/master-data/staff/${staffId}/email`, { email: 'nope' })).status, 400);
    assert.equal((await call(admin, 'PUT', `/master-data/staff/${staffId}/email`, { email: 'Wanjiru@Test.Local' })).status, 200);
    assert.equal((await call(admin, 'PUT', `/master-data/staff/${adminId}/email`, { email: 'wanjiru@test.local' })).status, 400); // taken
    const details = await call(admin, 'GET', '/master-data/staff-details');
    assert.equal(details.body.find((u: any) => u.id === staffId).email, 'wanjiru@test.local'); // stored lowercase
  });

  it('emails a fresh PIN that works once, then forces the person to choose their own', async () => {
    const before = inbox.length;
    const sent = await call(admin, 'POST', `/master-data/staff/${staffId}/send-pin`);
    assert.equal(sent.status, 200);
    assert.equal(sent.body.sentTo, 'wanjiru@test.local');
    const mail = inbox.slice(before).find((m) => m.to.includes('wanjiru@test.local'))!;
    assert.ok(mail, 'the email arrived');
    const pin = /^\s+(\d{4})\s*$/m.exec(mail.data)?.[1];
    assert.ok(pin, 'the PIN is in the email');
    assert.match(mail.data, /https:\/\/pos\.test\.local/); // the sign-in address

    // the emailed PIN signs them in, and the login says they must change it
    const login = await call(null, 'POST', '/auth/login', { userId: staffId, pin });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.mustChangePin, true);

    // choosing their own clears the flag
    const mine = await call(login.body.token, 'POST', '/auth/change-pin', { currentPin: pin, newPin: pin === '7391' ? '7392' : '7391' });
    assert.equal(mine.status, 200);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: staffId } })).mustChangePin, false);
  });

  it('if the email cannot be sent, the person keeps their old PIN', async () => {
    await call(admin, 'PUT', '/master-data/mail', { smtpPort: 1 });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: staffId } });
    const r = await call(admin, 'POST', `/master-data/staff/${staffId}/send-pin`);
    assert.equal(r.status, 502);
    assert.match(r.body.error, /left unchanged/);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: staffId } });
    assert.equal(after.pinHash, before.pinHash);
    assert.equal(after.mustChangePin, false);
  });

  it('a new staff member can be created and emailed their PIN in one step', async () => {
    await call(admin, 'PUT', '/master-data/mail', { smtpPort });
    const before = inbox.length;
    const r = await call(admin, 'POST', '/master-data/staff', { firstName: 'Otieno', lastName: '(mail test)', role: 'Staff', pin: '4455', email: 'otieno@test.local', emailPin: true });
    assert.equal(r.status, 201);
    assert.equal(r.body.emailed.ok, true);
    assert.ok(inbox.slice(before).some((m) => m.to.includes('otieno@test.local') && m.data.includes('4455')));
    const created = await prisma.user.findFirstOrThrow({ where: { name: 'Otieno (mail test)' } });
    assert.equal(created.mustChangePin, true);
  });

  it('emails speak for the company named in Master Data, not a fixed name', async () => {
    await call(admin, 'PUT', '/master-data/settings', { companyName: 'Acme Prints Ltd' });
    const before = inbox.length;
    const r = await call(admin, 'POST', '/master-data/staff', { firstName: 'Brand', lastName: '(mail test)', role: 'Staff', pin: '5566', email: 'brand@test.local', emailPin: true });
    assert.equal(r.status, 201);
    const mail = inbox.slice(before).find((m) => m.to.includes('brand@test.local'))!;
    assert.ok(mail, 'the email arrived');
    assert.match(mail.data, /Acme Prints Ltd/); // no system name set: the company name is used
    assert.doesNotMatch(mail.data, /GLM Branding/);
    // a system name, when there is one, is what the system calls itself
    await call(admin, 'PUT', '/master-data/settings', { systemName: 'Acme Counter System' });
    const before2 = inbox.length;
    await call(admin, 'POST', '/master-data/staff', { firstName: 'Brand', middleName: 'Two', lastName: '(mail test)', role: 'Staff', pin: '5577', email: 'brand2@test.local', emailPin: true });
    const mail2 = inbox.slice(before2).find((m) => m.to.includes('brand2@test.local'))!;
    assert.match(mail2.data, /Acme Counter System/);
    await call(admin, 'PUT', '/master-data/settings', { companyName: 'GLM Branding', systemName: '' });
  });

  it('an invoice or quotation is emailed as a PDF attachment, built from the order, with a short message in the body', async () => {
    const svc = await prisma.service.create({ data: { name: 'Mail Test Banner', unit: 'piece', price: 1160 } });
    const mk = (orderNo: string, status: string, customerName: string) =>
      prisma.order.create({
        data: { orderNo, kind: 'walkin', staffId: adminId, createdDate: '2031-05-01', status, dueDate: status === 'Invoice' ? '2031-05-08' : null, stage: 'Order Received', customerName, lineItems: { create: [{ itemType: 'service', serviceId: svc.id, qty: 3, unitPrice: 1160 }, { itemType: 'service', serviceId: svc.id, qty: 1, unitPrice: 580, discountPct: 10 }] }, payments: status === 'Invoice' ? { create: [{ date: '2031-05-01', amount: 1000, method: 'Cash' }] } : undefined },
      });
    const invoice = await mk('W-PDF-INV', 'Invoice', 'Ngũgĩ wa Thiong’o 日本');
    const quote = await mk('W-PDF-QUO', 'Quote', 'Walk-in');

    const grab = (data: string) => {
      const m = /filename="?([^"\r\n;]+)"?[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(data);
      return m ? { name: m[1]!, bytes: Buffer.from(m[2]!.replace(/\s/g, ''), 'base64') } : null;
    };

    const before = inbox.length;
    const r = await call(admin, 'POST', '/email/send', { orderId: invoice.id, to: 'client@test.local', subject: 'Invoice W-PDF-INV' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mail = inbox.slice(before).find((m) => m.to.includes('client@test.local'))!;
    assert.ok(mail, 'the email arrived');
    assert.match(mail.data, /Content-Type: application\/pdf/i);
    const att = grab(mail.data)!;
    assert.equal(att.name, 'Invoice-W-PDF-INV.pdf');
    assert.equal(att.bytes.subarray(0, 5).toString(), '%PDF-', 'a real PDF file');
    assert.ok(att.bytes.length > 1500);
    const unfold = (s: string) => s.split('=\r\n').join(''); // quoted-printable soft line breaks
    assert.match(unfold(mail.data), /Please find attached our invoice W-PDF-INV/); // the body is a short message, not the document

    // a quotation goes the same way, named as one; a note can be added; an older tab's rendered HTML is ignored
    const b2 = inbox.length;
    const q = await call(admin, 'POST', '/email/send', { orderId: quote.id, to: 'client2@test.local', subject: 'Quotation W-PDF-QUO', message: 'Thanks for asking.', html: '<h1>old</h1>' });
    assert.equal(q.status, 200);
    const mail2 = inbox.slice(b2).find((m) => m.to.includes('client2@test.local'))!;
    assert.equal(grab(mail2.data)!.name, 'Quotation-W-PDF-QUO.pdf');
    assert.match(unfold(mail2.data), /Thanks for asking\./);
    assert.doesNotMatch(mail2.data, /<h1>old<\/h1>/);

    // only someone who may open the order can send it
    const other = await prisma.user.create({ data: { name: 'Other (mail test)', role: 'Staff', pinHash: 'x' } }); // fresh: the earlier staff token was retired when their PIN changed
    const otherToken = signToken({ id: other.id, name: other.name, role: 'Staff' });
    assert.equal((await call(otherToken, 'POST', '/email/send', { orderId: invoice.id, to: 'x@test.local', subject: 'x' })).status, 403);
    assert.equal((await call(admin, 'POST', '/email/send', { orderId: 99999999, to: 'x@test.local', subject: 'x' })).status, 404);
  });
});
