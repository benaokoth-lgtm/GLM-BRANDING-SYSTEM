// UV DTF: the same tracker as DTF with its own rolls and settings. A 30 cm × 50 m roll of two films (A printing, B laminating); film sold at KES 1,500 a metre (VAT included) with a
// floor of 1,200; artwork at 30 a piece plus 1,070 a running metre shared across the pieces (107 pieces on a metre = 40 each); no heat press fee; the same commission as DTF.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UV_DTF_SETTINGS, VAT_RATE, filmPremiumCommission, jobCalc, summariseRoll, todayStr } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';
import { ensureChartOfAccounts } from '../src/accounting/chart';

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};
const period = todayStr().slice(0, 7);

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const uvData = async () => (await call('lead', 'GET', '/dtf/data?product=uv')).body;
const dtfData = async () => (await call('lead', 'GET', '/dtf/data')).body;

describe('UV DTF film and artwork', () => {
  let roll = '';
  before(async () => {
    await prisma.role.create({ data: { name: 'Printer (uv test)', canAccessDtf: true, canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Lead (uv test)', canAccessDtf: true, canManageDtf: true, canCaptureOrders: true, canManageCommission: true } });
    for (const [key, role] of [['printer', 'Printer (uv test)'], ['lead', 'Lead (uv test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (uv test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: true }, create: { id: 1, enabled: true } });
    await ensureChartOfAccounts();
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('starts from the UV settings: a 30 cm × 50 m roll, 1,500 a metre, floor 1,200, artwork 30 a piece + 1,070 a metre', async () => {
    const d = await uvData();
    assert.equal(d.product, 'uv');
    assert.deepEqual(d.settings, UV_DTF_SETTINGS);
    assert.deepEqual([d.settings.rollLengthM, d.settings.rollWidthCm, d.settings.stdPricePerM, d.settings.minPricePerM, d.settings.minPricePerPiece, d.settings.fixedChargePerMetre], [50, 30, 1500, 1200, 30, 1070]);
    // DTF keeps its own
    assert.equal((await dtfData()).settings.stdPricePerM, 500);
    // the artwork charge: 107 pieces on a metre come to 40 each, 4,280 in all
    const c = jobCalc(1, 107, d.settings.fixedChargePerMetre, d.settings.minPricePerPiece);
    assert.deepEqual([c.finalPerPiece, c.jobTotal], [40, 4280]);
  });

  it('a roll is two films: A (printing) and B (laminating); UV rolls and DTF rolls are kept apart', async () => {
    const r = await call('lead', 'POST', '/dtf/rolls', { product: 'uv', filmCost: 6500, inkPowderCost: 4500 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.id, /^UV-\d{3}$/);
    assert.deepEqual([r.body.product, r.body.rollLengthM, r.body.filmCost, r.body.inkPowderCost], ['uv', 50, 6500, 4500]);
    roll = r.body.id;
    const d = await uvData();
    assert.ok(d.rolls.some((x: any) => x.id === roll));
    assert.ok(!(await dtfData()).rolls.some((x: any) => x.id === roll)); // not among the DTF rolls
    const sum = summariseRoll(d.settings, d.rolls.find((x: any) => x.id === roll), d.sales, d.jobs);
    assert.equal(sum.rollCost, 11000); // 220 a metre
    // a DTF roll installed meanwhile does not take a UV number
    const dtfRoll = await call('lead', 'POST', '/dtf/rolls', { filmCost: 5000, inkPowderCost: 1000 });
    assert.match(dtfRoll.body.id, /^ROLL-\d{3}$/);
    // a part-used UV roll: 20 of the 50 m left carries 40% of each film's cost
    const part = await call('lead', 'POST', '/dtf/rolls', { product: 'uv', filmCost: 6500, inkPowderCost: 4500, metresLeft: 20 });
    assert.deepEqual([part.body.rollLengthM, part.body.carriedInUsedM, part.body.filmCost, part.body.inkPowderCost], [20, 30, 2600, 1800]);
  });

  it('a film sale is at 1,500 a metre with a floor of 1,200, in its own order series and line of business', async () => {
    const cheap = await call('printer', 'POST', '/dtf/sales', { rollId: roll, client: 'UV Client', metres: 2, pricePerM: 1199 });
    assert.equal(cheap.status, 400);
    assert.match(cheap.body.error, /cannot be below 1200/);
    const sale = await call('printer', 'POST', '/dtf/sales', { rollId: roll, client: 'UV Client', metres: 3, amountPaid: 4500 });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    assert.match(sale.body.order.orderNo, /^U-\d{4}$/);
    assert.equal(sale.body.order.totals.grandTotal, 4500); // 3 m at 1,500
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'UV DTF Sheet (per metre)' }, include: { businessHead: true } });
    assert.deepEqual([service.soldViaDtfModule, service.unit, service.price, service.businessHead?.name], [true, 'metre', 1500, 'UV DTF Printing']);
    const atFloor = await call('printer', 'POST', '/dtf/sales', { rollId: roll, client: 'UV Client', metres: 1, pricePerM: 1200 });
    assert.equal(atFloor.status, 201);
    // the same film commission table as DTF, measured above the UV floor of 1,200
    const stmt = (await call('lead', 'GET', `/commission/statement?period=${period}`)).body.statements.find((s: any) => s.staffId === ids.printer);
    const bands = (await call('lead', 'GET', '/commission/settings')).body.filmBands; // whatever the film table is now — the same one DTF uses
    const expected = Math.round(filmPremiumCommission(3, 1500, 1200, bands, VAT_RATE) * 100) / 100;
    assert.ok(expected > 0);
    assert.ok(Math.abs(stmt.film.commission - expected) < 0.02, `${stmt.film.commission} vs ${expected}`);
  });

  it('artwork: 30 a piece plus 1,070 a running metre; 107 pieces on a metre are 40 each; no heat press fee; below the recommended price needs approval', async () => {
    const job = await call('printer', 'POST', '/dtf/jobs', { rollId: roll, client: 'UV Art Client', runningMetres: 1, pieces: 107, amountPaid: 4280 });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    assert.match(job.body.order.orderNo, /^U-\d{4}$/);
    assert.equal(job.body.order.totals.grandTotal, 4280);
    assert.equal(job.body.approval, null);
    assert.equal((await prisma.service.findFirstOrThrow({ where: { name: 'UV DTF Printing' } })).chargesPressingFee, false);
    // fewer pieces on the metre cost more each, more cost less (never below 30)
    const few = jobCalc(1, 20, 1070, 30).finalPerPiece;
    const many = jobCalc(1, 400, 1070, 30).finalPerPiece;
    assert.ok(few > 83 && many < 33 && many > 30);

    // a price under the floor of 30 is refused; under the recommended price it waits for a manager
    const under = await call('printer', 'POST', '/dtf/jobs', { rollId: roll, client: 'UV Art Client', runningMetres: 1, pieces: 107, pricePerPiece: 29 });
    assert.equal(under.status, 400);
    assert.match(under.body.error, /minimum of 30/);
    const lower = await call('printer', 'POST', '/dtf/jobs', { rollId: roll, client: 'UV Art Client', runningMetres: 1, pieces: 107, pricePerPiece: 35 });
    assert.equal(lower.status, 201, JSON.stringify(lower.body));
    assert.equal(lower.body.approval, 'Pending');
    assert.equal((await call('printer', 'POST', '/dtf/jobs', { rollId: roll, client: 'x', runningMetres: 1, pieces: 107, pricePerPiece: 35, amountPaid: 100 })).status, 400); // no payment before it is approved

    // approvals and the counts are kept per product
    const uvApprovals = (await call('lead', 'GET', '/dtf/approvals?product=uv')).body;
    assert.ok(uvApprovals.some((a: any) => a.orderNo === lower.body.order.orderNo));
    assert.ok(!(await call('lead', 'GET', '/dtf/approvals')).body.some((a: any) => a.orderNo === lower.body.order.orderNo));
    assert.ok((await uvData()).pendingApprovals >= 1);
  });

  it('DTF still needs its heat press fee, and the day-by-day lists are per product', async () => {
    const dtfRoll = (await dtfData()).rolls.find((r: any) => r.status === 'open');
    const noFee = await call('printer', 'POST', '/dtf/jobs', { rollId: dtfRoll.id, client: 'DTF Client', runningMetres: 1, pieces: 54 });
    assert.equal(noFee.status, 400);
    assert.match(noFee.body.error, /heat press fee/);
    const uvSales = (await call('lead', 'GET', '/dtf/daily?kind=sales&product=uv')).body.days.flatMap((d: any) => d.orders);
    assert.ok(uvSales.length >= 2 && uvSales.every((o: any) => /^UV-/.test(o.rollId)));
    const dtfSales = (await call('lead', 'GET', '/dtf/daily?kind=sales')).body.days.flatMap((d: any) => d.orders);
    assert.ok(dtfSales.every((o: any) => !/^UV-/.test(o.rollId)));
  });
});
