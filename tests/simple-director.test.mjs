import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimpleDirector } from '../simple-director.mjs';
import { validateMusicConfig } from '../music-intent.js';
const profile = (mean, level = mean) => ({ duration: 120, samplePeriod: .2, meanLoudness: mean, traces: { loudness: Array(600).fill(level) } });
const varying = values => ({ duration: 120, samplePeriod: 1, traces: { loudness: values } });
test('normalised minimum, median and maximum select slow, normal and fast times', () => {
  for (const [values, expected] of [[[1, 2, 3], 24], [[2, 1, 3], 12], [[3, 1, 2], 3]]) {
    assert.equal(createSimpleDirector(varying(values))(0).look.transitionSeconds, expected);
  }
  assert.equal(createSimpleDirector(varying([2, 0, 4, 6, 8]))(0).look.transitionSeconds, 16);
  assert.ok(Math.abs(createSimpleDirector(varying([6, 0, 2, 4, 8]))(0).look.transitionSeconds - 4.8) < 1e-10);
});
test('recording gain does not change trajectories and controls set the limits', () => {
  const values = [1, 4, 2, 3, 8, 4, 2];
  const a = createSimpleDirector(varying(values));
  const b = createSimpleDirector(varying(values.map(x => x * .125)));
  for (const t of [0, 5, 20, 90]) assert.deepEqual(a(t), b(t));
  const config = { simpleNormalSeconds: 10, simpleFastestSeconds: 2, simpleSlowestSeconds: 30 };
  assert.equal(createSimpleDirector(varying([3, 1, 2]), config)(0).look.transitionSeconds, 2);
  assert.equal(createSimpleDirector(varying([1, 3, 2]), config)(0).look.transitionSeconds, 30);
  assert.throws(() => validateMusicConfig({ simpleFastestSeconds: 20 }));
  assert.throws(() => validateMusicConfig({ simpleSlowestSeconds: 2 }));
  assert.throws(() => validateMusicConfig({ simpleNormalSeconds: NaN }));
});
test('flat or missing loudness uses normal pace, including median at either endpoint', () => {
  for (const values of [[0, 0], [4, 4], [], [0, 0, 1], [1, 1, 0]])
    assert.equal(createSimpleDirector(varying(values))(0).look.transitionSeconds, 12);
});
test('targets stay fixed until arrival, hues are continuous and seeks deterministic', () => {
  const at = createSimpleDirector(profile(.1), {}, ['one', 'two']);
  const first = at(0).look, end = first.transitionSeconds;
  assert.equal(at(end / 2).look.targetHue, first.targetHue);
  const arrived = at(end).look.hue;
  assert.ok(Math.abs(((arrived - first.targetHue + 540) % 360) - 180) < 1e-8);
  const before = at(end - .00001).look.hue;
  assert.ok(Math.abs(((arrived - before + 540) % 360) - 180) < .01);
  const saved = at(40); at(90); assert.deepEqual(at(40), saved);
  assert.notEqual(first.fixtureHues.one, first.fixtureHues.two);
});
test('silence stays finite and brightness and saturation stay constant', () => {
  const at = createSimpleDirector(profile(0), { maximumBrightnessPercent: 80 });
  for (const t of [0, 20, 120]) {
    const look = at(t).look;
    assert.ok(Number.isFinite(look.hue));
    assert.equal(look.brightness, .8); assert.equal(look.saturation, 1);
    assert.equal(look.pulseStrength, 0);
  }
  assert.equal(validateMusicConfig().simpleLoudness, true);
  assert.throws(() => validateMusicConfig({ simpleLoudness: 'true' }));
});

test('a loud passage accelerates an existing transition without changing its target', () => {
  const values = Array(100).fill(2); values[0] = 0; values[5] = 4;
  const at = createSimpleDirector(varying(values), { simpleFastestSeconds: 1 });
  const delta = (a, b) => Math.abs(((b - a + 540) % 360) - 180);
  const quietMovement = delta(at(4).look.hue, at(4.1).look.hue);
  const loudMovement = delta(at(5).look.hue, at(5.1).look.hue);
  assert.equal(at(5).look.transitionSeconds, 1);
  assert.equal(at(5).look.targetHue, at(5.1).look.targetHue);
  assert.ok(Math.abs(loudMovement / quietMovement - 12) < 1e-7);
  assert.equal(at(6).look.transitionSeconds, 12);
});
