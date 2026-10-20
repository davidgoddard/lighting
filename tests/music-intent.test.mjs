import test from "node:test";
import assert from "node:assert/strict";
import { computeMusicIntent, createMusicIntentState, pauseEnvelope, validateMusicConfig } from "../music-intent.js";

const profile = { duration: 30, steps: Array.from({ length: 30 }, (_, time) => ({ time, energy: .6, fastEnergy: .8,
  fastActivity: .7, activity: .65, intensity: .7, drive: .75, development: .1, trend: "STABLE" })),
  pauses: [{ time: 15, end: 15.5, score: .8 }] };

test("music defaults match the production specification", () => {
  const config = validateMusicConfig();
  assert.equal(config.influencePercent, 100); assert.equal(config.transitionSpeedPercent, 220);
  assert.equal(config.minimumBrightnessPercent, 25); assert.equal(config.maximumBrightnessPercent, 100);
  assert.equal(config.gamma, 1.05); assert.equal(config.enabled, false);
});

test("zero influence preserves legacy value and full influence stays bounded", () => {
  const zero = computeMusicIntent(profile, 2, validateMusicConfig({ influencePercent: 0 }), createMusicIntentState(), 1, 1);
  assert.equal(zero.brightness, 1); assert.equal(zero.saturation, 1);
  const full = computeMusicIntent(profile, 2, validateMusicConfig({ enabled: true }), createMusicIntentState(), 1, 1);
  assert.ok(full.brightness >= .25 && full.brightness <= 1); assert.ok(full.hueRate > 1.7);
});

test("transition rate stays slow for simple music and opens up for energetic music", () => {
  const step = values => ({ energy: .5, fastEnergy: .5, fastActivity: .1, activity: .2,
    intensity: .4, drive: .15, development: 0, trend: "STABLE", ...values });
  const simple = { duration: 2, steps: [step(), step()], pauses: [] };
  const energetic = { duration: 2, steps: [step({ fastEnergy: .95, fastActivity: .9, activity: .9,
    intensity: .9, drive: .9 }), step({ fastEnergy: .95, fastActivity: .9, activity: .9, intensity: .9, drive: .9 })], pauses: [] };
  const config = validateMusicConfig({ enabled: true });
  const slowRate = computeMusicIntent(simple, 0, config, createMusicIntentState(), 1, 1).hueRate;
  const fastRate = computeMusicIntent(energetic, 0, config, createMusicIntentState(), 1, 1).hueRate;
  assert.ok(slowRate < 2, `expected a gentle steady rate, got ${slowRate}`);
  assert.ok(fastRate > 90, `expected energetic music to move rapidly, got ${fastRate}`);
  assert.ok(fastRate / slowRate > 50, "expected a wide musical transition range");
});

test("dramatic pause uses a stronger lead dim and short post-return hold", () => {
  const config = validateMusicConfig();
  assert.equal(pauseEnvelope(profile, 6.9, config), null);
  assert.equal(pauseEnvelope(profile, 9, config).brightness, .65);
  assert.equal(pauseEnvelope(profile, 15.2, config).phase, "holding");
  assert.equal(pauseEnvelope(profile, 15.99, config).phase, "holding");
  assert.equal(pauseEnvelope(profile, 16, config).phase, "returning");
  assert.equal(pauseEnvelope(profile, 20.5, config), null);
});
