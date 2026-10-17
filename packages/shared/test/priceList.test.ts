import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_FALSE_FOR_TEST } from './priceListHelper.ts';
import { asPriceList, freelancerPrice, priceListsFor, roundToStep } from '../src/priceList.ts';

test('the Freelancer price: the GLM price less the percentage, rounded; a typed price wins; never above GLM', () => {
  assert.equal(freelancerPrice(500, 0, 5), 500); // no percentage: untouched (and not rounded)
  assert.equal(freelancerPrice(1234, 0, 5), 1234);
  assert.equal(freelancerPrice(1234, 10, 5), 1110); // 1,110.6 to the nearest 5
  assert.equal(freelancerPrice(1234, 10, 10), 1110);
  assert.equal(freelancerPrice(1234, 10, 0), 1110.6); // exact
  assert.equal(freelancerPrice(1234, 10, 5, 1000), 1000); // typed by hand
  assert.equal(freelancerPrice(1234, 10, 5, null), 1110);
  assert.equal(freelancerPrice(3, 10, 5), 3); // a small price rounded up to the step would be dearer than GLM: kept at GLM
  assert.equal(freelancerPrice(2, 60, 5), 0.8); // rounds to nothing: the exact figure instead
  assert.equal(freelancerPrice(100, 90, 5), 10);
  assert.equal(roundToStep(12.5, 5), 15);
  assert.equal(roundToStep(12.4, 5), 10);
  assert.equal(asPriceList('freelancer'), 'freelancer');
  assert.equal(asPriceList(undefined), 'glm');
  assert.equal(asPriceList('nonsense'), 'glm');
});

test('who captures under which list', () => {
  const p = (extra: object) => ({ ...ALL_FALSE_FOR_TEST, ...extra }) as never;
  assert.deepEqual(priceListsFor('Admin', p({})), ['glm', 'freelancer']);
  assert.deepEqual(priceListsFor('Front Office', p({ canCaptureOrders: true, canCaptureForOthers: true })), ['glm', 'freelancer']);
  assert.deepEqual(priceListsFor('Staff', p({ canCaptureOrders: true, canAccessDtf: true, canBeAssignedOrders: true })), ['freelancer']); // a sales person
  assert.deepEqual(priceListsFor('Glm staff', p({ canCaptureOrders: true, canAccessDtf: true })), ['glm']);
  assert.deepEqual(priceListsFor('DTF manager', p({ canAccessDtf: true, canManageDtf: true })), ['glm', 'freelancer']);
  assert.deepEqual(priceListsFor('Supervisor', p({ canAccessDtf: true })), ['glm']);
  assert.deepEqual(priceListsFor('Nobody', p({})), []);
});
