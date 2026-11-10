import test from 'node:test';
import assert from 'node:assert/strict';
import { hueOffsets, offsetHue } from '../music-handoff.mjs';

test('a newly analysed song inherits each fixture visible hue', () => {
  const shown={one:25,two:317,master:25};
  const incoming={one:292,two:19,master:108};
  const offset=hueOffsets(shown,incoming);
  for (const name of Object.keys(shown))
    assert.ok(Math.abs(offsetHue(incoming[name], offset[name])-shown[name]) < 1e-8);
});

test('a fixture hue offset remains constant over subsequent musical movement', () => {
  const shift=hueOffsets({one:350},{one:20}).one;
  assert.equal(offsetHue(20,shift),350);
  assert.equal(offsetHue(50,shift),20);
});

test('mode handoff starts at displayed colour and smoothly reaches new trajectory across red', async () => {
  const { blendHue } = await import('../music-handoff.mjs');
  assert.equal(blendHue(350, 10, 0), 350);
  assert.equal(blendHue(350, 10, .5), 0);
  assert.equal(blendHue(350, 10, 1), 10);
  assert.equal(blendHue(350, 10, 2), 10);
});
