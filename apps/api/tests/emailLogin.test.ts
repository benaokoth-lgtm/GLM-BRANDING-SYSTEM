// Signing in with the email address a login was sent to — for someone whose sign-in screen cannot show the list of names (a blocker, a data-saving browser…).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { PIN_ROUNDS } from '../src/pins';

let server: Server;
let base = '';
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

describe('signing in with an email address and PIN', () => {
  let wesleyId = 0;
  before(async () => {
    await prisma.role.create({ data: { name: 'Seller (email login test)', canCaptureOrders: true } });
    const w = await prisma.user.create({ data: { name: 'Wesley (email login test)', role: 'Seller (email login test)', email: 'wesley.emaillogin@example.com', pinHash: await bcrypt.hash('482916', PIN_ROUNDS), pinLength: 6 } });
    wesleyId = w.id;
    await prisma.user.create({ data: { name: 'Gone (email login test)', role: 'Seller (email login test)', email: 'gone.emaillogin@example.com', pinHash: await bcrypt.hash('482916', PIN_ROUNDS), pinLength: 6, active: false } });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('signs the person in whatever the capitals or spaces in the address, exactly as picking their name does', async () => {
    const r = await post('/auth/login', { email: '  Wesley.EmailLogin@Example.com ', pin: '482916' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token);
    assert.equal(r.body.user.id, wesleyId);
    assert.equal(r.body.user.name, 'Wesley (email login test)');
    const byName = await post('/auth/login', { userId: wesleyId, pin: '482916' });
    assert.equal(byName.status, 200); // choosing a name still works
  });

  it('does not tell a wrong PIN from an address that is not on the system, and checks the PIN first', async () => {
    const wrongPin = await post('/auth/login', { email: 'wesley.emaillogin@example.com', pin: '000000' });
    const noSuch = await post('/auth/login', { email: 'nobody.emaillogin@example.com', pin: '482916' });
    assert.equal(wrongPin.status, 401);
    assert.equal(noSuch.status, 401);
    assert.equal(wrongPin.body.error, noSuch.body.error);
    assert.equal(wrongPin.body.token, undefined);
  });

  it('needs an email address or a name, and a PIN; a switched-off sign-in stays off', async () => {
    assert.equal((await post('/auth/login', { pin: '482916' })).status, 400);
    assert.equal((await post('/auth/login', { email: 'wesley.emaillogin@example.com' })).status, 400);
    assert.equal((await post('/auth/login', { email: '   ', pin: '482916' })).status, 400);
    const off = await post('/auth/login', { email: 'gone.emaillogin@example.com', pin: '482916' });
    assert.equal(off.status, 401);
    assert.match(off.body.error, /switched off/);
  });
});
