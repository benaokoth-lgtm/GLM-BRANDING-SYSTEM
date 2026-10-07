import test from 'node:test';
import assert from 'node:assert/strict';
import { addWeeks, bandedAmount, isWeekStart, qualifyingShare, weekEnd, weekStart, DEFAULT_FREELANCE_BANDS } from '../src/commission.ts';

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
  // 80,000 net: first 50,000 at 3% (1,500) + 30,000 at 5% (1,500)
  assert.equal(bandedAmount(DEFAULT_FREELANCE_BANDS, 80000), 3000);
  assert.equal(bandedAmount(DEFAULT_FREELANCE_BANDS, 200000), 1500 + 5000 + 3500);
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
