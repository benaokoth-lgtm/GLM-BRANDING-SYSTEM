// A sheet of artworks of different sizes, perhaps for different clients, on one length of film: the sales person prices each size, the rows must add up to at least the recommended total for
// the whole length (the cost shared by NUMBER of artworks), each client gets their own order, the film is taken once, and commission is on what the sheet brings in above the recommendation.
// (Named z… because it records orders.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jobExtras, sheetCalc, sheetClientKey } from '@glm/shared';
import type { DtfArtworkJob } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { buildStatements } from '../src/commission';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
const ROLL = 'ROLL-SHEET';
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const row = (client: string, label: string, qty: number, price: number) => ({ client, phone: '', label, qty, price });
const sheet = (extra: Record<string, unknown>) => call('printer', 'POST', '/dtf/sheets', { rollId: ROLL, runningMetres: 3, heatPressFee: 20, ...extra });

// DTF defaults: 30 minimum a piece, 2,160 a metre. 3 m over 140 artworks: 30 + 6,480 ÷ 140 = 76.29 each, 10,680 in all.
describe('artwork sheets', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Printer (sheet test)', canAccessDtf: true, canCaptureOrders: true } });
    const u = await prisma.user.create({ data: { name: 'printer (sheet test)', role: 'Printer (sheet test)', pinHash: 'x' } });
    ids.printer = u.id;
    tokens.printer = signToken({ id: u.id, name: u.name, role: 'Printer (sheet test)' });
    await prisma.service.create({ data: { name: 'DTF Printing', unit: 'piece', price: 70 } }).catch(() => null);
    await prisma.dtfRoll.create({ data: { id: ROLL, installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100, filmCost: 6000, inkPowderCost: 4000 } });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('works out the recommended total for the whole length, and shares the film by number of artworks', () => {
    const c = sheetCalc([row('Client A', '5 × 5 cm', 100, 50), row('Client B', '15 × 20 cm', 40, 160)], 3, 2160, 30);
    assert.equal(c.ok, true, c.problems.join('; '));
    assert.deepEqual([c.pieces, c.recommendedPerPiece, c.recommendedTotal, c.enteredTotal, c.surplus], [140, 76.29, 10680, 11400, 720]);
    const [a, b] = c.clients;
    assert.deepEqual([a!.pieces, a!.metres, a!.amount, a!.fairShare, a!.pctOfFairShare], [100, 2.143, 5000, 7628.57, 65.54]); // A pays less than their share…
    assert.deepEqual([b!.pieces, b!.metres, b!.amount, b!.fairShare], [40, 0.857, 6400, 3051.43]); // …and B more
    assert.equal(a!.metres + b!.metres, 3); // the film adds up to the metres entered
    // rows with no client belong to the sheet's own client; one client in two rows is one order
    const same = sheetCalc([row('', 'small', 10, 80), row('', 'large', 10, 120), row('Other', 'x', 5, 90)], 1, 2160, 30, 'Walk-in');
    assert.deepEqual(same.clients.map((x) => [x.client, x.pieces]), [['Walk-in', 20], ['Other', 5]]);
    assert.equal(sheetClientKey('Hope  Chapel', ''), sheetClientKey('hope chapel', ''));
    assert.equal(sheetClientKey('A', '0711 223 344'), sheetClientKey('B', '0711223344')); // a phone number tells the same client
  });

  it('refuses a sheet below the recommended total, a price under the minimum, and rows that are not artworks', () => {
    const low = sheetCalc([row('A', 'a', 100, 40), row('B', 'b', 40, 150)], 3, 2160, 30); // 10,000 against 10,680
    assert.equal(low.ok, false);
    assert.match(low.problems[0]!, /680 below the recommended total of 10680/);
    assert.match(sheetCalc([row('A', 'a', 10, 25)], 1, 2160, 30).problems.join(), /below the minimum of 30/);
    assert.match(sheetCalc([row('A', 'a', 0, 90)], 1, 2160, 30).problems.join(), /how many artworks/);
    assert.match(sheetCalc([], 1, 2160, 30).problems.join(), /at least one row/);
    assert.match(sheetCalc([row('A', 'a', 10, 500)], 0, 2160, 30).problems.join(), /running metres/);
    assert.equal(sheetCalc([row('A', 'a', 10, 500)], 1, 2160, 30).ok, true); // exactly at, or above, is fine
    // the artworks on the length, as entered beside the metres, are the artworks the rows must add up to
    const rows = [row('A', 'a', 100, 60), row('B', 'b', 40, 160)];
    assert.equal(sheetCalc(rows, 3, 2160, 30, '', '', 140).ok, true);
    assert.match(sheetCalc(rows, 3, 2160, 30, '', '', 150).problems[0]!, /add up to 140 artworks but the length has 150 — 10 still to place/);
    assert.match(sheetCalc(rows, 3, 2160, 30, '', '', 130).problems[0]!, /but the length has 130 — 10 too many/);
    assert.equal(sheetCalc(rows, 3, 2160, 30, '', '', 0).ok, true); // not given: the rows say how many there are
  });

  it('on a sheet the clients are judged together: only what the sheet earns above the recommendation counts, shared by what each was charged', () => {
    const job = (id: string, pieces: number, metres: number, total: number): DtfArtworkJob => ({ id, rollId: 'R', jobOn: '2026-10-01', client: id, runningMetres: metres, pieces, fixedChargePerMetreAtJob: 2160, minPricePerPieceAtJob: 30, chargedTotal: total, sheetId: 'S' });
    const x = jobExtras([job('a', 100, 2.143, 5000), job('b', 40, 0.857, 6400)]);
    const ex = (id: string) => x.get(id)!;
    assert.equal(ex('a').short, 0); // A paid under their share, but the sheet is above the recommendation
    assert.equal(Math.round((ex('a').excess + ex('b').excess) * 10) / 10, 720);
    assert.ok(ex('b').excess > ex('a').excess);
    // a job on its own is judged on its own price, as before
    const solo: DtfArtworkJob = { id: 's', rollId: 'R', jobOn: '2026-10-01', client: 's', runningMetres: 2, pieces: 108, fixedChargePerMetreAtJob: 2160, minPricePerPieceAtJob: 30, chargedPerPiece: 80 };
    assert.deepEqual(jobExtras([solo]).get('s'), { excess: 1080, short: 0 }); // 108 × (80 − 70)
    assert.deepEqual(jobExtras([{ ...solo, chargedPerPiece: 60 }]).get('s'), { excess: 0, short: 1080 });
  });

  it('records one order per client with a line for each size, takes the film once, and nobody waits for approval', async () => {
    const r = await sheet({
      rows: [row('Client A', '5 × 5 cm', 100, 50), row('Client B', '15 × 20 cm', 40, 160)],
      clientPayments: [{ key: sheetClientKey('Client A', ''), payments: [{ method: 'Cash', amount: 7000 }] }, { key: sheetClientKey('Client B', ''), payments: [{ method: 'Cash', amount: 7200 }] }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.orders.length, r.body.recommendedTotal, r.body.enteredTotal, r.body.surplus], [2, 10680, 11400, 720]);
    const [a, b] = r.body.orders;
    assert.deepEqual([a.customerName, a.totals.grandTotal, a.totals.balanceDue, a.priceApproval], ['Client A', 7000, 0, null]); // 100 × (50 + 20 heat press)
    assert.deepEqual([b.customerName, b.totals.grandTotal, b.totals.balanceDue, b.priceApproval], ['Client B', 7200, 0, null]); // 40 × (160 + 20)
    assert.match(a.lineItems[0].serviceName, /5 × 5 cm/);
    assert.deepEqual([a.lineItems[0].qty, a.lineItems[0].unitPrice], [100, 50]);
    // the film: the metres entered, once
    const jobs = await prisma.dtfArtworkJob.findMany({ where: { sheetId: r.body.sheetId }, orderBy: { id: 'asc' } });
    assert.deepEqual(jobs.map((j) => [j.client, j.pieces, j.approvalStatus]), [['Client A', 100, 'Approved'], ['Client B', 40, 'Approved']]);
    assert.equal(Math.round(jobs.reduce((s, j) => s + j.runningMetres, 0) * 1000) / 1000, 3);
    assert.deepEqual(jobs.map((j) => j.chargedTotal), [5000, 6400]);
    assert.equal((await prisma.priceApproval.count({ where: { orderNo: { in: [a.orderNo, b.orderNo] } } })), 0);
    // the commission of the sales person is on what the sheet earned above the recommendation (720), not on each client's own premium
    const month = new Date().toISOString().slice(0, 7);
    const st = (await buildStatements(month)).statements.find((s) => s.staffId === ids.printer);
    assert.ok(st);
    assert.ok(Math.abs(st!.artwork.commission - 310.34) < 0.05, `commission ${st!.artwork.commission}`); // 720 ÷ 1.16 × 50%
  });

  it('refuses what the sheet may not be: below the total, under the minimum, no heat press fee', async () => {
    const rows = [row('Client A', '5 × 5 cm', 100, 40), row('Client B', '15 × 20 cm', 40, 150)];
    const low = await sheet({ rows });
    assert.equal(low.status, 400);
    assert.match(low.body.error, /below the recommended total/);
    assert.equal((await sheet({ rows: [row('A', 'x', 10, 25)] })).status, 400);
    const placed = await sheet({ pieces: 150, rows: [row('Client A', '5 × 5 cm', 100, 60), row('Client B', '15 × 20 cm', 40, 160)] });
    assert.equal(placed.status, 400);
    assert.match(placed.body.error, /10 still to place/);
    const noFee = await call('printer', 'POST', '/dtf/sheets', { rollId: ROLL, runningMetres: 3, rows: [row('A', 'x', 10, 900)] });
    assert.equal(noFee.status, 400);
    assert.match(noFee.body.error, /heat press fee/);
    // a client cannot pay more than their own order
    const over = await sheet({ rows: [row('A', 'x', 10, 900)], clientPayments: [{ key: sheetClientKey('A', ''), payments: [{ method: 'Cash', amount: 99999 }] }] });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /cannot exceed/);
    assert.equal((await call('printer', 'POST', '/dtf/sheets', { rollId: 'NOPE', runningMetres: 3, heatPressFee: 20, rows: [row('A', 'x', 10, 900)] })).status, 400);
  });

  it('one client with several sizes is one order with a line each (the single-client case)', async () => {
    // 1.5 m over 60 artworks: 30 + 3,240 ÷ 60 = 84 each, 5,040 in all
    const r = await sheet({ runningMetres: 1.5, pieces: 60, client: 'Hope Chapel', rows: [row('', 'small', 50, 60), row('', 'large', 10, 250)] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.orders.length, 1);
    const o = r.body.orders[0];
    assert.deepEqual([o.customerName, o.lineItems.length, o.totals.grandTotal], ['Hope Chapel', 2, 5500 + 60 * 20]);
    assert.deepEqual(o.lineItems.map((l: any) => [l.qty, l.unitPrice]), [[50, 60], [10, 250]]);
  });
});
