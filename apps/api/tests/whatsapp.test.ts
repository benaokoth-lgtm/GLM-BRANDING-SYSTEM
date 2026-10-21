// WhatsApp: the Admin's setup, and sending an invoice or quotation to a customer as a PDF, against a stand-in for Meta's Cloud API (throwaway database).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

const TOKEN = 'EAAG-test-token-never-shown';
const PHONE_ID = '109876543210987';

// What the stand-in saw, and how it should answer the next message.
const seen: { method: string; url: string; auth: string | undefined; body: Buffer }[] = [];
let nextMessage: { status: number; body: unknown } | null = null;

function startMeta(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
      if (req.method === 'GET' && req.url?.startsWith(`/v21.0/${PHONE_ID}?`)) return reply(200, { display_phone_number: '+254 797 785 033', verified_name: 'GLM Branding', quality_rating: 'GREEN', id: PHONE_ID });
      if (req.method === 'POST' && req.url === `/v21.0/${PHONE_ID}/media`) return reply(200, { id: 'MEDIA-1' });
      if (req.method === 'POST' && req.url === `/v21.0/${PHONE_ID}/messages`) {
        if (nextMessage) {
          const n = nextMessage;
          nextMessage = null;
          return reply(n.status, n.body);
        }
        return reply(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.TEST1' }] });
      }
      reply(404, { error: { message: 'no such thing', code: 100 } });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

let api: http.Server;
let meta: http.Server;
let base = '';
let admin = '';
let staff = '';
let staffOwn = '';
let invoiceId = 0;
let quoteId = 0;
let noPhoneId = 0;

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('sending an invoice straight to a customer on WhatsApp', () => {
  before(async () => {
    meta = await startMeta();
    process.env.WHATSAPP_TEST_URL = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
    const a = await prisma.user.create({ data: { name: 'Admin (wa test)', role: 'Admin', pinHash: 'x' } });
    admin = signToken({ id: a.id, name: a.name, role: 'Admin' });
    await prisma.role.create({ data: { name: 'WaStaff', canCaptureOrders: true } });
    const s = await prisma.user.create({ data: { name: 'Staff (wa test)', role: 'WaStaff', pinHash: 'x' } });
    staff = signToken({ id: s.id, name: s.name, role: 'WaStaff' });
    const own = await prisma.user.create({ data: { name: 'Owner (wa test)', role: 'WaStaff', pinHash: 'x' } });
    staffOwn = signToken({ id: own.id, name: own.name, role: 'WaStaff' });
    const svc = await prisma.service.create({ data: { name: 'WA Test Banner', unit: 'piece', price: 1160 } });
    const mk = (orderNo: string, status: string, extra: Record<string, unknown>) =>
      prisma.order.create({
        data: { orderNo, kind: 'walkin', staffId: own.id, createdDate: '2031-06-01', status, dueDate: status === 'Invoice' ? '2031-06-08' : null, stage: 'Order Received', lineItems: { create: [{ itemType: 'service', serviceId: svc.id, qty: 5, unitPrice: 1160 }] }, ...extra } as any,
      });
    invoiceId = (await mk('W-WA-INV', 'Invoice', { customerName: 'Wanjiru Kamau', phone: '0712 345 678', payments: { create: [{ date: '2031-06-01', amount: 2000, method: 'Cash' }] } })).id;
    quoteId = (await mk('W-WA-QUO', 'Quote', { customerName: 'Walk-in', phone: '0722 111 222' })).id;
    noPhoneId = (await mk('W-WA-NOPHONE', 'Invoice', { customerName: 'No Phone Person', phone: '' })).id;
    api = app.listen(0);
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  after(async () => {
    api.close();
    meta.close();
    delete process.env.WHATSAPP_TEST_URL;
    await prisma.$disconnect();
  });

  it('setup is Admin-only, starts empty, checks what is typed, and never sends the token back', async () => {
    assert.equal((await call(staff, 'GET', '/whatsapp/settings')).status, 403);
    const first = await call(admin, 'GET', '/whatsapp/settings');
    assert.deepEqual([first.body.configured, first.body.enabled, first.body.hasToken], [false, false, false]);
    assert.match(first.body.templateBody, /\{\{1\}\}.*\{\{5\}\}/); // the wording to copy into Meta's template form
    assert.equal((await call(admin, 'PUT', '/whatsapp/settings', { phoneNumberId: 'abc' })).status, 400);
    assert.equal((await call(admin, 'PUT', '/whatsapp/settings', { templateName: 'Has Capitals' })).status, 400);
    assert.equal((await call(admin, 'PUT', '/whatsapp/settings', { enabled: true })).status, 400); // nothing to switch on yet

    const saved = await call(admin, 'PUT', '/whatsapp/settings', { phoneNumberId: PHONE_ID, businessAccountId: '223344556677', accessToken: TOKEN });
    assert.equal(saved.status, 200);
    assert.ok(!JSON.stringify(saved.body).includes(TOKEN), 'the token was sent back');
    assert.deepEqual([saved.body.configured, saved.body.hasToken, saved.body.enabled], [true, true, false]);
    // leaving the token blank on a later save keeps it
    await call(admin, 'PUT', '/whatsapp/settings', { accessToken: '', templateLanguage: 'en_US' });
    const row = await prisma.whatsappSettings.findUniqueOrThrow({ where: { id: 1 } });
    assert.ok(row.accessToken && row.templateLanguage === 'en_US');
  });

  it('the connection test shows whose number it is; a wrong token is explained', async () => {
    const ok = await call(admin, 'POST', '/whatsapp/settings/test');
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.verifiedName, ok.body.displayPhoneNumber], ['GLM Branding', '+254 797 785 033']);
    assert.equal(seen.at(-1)!.auth, `Bearer ${TOKEN}`);
    await call(admin, 'PUT', '/whatsapp/settings', { accessToken: 'a-wrong-token' });
    const bad = await call(admin, 'POST', '/whatsapp/settings/test');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /access token/);
    await call(admin, 'PUT', '/whatsapp/settings', { accessToken: TOKEN });
  });

  it('while it is switched off nothing can be sent, and the order window is told', async () => {
    assert.deepEqual((await call(staffOwn, 'GET', '/whatsapp/status')).body, { ready: false, template: false });
    const r = await call(staffOwn, 'POST', '/whatsapp/send', { orderId: invoiceId });
    assert.equal(r.status, 501);
    assert.match(r.body.error, /Master Data → WhatsApp/);
  });

  it('sends the invoice as a PDF in a template message: upload, then the message with the document, the number and five values', async () => {
    assert.equal((await call(admin, 'PUT', '/whatsapp/settings', { enabled: true, templateName: 'glm_invoice_pdf', templateLanguage: 'en' })).status, 200);
    assert.deepEqual((await call(staffOwn, 'GET', '/whatsapp/status')).body, { ready: true, template: true });

    const before = seen.length;
    const r = await call(staffOwn, 'POST', '/whatsapp/send', { orderId: invoiceId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.to, r.body.messageId, r.body.mode, r.body.attachment], ['254712345678', 'wamid.TEST1', 'template', 'Invoice-W-WA-INV.pdf']);

    const [upload, message] = seen.slice(before);
    assert.equal(upload!.url, `/v21.0/${PHONE_ID}/media`);
    const raw = upload!.body.toString('latin1');
    assert.match(raw, /name="messaging_product"[\s\S]*whatsapp/);
    assert.match(raw, /application\/pdf/);
    assert.match(raw, /filename="Invoice-W-WA-INV\.pdf"/);
    assert.ok(raw.includes('%PDF-'), 'the file itself is in the upload');

    assert.equal(message!.url, `/v21.0/${PHONE_ID}/messages`);
    assert.equal(message!.auth, `Bearer ${TOKEN}`);
    const sent = JSON.parse(message!.body.toString());
    assert.deepEqual([sent.messaging_product, sent.to, sent.type, sent.template.name, sent.template.language.code], ['whatsapp', '254712345678', 'template', 'glm_invoice_pdf', 'en']);
    assert.deepEqual(sent.template.components[0], { type: 'header', parameters: [{ type: 'document', document: { id: 'MEDIA-1', filename: 'Invoice-W-WA-INV.pdf' } }] });
    // 5 × 1,160 = 5,800 less 2,000 paid
    assert.deepEqual(
      sent.template.components[1].parameters.map((p: any) => p.text),
      ['Wanjiru Kamau', 'invoice', 'W-WA-INV', 'Ksh 5,800.00', 'Balance due Ksh 3,800.00 by 08/06/2031.'],
    );

    const log = (await call(staffOwn, 'GET', `/whatsapp/log?orderId=${invoiceId}`)).body;
    assert.deepEqual([log[0].status, log[0].to, log[0].mode, log[0].sentByName], ['Sent', '254712345678', 'template', 'Owner (wa test)']);
  });

  it('a number typed at the till overrides the order\'s; a quotation goes the same way, named as one', async () => {
    const before = seen.length;
    const r = await call(staffOwn, 'POST', '/whatsapp/send', { orderId: quoteId, to: '+254 733 000 111' });
    assert.equal(r.status, 200);
    assert.equal(r.body.to, '254733000111');
    assert.equal(r.body.attachment, 'Quotation-W-WA-QUO.pdf');
    const sent = JSON.parse(seen.slice(before)[1]!.body.toString());
    assert.equal(sent.template.components[1].parameters[1].text, 'quotation');
  });

  it('what WhatsApp refuses is explained in plain words, and the attempt is recorded as failed', async () => {
    nextMessage = { status: 400, body: { error: { message: 'Re-engagement message', code: 131047 } } };
    const r = await call(staffOwn, 'POST', '/whatsapp/send', { orderId: invoiceId });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /24 hours/);
    nextMessage = { status: 400, body: { error: { message: 'Template name does not exist in the translation', code: 132001 } } };
    assert.match((await call(staffOwn, 'POST', '/whatsapp/send', { orderId: invoiceId })).body.error, /cannot find that template/);
    const log = (await call(staffOwn, 'GET', `/whatsapp/log?orderId=${invoiceId}`)).body;
    assert.deepEqual([log[0].status, log[1].status, log[2].status], ['Failed', 'Failed', 'Sent']);
    assert.match(log[1].error, /24 hours/);
  });

  it('with no template saved a plain document message is tried (it works only inside the 24-hour window)', async () => {
    await call(admin, 'PUT', '/whatsapp/settings', { templateName: '' });
    const before = seen.length;
    const r = await call(staffOwn, 'POST', '/whatsapp/send', { orderId: invoiceId });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'document');
    const sent = JSON.parse(seen.slice(before)[1]!.body.toString());
    assert.deepEqual([sent.type, sent.document.id, sent.document.filename], ['document', 'MEDIA-1', 'Invoice-W-WA-INV.pdf']);
    assert.match(sent.document.caption, /Invoice W-WA-INV/);
    await call(admin, 'PUT', '/whatsapp/settings', { templateName: 'glm_invoice_pdf' });
  });

  it('only someone who may open the order can send it; a missing or bad number is asked for', async () => {
    assert.equal((await call(staff, 'POST', '/whatsapp/send', { orderId: invoiceId })).status, 403); // another person's order
    assert.equal((await call(staff, 'GET', `/whatsapp/log?orderId=${invoiceId}`)).status, 403);
    assert.equal((await call(staffOwn, 'POST', '/whatsapp/send', { orderId: 99999999 })).status, 404);
    const none = await call(staffOwn, 'POST', '/whatsapp/send', { orderId: noPhoneId });
    assert.equal(none.status, 400);
    assert.match(none.body.error, /WhatsApp number/);
    assert.equal((await call(staffOwn, 'POST', '/whatsapp/send', { orderId: invoiceId, to: '12345' })).status, 400);
    assert.equal((await call(null, 'POST', '/whatsapp/send', { orderId: invoiceId })).status, 401);
  });

  it('a file picked with the paperclip goes to any number: a PDF through the template, a picture or other file as a plain message; with checks on type, size, number and order', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    // a PDF: upload, then the approved template with the file as its header and the file name in the body
    let before = seen.length;
    const pdf = await call(staffOwn, 'POST', '/whatsapp/send-file', { to: '0712 345 678', filename: 'Artwork proof.pdf', mime: 'application/pdf', data: b64('%PDF-1.4 test'), customer: 'Wanjiru' });
    assert.equal(pdf.status, 200, JSON.stringify(pdf.body));
    assert.deepEqual([pdf.body.to, pdf.body.mode, pdf.body.attachment], ['254712345678', 'template', 'Artwork proof.pdf']);
    const tpl = JSON.parse(seen.slice(before)[1]!.body.toString());
    assert.equal(tpl.template.components[0].parameters[0].document.id, 'MEDIA-1');
    assert.equal(tpl.template.components[1].parameters[2].text, 'Artwork proof.pdf');
    // a picture: sent as an image with the message as its caption
    before = seen.length;
    const img = await call(staffOwn, 'POST', '/whatsapp/send-file', { to: '0712345678', filename: 'proof.png', mime: 'image/png', data: b64('PNGDATA'), message: 'Please approve this proof' });
    assert.equal(img.status, 200);
    assert.equal(img.body.mode, 'image');
    const sent = JSON.parse(seen.slice(before)[1]!.body.toString());
    assert.deepEqual([sent.type, sent.image.id, sent.image.caption], ['image', 'MEDIA-1', 'Please approve this proof']);
    // a Word file: a plain document message
    const doc = await call(staffOwn, 'POST', '/whatsapp/send-file', { to: '0712345678', filename: 'terms.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: b64('DOCX') });
    assert.equal(doc.body.mode, 'document');
    // it is logged with the file name, for the sender and for an Admin
    const recent = (await call(staffOwn, 'GET', '/whatsapp/recent')).body;
    assert.deepEqual(recent.slice(0, 3).map((r: any) => [r.fileName, r.status]), [['terms.docx', 'Sent'], ['proof.png', 'Sent'], ['Artwork proof.pdf', 'Sent']]);
    assert.ok((await call(admin, 'GET', '/whatsapp/recent')).body.length >= 3);
    // checks
    const bad = (body: Record<string, unknown>) => call(staffOwn, 'POST', '/whatsapp/send-file', { to: '0712345678', filename: 'a.pdf', mime: 'application/pdf', data: b64('x'), ...body });
    assert.match((await bad({ mime: 'application/x-msdownload', filename: 'a.exe' })).body.error, /cannot be sent/);
    assert.match((await bad({ to: '123' })).body.error, /WhatsApp number/);
    assert.equal((await bad({ data: '' })).status, 400);
    assert.match((await bad({ data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') })).body.error, /10 MB/);
    assert.match((await bad({ mime: 'image/jpeg', filename: 'a.jpg', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') })).body.error, /5 MB/);
    // with an order: only someone who may open it; and a failure from WhatsApp is explained and logged
    assert.equal((await call(staff, 'POST', '/whatsapp/send-file', { to: '0712345678', filename: 'a.pdf', mime: 'application/pdf', data: b64('x'), orderId: invoiceId })).status, 403);
    nextMessage = { status: 400, body: { error: { message: 'Re-engagement message', code: 131047 } } };
    const late = await call(staffOwn, 'POST', '/whatsapp/send-file', { to: '0712345678', filename: 'p.png', mime: 'image/png', data: b64('x'), orderId: invoiceId });
    assert.equal(late.status, 502);
    assert.match(late.body.error, /24 hours/);
    assert.equal((await call(staffOwn, 'GET', `/whatsapp/log?orderId=${invoiceId}`)).body[0].fileName, 'p.png');
    assert.equal((await call(null, 'POST', '/whatsapp/send-file', {})).status, 401);
  });
});
