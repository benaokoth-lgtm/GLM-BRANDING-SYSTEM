import test from 'node:test';
import assert from 'node:assert/strict';
import { composeName, splitName } from '../src/staff.ts';

test('the full name is first, middle and surname with single spaces; the middle name is optional', () => {
  assert.equal(composeName({ firstName: 'Grace', middleName: 'Wanjiru', lastName: 'Njeri' }), 'Grace Wanjiru Njeri');
  assert.equal(composeName({ firstName: ' Grace ', middleName: '', lastName: 'Njeri' }), 'Grace Njeri');
  assert.equal(composeName({ firstName: 'Grace', middleName: '  ', lastName: 'Njeri' }), 'Grace Njeri');
  assert.equal(composeName({ firstName: 'Mary   Ann', lastName: 'Otieno' }), 'Mary Ann Otieno');
});

test('a name typed as one piece is split into first, middle and surname', () => {
  assert.deepEqual(splitName('Ken Mwangi'), { firstName: 'Ken', middleName: '', lastName: 'Mwangi' });
  assert.deepEqual(splitName('Grace Wanjiru Njeri'), { firstName: 'Grace', middleName: 'Wanjiru', lastName: 'Njeri' });
  assert.deepEqual(splitName('Peter Kamau Mwangi Otieno'), { firstName: 'Peter', middleName: 'Kamau Mwangi', lastName: 'Otieno' });
  assert.deepEqual(splitName('  Ann   Lee '), { firstName: 'Ann', middleName: '', lastName: 'Lee' });
});

test('a single word is a first name with no surname yet; nothing gives nothing', () => {
  assert.deepEqual(splitName('BEN'), { firstName: 'BEN', middleName: '', lastName: '' });
  assert.deepEqual(splitName(''), { firstName: '', middleName: '', lastName: '' });
  assert.deepEqual(splitName(null), { firstName: '', middleName: '', lastName: '' });
});
