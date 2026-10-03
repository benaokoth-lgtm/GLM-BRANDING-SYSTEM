import test from 'node:test';
import assert from 'node:assert/strict';
import { jobMargin, markupOf, needsCosting, priceFromCost } from '../src/outsourced.ts';

test('a percentage mark-up on the supplier price, rounded up to a whole shilling', () => {
  assert.equal(priceFromCost(40, 'percent', 50), 60); // the eulogy example: 40 quoted → 60
  assert.equal(priceFromCost(37, 'percent', 50), 56); // 55.5 → 56, never down
  assert.equal(priceFromCost(100, 'percent', 0), 100); // no mark-up: at cost
});

test('a fixed amount per unit works the same way', () => {
  assert.equal(priceFromCost(40, 'amount', 25), 65);
  assert.equal(priceFromCost(40.4, 'amount', 10), 51); // 50.4 → 51
});

test('bad input never produces a negative or NaN price', () => {
  assert.equal(priceFromCost(-5, 'percent', 50), 0);
  assert.equal(priceFromCost(NaN, 'percent', 50), 0);
  assert.equal(priceFromCost(40, 'percent', -10), 40); // a negative mark-up is ignored
});

test('the mark-up a hand-set price represents', () => {
  assert.deepEqual(markupOf(40, 60), { amount: 20, percent: 50 });
  assert.deepEqual(markupOf(0, 60), { amount: 60, percent: null });
});

test('job margin: 200 eulogies quoted at 40 each, sold at 60', () => {
  const m = jobMargin(200 * 60, 200 * 40, 0.16);
  assert.equal(m.grossProfit, 4000);
  assert.equal(m.markupPct, 50); // on cost
  assert.equal(m.marginPct, 33.33); // on the sale
  // VAT: the 12,000 sale carries 16% VAT inside it, and the supplier's VAT isn't reclaimed, so the books see less profit
  assert.equal(m.saleExVat, 10344.83);
  assert.equal(m.bookProfit, 2344.83);
  assert.equal(m.bookMarginPct, 22.67);
});

test('a job with nothing sold or costed has no percentages', () => {
  const m = jobMargin(0, 0, 0.16);
  assert.equal(m.markupPct, null);
  assert.equal(m.marginPct, null);
  assert.equal(m.bookMarginPct, null);
});

test('an outsourced line needs costing until the supplier quote is in', () => {
  assert.equal(needsCosting({ outsourced: true, supplierCost: null }), true);
  assert.equal(needsCosting({ outsourced: true, supplierCost: 0 }), true);
  assert.equal(needsCosting({ outsourced: true, supplierCost: 40 }), false);
  assert.equal(needsCosting({ outsourced: false, supplierCost: null }), false);
});
