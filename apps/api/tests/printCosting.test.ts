// Job Costing → Brochures & Eulogies: the arithmetic from the design handoff, who sees the mark-up, and the rates an Admin keeps.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_PRINT_SETTINGS, printCalc, printMarkupPct, printSettingsProblem, printSpec } from '@glm/shared';
import type { PrintJob } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

const S = DEFAULT_PRINT_SETTINGS;
const eulogy: PrintJob = { product: 'eulogy', pages: 8, paper: 0, cover: 4, coverSep: false, lam: false, fold: true, size: 'A4', sides: 2, qty: 100, mode: 'tier' };
const brochure: PrintJob = { ...eulogy, product: 'brochure', size: 'A4', sides: 2, qty: 500, fold: false };

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('Job Costing: Brochures & Eulogies', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Seller (print test)', canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Finance (print test)', canCaptureOrders: true, canSeeCosts: true } });
    await prisma.role.create({ data: { name: 'Nobody (print test)' } });
    for (const [key, role] of [['seller', 'Seller (print test)'], ['finance', 'Finance (print test)'], ['nobody', 'Nobody (print test)']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (print test)`, role, pinHash: 'x' } });
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    const admin = await prisma.user.findFirst({ where: { role: 'Admin', active: true } });
    const a = admin ?? (await prisma.user.create({ data: { name: 'admin (print test)', role: 'Admin', pinHash: 'x' } }));
    tokens.admin = signToken({ id: a.id, name: a.name, role: 'Admin' });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await prisma.printCostSetting.deleteMany({});
    server.close();
    await prisma.$disconnect();
  });

  it('an 8-page eulogy, 100 copies: sheets, finishing, design, then the 35% tier and VAT', () => {
    const r = printCalc(eulogy, S);
    // 2 sheets × 60 × 100; stapling, trimming and folding per set; design, proofing and delivery per job
    assert.deepEqual(r.lines.map((l) => [l.label, l.amount]), [['Inside sheets', 12000], ['Stapling', 800], ['Trimming', 600], ['Folding / creasing', 1000], ['Design/layout', 3000], ['Proofing', 300], ['Delivery', 500]]);
    assert.equal(r.cost, 18200);
    assert.deepEqual([r.markupPct, r.markup, r.priceExVat, r.vat, r.total], [35, 6370, 24570, 3931.2, 28501.2]);
    assert.equal(Math.round(r.unitTotal * 100) / 100, 285.01);
    assert.equal(r.sheets, 200);
  });

  it('a separate cover takes the place of one inside sheet, and a 4-page booklet is stapled by nobody', () => {
    const c = printCalc({ ...eulogy, coverSep: true, cover: 4, lam: true }, S);
    assert.deepEqual(c.lines.slice(0, 3).map((l) => [l.label, l.amount]), [['Inside sheets', 6000], ['Cover sheet', 11500], ['Cover lamination', 6000]]);
    assert.equal(c.sheets, 200); // the booklet still has two sheets
    const four = printCalc({ ...eulogy, pages: 4 }, S);
    assert.equal(four.lines.some((l) => l.label === 'Stapling'), false);
    assert.equal(four.lines[0]!.amount, 6000); // one folded sheet each
    // the company profile has its own design fee
    const profile = printCalc({ ...eulogy, product: 'profile' }, { ...S, fees: { ...S.fees, designPr: 4000 } });
    assert.equal(profile.lines.find((l) => l.label === 'Design/layout')!.amount, 4000);
  });

  it('a brochure: A4 is two to an A3 sheet, B5 four, and wastage rounds the sheets up', () => {
    const r = printCalc(brochure, S);
    // 500 A4 → 250 sheets, +5% = 263 sheets, double side at 60
    assert.equal(r.lines[0]!.amount, 15780);
    assert.equal(r.lines[0]!.note, '263 sheets × 60 (250 + 13 waste)');
    assert.deepEqual([r.cost, r.markupPct, r.priceExVat, r.total], [18080, 25, 22600, 26216]);
    const b5 = printCalc({ ...brochure, size: 'B5', sides: 1, qty: 100 }, S);
    assert.equal(b5.lines[0]!.note, '27 sheets × 35 (25 + 2 waste)');
    assert.equal(printCalc({ ...brochure, lam: true, qty: 100 }, S).lines.some((l) => l.label === 'Lamination'), true);
  });

  it('the mark-up is the highest tier the quantity reaches, or the first tier in flat mode', () => {
    const t = S.tiers;
    assert.deepEqual([1, 99, 100, 499, 500, 5000].map((q) => printMarkupPct(t, q, 'tier')), [50, 50, 35, 35, 25, 25]);
    assert.equal(printMarkupPct(t, 5000, 'flat'), 50);
  });

  it('describes the job for a quote', () => {
    assert.equal(printSpec(eulogy, S), 'Eulogy, 8 pages / 130gsm gloss, stapled, trimmed and folded');
    assert.equal(printSpec({ ...eulogy, pages: 4, fold: false }, S), 'Eulogy, 4 pages / 130gsm gloss, trimmed');
    assert.equal(printSpec(brochure, S), 'Brochure, A4 double side / 130gsm gloss');
  });

  it('rates must start at 1 copy, climb, and not be negative', () => {
    assert.equal(printSettingsProblem(S), null);
    assert.match(printSettingsProblem({ ...S, tiers: [{ min: 10, pct: 30 }] }) ?? '', /start at 1/);
    assert.match(printSettingsProblem({ ...S, tiers: [{ min: 1, pct: 30 }, { min: 1, pct: 20 }] }) ?? '', /same quantity/);
    assert.match(printSettingsProblem({ ...S, papers: [{ name: 'X', one: -1, two: 5 }] }) ?? '', /negative/);
    assert.match(printSettingsProblem({ ...S, fees: { ...S.fees, waste: 150 } }) ?? '', /100%/);
  });

  it('the screen: everyone who costs a job sees the cost lines and the price; the mark-up only people who see costs', async () => {
    assert.equal((await call('nobody', 'POST', '/costing/print/quote', { ...eulogy })).status, 403);
    const sellerQ = await call('seller', 'POST', '/costing/print/quote', { ...eulogy, mode: 'flat' }); // a seller cannot choose flat: it is tiered
    assert.equal(sellerQ.status, 200, JSON.stringify(sellerQ.body));
    assert.equal(sellerQ.body.cost, 18200);
    assert.equal(sellerQ.body.total, 28501.2); // the 35% tier, not the flat 50%
    assert.equal(sellerQ.body.lines.length, 7);
    assert.equal(sellerQ.body.markupPct, undefined);
    assert.equal(sellerQ.body.profit, undefined);
    const fin = await call('finance', 'POST', '/costing/print/quote', { ...eulogy, mode: 'flat' });
    assert.deepEqual([fin.body.markupPct, fin.body.markup, fin.body.priceExVat], [50, 9100, 27300]);
    assert.equal(fin.body.profit, 9100);
    assert.equal((await call('seller', 'POST', '/costing/print/quote', { ...eulogy, pages: 6 })).status, 400);
    assert.equal((await call('seller', 'POST', '/costing/print/quote', { ...eulogy, qty: 0 })).status, 400);
    assert.equal((await call('seller', 'POST', '/costing/print/quote', { ...eulogy, paper: 99 })).status, 400);
  });

  it('the price list: the VAT-inclusive price of one copy or piece at the usual quantities', async () => {
    const r = await call('seller', 'POST', '/costing/print/pricelist', { paper: 0 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.bookletQtys, [25, 50, 100, 250, 500]);
    assert.equal(r.body.booklets.length, 8);
    const eight = r.body.booklets.find((b: any) => b.pages === 8);
    assert.equal(eight.cells[2], 285.01); // 100 copies, as above
    assert.equal(r.body.brochures.length, 4);
    const a4double = r.body.brochures.find((b: any) => b.name === 'A4 double side');
    assert.deepEqual([a4double.ups, a4double.cells[2]], [2, 52.43]); // 500 pieces: 26,216 / 500
  });

  it('only an Admin keeps the rates, and a new rate changes the price', async () => {
    assert.equal((await call('finance', 'GET', '/costing/print/settings')).status, 403);
    assert.equal((await call('seller', 'PUT', '/costing/print/settings', S)).status, 403);
    const g = await call('admin', 'GET', '/costing/print/settings');
    assert.deepEqual(g.body, S);
    assert.equal((await call('admin', 'PUT', '/costing/print/settings', { ...S, tiers: [{ min: 5, pct: 30 }] })).status, 400);
    const next = { ...S, papers: S.papers.map((p, i) => (i === 0 ? { ...p, two: 70 } : p)) };
    assert.equal((await call('admin', 'PUT', '/costing/print/settings', next)).status, 200);
    const q = await call('seller', 'POST', '/costing/print/quote', { ...eulogy });
    assert.equal(q.body.lines[0].amount, 14000); // 2 sheets × 70 × 100
    assert.equal((await call('admin', 'PUT', '/costing/print/settings', S)).status, 200);
    assert.equal((await call('seller', 'POST', '/costing/print/quote', { ...eulogy })).body.cost, 18200);
  });
});
