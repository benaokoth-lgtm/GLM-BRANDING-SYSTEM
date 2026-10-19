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
import { readXlsx } from '../src/xlsx';

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

  it('an A5 eulogy booklet is costed from the A3 sheet rate: two A4 sheets from each A3, half the paper, the same finishing', async () => {
    // 8 pages = 2 A4 sheets a copy: 200 A4 sheets = 100 A3 × 60 = 6,000, then stapling 800, trimming 600, folding 1,000, design 3,000, proofing 300, delivery 500
    const q = await call('seller', 'POST', '/costing/print/quote', { ...eulogy, booklet: 'A5' });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.cost, 12200);
    assert.equal(q.body.sheets, 100); // A3 sheets
    assert.equal(q.body.total, 19105.2); // cost 12,200 + 35% + VAT
    assert.equal(q.body.spec, 'Eulogy (A5 booklet), 8 pages / 130gsm gloss, stapled, trimmed and folded');
    // the A4 booklet is as it was, and a request that says nothing is an A4 booklet (every earlier quote)
    assert.equal((await call('seller', 'POST', '/costing/print/quote', { ...eulogy })).body.cost, 18200);
    assert.equal((await call('seller', 'POST', '/costing/print/quote', { ...eulogy, booklet: 'A4' })).body.cost, 18200);
    // an odd number of A4 sheets leaves half an A3 sheet: 5 copies of 4 pages = 5 A4 sheets = 3 A3
    const odd = await call('seller', 'POST', '/costing/print/quote', { ...eulogy, pages: 4, qty: 5, booklet: 'A5' });
    assert.deepEqual([odd.body.sheets, odd.body.lines[0].amount], [3, 180]);
    // a separate cover is an A4 sheet too (2 from an A3): 100 covers on 250gsm = 50 A3 × 115, and 100 inside A4 sheets = 50 A3 × 60
    const cov = await call('seller', 'POST', '/costing/print/quote', { ...eulogy, booklet: 'A5', coverSep: true, cover: 4 });
    assert.deepEqual(cov.body.lines.slice(0, 2).map((l: any) => l.amount), [3000, 5750]);
    // cutting the A3 sheets is its own fee, nothing until it is set
    assert.ok(!q.body.lines.some((l: any) => /Cutting/.test(l.label)));
    assert.equal((await call('admin', 'PUT', '/costing/print/settings', { ...S, fees: { ...S.fees, cut: 2 } })).status, 200);
    const cut = await call('seller', 'POST', '/costing/print/quote', { ...eulogy, booklet: 'A5' });
    assert.equal(cut.body.lines.find((l: any) => /Cutting/.test(l.label)).amount, 200); // 100 A3 sheets × 2
    assert.equal(cut.body.cost, 12400);
    assert.equal((await call('admin', 'PUT', '/costing/print/settings', S)).status, 200);
    // the price list shows both: the A5 booklet's 8 pages at 100 copies
    const list = (await call('seller', 'POST', '/costing/print/pricelist', {})).body;
    assert.equal(list.bookletsA5.find((b: any) => b.pages === 8).cells[2], 191.05);
    assert.equal(list.booklets.find((b: any) => b.pages === 8).cells[2], 285.01);
  });

  it('more papers can be added: they come last, are costed like the others, and cannot repeat a name', async () => {
    const more = { ...S, papers: [...S.papers, { name: '300gsm art card', one: 90, two: 150 }, { name: '115gsm gloss', one: 30, two: 50 }] };
    assert.equal((await call('admin', 'PUT', '/costing/print/settings', more)).status, 200);
    assert.deepEqual((await call('seller', 'GET', '/costing/print/config')).body.papers.slice(-2), ['300gsm art card', '115gsm gloss']);
    // the new paper is picked by its place on the list; the older ones keep theirs
    const q = await call('seller', 'POST', '/costing/print/quote', { ...eulogy, paper: S.papers.length });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.lines[0].amount, 30000); // 2 sheets × 150 (two sides) × 100
    assert.equal((await call('seller', 'POST', '/costing/print/quote', { ...eulogy })).body.cost, 18200); // paper 0 is unchanged
    assert.equal((await call('admin', 'PUT', '/costing/print/settings', { ...S, papers: [...S.papers, { name: '130GSM gloss', one: 1, two: 1 }] })).status, 400); // the same name twice
    assert.equal((await call('admin', 'PUT', '/costing/print/settings', S)).status, 200);
  });

  it('a print costing saved as a quote is agreed, approved under the floor, and captured as an order', async () => {
    const save = (who: string, extra: object = {}) => call(who, 'POST', '/costing/print/quotes', { ...eulogy, clientName: 'Hope Chapel', phone: '0712 000 000', ...extra });
    assert.equal((await call('nobody', 'POST', '/costing/print/quotes', { ...eulogy, clientName: 'X Y' })).status, 403);
    assert.equal((await save('seller', { clientName: 'X' })).status, 400); // a name is needed
    const q = await save('seller');
    assert.equal(q.status, 201, JSON.stringify(q.body));
    assert.match(q.body.quoteNo, /^CQ-\d+$/);
    assert.deepEqual([q.body.jobType, q.body.cost, q.body.price, q.body.total], ['eulogy', 18200, 24570, 28501.2]);
    assert.equal(q.body.summary, 'Eulogy, 8 pages / 130gsm gloss, stapled, trimmed and folded — 100 copies');
    assert.equal(q.body.lines.length, 7);
    assert.equal(q.body.marginPct, undefined); // not for a seller
    // 18,200 cost + the 30% floor = 23,660 before VAT = 27,445.60 with VAT: anything lower needs a manager
    assert.equal(q.body.lowestTotal, 27445.6);
    assert.equal((await call('seller', 'POST', `/costing/quotes/${q.body.id}/agree`, { total: 20000 })).status, 400); // below cost
    const low = await call('seller', 'POST', `/costing/quotes/${q.body.id}/agree`, { total: 26000 });
    assert.equal(low.body.approval, 'Pending');
    assert.equal((await call('seller', 'POST', `/costing/quotes/${q.body.id}/capture`, { paymentTiming: 'onCompletion' })).status, 400);
    assert.equal((await call('finance', 'POST', `/costing/quotes/${q.body.id}/approve`)).body.approval, 'Approved');
    const cap = await call('seller', 'POST', `/costing/quotes/${q.body.id}/capture`, { paymentTiming: 'onAcceptance', payments: [{ method: 'Cash', amount: 10000 }] });
    assert.equal(cap.status, 201, JSON.stringify(cap.body));
    assert.deepEqual([cap.body.totals.grandTotal, cap.body.totals.balanceDue, cap.body.customerName], [26000, 16000, 'Hope Chapel']);
    assert.equal(cap.body.lineItems[0].serviceName, 'Costed job — Eulogy — Eulogy, 8 pages / 130gsm gloss, stapled, trimmed and folded — 100 copies');
    // what the job costs us (VAT included, as the printer bills it) is on the line for Finance only
    assert.equal((await call('admin', 'GET', `/orders/${cap.body.id}`)).body.lineItems[0].supplierCost, 21112);
    assert.equal((await call('seller', 'GET', `/orders/${cap.body.id}`)).body.lineItems[0].supplierCost, undefined);
    // a finance user sees the margin; and a flat markup is theirs to choose
    const fin = await save('finance', { mode: 'flat' });
    assert.deepEqual([fin.body.marginPct, fin.body.price], [50, 27300]);
    // the lowest margin without approval is one of the rates
    const s = (await call('admin', 'GET', '/costing/print/settings')).body;
    assert.equal(s.floorMarginPct, 30);
    assert.equal((await call('admin', 'PUT', '/costing/print/settings', { ...s, floorMarginPct: 20 })).status, 200);
    const looser = await save('seller');
    assert.equal(looser.body.lowestTotal, 25334.4); // 18,200 × 1.2 × 1.16; (a floor can never be above the margin the quote was made at)
    assert.equal((await call('admin', 'PUT', '/costing/print/settings', s)).status, 200);
  });

  it('the supplier price-check sheet lists every item and service Job Costing costs from, with the current rate and room for quotes', async () => {
    const get = (who: string) => fetch(`${base}/api/costing/rates.xlsx`, { headers: { Authorization: `Bearer ${tokens[who]}` } });
    assert.equal((await get('finance')).status, 403); // the rates are an Admin's
    const res = await get('admin');
    assert.equal(res.status, 200);
    const grid = readXlsx(Buffer.from(await res.arrayBuffer()));
    assert.ok(grid[0]!.includes('Supplier 1 quote') && grid[0]!.includes('Supplier 3 quote'));
    const rows = grid.slice(1);
    const sections = new Set(rows.map((r) => r[1]));
    for (const s of ['Business cards & signage', 'Brochures & eulogies — paper', 'Brochures & eulogies — services & fees']) assert.ok(sections.has(s), s);
    // a signage rate, a paper at both sides, a fee — each with what it is charged on and today's rate
    const lam = rows.find((r) => r[2] === 'Lamination film')!;
    assert.deepEqual([lam[3], lam[5], lam[6], lam[8]], ['Material', 'per A3 sheet', 'Laminated cards only', '60']);
    assert.equal(rows.find((r) => r[2] === '130gsm gloss, printed both sides')![8], '60');
    assert.equal(rows.find((r) => r[2] === 'Stapling')![8], '8');
    assert.equal(rows.some((r) => r[2] === 'Brochure wastage'), false); // an allowance, not a price
  });

  it('a saved quote is the house quotation: printable document, PDF, email and WhatsApp, with the price and never the cost', async () => {
    const save = await call('seller', 'POST', '/costing/print/quotes', { ...eulogy, clientName: 'Hope Chapel', phone: '0712 000 111' });
    assert.equal(save.status, 201, JSON.stringify(save.body));
    const id = save.body.id;
    const doc = await call('seller', 'GET', `/costing/quotes/${id}/document`);
    assert.equal(doc.status, 200);
    // the same shape an order's invoice or quotation has, so the same templates print it
    assert.deepEqual([doc.body.status, doc.body.kind, doc.body.orderNo, doc.body.customerName, doc.body.phone], ['Quote', 'corporate', save.body.quoteNo, 'Hope Chapel', '0712 000 111']);
    assert.equal(doc.body.validUntil, save.body.validUntil);
    assert.equal(doc.body.staff.name, 'seller (print test)');
    assert.deepEqual([doc.body.totals.grandTotal, doc.body.lineItems.length, doc.body.lineItems[0].lineTotal], [28501.2, 1, 28501.2]);
    assert.equal(doc.body.lineItems[0].serviceName, 'Eulogy, 8 pages / 130gsm gloss, stapled, trimmed and folded — 100 copies');
    assert.ok(!JSON.stringify(doc.body).includes('18200'), 'the cost is not on the document'); // 18,200 is what it costs us
    // the price agreed with the client replaces the quoted one once it stands; one waiting for approval does not
    assert.equal((await call('seller', 'POST', `/costing/quotes/${id}/agree`, { total: 26000 })).body.approval, 'Pending');
    assert.equal((await call('seller', 'GET', `/costing/quotes/${id}/document`)).body.totals.grandTotal, 28501.2);
    await call('finance', 'POST', `/costing/quotes/${id}/approve`);
    assert.equal((await call('seller', 'GET', `/costing/quotes/${id}/document`)).body.totals.grandTotal, 26000);
    assert.equal((await call('seller', 'POST', `/costing/quotes/${id}/agree`, { total: 28000 })).body.approval, '');
    assert.equal((await call('seller', 'GET', `/costing/quotes/${id}/document`)).body.totals.grandTotal, 28000);
    // the PDF
    const pdf = await fetch(`${base}/api/costing/quotes/${id}/pdf`, { headers: { Authorization: `Bearer ${tokens.seller}` } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type') ?? '', /application\/pdf/);
    assert.match(pdf.headers.get('content-disposition') ?? '', /Quotation-CQ-\d+\.pdf/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    // only the salesperson's own quote (or a manager's): another salesperson and a role that does not cost jobs are refused
    assert.equal((await call('nobody', 'GET', `/costing/quotes/${id}/document`)).status, 403);
    const other = await prisma.user.create({ data: { name: 'seller two (print test)', role: 'Seller (print test)', pinHash: 'x' } });
    tokens.other = signToken({ id: other.id, name: other.name, role: 'Seller (print test)' });
    assert.equal((await call('other', 'GET', `/costing/quotes/${id}/document`)).status, 403);
    assert.equal((await fetch(`${base}/api/costing/quotes/${id}/pdf`, { headers: { Authorization: `Bearer ${tokens.other}` } })).status, 403);
    // sending someone else's quote is refused (501 where mail is not set up at all, which comes first)
    assert.ok([403, 501].includes((await call('other', 'POST', '/email/send', { costingQuoteId: id, to: 'a@b.co', subject: 'x' })).status));
    assert.equal((await call('other', 'GET', `/whatsapp/log?costingQuoteId=${id}`)).status, 403);
    assert.deepEqual((await call('seller', 'GET', `/whatsapp/log?costingQuoteId=${id}`)).body, []);
    assert.ok([400, 501].includes((await call('seller', 'POST', '/email/send', { to: 'a@b.co', subject: 'x' })).status)); // neither an order nor a quote chosen
  });
});
