// The freelance sales persons' rates on their own screen (Commission → Freelancers → Rates): only an Admin changes them, anyone who sees Commission reads them, and they are the same fields as
// Commission → Rates, so the weekly statements follow at once. (Named z… because it changes the shared commission settings and puts them back.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { getCommissionConfig } from '../src/commission';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const rates = (extra: object = {}) => ({ freelanceRatePct: 9, freelanceLowRatePct: 4.5, freelanceOwnershipMonths: 6, freelanceWhtRate: 3, ...extra });

describe('freelance commission rates', () => {
  before(async () => {
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true }, create: { id: 1, enabled: true } });
    await prisma.role.create({ data: { name: 'Lead (fl rates test)', canManageCommission: true, canCaptureOrders: true } });
    for (const [key, role] of [['admin', 'Admin'], ['lead', 'Lead (fl rates test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (fl rates test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    // back to the starting rates
    await call('admin', 'PUT', '/commission/freelance-settings', rates({ freelanceRatePct: 8, freelanceLowRatePct: 4, freelanceOwnershipMonths: 12, freelanceWhtRate: 5 }));
    server.close();
    await prisma.$disconnect();
  });

  it('only an Admin changes them; a commission manager reads them but cannot', async () => {
    assert.equal((await call('lead', 'PUT', '/commission/freelance-settings', rates())).status, 403);
    const read = await call('lead', 'GET', '/commission/settings');
    assert.equal(read.status, 200);
    assert.ok(typeof read.body.freelanceRatePct === 'number' && typeof read.body.freelanceLowRatePct === 'number');
  });

  it('an Admin changes any of them, at any time, and everything that reads them follows', async () => {
    const r = await call('admin', 'PUT', '/commission/freelance-settings', rates());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.freelanceRatePct, r.body.freelanceLowRatePct, r.body.freelanceOwnershipMonths, r.body.freelanceWhtRate], [9, 4.5, 6, 3]);
    const cfg = await getCommissionConfig(); // what the weekly statements are worked out with
    assert.deepEqual([cfg.freelanceRatePct, cfg.freelanceLowRatePct, cfg.freelanceOwnershipMonths, cfg.freelanceWhtRate], [9, 4.5, 6, 3]);
    assert.equal((await call('lead', 'GET', '/commission/settings')).body.freelanceRatePct, 9);
    // the rest of the commission rates are untouched
    assert.equal(cfg.artworkRatePct, 50);
    // and again, to something else
    const again = await call('admin', 'PUT', '/commission/freelance-settings', rates({ freelanceRatePct: 7.5, freelanceLowRatePct: 3 }));
    assert.equal(again.status, 200);
    assert.deepEqual([(await getCommissionConfig()).freelanceRatePct, (await getCommissionConfig()).freelanceLowRatePct], [7.5, 3]);
  });

  it('refuses rates that cannot be right', async () => {
    assert.equal((await call('admin', 'PUT', '/commission/freelance-settings', rates({ freelanceRatePct: 31 }))).status, 400);
    assert.equal((await call('admin', 'PUT', '/commission/freelance-settings', rates({ freelanceRatePct: -1 }))).status, 400);
    assert.equal((await call('admin', 'PUT', '/commission/freelance-settings', rates({ freelanceWhtRate: -1 }))).status, 400);
    assert.equal((await call('admin', 'PUT', '/commission/freelance-settings', rates({ freelanceOwnershipMonths: 0 }))).status, 400);
    const bad = await call('admin', 'PUT', '/commission/freelance-settings', rates({ freelanceRatePct: 5, freelanceLowRatePct: 6 })); // the low rate cannot beat the standard one
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /low rate/);
    assert.equal((await call('admin', 'PUT', '/commission/freelance-settings', { freelanceRatePct: 8 })).status, 400); // all of them, so nothing is left half set
  });
});
