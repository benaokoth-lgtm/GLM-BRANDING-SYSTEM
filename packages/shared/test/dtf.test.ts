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
