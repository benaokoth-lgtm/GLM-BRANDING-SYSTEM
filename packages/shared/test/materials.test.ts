import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSizes, materialName } from '../src/materials.ts';

test('a line is named by its item and size; an item with no size is just its name', () => {
  assert.equal(materialName('Polo Shirt', 'L'), 'Polo Shirt — L');
  assert.equal(materialName('  Polo   Shirt ', ' XL '), 'Polo Shirt — XL');
  assert.equal(materialName('Cap', ''), 'Cap');
  assert.equal(materialName('Cap', null), 'Cap');
});

test('sizes sort the way people expect: clothing sizes in order, then numbers, then the rest A to Z', () => {
  const shuffled = ['XL', 'M', '42', 'S', 'XXL', '38', 'Large print', 'L', '2XL', 'A4'];
  assert.deepEqual([...shuffled].sort(compareSizes), ['S', 'M', 'L', 'XL', 'XXL', '2XL', '38', '42', 'A4', 'Large print']);
});
