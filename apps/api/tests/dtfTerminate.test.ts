// Terminating a roll: it has physically run out while the system still shows a balance. The roll is closed at a cut-off date and the balance is written off as waste —
// from the roll itself, or while installing the next roll.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { summariseRoll, todayStr } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const TODAY = todayStr();
const YESTERDAY = (() => { const d = new Date(TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const newRoll = (id: string) => prisma.dtfRoll.create({ data: { id, installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100, filmCost: 10000, inkPowderCost: 0 } });
const sale = (who: string, rollId: string, metres: number, extra: Record<string, unknown> = {}) => call(who, 'POST', '/dtf/sales', { rollId, client: 'Terminate Client', metres, ...extra });
const rollOf = async (id: string) => (await call('lead', 'GET', '/dtf/data')).body.rolls.find((r: any) => r.id === id);

describe('terminating a roll that is physically finished', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Printer (term test)', canAccessDtf: true, canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Lead (term test)', canAccessDtf: true, canManageDtf: true, canCaptureOrders: true } });
    for (const [key, role] of [['printer', 'Printer (term test)'], ['lead', 'Lead (term test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (term test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.service.create({ data: { name: 'DTF Printing', unit: 'piece', price: 70 } }).catch(() => null);
    await prisma.service.create({ data: { name: 'DTF Sheet (per metre)', unit: 'metre', price: 500 } }).catch(() => null);
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('closes the roll at the cut-off, writes the balance the system still shows off as waste, and the roll takes no more sales', async () => {
    await newRoll('ROLL-T1');
    assert.equal((await sale('printer', 'ROLL-T1', 30)).status, 201); // 30 of 100 m recorded; the shelf is empty but the system says 70 m
    const r = await call('lead', 'POST', '/dtf/rolls/ROLL-T1/terminate', { cutOff: TODAY, note: 'Physically finished — film ran out on the machine' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.status, r.body.closeKind, r.body.finishedOn, r.body.writtenOffM], ['closed', 'terminated', TODAY, 70]);
    assert.equal(r.body.closeNote, 'Physically finished — film ran out on the machine');

    // the numbers the tracker shows: 70 m of waste, flagged as a termination
    const data = (await call('lead', 'GET', '/dtf/data')).body;
    const sum = summariseRoll(data.settings, data.rolls.find((x: any) => x.id === 'ROLL-T1'), data.sales, data.jobs);
    assert.deepEqual([sum.closed, sum.terminated, sum.wastageM, sum.wastagePct], [true, true, 70, 70]);
    assert.equal(sum.wastageKes, 7000); // 70% of the 10,000 roll cost

    const more = await sale('printer', 'ROLL-T1', 1);
    assert.equal(more.status, 400);
    assert.match(more.body.error, /closed/);
    assert.equal((await call('lead', 'POST', '/dtf/rolls/ROLL-T1/terminate', { note: 'again please' })).status, 400); // already closed
  });

  it('is for DTF managers, needs a reason, and a sensible cut-off', async () => {
    await newRoll('ROLL-T2');
    assert.equal((await sale('printer', 'ROLL-T2', 10)).status, 201);
    assert.equal((await call('printer', 'POST', '/dtf/rolls/ROLL-T2/terminate', { note: 'not allowed to' })).status, 403);
    assert.equal((await call('lead', 'POST', '/dtf/rolls/ROLL-T2/terminate', { note: '' })).status, 400); // no reason
    assert.equal((await call('lead', 'POST', '/dtf/rolls/ROLL-T2/terminate', { note: 'finished', cutOff: '2999-01-01' })).status, 400); // future
    assert.equal((await call('lead', 'POST', '/dtf/rolls/ROLL-T2/terminate', { note: 'finished', cutOff: '2025-12-31' })).status, 400); // before it was installed
    const early = await call('lead', 'POST', '/dtf/rolls/ROLL-T2/terminate', { note: 'finished', cutOff: YESTERDAY }); // today's sale is after that cut-off
    assert.equal(early.status, 400);
    assert.match(early.body.error, /after/);
    assert.equal((await call('lead', 'POST', '/dtf/rolls/ROLL-NOPE/terminate', { note: 'finished' })).status, 400);
    assert.equal((await rollOf('ROLL-T2')).status, 'open'); // none of that changed it
  });

  it('artwork jobs still waiting for a price approval hold the roll: decide them first', async () => {
    await newRoll('ROLL-T3');
    // 2 running metres over 108 pieces: recommended 70 a piece; 50 is a discount that needs approval
    const job = await call('lead', 'POST', '/dtf/jobs', { rollId: 'ROLL-T3', client: 'Pending Client', runningMetres: 2, pieces: 108, heatPressFee: 20, pricePerPiece: 50 });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    const r = await call('lead', 'POST', '/dtf/rolls/ROLL-T3/terminate', { note: 'finished' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /approval/);
  });

  it('installing the next roll can terminate the one still showing a balance — together, or not at all', async () => {
    const before = await prisma.dtfRoll.count();
    // a roll that does not exist: nothing is installed
    const bad = await call('lead', 'POST', '/dtf/rolls', { installedOn: TODAY, filmCost: 9000, terminate: [{ rollId: 'ROLL-NOPE', note: 'finished' }] });
    assert.equal(bad.status, 400);
    assert.equal(await prisma.dtfRoll.count(), before);
    // no reason: refused
    assert.equal((await call('lead', 'POST', '/dtf/rolls', { installedOn: TODAY, terminate: [{ rollId: 'ROLL-T2', note: '' }] })).status, 400);

    // ROLL-T2 (10 of 100 m recorded) is finished: terminate it and install the new roll in one go
    const ok = await call('lead', 'POST', '/dtf/rolls', { installedOn: TODAY, filmCost: 9000, inkPowderCost: 1000, terminate: [{ rollId: 'ROLL-T2', note: 'Replaced — film physically used up' }] });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.status, 'open');
    assert.equal(await prisma.dtfRoll.count(), before + 1);
    const old = await rollOf('ROLL-T2');
    assert.deepEqual([old.status, old.closeKind, old.finishedOn, old.writtenOffM], ['closed', 'terminated', TODAY, 90]);
    assert.equal(old.closedByName, 'lead (term test)');
  });

  it('reopening a terminated roll clears the termination', async () => {
    const r = await call('lead', 'POST', '/dtf/rolls/ROLL-T1/reopen', {});
    assert.equal(r.status, 200);
    const roll = await rollOf('ROLL-T1');
    assert.deepEqual([roll.status, roll.closeKind, roll.closeNote, roll.writtenOffM, roll.finishedOn], ['open', '', '', 0, null]);
  });

  it('closing a roll the normal way is not a termination', async () => {
    await newRoll('ROLL-T4');
    const r = await call('lead', 'POST', '/dtf/rolls/ROLL-T4/close', {});
    assert.equal(r.status, 200);
    const roll = await rollOf('ROLL-T4');
    assert.deepEqual([roll.status, roll.closeKind], ['closed', '']);
    const data = (await call('lead', 'GET', '/dtf/data')).body;
    assert.equal(summariseRoll(data.settings, data.rolls.find((x: any) => x.id === 'ROLL-T4'), data.sales, data.jobs).terminated, false);
  });
});
