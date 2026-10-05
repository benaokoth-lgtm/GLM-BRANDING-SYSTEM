// Company details printed on invoices, quotations and receipts: two phone numbers, website, Facebook page and TikTok.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('company contact details', () => {
  before(async () => {
    const admin = await prisma.user.create({ data: { name: 'Company Admin', firstName: 'Company', lastName: 'Admin', role: 'Admin', pinHash: 'x' } });
    tokens.admin = signToken({ id: admin.id, name: admin.name, role: 'Admin' });
    await prisma.role.upsert({ where: { name: 'Staff' }, update: {}, create: { name: 'Staff' } });
    const staff = await prisma.user.create({ data: { name: 'Company Staff', firstName: 'Company', lastName: 'Staff', role: 'Staff', pinHash: 'x' } });
    tokens.staff = signToken({ id: staff.id, name: staff.name, role: 'Staff' });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('an Admin saves a second phone, website, Facebook page and TikTok; everyone who prints can read them', async () => {
    const saved = await call('admin', 'PUT', '/master-data/settings', {
      companyPhone: ' 0797 785 033 ',
      companyPhone2: ' 0722 000 111 ',
      website: ' www.glmgroup.co.ke ',
      facebook: ' facebook.com/glmbranding ',
      tiktok: ' @glmbranding ',
    });
    assert.equal(saved.status, 200);
    assert.deepEqual([saved.body.companyPhone, saved.body.companyPhone2, saved.body.website, saved.body.facebook, saved.body.tiktok], ['0797 785 033', '0722 000 111', 'www.glmgroup.co.ke', 'facebook.com/glmbranding', '@glmbranding']);
    const read = await call('staff', 'GET', '/master-data/settings'); // the till reads them to print receipts
    assert.equal(read.status, 200);
    assert.deepEqual([read.body.companyPhone2, read.body.website, read.body.facebook, read.body.tiktok], ['0722 000 111', 'www.glmgroup.co.ke', 'facebook.com/glmbranding', '@glmbranding']);
  });

  it('they can be cleared, and only an Admin can change them', async () => {
    assert.equal((await call('staff', 'PUT', '/master-data/settings', { website: 'x' })).status, 403);
    const cleared = await call('admin', 'PUT', '/master-data/settings', { companyPhone2: '', website: '', facebook: '', tiktok: '' });
    assert.equal(cleared.status, 200);
    assert.deepEqual([cleared.body.companyPhone2, cleared.body.website, cleared.body.facebook, cleared.body.tiktok], ['', '', '', '']);
  });
});
