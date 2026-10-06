import test from 'node:test';
import assert from 'node:assert/strict';
import { isWeakPin, pinProblem, requiredPinLength } from '../src/pin.ts';

test('the Admin and any role that touches money, costs, pay or the books needs 6 digits; others 4', () => {
  assert.equal(requiredPinLength('Admin'), 6);
  assert.equal(requiredPinLength('Sales', { canCaptureOrders: true }), 4);
  assert.equal(requiredPinLength('Cashier', { canManagePayments: true }), 6);
  assert.equal(requiredPinLength('Finance Manager', { canAccessFinance: true, canAccessAccounting: true }), 6);
  assert.equal(requiredPinLength('Lead', { canSeeCosts: true }), 6);
  assert.equal(requiredPinLength('Nobody', null), 4);
});

test('obvious PINs are refused: repeats, runs up or down, repeated pairs, and the common ones', () => {
  for (const p of ['0000', '1111', '999999', '1234', '4321', '0123', '123456', '654321', '7890', '1212', '123123', '2580', '1122']) assert.equal(isWeakPin(p), true, p);
  for (const p of ['4821', '0427', '739104', '580913', '1357'.replace('1357', '3917')]) assert.equal(isWeakPin(p), false, p);
});

test('a PIN is checked for digits, length for the role, and obviousness — with a reason in words', () => {
  assert.equal(pinProblem('4821', 'Sales', {}), null);
  assert.match(pinProblem('48a1', 'Sales', {}) ?? '', /digits only/);
  assert.match(pinProblem('482', 'Sales', {}) ?? '', /at least 4/);
  assert.match(pinProblem('4821', 'Admin') ?? '', /6-digit/);
  assert.equal(pinProblem('739104', 'Admin'), null);
  assert.match(pinProblem('1234', 'Sales', {}) ?? '', /too easy/);
  assert.match(pinProblem('1234567', 'Sales', {}) ?? '', /at most 6/);
  assert.equal(pinProblem('48215', 'Sales', {}), null); // longer than needed is fine
});
