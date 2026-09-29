import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DTF_SETTINGS as S,
  computeBillableMetres,
  computeFill,
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
  assert.equal(saleCalc(S, 1, 501, 0).valid, false);
});

test('artwork job follows the billable-metres formula (jobCalc takes billableMetres directly)', () => {
  // 2 m billable, 4 artworks: base = 2*500/4 = 250; proposed = 750; disc 50 -> 700; 10 pcs -> 7000
  const j = jobCalc(S, 2, 4, 10, null, 50);
  assert.equal(j.basePerArtwork, 250); assert.equal(j.proposed, 750);
  assert.equal(j.finalPerPiece, 700); assert.equal(j.jobTotal, 7000); assert.equal(j.belowBase, false);
  assert.equal(jobCalc(S, 2, 4, 10, 1, 50).belowBase, true); // 250-50 < 250
  assert.equal(jobCalc(S, 2, 4, 10, null, -100).finalPerPiece, 850); // negative discount prices up
  assert.equal(jobCalc(S, 2, 4, 10, null, 0, 500, 10000).finalPerPiece, 10000); // minPricePerPiece floor wins over a tiny proposed price
});

test('fill and billable metres: unfilled-width premium, and the floor for tiny jobs', () => {
  assert.equal(computeFill(30, 60), 0.5);
  assert.equal(computeFill(60, 60), 1);
  assert.equal(computeFill(90, 60), 1); // can't exceed the roll's width
  assert.equal(computeBillableMetres(S, 1, 30), 1.25); // 1 * (1 + 0.5*(1-0.5))
  assert.equal(computeBillableMetres(S, 1, 60), 1); // full width -> no premium
  assert.equal(computeBillableMetres(S, 0.1, 60), 0.25); // floor: MAX(0.1, 0.25) * 1
});

test('worked examples from the pricing memo: 3 pieces at half fill vs. 24 pieces at full width', () => {
  // Job A: 1m running, 3 pieces, ~30cm of 60 used -> fill 50%, billable 1.25m
  const billableA = computeBillableMetres(S, 1, 30);
  const a = jobCalc(S, billableA, 3, 3, null, 0);
  assert.equal(a.billableMetres, 1.25);
  assert.equal(a.finalPerPiece, 625);
  assert.equal(a.jobTotal, 1875);

  // Job B: 1m running, 24 pieces, full width -> fill 100%, billable 1m
  const billableB = computeBillableMetres(S, 1, 60);
  const b = jobCalc(S, billableB, 24, 24, null, 0);
  assert.equal(b.billableMetres, 1);
  assert.equal(b.finalPerPiece, 62.5);
  assert.equal(b.jobTotal, 1500);
});

const roll = (o: Partial<DtfRoll> = {}): DtfRoll => ({
  id: 'ROLL-001', installedOn: '2026-01-01', finishedOn: null, status: 'open',
  filmCost: 9000, inkPowderCost: 6000, rollLengthM: 100, ...o,
});
const sale = (rollId: string, metres: number, price = 500): DtfFilmSale => ({
  id: 's' + metres + rollId, rollId, soldOn: '2026-01-02', client: 'x', metres, pricePerM: price, stdPriceAtSale: 500, amountPaid: 0,
});
const job = (rollId: string, m: number): DtfArtworkJob => ({
  id: 'j' + m + rollId, rollId, jobOn: '2026-01-02', client: 'x', runningMetres: m, widthUsedCm: S.rollWidthCm, billableMetres: m, artworks: 1, pieces: 1,
  multiplier: 3, stdPriceAtJob: 500, minPricePerPieceAtJob: S.minPricePerPiece, discountPerPiece: 0,
});

test('roll roll-up: wastage only on closed rolls, profit absorbs it', () => {
  const sales = [sale('ROLL-001', 70)]; const jobs = [job('ROLL-001', 20)];
  const open = summariseRoll(S, roll(), sales, jobs);
  assert.equal(open.wastageM, 0); assert.equal(open.remainingM, 10);
  const closed = summariseRoll(S, roll({ status: 'closed' }), sales, jobs);
  assert.equal(closed.wastageM, 10); assert.equal(closed.wastagePct, 10);
  assert.equal(closed.wastageKes, 1500); assert.equal(closed.overTolerance, true);
  // revenue = 70*500 + 20*500*3 = 35000 + 30000; profit = 65000 - 15000
  assert.equal(closed.revenue, 65000); assert.equal(closed.profit, 50000);
});

test('dashboard: orphans, cost per metre, per-closed-roll profit', () => {
  const rolls = [roll({ status: 'closed' }), roll({ id: 'ROLL-002', installedOn: null })];
  const d = dashboard(S, rolls, [sale('ROLL-001', 100), sale('ROLL-002', 5)], []);
  assert.equal(d.orphanCount, 1);
  assert.equal(d.startedCount, 1); assert.equal(d.costPerM, 150);
  assert.equal(d.profitPerClosedRoll, 35000); assert.equal(d.filmMarginPerM, 350);
});
