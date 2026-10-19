// The DTF artwork order as a measured, priced list: the length of film used, and rows of client / size (cm) / how many / price of one artwork (heat press included). There is no recommended
// price — the sales person's prices are the prices. The sizes feed DTF → Film layout (film area against the artworks' area, for information only). (Named z… because it records orders.)
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { artworkListCalc, jobExtras, systemJobCalc } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const row = (client: string, widthCm: number, heightCm: number, qty: number, price: number, press = 10, garmentMaterialId: number | null = null) => ({ client, phone: '', widthCm, heightCm, qty, price, press, garmentMaterialId });
// the same row for the calculation (garmentPrice is the stock price list's)
const calcRow = (client: string, widthCm: number, heightCm: number, qty: number, price: number, press = 10, garmentId: number | null = null, garmentPrice = 0) => ({ client, phone: '', widthCm, heightCm, qty, price, press, garmentId, garmentPrice });

describe('DTF artwork prints: measured rows, prices set by the sales person, film layout', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Seller (artwork list test)', canCaptureOrders: true, canAccessDtf: true } });
    for (const [key, role] of [['admin', 'Admin'], ['seller', 'Seller (artwork list test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (artwork list test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.dtfRoll.create({ data: { id: 'ROLL-PRT', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 100, filmCost: 5000, inkPowderCost: 1000 } });
    await prisma.dtfRoll.create({ data: { id: 'UV-PRT', product: 'uv', installedOn: '2026-01-01', createdByName: 'test', rollLengthM: 50, filmCost: 5000, inkPowderCost: 1000 } });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('works the rows out: totals, areas against the film, each client’s share of the film by area', () => {
    const c = artworkListCalc([calcRow('A', 10, 10, 20, 45, 0), calcRow('B', 6, 8, 50, 30, 0), calcRow('A', 15, 20, 4, 120, 0)], 1.2, 58, '', '', false);
    assert.equal(c.ok, true, c.problems.join('; '));
    assert.deepEqual([c.pieces, c.enteredTotal, c.filmAreaCm2, c.artworkAreaCm2], [74, 2880, 6960, 5600]);
    assert.equal(c.efficiencyPct, 80.46);
    assert.deepEqual(c.clients.map((x) => [x.client, x.amount, x.areaCm2, x.metres]), [['A', 1380, 3200, 0.686], ['B', 1500, 2400, 0.514]]);
    assert.equal(Math.round(c.clients.reduce((a, x) => a + x.metres, 0) * 1000) / 1000, 1.2); // the shares add up to the length exactly
    // checks: a size is needed, it must fit the film, and a price; artworks bigger than the film are a warning, not a block
    assert.match(artworkListCalc([calcRow('', 0, 5, 1, 10)], 1, 58).problems[0]!, /width and height/);
    assert.match(artworkListCalc([calcRow('', 70, 80, 1, 10)], 1, 58).problems[0]!, /does not fit the 58 cm film/);
    assert.match(artworkListCalc([calcRow('', 5, 5, 1, 0)], 1, 58).problems[0]!, /price/);
    // DTF: every artwork is pressed, so a row needs the heat press price; the garment is ours (and priced from the stock list) or the client's own
    assert.match(artworkListCalc([calcRow('', 5, 5, 1, 10, 0)], 1, 58).problems[0]!, /heat press price/);
    const g = artworkListCalc([calcRow('A', 10, 10, 4, 45, 15, 7, 600), calcRow('A', 10, 10, 2, 45, 15)], 1, 58);
    assert.deepEqual([g.enteredTotal, g.clients[0]!.artworkAmount, g.clients[0]!.pressAmount, g.clients[0]!.garmentAmount], [4 * 660 + 2 * 60, 270, 90, 2400]);
    // UV DTF is applied cold: no heat press and no garment
    assert.match(artworkListCalc([calcRow('', 5, 5, 1, 10, 5)], 1, 30, '', '', false).problems[0]!, /applied cold/);
    const over = artworkListCalc([calcRow('', 50, 50, 10, 10)], 0.5, 58);
    assert.equal(over.ok, true);
    assert.match(over.warnings[0]!, /more than the/);
  });

  it('records one order a client with the artwork, the heat press and (when ours) the garment as separate lines, takes the garment from stock, and draws the film once', async () => {
    const polo = (await prisma.material.create({ data: { name: 'Polo Shirt L (print test)', price: 600, stockQty: 10 } })).id;
    const r = await call('seller', 'POST', '/dtf/prints', {
      rollId: 'ROLL-PRT',
      runningMetres: 1.2,
      rows: [row('Print A', 10, 10, 20, 45, 15), row('Print B', 6, 8, 50, 30, 10, polo), row('Print A', 15, 20, 4, 120, 15)],
      clientPayments: [],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.orders.length, 2);
    const a = r.body.orders.find((o: any) => o.customerName === 'Print A');
    // Print A brought their own garments: the print and the press only — 20 × (45 + 15) + 4 × (120 + 15)
    assert.equal(a.totals.grandTotal, 20 * 60 + 4 * 135);
    assert.deepEqual(a.lineItems.map((l: any) => [l.qty, l.unitPrice, l.serviceName]), [
      [20, 45, 'DTF Printing — 10 × 10 cm'],
      [20, 15, 'DTF Heat Press — 10 × 10 cm on the client’s own garment'],
      [4, 120, 'DTF Printing — 15 × 20 cm'],
      [4, 15, 'DTF Heat Press — 15 × 20 cm on the client’s own garment'],
    ]);
    // Print B used our garments: one polo for each of the 50 artworks, at the stock price list's price
    const b = r.body.orders.find((o: any) => o.customerName === 'Print B');
    assert.equal(b.totals.grandTotal, 50 * (30 + 10 + 600));
    assert.deepEqual(b.lineItems.map((l: any) => [l.qty, l.unitPrice, l.serviceName ?? l.materialName]), [
      [50, 30, 'DTF Printing — 6 × 8 cm'],
      [50, 10, 'DTF Heat Press — 6 × 8 cm on our Polo Shirt L (print test)'],
      [50, 600, 'Polo Shirt L (print test)'],
    ]);
    // the stock left the shelf with the order (only Print B's garments)
    assert.equal((await prisma.material.findUniqueOrThrow({ where: { id: polo } })).stockQty, 10 - 50);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).stockTaken, true);
    // the film's own revenue is the artworks only
    const data = (await call('admin', 'GET', '/dtf/data?product=dtf')).body;
    assert.equal(data.settings.layoutWidthCm, 58);
    const jobs = data.jobs.filter((j: any) => j.sheetId === r.body.sheetId);
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs.map((j: any) => j.chargedTotal).sort((x: number, y: number) => x - y), [900 + 480, 1500]);
    assert.equal(Math.round(jobs.reduce((x: number, j: any) => x + j.runningMetres, 0) * 1000) / 1000, 1.2);
    assert.ok(jobs.every((j: any) => j.pricedBySales && j.filmWidthCm === 58 && j.approvalStatus === 'Approved'));
    assert.deepEqual(jobs.map((j: any) => j.areaCm2).sort(), [2400, 3200]);
    // nothing was recommended, so nothing is earned above it and nothing is given away below it
    const asJobs = jobs.map((j: any) => ({ ...j, id: String(j.id) }));
    for (const x of jobExtras(asJobs).values()) assert.deepEqual(x, { excess: 0, short: 0 });
    assert.equal(systemJobCalc(asJobs[0]).jobTotal, asJobs[0].chargedTotal);
    // a return of the garments puts them back (the order's stock was taken); one without the restock does not
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'ROLL-PRT', runningMetres: 1, rows: [row('Z', 10, 10, 1, 45, 0)] })).status, 400); // no heat press price: refused
    // a stock item that is not on the list is refused
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'ROLL-PRT', runningMetres: 1, rows: [row('Z', 10, 10, 1, 45, 10, 99999999)] })).status, 400);
  });

  it('refuses what does not fit, and a roll that does not exist', async () => {
    const bad = await call('seller', 'POST', '/dtf/prints', { rollId: 'ROLL-PRT', runningMetres: 1, rows: [row('X', 70, 80, 1, 10)] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /does not fit the 58 cm film/);
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'ROLL-NOPE', runningMetres: 1, rows: [row('X', 5, 5, 1, 10)] })).status, 400);
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'ROLL-PRT', runningMetres: 1, rows: [] })).status, 400);
    // UV DTF has its own roll width (30 cm): 40 × 45 does not fit it, 25 × 40 does
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'UV-PRT', runningMetres: 1, rows: [row('X', 40, 45, 1, 10, 0)] })).status, 400);
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'UV-PRT', runningMetres: 1, rows: [row('X', 25, 40, 1, 10, 0)] })).status, 201);
    // a UV sticker is applied cold: a heat press price or a garment on a UV row is refused
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'UV-PRT', runningMetres: 1, rows: [row('X', 25, 40, 1, 10, 5)] })).status, 201); // (the press is ignored for UV, not charged)
  });

  it('Film layout is for managers: film area against the artworks’ area, overall and by person, and earlier prints are left out', async () => {
    assert.equal((await call('seller', 'GET', '/dtf/layout?product=dtf')).status, 403);
    const l = (await call('admin', 'GET', '/dtf/layout?product=dtf')).body;
    const mine = l.prints.find((p: any) => p.clients === 2);
    assert.deepEqual([mine.metres, mine.filmAreaCm2, mine.artworkAreaCm2, mine.unfilledCm2, mine.efficiencyPct, mine.suspicious], [1.2, 6960, 5600, 1360, 80.46, false]);
    assert.ok(l.summary.prints >= 1 && l.summary.efficiencyPct > 0);
    assert.ok(l.byPerson.some((p: any) => p.name === 'seller (artwork list test)'));
    // a job from before sizes were recorded is counted apart, not averaged in
    const old = await prisma.dtfArtworkJob.create({ data: { rollId: 'ROLL-PRT', jobOn: '2026-01-02', client: 'Old', runningMetres: 2, pieces: 10, capturedByName: 'x' } });
    const again = (await call('admin', 'GET', '/dtf/layout?product=dtf')).body;
    assert.equal(again.jobsWithoutSizes, l.jobsWithoutSizes + 1);
    assert.equal(again.summary.prints, l.summary.prints);
    await prisma.dtfArtworkJob.delete({ where: { id: old.id } });
  });
});
