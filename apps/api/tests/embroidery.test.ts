// Embroidery pricing and orders: the stitch-based calculator (per-tier minimum, setup on its own line, design origination once per job), saved designs for repeat
// orders, who may charge less than the recommended price, and that the order is a General Order underneath.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_EMBROIDERY_SETTINGS, embroiderySettingsProblem, qtyTierFor, quantityPrice, quoteDesign, quoteJob, stitchPrice } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

describe('embroidery pricing arithmetic', () => {
  const S = DEFAULT_EMBROIDERY_SETTINGS;

  it('prices by stitch count first: the price moves with the stitches, with a small minimum for tiny designs', () => {
    assert.equal(stitchPrice(3000, S), 60); // 48 lifted to the minimum of 60
    assert.equal(stitchPrice(5000, S), 80);
    assert.equal(stitchPrice(6000, S), 96);
    assert.equal(stitchPrice(10000, S), 160);
    assert.equal(stitchPrice(20000, S), 320);
    assert.equal(stitchPrice(6333, S), 102); // 101.33 rounded up to the whole shilling
    // a bigger design always costs more once it is above the minimum — the stitch count is not hidden
    assert.ok(stitchPrice(8000, S) > stitchPrice(6000, S));
  });

  it('the price by quantity is the price by stitches less the quantity discount, and never higher', () => {
    assert.equal(qtyTierFor(S.qtyTiers, 5).discountPct, 0);
    assert.equal(qtyTierFor(S.qtyTiers, 12).discountPct, 10);
    assert.equal(qtyTierFor([...S.qtyTiers].reverse(), 25).discountPct, 15); // the order of the list does not matter
    const byQty = (q: number) => quantityPrice(6000, q, S);
    assert.deepEqual([1, 5, 6, 12, 25, 50, 100].map(byQty), [96, 96, 92, 87, 82, 77, 72]);
    for (const q of [1, 6, 12, 25, 50, 100, 1000]) assert.ok(byQty(q) <= stitchPrice(6000, S));
    // it falls (or stays) as the quantity rises
    assert.ok([1, 6, 12, 25, 50, 100].map(byQty).every((p, i, all) => i === 0 || p <= all[i - 1]!));
  });

  it('the staff apply either price; one of their own is measured against the lowest standard price', () => {
    const by = (basis: 'stitch' | 'quantity', pricePerPiece?: number) => quoteDesign({ name: 'x', stitches: 6000, basis, pricePerPiece }, 12, S);
    const stitch = by('stitch');
    assert.equal(stitch.piece, 96);
    assert.equal(stitch.basis, 'stitch');
    const qty = by('quantity');
    assert.equal(qty.piece, 87);
    assert.equal(qty.recommended, 87);
    assert.ok(qty.piece < stitch.piece);
    const custom = by('stitch', 90);
    assert.equal(custom.basis, 'custom');
    assert.equal(custom.piece, 90);
    assert.equal(custom.lowest, 87); // below this needs approval
    assert.equal(stitch.stitchPrice, 96);
    assert.equal(stitch.quantityPrice, 87);
    assert.equal(stitch.discountPct, 10);
  });

  it('keeps the setup fee on its own line: once per design, waived on a repeat or from the waiver quantity', () => {
    const one = quoteDesign({ name: 'x', stitches: 6000 }, 12, S);
    assert.equal(one.setup, 1200);
    assert.equal(one.subtotal, 96 * 12 + 1200); // the piece price carries no share of the setup
    assert.equal(quoteDesign({ name: 'x', stitches: 6000, repeat: true }, 12, S).setup, 0);
    assert.equal(quoteDesign({ name: 'x', stitches: 6000 }, 100, S).setupWaived, true);
    assert.equal(quoteDesign({ name: 'x', stitches: 6000 }, 99, S).setup, 1200);
    assert.equal(quoteDesign({ name: 'x', stitches: 6000 }, 500, { ...S, waiveAtQty: 0 }).setup, 1200); // 0 = never waived
  });

  it('adds design origination once per job, and only when the client has no artwork', () => {
    const designs = [{ name: 'Left chest', stitches: 6000 }, { name: 'Back', stitches: 20000 }];
    const mine = quoteJob(designs, 12, false, S);
    const theirs = quoteJob(designs, 12, true, S);
    assert.equal(mine.origination, 1500);
    assert.equal(theirs.origination, 0);
    assert.equal(mine.total - theirs.total, 1500); // once, however many designs
    assert.equal(theirs.total, 96 * 12 + 1200 + 320 * 12 + 1200);
  });

  it('refuses settings with no rate, no band for 1 piece, or a price by quantity that would rise with the quantity', () => {
    assert.equal(embroiderySettingsProblem(S), null);
    assert.match(embroiderySettingsProblem({ ...S, stitchRate: 0 })!, /more than 0/);
    assert.match(embroiderySettingsProblem({ ...S, qtyTiers: [] })!, /at least one/);
    assert.match(embroiderySettingsProblem({ ...S, qtyTiers: [{ min: 5, discountPct: 10 }] })!, /1 piece/);
    assert.match(embroiderySettingsProblem({ ...S, qtyTiers: [{ min: 1, discountPct: 0 }, { min: 1, discountPct: 5 }] })!, /same quantity/);
    assert.match(embroiderySettingsProblem({ ...S, qtyTiers: [{ min: 1, discountPct: 0 }, { min: 6, discountPct: 95 }] })!, /0% and 90%/);
    assert.match(embroiderySettingsProblem({ ...S, qtyTiers: [{ min: 1, discountPct: 0 }, { min: 6, discountPct: 10 }, { min: 12, discountPct: 5 }] })!, /must not go up/);
    assert.match(embroiderySettingsProblem({ ...S, setupFee: -1 })!, /negative/);
  });
});

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const order = (who: string, over: Record<string, unknown> = {}) =>
  call(who, 'POST', '/embroidery/orders', { customerName: 'Embroidery Customer', phone: '', paymentTiming: 'onCompletion', qty: 12, clientSupplies: false, designs: [{ name: 'Left chest', stitches: 6000, save: true }], ...over });

describe('embroidery orders', () => {
  before(async () => {
    await prisma.role.create({ data: { name: 'Emb Sales', canCaptureOrders: true } });
    await prisma.role.create({ data: { name: 'Emb Manager', canCaptureOrders: true, canManagePayments: true } });
    await prisma.role.create({ data: { name: 'Emb Nobody' } });
    for (const [key, role] of [['sales', 'Emb Sales'], ['manager', 'Emb Manager'], ['nobody', 'Emb Nobody'], ['admin', 'Admin']] as const) {
      const u = await prisma.user.create({ data: { name: `${key} (embroidery test)`, role, pinHash: 'x' } });
      ids[key] = u.id;
      tokens[key] = signToken({ id: u.id, name: u.name, role });
    }
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.close();
    await prisma.$disconnect();
  });

  it('shows the numbers to people who take orders, and lets only the Admin change them', async () => {
    assert.equal((await call('nobody', 'GET', '/embroidery/config')).status, 403);
    const cfg = await call('sales', 'GET', '/embroidery/config');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.settings.qtyTiers.length, 6);
    assert.equal(cfg.body.settings.stitchRate, 16);

    assert.equal((await call('manager', 'PUT', '/embroidery/settings', cfg.body.settings)).status, 403);
    assert.equal((await call('admin', 'PUT', '/embroidery/settings', { ...cfg.body.settings, qtyTiers: [{ min: 5, discountPct: 10 }] })).status, 400);
    const saved = await call('admin', 'PUT', '/embroidery/settings', { ...cfg.body.settings, setupFee: 1000 });
    assert.equal(saved.status, 200);
    assert.equal((await call('sales', 'GET', '/embroidery/config')).body.settings.setupFee, 1000);
    await call('admin', 'PUT', '/embroidery/settings', cfg.body.settings); // put the standing numbers back for the rest
  });

  it('captures a General Order underneath: its own number, the design and stitches on the line, setup and origination on their own lines', async () => {
    const r = await order('sales');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.orderNo, /^E-\d+$/);
    const lines = r.body.lineItems as any[];
    assert.equal(lines.length, 3);
    const piece = lines.find((l) => l.serviceName.startsWith('Embroidery per piece'))!;
    assert.match(piece.serviceName, /Left chest · 6,000 stitches/);
    assert.equal(piece.qty, 12);
    assert.equal(piece.unitPrice, 96); // 6,000 stitches × KES 16 per 1,000: the price by stitches (the default basis)
    const setup = lines.find((l) => l.serviceName.startsWith('Embroidery digitizing setup'))!;
    assert.equal(setup.unitPrice, 1200);
    assert.equal(setup.qty, 1);
    const orig = lines.find((l) => l.serviceName === 'Design origination')!;
    assert.equal(orig.unitPrice, 1500);
    assert.equal(r.body.totals.grandTotal, 96 * 12 + 1200 + 1500);
    assert.equal(r.body.staff.id, ids.sales);

    const row = await prisma.order.findUniqueOrThrow({ where: { id: r.body.id }, include: { embroideryJob: true } });
    assert.equal(row.channel, 'general'); // counted for the monthly sales target like any General Order
    assert.equal(row.embroideryJob?.qty, 12);
    assert.equal(JSON.parse(row.embroideryJob!.settingsJson).setupFee, 1200); // the prices it was made with are kept
    // the three services are sold only through this screen
    assert.ok((await prisma.service.findMany({ where: { name: { in: ['Embroidery per piece', 'Embroidery digitizing setup', 'Design origination'] } } })).every((s) => s.soldViaDtfModule));
  });

  it('takes payment the same way as any order, and an unpaid balance makes it an invoice', async () => {
    const paid = await order('sales', { paymentTiming: 'onAcceptance', payments: [{ method: 'Cash', amount: 1000 }], designs: [{ name: 'Cap', stitches: 4000 }] });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.equal(paid.body.status, 'Invoice'); // part paid: the balance is tracked as an invoice
    assert.equal(paid.body.totals.paidTotal, 1000);
    assert.equal((await order('sales', { paymentTiming: 'onAcceptance', payments: [{ method: 'Cash', amount: 999_999 }], designs: [{ name: 'Cap', stitches: 4000 }] })).status, 400);
  });

  it('a saved design is picked for a repeat: its own stitch count, no setup line', async () => {
    const saved = (await call('sales', 'GET', '/embroidery/designs?q=left chest')).body as any[];
    assert.ok(saved.length >= 1);
    assert.equal(saved[0].stitches, 6000);
    // a repeat that is not a saved design is refused
    assert.equal((await order('sales', { designs: [{ name: 'Fake repeat', stitches: 6000, repeat: true }] })).status, 400);
    // a repeat of the saved design: the stitch count is the saved one even if the screen sent another
    const r = await order('sales', { clientSupplies: true, designs: [{ designId: saved[0].id, name: 'Left chest', stitches: 99, repeat: true }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const lines = r.body.lineItems as any[];
    assert.equal(lines.length, 1); // no setup, no origination
    assert.match(lines[0].serviceName, /6,000 stitches/);
    assert.equal(r.body.totals.grandTotal, 96 * 12);
    assert.equal((await prisma.embroideryDesign.findUniqueOrThrow({ where: { id: saved[0].id } })).timesUsed >= 2, true);
  });

  it('the staff apply the price by stitches or the lower price by quantity; only a price below the quantity price goes for approval', async () => {
    // by stitches (the default)
    const full = await order('sales', { clientSupplies: true });
    assert.equal(full.status, 201);
    assert.equal((full.body.lineItems as any[]).find((l) => l.serviceName.startsWith('Embroidery per piece')).unitPrice, 96);
    // by quantity: lower, and a standard price — no approval
    const lower = await order('sales', { clientSupplies: true, designs: [{ name: 'By quantity', stitches: 6000, basis: 'quantity' }] });
    assert.equal(lower.status, 201, JSON.stringify(lower.body));
    assert.equal((lower.body.lineItems as any[]).find((l) => l.serviceName.startsWith('Embroidery per piece')).unitPrice, 87); // 10% off at 12 pieces
    assert.equal(lower.body.priceApproval, null);
    // a price of their own above either standard price is open to everyone
    const more = await order('sales', { clientSupplies: true, designs: [{ name: 'Premium', stitches: 6000, pricePerPiece: 150 }] });
    assert.equal(more.status, 201);
    assert.equal((more.body.lineItems as any[]).find((l) => l.serviceName.startsWith('Embroidery per piece')).unitPrice, 150);
    assert.equal(more.body.priceApproval, null);
    // between the two standard prices is fine too
    const between = await order('sales', { clientSupplies: true, designs: [{ name: 'Between', stitches: 6000, pricePerPiece: 90 }] });
    assert.equal(between.body.priceApproval, null);

    // below the price by quantity: it waits in the price-approval queue, like an artwork job
    const cheap = await order('sales', { clientSupplies: true, designs: [{ name: 'Cheap', stitches: 6000, pricePerPiece: 70 }] });
    assert.equal(cheap.status, 201, JSON.stringify(cheap.body));
    assert.equal(cheap.body.priceApproval, 'Pending');
    const job = await prisma.embroideryJob.findUniqueOrThrow({ where: { orderId: cheap.body.id } });
    assert.equal(job.approvalStatus, 'Pending');
    assert.equal(job.belowRecommended, true);
    const ask = await prisma.priceApproval.findFirstOrThrow({ where: { orderId: cheap.body.id } });
    assert.equal(ask.kind, 'embroidery');
    assert.equal(ask.systemPerPiece, 87);
    assert.equal(ask.chargedPerPiece, 70);
    assert.equal(ask.shortfall, 204); // (87 − 70) × 12 pieces

    // it cannot be paid for at capture while the price waits
    const paid = await order('sales', { paymentTiming: 'onAcceptance', payments: [{ method: 'Cash', amount: 500 }], designs: [{ name: 'Cheap again', stitches: 6000, pricePerPiece: 70 }] });
    assert.equal(paid.status, 400);
    assert.match(paid.body.error, /approval/);
  });

  it('keeps what each design was priced with: both standard prices and the one applied', async () => {
    const r = await order('sales', { clientSupplies: true, designs: [{ name: 'Snapshot', stitches: 6000, basis: 'quantity' }] });
    const job = await prisma.embroideryJob.findUniqueOrThrow({ where: { orderId: r.body.id } });
    const d = JSON.parse(job.designsJson)[0];
    assert.deepEqual({ stitchPrice: d.stitchPrice, quantityPrice: d.quantityPrice, basis: d.basis, piece: d.piece, discountPct: d.discountPct }, { stitchPrice: 96, quantityPrice: 87, basis: 'quantity', piece: 87, discountPct: 10 });
    assert.equal(JSON.parse(job.settingsJson).stitchRate, 16);
  });

  it('waives the setup fee from the waiver quantity, and prices several placements on one garment', async () => {
    const big = await order('sales', { qty: 100, clientSupplies: true, designs: [{ name: 'Front', stitches: 6000 }, { name: 'Back', stitches: 20000 }] });
    assert.equal(big.status, 201, JSON.stringify(big.body));
    const lines = big.body.lineItems as any[];
    assert.equal(lines.length, 2); // two piece lines, no setup lines
    assert.deepEqual(lines.map((l) => l.unitPrice).sort((a, b) => a - b), [96, 320]); // 6,000 and 20,000 stitches by stitches (the quantity price is the lower option)
  });

  it('refuses an unknown garment, an empty job, and someone who may not take orders', async () => {
    assert.equal((await order('sales', { garments: [{ materialId: 999999, qty: 1 }] })).status, 400);
    assert.equal((await order('sales', { designs: [] })).status, 400);
    assert.equal((await order('nobody')).status, 403);
  });
});
