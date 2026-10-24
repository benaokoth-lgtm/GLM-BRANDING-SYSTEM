// M-Pesa Matching is paged: the waiting list and the matched list come a page at a time, the totals still cover everything, and a page past the end gives the last page. (Named z… because it records data.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { todayStr } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
let token = '';
async function get(path: string) {
  const res = await fetch(`${base}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('M-Pesa Matching is paged', () => {
  before(async () => {
    const u = await prisma.user.create({ data: { name: 'paging admin', role: 'Admin', pinHash: 'x' } });
    token = signToken({ id: u.id, name: u.name, role: 'Admin' });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('the waiting list comes a page at a time, and the summary covers every waiting payment', async () => {
    const before = (await get('/accounting/mpesa?status=Unmatched&pageSize=10')).body;
    for (let i = 0; i < 27; i++) {
      await prisma.mpesaTransaction.create({ data: { checkoutRequestId: `IMPORT-QPAGE${i}`, merchantRequestId: '', phone: '254700000000', amount: 100, accountReference: 'Paybill', status: 'Unmatched', mpesaReceipt: `QPAGE${String(i).padStart(3, '0')}`, kind: 'C2B', payerName: 'Pager', receivedOn: todayStr(), createdByName: 'test' } });
    }
    const p1 = (await get('/accounting/mpesa?status=Unmatched&pageSize=10&page=1')).body;
    const p2 = (await get('/accounting/mpesa?status=Unmatched&pageSize=10&page=2')).body;
    assert.equal(p1.rows.length, 10);
    assert.equal(p1.total, before.total + 27);
    assert.equal(p1.pageCount, Math.ceil((before.total + 27) / 10));
    assert.equal(p1.summary.unmatchedCount, before.summary.unmatchedCount + 27); // everything waiting, not just this page
    assert.equal(Math.round((p1.summary.unmatchedTotal - before.summary.unmatchedTotal) * 100) / 100, 2700);
    assert.ok(!p1.rows.some((r: any) => p2.rows.some((q: any) => q.id === r.id))); // no row on two pages
    const last = (await get('/accounting/mpesa?status=Unmatched&pageSize=10&page=999')).body;
    assert.equal(last.page, last.pageCount);
    assert.equal((await get('/accounting/mpesa?status=Unmatched&pageSize=7')).body.pageSize, 25); // only the offered sizes
    assert.equal((await get('/accounting/mpesa?status=Unmatched&pageSize=100')).body.rows.length, Math.min(100, p1.total));
  });

  it('the matched list is paged too', async () => {
    const m = (await get('/accounting/mpesa/matched?pageSize=10')).body;
    assert.equal(m.page, 1);
    assert.equal(m.pageSize, 10);
    assert.equal(m.pageCount, Math.max(1, Math.ceil(m.total / 10)));
    assert.ok(m.rows.length <= 10 + 5); // a receipt shared by several orders adds a row for each part
  });
});
