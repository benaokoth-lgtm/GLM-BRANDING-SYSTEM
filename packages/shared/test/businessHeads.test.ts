import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BUSINESS_HEADS, defaultBusinessHeadName } from '../src/businessHeads.ts';

test('the business starts with six heads', () => {
  assert.deepEqual([...DEFAULT_BUSINESS_HEADS], ['DTF Printing', 'UV Printing', 'Laser Engraving', 'Large Format Printing', 'Embroidery', 'General Order']);
});

test('a service lands under the obvious head, and General Order when nothing fits', () => {
  assert.equal(defaultBusinessHeadName('DTF Printing'), 'DTF Printing');
  assert.equal(defaultBusinessHeadName('DTF Sheet (per metre)'), 'DTF Printing');
  assert.equal(defaultBusinessHeadName('Embroidery — cap logo'), 'Embroidery');
  assert.equal(defaultBusinessHeadName('Laser engraving on glass'), 'Laser Engraving');
  assert.equal(defaultBusinessHeadName('UV flatbed print'), 'UV Printing');
  assert.equal(defaultBusinessHeadName('Large format poster'), 'Large Format Printing');
  assert.equal(defaultBusinessHeadName('Banner printing'), 'Large Format Printing');
  assert.equal(defaultBusinessHeadName('Eulogy printing'), 'General Order');
  assert.equal(defaultBusinessHeadName('Screen printing'), 'General Order');
  assert.equal(defaultBusinessHeadName('Business cards'), 'General Order'); // "uv" inside another word is not UV
});
