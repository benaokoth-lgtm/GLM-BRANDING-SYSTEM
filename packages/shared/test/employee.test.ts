import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanKraPin, cleanNationalId, cleanShifNumber } from '../src/employee.ts';

test('a KRA PIN is a letter, nine digits and a letter, stored in capitals', () => {
  assert.deepEqual(cleanKraPin('a123456789b'), { value: 'A123456789B' });
  assert.deepEqual(cleanKraPin(' A123 456 789 b '), { value: 'A123456789B' });
  assert.deepEqual(cleanKraPin(''), { value: null });
  assert.deepEqual(cleanKraPin(null), { value: null });
  for (const bad of ['123456789', 'A12345678B', 'A1234567890B', 'AB123456789', 'A123456789']) assert.ok(cleanKraPin(bad).error, bad);
});

test('a National ID is 7 or 8 digits', () => {
  assert.deepEqual(cleanNationalId('12345678'), { value: '12345678' });
  assert.deepEqual(cleanNationalId('1234567'), { value: '1234567' });
  assert.deepEqual(cleanNationalId(' 123 456 78 '), { value: '12345678' });
  assert.deepEqual(cleanNationalId(''), { value: null });
  for (const bad of ['123456', '123456789', '12345A78']) assert.ok(cleanNationalId(bad).error, bad);
});

test('a SHIF number is tidied and checked loosely', () => {
  assert.deepEqual(cleanShifNumber(' shif-0012345 '), { value: 'SHIF-0012345' });
  assert.deepEqual(cleanShifNumber('CR/1234567'), { value: 'CR/1234567' });
  assert.deepEqual(cleanShifNumber(''), { value: null });
  for (const bad of ['abc', '--12345', 'a'.repeat(30), 'SH IF!']) assert.ok(cleanShifNumber(bad).error, bad);
});
