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

test("dramatic pause uses the V10 lead, hold, and return envelope", () => {
  const config = validateMusicConfig();
  assert.equal(pauseEnvelope(profile, 6.9, config), null);
  assert.equal(pauseEnvelope(profile, 15.2, config).phase, "holding");
  assert.equal(pauseEnvelope(profile, 19, config).phase, "returning");
});
