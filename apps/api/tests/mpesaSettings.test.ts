// M-Pesa settings (Master Data → M-Pesa) and the callbacks that depend on them, over real HTTP (throwaway database).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
let admin = '';
let staff = '';

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('M-Pesa settings', () => {
  before(async () => {
    const a = await prisma.user.create({ data: { name: 'Admin (mpesa test)', role: 'Admin', pinHash: 'x' } });
    const s = await prisma.user.create({ data: { name: 'Staff (mpesa test)', role: 'Staff', pinHash: 'x' } });
    admin = signToken({ id: a.id, name: a.name, role: 'Admin' });
    staff = signToken({ id: s.id, name: s.name, role: 'Staff' });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('is for the Admin only, and starts switched off with nothing set', async () => {
    assert.equal((await call(staff, 'GET', '/mpesa/settings')).status, 403);
    assert.equal((await call(null, 'GET', '/mpesa/settings')).status, 401);
    const r = await call(admin, 'GET', '/mpesa/settings');
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.ready, false);
    assert.equal(r.body.hasConsumerKey, false);
    // nobody can send a prompt until it is set up
    const stk = await call(staff, 'POST', '/mpesa/stkpush', { phone: '0712345678', amount: 100, accountReference: 'X' });
    assert.equal(stk.status, 501);
    assert.match(stk.body.error, /Master Data → M-Pesa/);
  });

  it('saves without ever sending the secrets back, and will not switch on until it is complete', async () => {
    const early = await call(admin, 'PUT', '/mpesa/settings', { enabled: true, shortCode: '174379' });
    assert.equal(early.status, 400);
    assert.match(early.body.error, /consumer key/);

    assert.equal((await call(admin, 'PUT', '/mpesa/settings', { publicBaseUrl: 'http://not-secure.example' })).status, 400);

    const saved = await call(admin, 'PUT', '/mpesa/settings', {
      environment: 'sandbox',
      shortCode: '174379',
      isTill: false,
      publicBaseUrl: 'https://pos.example.co.ke/',
      consumerKey: 'KEY-SECRET-VALUE',
      consumerSecret: 'CONSUMER-SECRET-VALUE',
      passkey: 'PASSKEY-SECRET-VALUE',
    });
    assert.equal(saved.status, 200);
    const text = JSON.stringify(saved.body);
    for (const secret of ['KEY-SECRET-VALUE', 'CONSUMER-SECRET-VALUE', 'PASSKEY-SECRET-VALUE']) assert.ok(!text.includes(secret), 'a saved secret was sent back');
    assert.equal(saved.body.hasConsumerKey, true);
    assert.equal(saved.body.hasConsumerSecret, true);
    assert.equal(saved.body.hasPasskey, true);
    assert.equal(saved.body.publicBaseUrl, 'https://pos.example.co.ke'); // trailing slash dropped
    assert.equal(saved.body.enabled, false);

    // the callback addresses are built from the public address and a random secret
    const urls = saved.body.callbackUrls;
    assert.match(urls.stk, /^https:\/\/pos\.example\.co\.ke\/api\/mpesa\/callback\/[0-9a-f]{20,}$/);
    assert.match(urls.confirmation, /\/api\/mpesa\/c2b\/[0-9a-f]{20,}\/confirmation$/);

    // leaving the secret fields blank on a later save keeps what is stored
    const again = await call(admin, 'PUT', '/mpesa/settings', { shortCode: '600000', consumerKey: '', consumerSecret: '', passkey: '' });
    assert.equal(again.body.shortCode, '600000');
    assert.equal(again.body.hasConsumerSecret, true);
    const row = await prisma.mpesaSettings.findUniqueOrThrow({ where: { id: 1 } });
    assert.equal(row.consumerSecret, 'CONSUMER-SECRET-VALUE');
    assert.equal(row.callbackSecret.length >= 20, true);
    assert.equal(urls.stk.endsWith(row.callbackSecret), true); // the secret is stable across saves

    const on = await call(admin, 'PUT', '/mpesa/settings', { enabled: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.ready, true);
    assert.equal((await call(admin, 'PUT', '/mpesa/settings', { enabled: false })).body.enabled, false);
  });

  it('callbacks only act when the address carries the secret', async () => {
    const row = await prisma.mpesaSettings.findUniqueOrThrow({ where: { id: 1 } });
    const body = { TransID: 'QWE1234567', TransAmount: '1500.00', TransTime: '20310312101500', BillRefNumber: 'NOPE-1', MSISDN: 'hashed', FirstName: 'Jane', LastName: 'Roe' };

    const wrong = await call(null, 'POST', '/mpesa/c2b/not-the-secret-not-the-secret/confirmation', body);
    assert.equal(wrong.status, 200); // always acknowledged, so Safaricom does not retry…
    assert.equal(await prisma.mpesaTransaction.count({ where: { mpesaReceipt: 'QWE1234567' } }), 0); // …but nothing was recorded

    const right = await call(null, 'POST', `/mpesa/c2b/${row.callbackSecret}/confirmation`, body);
    assert.equal(right.status, 200);
    const tx = await prisma.mpesaTransaction.findUniqueOrThrow({ where: { mpesaReceipt: 'QWE1234567' } });
    assert.equal(tx.kind, 'C2B');
    assert.equal(tx.status, 'Unmatched');
    assert.equal(tx.amount, 1500);
    assert.equal(tx.receivedOn, '2031-03-12');
    assert.equal(tx.payerName, 'Jane Roe');

    // the older no-secret STK address does nothing once the Admin has saved settings
    assert.equal((await call(null, 'POST', '/mpesa/callback', { Body: { stkCallback: { CheckoutRequestID: 'x', ResultCode: 0 } } })).status, 200);
  });
});
