// Artwork charged on running metres alone: the charge per running metre × the running metres, shared equally between the artworks on that length, so the client bears the empty space
// (600 a metre, 0.53 m, 2 artworks: 600 × 0.53 ÷ 2 = 159 each). The per-piece minimum can be 0. Below the recommended price still goes to a manager. (Named z… because it records orders
// and changes the UV DTF settings, which it puts back.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sheetCalc, systemJobCalc, todayStr, UV_DTF_SETTINGS } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ROLL = 'UV-RUNM';
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const setup = (extra: object = {}) => ({ ...UV_DTF_SETTINGS, fixedChargePerMetre: 600, minPricePerPiece: 0, smallShareBelow: 0, ...extra });

describe('artwork charged on running metres', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Printer (run metres test)', canAccessDtf: true, canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Lead (run metres test)', canAccessDtf: true, canManageDtf: true, canCaptureOrders: true } });
    for (const [key, role] of [['printer', 'Printer (run metres test)'], ['lead', 'Lead (run metres test)'], ['lead2', 'Lead (run metres test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (run metres test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await call('lead', 'GET', '/dtf/data?product=uv'); // makes the UV settings row
    await prisma.dtfRoll.create({ data: { id: ROLL, product: 'uv', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 50, filmCost: 6500, inkPowderCost: 4500 } });
  });
  after(async () => {
    await call('lead', 'PUT', '/dtf/settings?product=uv', UV_DTF_SETTINGS); // back to the starting figures
    server.close();
    await prisma.$disconnect();
  });

  it('the setup takes a charge per running metre with no minimum per piece', async () => {
    const r = await call('lead', 'PUT', '/dtf/settings?product=uv', setup());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = (await call('lead', 'GET', '/dtf/data?product=uv')).body;
    assert.deepEqual([d.settings.fixedChargePerMetre, d.settings.minPricePerPiece], [600, 0]);
  });

  it('2 artworks on 0.53 m at 600 a metre are 159 each — the client bears the empty space; a lower price waits for a manager', async () => {
    const job = await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Run Metres Client', runningMetres: 0.53, pieces: 2 });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    assert.equal(job.body.order.totals.grandTotal, 318);
    assert.equal(job.body.approval, null);
    // more artworks on the same film share it: 6 on 0.53 m are 53 each
    const six = await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Run Metres Client', runningMetres: 0.53, pieces: 6 });
    assert.equal(six.status, 201, JSON.stringify(six.body));
    assert.equal(six.body.order.totals.grandTotal, 318);
    // below the recommended price: a manager has to approve; nothing is below nothing, though
    const lower = await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Run Metres Client', runningMetres: 0.53, pieces: 2, pricePerPiece: 120 });
    assert.equal(lower.status, 201, JSON.stringify(lower.body));
    assert.equal(lower.body.approval, 'Pending');
    assert.equal(lower.body.order.totals.grandTotal, 240);
    assert.equal((await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'x', runningMetres: 0.53, pieces: 2, pricePerPiece: 0 })).status, 400);
    // above it is allowed
    const higher = await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Run Metres Client', runningMetres: 0.53, pieces: 2, pricePerPiece: 200 });
    assert.equal(higher.status, 201);
    assert.equal(higher.body.approval, null);
  });

  it('a sheet is judged against the same total: the rows may price artworks differently but not add up to less than 318', () => {
    const rows = (a: number, b: number) => [{ client: 'A', phone: '', label: 'big', qty: 1, price: a }, { client: 'B', phone: '', label: 'small', qty: 1, price: b }];
    const ok = sheetCalc(rows(250, 68), 0.53, 600, 0, '', '', 2);
    assert.equal(ok.recommendedTotal, 318);
    assert.equal(ok.recommendedPerPiece, 159);
    assert.equal(ok.ok, true, ok.problems.join('; '));
    const short = sheetCalc(rows(200, 100), 0.53, 600, 0, '', '', 2);
    assert.equal(short.ok, false);
    assert.match(short.problems.join(' '), /below the recommended total of 318/);
  });

  it('the price per running metre has its own place: only a DTF manager changes it, the next order uses it, and the change is on record', async () => {
    assert.equal((await call('printer', 'PUT', '/dtf/artwork-rate', { product: 'uv', pricePerMetre: 700 })).status, 403);
    assert.equal((await call('lead', 'PUT', '/dtf/artwork-rate', { product: 'uv', pricePerMetre: 0 })).status, 400);
    assert.equal((await call('lead', 'PUT', '/dtf/artwork-rate', { product: 'uv' })).status, 400);
    const r = await call('lead', 'PUT', '/dtf/artwork-rate', { product: 'uv', pricePerMetre: 700 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.pricePerMetre, r.body.previous], [700, 600]);
    const d = (await call('lead', 'GET', '/dtf/data?product=uv')).body;
    assert.equal(d.settings.fixedChargePerMetre, 700);
    assert.equal(d.settings.minPricePerPiece, 0); // the rest of the setup is untouched
    // the next artwork order is worked out from it: 700 × 0.5 ÷ 2 = 175 each
    const job = await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Rate Client', runningMetres: 0.5, pieces: 2 });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    assert.equal(job.body.order.totals.grandTotal, 350);
    // DTF's own price is not touched by a UV change
    assert.notEqual((await call('lead', 'GET', '/dtf/data')).body.settings.fixedChargePerMetre, 700);
    // who set what is on record (the audit log is written just after the response)
    let hist: any[] = [];
    for (let i = 0; i < 20 && hist.length === 0; i++) {
      hist = (await call('lead', 'GET', '/dtf/artwork-rate/history?product=uv')).body;
      if (hist.length === 0) await new Promise((x) => setTimeout(x, 100));
    }
    assert.deepEqual([hist[0].pricePerMetre, hist[0].by], [700, 'lead (run metres test)']);
    assert.equal((await call('printer', 'GET', '/dtf/artwork-rate/history?product=uv')).status, 403);
  });

  it('UV DTF has a base price of 40: an artwork whose share of the film is under 40 is recommended at 40; the small-share price cannot be set below the lowest price or the share it applies to', async () => {
    assert.equal((await call('lead', 'PUT', '/dtf/settings?product=uv', setup({ minPricePerPiece: 30, smallShareBelow: 40, smallSharePrice: 20 }))).status, 400);
    assert.equal((await call('lead', 'PUT', '/dtf/settings?product=uv', setup({ minPricePerPiece: 30, smallShareBelow: 50, smallSharePrice: 40 }))).status, 400);
    assert.equal((await call('lead', 'PUT', '/dtf/settings?product=uv', setup({ minPricePerPiece: 30, smallShareBelow: 40, smallSharePrice: 40 }))).status, 200);
    // 600 × 0.53 ÷ 30 = 10.60 each is under 30, so 40 each: 1,200 in all
    const small = await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Small Client', runningMetres: 0.53, pieces: 30 });
    assert.equal(small.status, 201, JSON.stringify(small.body));
    assert.equal(small.body.order.totals.grandTotal, 1200);
    assert.equal(small.body.approval, null);
    // the job reads back at 40 each — nothing counted as above or below the recommendation
    const job = await prisma.dtfArtworkJob.findFirstOrThrow({ where: { orderId: small.body.order.id } });
    const sys = systemJobCalc({ ...job, minPricePerPieceAtJob: job.minPricePerPieceAtJob, jobOn: job.jobOn } as any);
    assert.equal(sys.finalPerPiece, 40);
    // under the recommended 40 (but not under 30) waits for a manager; under the lowest price is refused
    const lower = await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Small Client', runningMetres: 0.53, pieces: 30, pricePerPiece: 35 });
    assert.equal(lower.status, 201, JSON.stringify(lower.body));
    assert.equal(lower.body.approval, 'Pending');
    assert.equal((await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'x', runningMetres: 0.53, pieces: 30, pricePerPiece: 25 })).status, 400);
    // a share of 40 or more is left alone: 600 × 0.53 ÷ 6 = 53; just under (÷ 8 = 39.75) is brought up to the base price of 40
    const fine = await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Small Client', runningMetres: 0.53, pieces: 6 });
    assert.equal(fine.body.order.totals.grandTotal, 318);
    const base = await call('printer', 'POST', '/dtf/jobs', { rollId: ROLL, client: 'Small Client', runningMetres: 0.53, pieces: 8 });
    assert.equal(base.body.order.totals.grandTotal, 320);
    // a sheet: 30 artworks on 0.53 m must add up to 1,200, not 318
    const rows = (price: number) => [{ client: 'A', phone: '', label: 'tiny', qty: 30, price }];
    const low = await call('printer', 'POST', '/dtf/sheets', { rollId: ROLL, runningMetres: 0.53, pieces: 30, rows: rows(35) });
    assert.equal(low.status, 400);
    assert.match(low.body.error, /below the recommended total of 1200/);
    const ok = await call('printer', 'POST', '/dtf/sheets', { rollId: ROLL, runningMetres: 0.53, pieces: 30, rows: rows(40) });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.recommendedTotal, 1200);

    // the report of approved price changes: the 35 that waited for a manager is listed once a manager approves it (not the person who asked)
    const waiting = (await call('lead', 'GET', '/dtf/approvals?product=uv')).body.find((a: any) => a.orderNo === lower.body.order.orderNo);
    assert.equal(waiting.status, 'Pending');
    assert.equal((await call('printer', 'POST', `/dtf/approvals/${waiting.id}/approve`, {})).status, 403);
    const before = (await call('lead', 'GET', '/dtf/approvals/report?product=uv')).body;
    assert.ok(!before.rows.some((r: any) => r.orderNo === waiting.orderNo)); // not before it is approved
    assert.equal((await call('lead2', 'POST', `/dtf/approvals/${waiting.id}/approve`, {})).status, 200);
    const rep = (await call('lead', 'GET', '/dtf/approvals/report?product=uv')).body;
    const mine = rep.rows.find((r: any) => r.orderNo === waiting.orderNo);
    assert.ok(mine);
    assert.deepEqual([mine.systemPerPiece, mine.chargedPerPiece, mine.pieces, mine.shortfall, mine.status, mine.requestedByName, mine.decidedByName], [40, 35, 30, 150, 'Approved', 'printer (run metres test)', 'lead2 (run metres test)']);
    assert.ok(mine.requestedAt && mine.decidedAt);
    assert.equal(rep.count, rep.rows.length);
    // by date; the DTF report does not show UV ones; managers only
    const today = todayStr();
    assert.equal((await call('lead', 'GET', '/dtf/approvals/report?product=uv&from=2000-01-01&to=2000-01-02')).body.count, 0);
    assert.ok((await call('lead', 'GET', `/dtf/approvals/report?product=uv&from=${today}&to=${today}`)).body.rows.some((r: any) => r.orderNo === waiting.orderNo));
    assert.ok(!(await call('lead', 'GET', '/dtf/approvals/report')).body.rows.some((r: any) => r.orderNo === waiting.orderNo));
    assert.equal((await call('printer', 'GET', '/dtf/approvals/report?product=uv')).status, 403);
  });
});
