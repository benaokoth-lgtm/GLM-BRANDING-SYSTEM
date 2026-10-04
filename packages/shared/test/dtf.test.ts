import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DTF_SETTINGS as S,
  dtfDashboard as dashboard,
  jobCalc,
  saleCalc,
  summariseRoll,
  type DtfArtworkJob,
  type DtfFilmSale,
  type DtfRoll,
} from '../src/dtf.ts';

test('film sale: blank price uses standard, band enforced', () => {
  const a = saleCalc(S, 10, null, 1000);
  assert.equal(a.price, 500); assert.equal(a.total, 5000); assert.equal(a.balance, 4000); assert.equal(a.valid, true);
  const b = saleCalc(S, 10, 450, 0);
  assert.equal(b.discountPerM, 50); assert.equal(b.total, 4500);
  assert.equal(saleCalc(S, 1, 399, 0).valid, false);
  // There is no ceiling any more: charging above the standard price is allowed (and rewarded as commission).
  assert.equal(saleCalc(S, 1, 501, 0).valid, true);
  assert.equal(saleCalc(S, 10, 520, 0).discountPerM, -20);
});

test('artwork job: price per piece = floor + fixed charge per metre / pieces', () => {
  // The pricing memo's own worked example: (50-30)*108/1 = 2160 fixed charge,
  // so 1m running / 108 pieces should price back out at exactly 50/piece.
  const j = jobCalc(1, 108, 2160, 30);
  assert.equal(j.finalPerPiece, 50);
  assert.equal(j.jobTotal, 5400);
});

test('artwork job: more pieces per metre is cheaper, fewer is dearer, floor never broken', () => {
  const base = jobCalc(1, 108, 2160, 30).finalPerPiece; // 50
  assert.equal(jobCalc(1, 216, 2160, 30).finalPerPiece < base, true); // double the pieces -> cheaper
  assert.equal(jobCalc(1, 54, 2160, 30).finalPerPiece > base, true); // half the pieces -> dearer
  // As pieces grows, price falls toward but never below the floor (at large
  // enough pieces counts the per-piece premium rounds away to nothing at 2dp
  // — 10,000 is chosen so it's still just above the floor after rounding).
  assert.equal(jobCalc(1, 10_000, 2160, 30).finalPerPiece > 30, true);
  assert.equal(jobCalc(1, 1, 0, 30).finalPerPiece, 30); // no fixed charge -> exactly the floor
});

const roll = (o: Partial<DtfRoll> = {}): DtfRoll => ({
  id: 'ROLL-001', installedOn: '2026-01-01', finishedOn: null, status: 'open',
  filmCost: 9000, inkPowderCost: 6000, rollLengthM: 100, ...o,
});
test('discounts: what pricing below standard or recommended costs a roll, and what it does to the profit', () => {
  const roll: DtfRoll = { id: 'ROLL-002', installedOn: '2026-01-01', finishedOn: null, status: 'open', filmCost: 6000, inkPowderCost: 4000, rollLengthM: 100 };
  // film: 10 m at the standard 500 and 10 m at 450 (50/m off → 500 given away)
  const sales: DtfFilmSale[] = [
    { id: 'a', rollId: 'ROLL-002', soldOn: '2026-01-02', client: 'x', metres: 10, pricePerM: 500, stdPriceAtSale: 500, amountPaid: 0 },
    { id: 'b', rollId: 'ROLL-002', soldOn: '2026-01-03', client: 'x', metres: 10, pricePerM: 450, stdPriceAtSale: 500, amountPaid: 0 },
    { id: 'c', rollId: 'ROLL-002', soldOn: '2026-01-04', client: 'x', metres: 4, pricePerM: 520, stdPriceAtSale: 500, amountPaid: 0 }, // above standard: a premium, not a discount
  ];
  // artwork: 2 running metres, 108 pieces → recommended 70; one job at 60 (10 off × 108 = 1,080), one at the recommended price
  const job = (id: string, charged: number | null, approvalStatus: 'Pending' | 'Approved' = 'Approved'): DtfArtworkJob => ({ id, rollId: 'ROLL-002', jobOn: '2026-01-05', client: 'y', runningMetres: 2, pieces: 108, fixedChargePerMetreAtJob: 2160, minPricePerPieceAtJob: 30, chargedPerPiece: charged, approvalStatus });
  const r = summariseRoll(S, roll, sales, [job('j1', 60), job('j2', null), job('j3', 50, 'Pending')]);
  assert.equal(r.filmDiscount, 500);
  assert.equal(r.artworkDiscount, 1080); // the pending job is not counted until it is approved
  assert.equal(r.discountGiven, 1580);
  assert.equal(r.premiumEarned, 80); // 4 m × 20
  assert.equal(r.discountedCount, 2); // one film sale and one approved artwork job
  assert.equal(r.discountedM, 12);
  assert.equal(r.pendingJobs, 1);
  // revenue: film 5000 + 4500 + 2080, artwork 6480 + 7560 (the pending job earns nothing yet)
  assert.equal(r.revenue, 5000 + 4500 + 2080 + 6480 + 7560);
  assert.equal(r.profit, r.revenue - 10000);
  assert.equal(r.revenueBeforeDiscounts, r.revenue + 1580);
  assert.equal(r.profitBeforeDiscounts, r.profit + 1580);
  assert.equal(r.profitLostPct, Math.round((1580 / (r.profit + 1580)) * 10000) / 100);
  // its metres are reserved though: 24 film + 6 artwork (three jobs of 2 m)
  assert.equal(r.artM, 6);
  // no discounts at all: nothing lost
  const none = summariseRoll(S, roll, [sales[0]!], [job('k', null)]);
  assert.equal(none.discountGiven, 0);
  assert.equal(none.profitLostPct, 0);
});

const sale = (rollId: string, metres: number, price = 500): DtfFilmSale => ({
  id: 's' + metres + rollId, rollId, soldOn: '2026-01-02', client: 'x', metres, pricePerM: price, stdPriceAtSale: 500, amountPaid: 0,
});
const job = (rollId: string, m: number, pieces = 10): DtfArtworkJob => ({
  id: 'j' + m + rollId, rollId, jobOn: '2026-01-02', client: 'x', runningMetres: m, pieces,
  fixedChargePerMetreAtJob: S.fixedChargePerMetre, minPricePerPieceAtJob: S.minPricePerPiece,
});

test('roll roll-up: wastage only on closed rolls, profit absorbs it', () => {
  const sales = [sale('ROLL-001', 70)]; const jobs = [job('ROLL-001', 20)];
  const open = summariseRoll(S, roll(), sales, jobs);
  assert.equal(open.wastageM, 0); assert.equal(open.remainingM, 10);
  const closed = summariseRoll(S, roll({ status: 'closed' }), sales, jobs);
  assert.equal(closed.wastageM, 10); assert.equal(closed.wastagePct, 10);
  assert.equal(closed.wastageKes, 1500); assert.equal(closed.overTolerance, true);
  // sale revenue = 70*500 = 35000; job = 30 + 2160*20/10 = 4350/pc * 10 pcs = 43500
  assert.equal(closed.revenue, 78500); assert.equal(closed.profit, 63500);
});

test('dashboard: orphans, cost per metre, per-closed-roll profit', () => {
  const rolls = [roll({ status: 'closed' }), roll({ id: 'ROLL-002', installedOn: null })];
  const d = dashboard(S, rolls, [sale('ROLL-001', 100), sale('ROLL-002', 5)], []);
  assert.equal(d.orphanCount, 1);
  assert.equal(d.startedCount, 1); assert.equal(d.costPerM, 150);
  assert.equal(d.profitPerClosedRoll, 35000); assert.equal(d.filmMarginPerM, 350);
});
