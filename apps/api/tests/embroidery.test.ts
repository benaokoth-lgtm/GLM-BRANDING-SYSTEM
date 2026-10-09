// Embroidery pricing and orders: the stitch-based calculator (per-tier minimum, setup on its own line, design origination once per job), saved designs for repeat
// orders, who may charge less than the recommended price, and that the order is a General Order underneath.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_EMBROIDERY_SETTINGS, embroiderySettingsProblem, quoteDesign, quoteJob, tierFor } from '@glm/shared';
import { app } from '../src/app';
import { prisma } from '../src/db';
import { signToken } from '../src/middleware/auth';

describe('embroidery pricing arithmetic', () => {
  const S = DEFAULT_EMBROIDERY_SETTINGS;

  it('uses the tier for the quantity: its rate and its own minimum price per piece', () => {
    assert.equal(tierFor(S.tiers, 1).rate, 14);
    assert.equal(tierFor(S.tiers, 11).rate, 12);
    assert.equal(tierFor(S.tiers, 12).rate, 10);
    assert.equal(tierFor(S.tiers, 500).floor, 100);
    assert.equal(tierFor([...S.tiers].reverse(), 25).rate, 9); // order in the list does not matter
    // 6,000 stitches: 84 at 1 piece is lifted to that tier's 150; 60 at 12 pieces is lifted to 120; 42 at 100 pieces to 100
    assert.equal(quoteDesign({ name: 'x', stitches: 6000 }, 1, S).recommended, 150);
    assert.equal(quoteDesign({ name: 'x', stitches: 6000 }, 12, S).recommended, 120);
    assert.equal(quoteDesign({ name: 'x', stitches: 6000 }, 100, S).recommended, 100);
  });

  it('rounds a stitch cost above the minimum up to the whole shilling', () => {
    const q = quoteDesign({ name: 'x', stitches: 13333 }, 12, S); // 10 × 13.333 = 133.33
    assert.equal(q.floored, false);
    assert.equal(q.recommended, 134);
  });

  it('puts the setup fee on its own line: charged once per design, and waived on a repeat or from the waiver quantity', () => {
    const one = quoteDesign({ name: 'x', stitches: 6000 }, 12, S);
    assert.equal(one.setup, 1200);
    assert.equal(one.subtotal, 120 * 12 + 1200); // the piece price carries no share of the setup
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
    // 2 designs × (piece × 12 + setup): 120 and 200 per piece
    assert.equal(theirs.total, 120 * 12 + 1200 + 200 * 12 + 1200);
  });

  it('refuses settings that leave a quantity without a rate', () => {
    assert.equal(embroiderySettingsProblem(S), null);
    assert.match(embroiderySettingsProblem({ ...S, tiers: [] })!, /at least one/);
    assert.match(embroiderySettingsProblem({ ...S, tiers: [{ min: 5, rate: 10, floor: 100 }] })!, /quantity 1/);
    assert.match(embroiderySettingsProblem({ ...S, tiers: [{ min: 1, rate: 10, floor: 100 }, { min: 1, rate: 9, floor: 90 }] })!, /same quantity/);
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
    assert.equal(cfg.body.settings.tiers.length, 6);

    assert.equal((await call('manager', 'PUT', '/embroidery/settings', cfg.body.settings)).status, 403);
    assert.equal((await call('admin', 'PUT', '/embroidery/settings', { ...cfg.body.settings, tiers: [{ min: 5, rate: 10, floor: 100 }] })).status, 400);
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
    assert.equal(piece.unitPrice, 120); // 6,000 stitches × KES 10 = 60, lifted to this tier's minimum
    const setup = lines.find((l) => l.serviceName.startsWith('Embroidery digitizing setup'))!;
    assert.equal(setup.unitPrice, 1200);
    assert.equal(setup.qty, 1);
    const orig = lines.find((l) => l.serviceName === 'Design origination')!;
    assert.equal(orig.unitPrice, 1500);
    assert.equal(r.body.totals.grandTotal, 120 * 12 + 1200 + 1500);
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
    assert.equal(r.body.totals.grandTotal, 120 * 12);
    assert.equal((await prisma.embroideryDesign.findUniqueOrThrow({ where: { id: saved[0].id } })).timesUsed >= 2, true);
  });

  it('charging more than recommended is open to everyone; charging less sends the job to the price-approval queue', async () => {
    const more = await order('sales', { clientSupplies: true, designs: [{ name: 'Premium', stitches: 6000, pricePerPiece: 150 }] });
    assert.equal(more.status, 201);
    assert.equal((more.body.lineItems as any[]).find((l) => l.serviceName.startsWith('Embroidery per piece')).unitPrice, 150);
    assert.equal(more.body.priceApproval, null);

    // anyone may ask for a lower price; it waits for a manager, like an artwork job
    const cheap = await order('sales', { clientSupplies: true, designs: [{ name: 'Cheap', stitches: 6000, pricePerPiece: 100 }] });
    assert.equal(cheap.status, 201, JSON.stringify(cheap.body));
    assert.equal(cheap.body.priceApproval, 'Pending');
    const job = await prisma.embroideryJob.findUniqueOrThrow({ where: { orderId: cheap.body.id } });
    assert.equal(job.approvalStatus, 'Pending');
    assert.equal(job.belowRecommended, true);
    const ask = await prisma.priceApproval.findFirstOrThrow({ where: { orderId: cheap.body.id } });
    assert.equal(ask.kind, 'embroidery');
    assert.equal(ask.systemPerPiece, 120);
    assert.equal(ask.chargedPerPiece, 100);
    assert.equal(ask.shortfall, 240); // (120 − 100) × 12 pieces

    // it cannot be paid for at capture while the price waits
    const paid = await order('sales', { paymentTiming: 'onAcceptance', payments: [{ method: 'Cash', amount: 500 }], designs: [{ name: 'Cheap again', stitches: 6000, pricePerPiece: 100 }] });
    assert.equal(paid.status, 400);
    assert.match(paid.body.error, /approval/);
  });

  it('waives the setup fee from the waiver quantity, and prices several placements on one garment', async () => {
    const big = await order('sales', { qty: 100, clientSupplies: true, designs: [{ name: 'Front', stitches: 6000 }, { name: 'Back', stitches: 20000 }] });
    assert.equal(big.status, 201, JSON.stringify(big.body));
    const lines = big.body.lineItems as any[];
    assert.equal(lines.length, 2); // two piece lines, no setup lines
    assert.deepEqual(lines.map((l) => l.unitPrice).sort((a, b) => a - b), [100, 140]); // 42 → minimum 100; 7 × 20 = 140
  });

  it('refuses an unknown garment, an empty job, and someone who may not take orders', async () => {
    assert.equal((await order('sales', { garments: [{ materialId: 999999, qty: 1 }] })).status, 400);
    assert.equal((await order('sales', { designs: [] })).status, 400);
    assert.equal((await order('nobody')).status, 403);
  });
});
