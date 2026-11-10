import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoudnessColourDirector } from '../loudness-colour.mjs';
const profile = values => ({ duration: values.length - 1, samplePeriod: 1, traces: { loudness: values } });
test('minimum, median and maximum are red with a reverse wheel on each side', () => {
  const at = createLoudnessColourDirector(profile([0, 1, 2, 3, 4, 3, 2, 1, 0]), {}, ['a','b']);
  for (const [time, expected] of [0,180,0,180,0,180,0,180,0].entries()) {
    const look = at(time).look;
    assert.equal(look.hue, expected);
    assert.equal(look.fixtureHues.a, expected);
    assert.equal(look.fixtureHues.b, expected);
    assert.equal(look.saturation, 1);
  }
});
test('interpolates level before hue, including across the red endpoint', () => {
  const at = createLoudnessColourDirector(profile([0, 4, 0]));
  assert.equal(at(.5).look.hue, 180);
  assert.equal(at(1.5).look.hue, 180);
  assert.ok(at(.999).look.hue < 1);
  assert.equal(at(1).look.hue, 0);
  assert.equal(at(.5).look.hue, 180); // seek back
});
test('gain independent; silence and flat tracks are red; config is validated', () => {
  const a = createLoudnessColourDirector(profile([1,2,5]));
  const b = createLoudnessColourDirector(profile([.1,.2,.5]));
  assert.ok(Math.abs(a(.5).look.hue - b(.5).look.hue) < 1e-9);
  for (const values of [[0,0], [4,4], []])
    assert.equal(createLoudnessColourDirector(profile(values))(0).look.hue, 0);
});

test('asymmetric median anchors each half independently with the requested direction', () => {
  // Median is 2, not the range midpoint 5.
  const at = createLoudnessColourDirector(profile([0, 2, 2, 2, 10]));
  assert.equal(at(0).look.hue, 0);
  assert.equal(at(1).look.hue, 0);
  assert.equal(at(4).look.hue, 0);
  assert.ok(Math.abs(at(5 / 6).look.hue - 60) < 1e-8);
  assert.ok(Math.abs(at(3 + 1 / 6).look.hue - 300) < 1e-8);
  assert.ok(Math.abs(at(3 + 1 / 3).look.hue - 240) < 1e-8);
  assert.equal(at(3.5).look.hue, 180);
  assert.ok(Math.abs(at(3 + 2 / 3).look.hue - 120) < 1e-8);
});
test('even sample count uses average middle values and endpoint medians remain finite', () => {
  const at = createLoudnessColourDirector(profile([0, 2, 4, 10]));
  assert.equal(at(1.5).look.hue, 0); // median = 3
  for (const values of [[0,0,4], [0,4,4]]) {
    const sample = createLoudnessColourDirector(profile(values));
    for (const time of [0, .5, 1, 1.5, 2]) assert.ok(Number.isFinite(sample(time).look.hue));
  }
});

test('offset layout spaces anchor hues evenly and preserves both revolutions', () => {
  const p = profile([0, 1, 2, 3, 4]);
  const shared = createLoudnessColourDirector(p);
  const at = createLoudnessColourDirector(p, { loudnessColourMode: 'offsets' }, ['a','b','c']);
  for (const time of [0, .25, 1, 2, 2.5, 4]) {
    const look = at(time).look;
    assert.equal(look.independentFixtures, true);
    assert.deepEqual(Object.values(look.fixtureHues), [0,120,240].map(offset => (shared(time).look.hue + offset) % 360));
  }
});
test('band layout uses each bands own range and median, repeating assignments', () => {
  const p = profile([0,1,2,3,4]);
  p.traces.loudnessBass = [0,1,2,3,4];
  p.traces.loudnessMid = [0,2,2,2,10];
  p.traces.loudnessTreble = [4,3,2,1,0];
  const at = createLoudnessColourDirector(p, { loudnessColourMode: 'bands' }, ['a','b','c','d']);
  const look = at(.5).look;
  for (const [index, name] of ['loudnessBass','loudnessMid','loudnessTreble'].entries()) {
    const expected = createLoudnessColourDirector({ ...p, traces: { loudness: p.traces[name] } })(.5).look.hue;
    assert.equal(look.fixtureHues[['a','b','c'][index]], expected);
  }
  assert.equal(look.fixtureHues.a, look.fixtureHues.d);
  assert.notEqual(look.fixtureHues.a, look.fixtureHues.b);
  assert.equal(look.independentFixtures, true);
});
test('older profiles report full-loudness fallback for missing bands', () => {
  const look = createLoudnessColourDirector(profile([0,1,2]), { loudnessColourMode: 'bands' }, ['a'])(.5).look;
  assert.match(look.cue, /unavailable/);
  assert.ok(Number.isFinite(look.fixtureHues.a));
});

test('individual audio assignments select all or a band and rotate around a chosen base colour', () => {
  const p = profile([0, 1, 2]);
  p.traces.loudnessBass = [0, 1, 2];
  p.traces.loudnessMid = [0, 2, 2];
  p.traces.loudnessTreble = [2, 1, 0];
  const at = createLoudnessColourDirector(p, { loudnessColourMode: 'shared' }, ['low', 'mid', 'off'], {
    low: { mode: 'audio', band: 'bass', baseHue: 30 },
    mid: { mode: 'audio', band: 'middle', baseHue: 120 },
    off: { mode: 'off', band: 'treble', baseHue: 240 }
  });
  const look = at(.5).look;
  const bass = createLoudnessColourDirector({ ...p, traces: { loudness: p.traces.loudnessBass } })(.5).look.hue;
  const middle = createLoudnessColourDirector({ ...p, traces: { loudness: p.traces.loudnessMid } })(.5).look.hue;
  assert.equal(look.fixtureHues.low, (bass + 30) % 360);
  assert.equal(look.fixtureHues.mid, (middle + 120) % 360);
  assert.equal(look.fixtureHues.off, look.hue);
});

test('all uses whole-track loudness and anchors minimum, median and maximum at the base colour', () => {
  const at = createLoudnessColourDirector(profile([0, 5, 10]), {}, ['all'], {
    all: { mode: 'audio', band: 'all', baseHue: 45 }
  });
  for (const time of [0, 1, 2]) assert.equal(at(time).look.fixtureHues.all, 45);
  assert.equal(at(.5).look.fixtureHues.all, 225);
});

test('VU attacks immediately and releases slowly from red towards green', () => {
  const at = createLoudnessColourDirector(profile([2, 10, 2, 2]), {}, ['vu'], {
    vu: { mode: 'audio', band: 'vu', baseHue: 245 }
  });
  assert.equal(at(0).look.fixtureHues.vu, 120);
  assert.equal(at(.25).look.fixtureHues.vu, 0, 'attack completes in one quarter of a sample interval');
  assert.equal(at(1).look.fixtureHues.vu, 0, 'a rising peak reaches red in one sample');
  assert.ok(at(2).look.fixtureHues.vu > 70 && at(2).look.fixtureHues.vu < 90,
    'one second after the peak the meter is still decaying');
  assert.ok(at(3).look.fixtureHues.vu > at(2).look.fixtureHues.vu,
    'continued low input moves progressively closer to green');
});

test('VU uses the unsmoothed meter trace instead of the ambient loudness trace', () => {
  const p = profile([5, 5, 5, 5]);
  p.traces.loudnessVu = [2, 10, 2, 2];
  const at = createLoudnessColourDirector(p, {}, ['vu'], {
    vu: { mode: 'audio', band: 'vu', baseHue: 0 }
  });
  assert.equal(at(0).look.fixtureHues.vu, 120);
  assert.equal(at(1).look.fixtureHues.vu, 0);
  assert.ok(at(2).look.fixtureHues.vu > 70 && at(2).look.fixtureHues.vu < 90);
});
