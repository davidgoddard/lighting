import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBridgeDmx } from '../bridge-dmx.js';

test('DMX binary envelope pads short universes and uses CCITT-FALSE CRC', () => {
  const frame = encodeBridgeDmx(Buffer.from([255, 165, 90, 10]));
  assert.equal(frame.length, 517);
  assert.deepEqual([...frame.subarray(0, 7)], [165, 90, 1, 255, 165, 90, 10]);
  assert.ok(frame.subarray(7, 515).every(byte => byte === 0));
  // Independent polynomial long division (rather than the encoder shift register).
  const bytes = [...frame.subarray(2, 515), 0, 0];
  bytes[0] ^= 255; bytes[1] ^= 255;
  for (let bit = 0; bit < 513 * 8; bit++) {
    if (!(bytes[bit >> 3] & (128 >> (bit % 8)))) continue;
    for (const offset of [0, 4, 11, 16]) {
      const at = bit + offset;
      bytes[at >> 3] ^= 128 >> (at % 8);
    }
  }
  assert.equal(frame.readUInt16LE(515), bytes[513] * 256 + bytes[514]);
  assert.throws(() => encodeBridgeDmx(Buffer.alloc(513)), /512/);
  const full = Buffer.from(Array.from({length:512}, (_, i) => i % 256));
  assert.deepEqual(encodeBridgeDmx(full).subarray(3, 515), full);
});
