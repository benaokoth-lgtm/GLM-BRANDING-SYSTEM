import test from 'node:test';
import assert from 'node:assert/strict';
import { computePay, nssfUpperLimit } from '../src/tax.ts';

const r2 = (n: number) => Math.round(n * 100) / 100;

test('NSSF: 6% of pay up to the Upper Earnings Limit, which steps up each February', () => {
  assert.equal(nssfUpperLimit('2026-03-01'), 108000);
  assert.equal(nssfUpperLimit('2026-01-31'), 72000);
  assert.equal(nssfUpperLimit('2025-06-15'), 72000);
  assert.equal(nssfUpperLimit('2024-06-15'), 36000);
  assert.equal(nssfUpperLimit('2023-06-15'), 18000);
  assert.equal(nssfUpperLimit(), 108000); // no date: the latest limit
});

test('an employee on 100,000: NSSF, SHIF and the housing levy come off before PAYE; the employer matches NSSF and the levy on top', () => {
  const p = computePay(100000, 'Employee', '2026-05-28');
  assert.equal(p.nssf, 6000);
  assert.equal(p.shif, 2750);
  assert.equal(p.housingLevy, 1500);
  assert.equal(p.taxablePay, 89750); // 100,000 − 6,000 − 2,750 − 1,500
  // bands: 24,000 × 10% + 8,333 × 25% + (89,750 − 32,333) × 30%
  assert.equal(r2(p.taxCharged), 21708.35);
  assert.equal(p.personalRelief, 2400);
  assert.equal(r2(p.paye), 19308.35);
  assert.equal(r2(p.totalDeductions), 29558.35); // PAYE + NSSF + SHIF + levy — the employee's shares only
  assert.equal(r2(p.netPay), 70441.65);
  assert.equal(p.nssfEmployer, 6000);
  assert.equal(p.housingLevyEmployer, 1500);
});

test('NSSF stops at the Upper Earnings Limit for the date of the pay', () => {
  const now = computePay(200000, 'Employee', '2026-03-01');
  assert.equal(now.nssf, 6480); // 6% of 108,000
  assert.equal(now.nssfEmployer, 6480);
  assert.equal(computePay(100000, 'Employee', '2025-06-01').nssf, 4320); // 6% of 72,000
  // 200,000 − 6,480 − 5,500 − 3,000 = 185,020 → 2,400 + 2,083.25 + 152,687 × 30% = 50,289.35 → less relief 2,400
  assert.equal(r2(now.taxablePay), 185020);
  assert.equal(r2(now.paye), 47889.35);
});

test('a low earner: the personal relief cannot make PAYE negative', () => {
  const p = computePay(20000, 'Employee', '2026-05-28');
  assert.equal(p.nssf, 1200);
  assert.equal(p.shif, 550);
  assert.equal(p.housingLevy, 300);
  assert.equal(p.taxablePay, 17950);
  assert.equal(r2(p.taxCharged), 1795);
  assert.equal(r2(p.personalRelief), 1795);
  assert.equal(p.paye, 0);
  assert.equal(r2(p.netPay), 17950); // 20,000 − 1,200 − 550 − 300
});

test('SHIF has a minimum of 300', () => {
  assert.equal(computePay(5000, 'Employee', '2026-05-28').shif, 300);
});

test('casual staff carry no statutory deductions', () => {
  const c = computePay(8000, 'Casual', '2026-05-28');
  assert.deepEqual([c.paye, c.nssf, c.shif, c.housingLevy, c.nssfEmployer, c.housingLevyEmployer, c.netPay], [0, 0, 0, 0, 0, 0, 8000]);
});
