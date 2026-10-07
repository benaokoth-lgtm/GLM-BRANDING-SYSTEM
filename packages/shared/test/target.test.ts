import test from 'node:test';
import assert from 'node:assert/strict';
import { bandedAmount, salesTarget } from '../src/commission.ts';

const bands = [
  { from: 0, rate: 2 },
  { from: 100000, rate: 4 },
];

test('3 × a salary of 40,000 makes the target 120,000; below it nothing is earned and the gap is shown', () => {
  const t = salesTarget({ multiplier: 3, mode: 'above', salary: 40000, achieved: 95000 });
  assert.deepEqual([t.required, t.met, t.remaining, t.eligibleSales, t.held], [120000, false, 25000, 0, true]);
});

test("'above': the bands start at the target — only what is sold past 120,000 earns", () => {
  const t = salesTarget({ multiplier: 3, mode: 'above', salary: 40000, achieved: 150000 });
  assert.deepEqual([t.met, t.eligibleSales, t.held], [true, 30000, false]);
  assert.equal(bandedAmount(bands, t.eligibleSales), 600); // 30,000 × 2%
  assert.equal(salesTarget({ multiplier: 3, mode: 'above', salary: 40000, achieved: 120000 }).eligibleSales, 0); // exactly on target: met, nothing above it yet
});

test("'all': once the target is met the bands apply to every shilling sold", () => {
  const t = salesTarget({ multiplier: 3, mode: 'all', salary: 40000, achieved: 150000 });
  assert.equal(t.eligibleSales, 150000);
  assert.equal(salesTarget({ multiplier: 3, mode: 'all', salary: 40000, achieved: 119999 }).eligibleSales, 0);
});

test('no recorded salary means the commission is held, not paid unchecked; a multiplier of 0 switches the target off', () => {
  const none = salesTarget({ multiplier: 3, mode: 'above', salary: null, achieved: 500000 });
  assert.deepEqual([none.salaryKnown, none.met, none.held, none.eligibleSales], [false, false, true, 0]);
  assert.equal(salesTarget({ multiplier: 3, mode: 'above', salary: 0, achieved: 500000 }).held, true);
  const off = salesTarget({ multiplier: 0, mode: 'above', salary: null, achieved: 70000 });
  assert.deepEqual([off.applies, off.met, off.held, off.eligibleSales], [false, true, false, 70000]);
});

test('refunds can take the month below zero but never below nothing; the multiplier can be fractional', () => {
  assert.equal(salesTarget({ multiplier: 3, mode: 'above', salary: 40000, achieved: -500 }).achieved, 0);
  assert.equal(salesTarget({ multiplier: 2.5, mode: 'above', salary: 40000, achieved: 0 }).required, 100000);
});
