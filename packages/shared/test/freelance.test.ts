import test from 'node:test';
import assert from 'node:assert/strict';
import { addWeeks, bandedAmount, freelanceSplit, isWeekStart, qualifyingShare, weekEnd, weekStart, DEFAULT_FREELANCE_BANDS } from '../src/commission.ts';

test('pay weeks run Monday to Sunday', () => {
  assert.equal(weekStart('2026-10-07'), '2026-10-05'); // a Wednesday
  assert.equal(weekStart('2026-10-05'), '2026-10-05'); // the Monday itself
  assert.equal(weekStart('2026-10-11'), '2026-10-05'); // the Sunday still belongs to that week
  assert.equal(weekStart('2026-10-12'), '2026-10-12');
  assert.equal(weekEnd('2026-10-05'), '2026-10-11');
  assert.equal(addWeeks('2026-10-05', -1), '2026-09-28');
  assert.equal(addWeeks('2026-12-28', 1), '2027-01-04'); // across a year end
  assert.deepEqual([isWeekStart('2026-10-05'), isWeekStart('2026-10-06'), isWeekStart('nope')], [true, false, false]);
});

test('the weekly bands are marginal, like the staff bands', () => {
  // 80,000 net of base-price sales: first 50,000 at 2% (1,000) + 30,000 at 3% (900)
  assert.equal(bandedAmount(DEFAULT_FREELANCE_BANDS, 80000), 1900);
  assert.equal(bandedAmount(DEFAULT_FREELANCE_BANDS, 200000), 1000 + 3000 + 2000);
});

const line = (qty: number, unitPrice: number, baseUnit: number, extra: Record<string, number> = {}) => ({ qty, unitPrice, baseUnit, ...extra });

test('only lines sold at or above their base price qualify; a short line is left out whole', () => {
  assert.equal(qualifyingShare([line(10, 100, 100)]), 1); // exactly at base
  assert.equal(qualifyingShare([line(10, 120, 100)]), 1); // above
  assert.equal(qualifyingShare([line(10, 90, 100)]), 0); // below
  // 1,000 at base and 500 below base: two thirds qualify
  assert.equal(Math.round(qualifyingShare([line(10, 100, 100), line(5, 100, 120)]) * 1000) / 1000, 0.667);
});

test('a discount that takes a line under its base price disqualifies it; an order discount counts too', () => {
  assert.equal(qualifyingShare([line(10, 100, 100, { discountPct: 10 })]), 0);
  assert.equal(qualifyingShare([line(10, 150, 100, { discountPct: 10 })]), 1); // priced high enough to stay above base after 10% off
  assert.equal(qualifyingShare([line(10, 100, 100)], 5), 0); // 5% off the whole order
  assert.equal(qualifyingShare([line(10, 100, 100)], 0, 50), 0); // Ksh 50 off the whole order
});

test('a heat press fee is passed through, not counted against the base; nothing sold means nothing qualifies', () => {
  assert.equal(qualifyingShare([line(10, 100, 100, { heatPressFee: 20 })]), 1);
  assert.equal(qualifyingShare([]), 0);
  assert.equal(qualifyingShare([line(0, 100, 100)]), 0);
});

import { withholdingOn } from '../src/commission.ts';

test('withholding tax is a percentage of the commission, to the cent, and never negative', () => {
  assert.equal(withholdingOn(4000, 5), 200);
  assert.equal(withholdingOn(4193.97, 5), 209.7); // 209.6985
  assert.equal(withholdingOn(1000, 0), 0); // exempt
  assert.equal(withholdingOn(0, 5), 0);
  assert.equal(withholdingOn(-50, 5), 0);
  assert.equal(withholdingOn(1000, 7.5), 75);
});

test('an order divides into the base part and the premium above base; commission is only ever paid on those, never on the whole price', () => {
  const near = (v: number, w: number) => assert.ok(Math.abs(v - w) < 1e-5, "expected " + w + " but got " + v);
  // sold at base: all base, no premium
  assert.deepEqual(freelanceSplit([line(10, 100, 100)]), { qualifying: 1, base: 1, low: 0, premium: 0 });
  // sold 20% above base: 100 of every 120 is base, 20 is premium
  const up = freelanceSplit([line(10, 120, 100)]);
  near(up.qualifying, 1); near(up.base, 100 / 120); near(up.premium, 20 / 120);
  // below base: nothing at all
  assert.deepEqual(freelanceSplit([line(10, 90, 100)]), { qualifying: 0, base: 0, low: 0, premium: 0 });
  // a short line is left out whole, the other line's premium still counts: 1,200 (base 1,000, premium 200) + 500 short
  const mix = freelanceSplit([line(10, 120, 100), line(5, 100, 120)]);
  near(mix.qualifying, 1200 / 1700); near(mix.base, 1000 / 1700); near(mix.premium, 200 / 1700);
});

test('thin-margin lines are tracked inside the base part', () => {
  const near = (v: number, w: number) => assert.ok(Math.abs(v - w) < 1e-5, "expected " + w + " but got " + v);
  // 1,000 at base on a normal line, 1,000 at base on a contracted-out line, plus 200 premium on that same contracted-out line
  const s = freelanceSplit([line(10, 100, 100), { ...line(10, 120, 100), lowMargin: true }]);
  near(s.qualifying, 1); near(s.base, 2000 / 2200); near(s.low, 1000 / 2200); near(s.premium, 200 / 2200);
});
