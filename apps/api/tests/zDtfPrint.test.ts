// The DTF artwork order as a priced list: the length of film used (the only film figure tracked), and rows of client / description / how many / price of one artwork (the print only) and, for DTF, the
// heat press and the garment (the client's own, or ours from stock). There is no recommended price — the sales person's prices are the prices. (Named z… because it records orders.)
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
const row = (client: string, label: string, qty: number, price: number, press = 10, garmentMaterialId: number | null = null) => ({ client, phone: '', label, qty, price, press, garmentMaterialId });
// the same row for the calculation (garmentPrice is the stock price list's)
const calcRow = (client: string, label: string, qty: number, price: number, press = 10, garmentId: number | null = null, garmentPrice = 0) => ({ client, phone: '', label, qty, price, press, garmentId, garmentPrice });

describe('DTF artwork prints: priced rows, film tracked by the length used', () => {
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

  it('works the rows out: totals, and each client’s share of the film by their number of artworks', () => {
    const c = artworkListCalc([calcRow('A', '', 20, 45, 0), calcRow('B', '', 50, 30, 0), calcRow('A', '', 4, 120, 0)], 1.2, '', '', false);
    assert.equal(c.ok, true, c.problems.join('; '));
    assert.deepEqual([c.pieces, c.enteredTotal], [74, 2880]);
    assert.deepEqual(c.clients.map((x) => [x.client, x.amount, x.pieces, x.metres]), [['A', 1380, 24, 0.389], ['B', 1500, 50, 0.811]]);
    assert.equal(Math.round(c.clients.reduce((a, x) => a + x.metres, 0) * 1000) / 1000, 1.2); // the shares add up to the length exactly
    // checks: the length of film, how many and a price — no size is asked for
    assert.match(artworkListCalc([calcRow('', '', 1, 10)], 0).problems[0]!, /length of film/);
    assert.match(artworkListCalc([calcRow('', '', 1, 0)], 1).problems[0]!, /price/);
    assert.match(artworkListCalc([calcRow('', '', 0, 10)], 1).problems[0]!, /how many/);
    // DTF: every artwork is pressed, so a row needs the heat press price; the garment is ours (and priced from the stock list) or the client's own
    assert.match(artworkListCalc([calcRow('', '', 1, 10, 0)], 1).problems[0]!, /heat press price/);
    const g = artworkListCalc([calcRow('A', '', 4, 45, 15, 7, 600), calcRow('A', '', 2, 45, 15)], 1);
    assert.deepEqual([g.enteredTotal, g.clients[0]!.artworkAmount, g.clients[0]!.pressAmount, g.clients[0]!.garmentAmount], [4 * 660 + 2 * 60, 270, 90, 2400]);
    // UV DTF is applied cold: no heat press and no garment
    assert.match(artworkListCalc([calcRow('', '', 1, 10, 5)], 1, '', '', false).problems[0]!, /applied cold/);
  });

  it('records one order a client with the artwork, the heat press and (when ours) the garment as separate lines, takes the garment from stock, and draws the film once', async () => {
    const polo = (await prisma.material.create({ data: { name: 'Polo Shirt L (print test)', price: 600, stockQty: 10 } })).id;
    const r = await call('seller', 'POST', '/dtf/prints', {
      rollId: 'ROLL-PRT',
      runningMetres: 1.2,
      rows: [row('Print A', 'left chest', 20, 45, 15), row('Print B', '', 50, 30, 10, polo), row('Print A', 'back', 4, 120, 15)],
      clientPayments: [],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.orders.length, 2);
    const a = r.body.orders.find((o: any) => o.customerName === 'Print A');
    // Print A brought their own garments: the print and the press only — 20 × (45 + 15) + 4 × (120 + 15)
    assert.equal(a.totals.grandTotal, 20 * 60 + 4 * 135);
    assert.deepEqual(a.lineItems.map((l: any) => [l.qty, l.unitPrice, l.serviceName]), [
      [20, 45, 'DTF Printing — left chest'],
      [20, 15, 'DTF Heat Press — left chest on the client’s own garment'],
      [4, 120, 'DTF Printing — back'],
      [4, 15, 'DTF Heat Press — back on the client’s own garment'],
    ]);
    // Print B used our garments: one polo for each of the 50 artworks, at the stock price list's price
    const b = r.body.orders.find((o: any) => o.customerName === 'Print B');
    assert.equal(b.totals.grandTotal, 50 * (30 + 10 + 600));
    assert.deepEqual(b.lineItems.map((l: any) => [l.qty, l.unitPrice, l.serviceName ?? l.materialName]), [
      [50, 30, 'DTF Printing'],
      [50, 10, 'DTF Heat Press — on our Polo Shirt L (print test)'],
      [50, 600, 'Polo Shirt L (print test)'],
    ]);
    // the stock left the shelf with the order (only Print B's garments)
    assert.equal((await prisma.material.findUniqueOrThrow({ where: { id: polo } })).stockQty, 10 - 50);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).stockTaken, true);
    // the film's own revenue is the artworks only; the film comes off the roll once, as the length entered, shared by number of artworks
    const data = (await call('admin', 'GET', '/dtf/data?product=dtf')).body;
    const jobs = data.jobs.filter((j: any) => j.sheetId === r.body.sheetId);
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs.map((j: any) => j.chargedTotal).sort((x: number, y: number) => x - y), [900 + 480, 1500]);
    assert.equal(Math.round(jobs.reduce((x: number, j: any) => x + j.runningMetres, 0) * 1000) / 1000, 1.2);
    assert.ok(jobs.every((j: any) => j.pricedBySales && j.approvalStatus === 'Approved'));
    // nothing was recommended, so nothing is earned above it and nothing is given away below it
    const asJobs = jobs.map((j: any) => ({ ...j, id: String(j.id) }));
    for (const x of jobExtras(asJobs).values()) assert.deepEqual(x, { excess: 0, short: 0 });
    assert.equal(systemJobCalc(asJobs[0]).jobTotal, asJobs[0].chargedTotal);
    // no heat press price: refused; a stock item that is not on the list: refused
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'ROLL-PRT', runningMetres: 1, rows: [row('Z', '', 1, 45, 0)] })).status, 400);
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'ROLL-PRT', runningMetres: 1, rows: [row('Z', '', 1, 45, 10, 99999999)] })).status, 400);
  });

  it('needs no size: a row is a count and a price; a missing roll or no rows is refused; UV DTF has no heat press', async () => {
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'ROLL-PRT', runningMetres: 1, rows: [row('X', '', 3, 10)] })).status, 201);
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'ROLL-NOPE', runningMetres: 1, rows: [row('X', '', 1, 10)] })).status, 400);
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'ROLL-PRT', runningMetres: 1, rows: [] })).status, 400);
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'ROLL-PRT', runningMetres: 0, rows: [row('X', '', 1, 10)] })).status, 400); // the length of film is what is tracked
    assert.equal((await call('seller', 'POST', '/dtf/prints', { rollId: 'UV-PRT', runningMetres: 1, rows: [row('X', '', 1, 10, 0)] })).status, 201);
    // the press is ignored for UV (nothing is charged for it)
    const uv = await call('seller', 'POST', '/dtf/prints', { rollId: 'UV-PRT', runningMetres: 1, rows: [row('X', '', 2, 10, 5)] });
    assert.equal(uv.status, 201);
    assert.equal(uv.body.orders[0].totals.grandTotal, 20);
  });

  it('the Film layout report is gone', async () => {
    assert.equal((await call('admin', 'GET', '/dtf/layout?product=dtf')).status, 404);
  });
});
