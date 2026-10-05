import test from 'node:test';
import assert from 'node:assert/strict';
import { whatsappNumber } from '../src/phone.ts';

test('Kenyan numbers in any usual form become the international digits WhatsApp wants', () => {
  for (const raw of ['0797 785 033', '0797785033', '797785033', '+254 797 785 033', '254797785033', '00254797785033', '(0797) 785-033']) {
    assert.equal(whatsappNumber(raw), '254797785033', raw);
  }
  assert.equal(whatsappNumber('0112345678'), '254112345678'); // the newer 01xx lines
});

test('another country code is kept as it is', () => {
  assert.equal(whatsappNumber('+44 7911 123456'), '447911123456');
});

test('something that cannot be a phone number gives nothing', () => {
  for (const raw of ['', '   ', null, undefined, '12345', 'abc', '07977850', '1'.repeat(16)]) assert.equal(whatsappNumber(raw as string | null | undefined), null, String(raw));
});
