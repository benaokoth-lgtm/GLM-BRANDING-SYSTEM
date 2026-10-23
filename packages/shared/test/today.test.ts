import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, todayStr } from '../src/calc.ts';

describe('dates are the calendar day in Nairobi', () => {
  it('today changes at midnight in Nairobi (21:00 UTC), not at midnight UTC', () => {
    assert.equal(todayStr(new Date('2026-10-22T20:59:59Z')), '2026-10-22');
    assert.equal(todayStr(new Date('2026-10-22T21:00:00Z')), '2026-10-23'); // 00:00 in Nairobi
    assert.equal(todayStr(new Date('2026-10-23T00:30:00Z')), '2026-10-23');
    assert.equal(todayStr(new Date('2026-12-31T22:00:00Z')), '2027-01-01'); // a year end
  });

  it('adding days works on calendar dates whatever the machine’s own zone', () => {
    assert.equal(addDays('2026-10-23', 1), '2026-10-24');
    assert.equal(addDays('2026-10-23', -1), '2026-10-22');
    assert.equal(addDays('2024-02-28', 2), '2024-03-01'); // leap year
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });
});
