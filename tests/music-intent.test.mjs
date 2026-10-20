import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMusicIntent, createMusicIntentState, formatMusicDiagnostic, sampleProfile, validateMusicConfig } from "../music-intent.js";

const point = (energy, fast, phrase, development) => [energy, fast, phrase, development];
function profile({ timeline, rhythm, strong = [], edges = [], breaks = [], entrances = [] }) {
  return { duration: timeline.length, hop: 1, timeline, rhythm, rhythmHop: 1,
    phraseMedian: .4, phraseUpper: .7, events: [], strong, edges, breaks, entrances };
}
const calmProfile = profile({ timeline: Array.from({ length: 10 }, () => point(.3, .35, .35, 0)), rhythm: Array.from({ length: 10 }, () => [0, 0, 0]) });

test("prototype control defaults and ranges are preserved", () => {
  const config = validateMusicConfig({});
  assert.deepEqual({ min: config.minimumBrightnessPercent, max: config.maximumBrightnessPercent, gamma: config.gamma,
    rhythm: config.rhythmicMomentumInfluencePercent, energy: config.aboveAverageEnergyInfluencePercent,
    relaxation: config.movementRelaxationMs, speed: config.colourStepSpeedPercent,
    threshold: config.exceptionalKickThresholdPercent, kickTime: config.exceptionalKickColourTimeMs, structure: config.structureEffectsEnabled },
  { min: 25, max: 100, gamma: 1.05, rhythm: 100, energy: 75, relaxation: 2500, speed: 220, threshold: 90, kickTime: 650, structure: true });
  assert.throws(() => validateMusicConfig({ movementRelaxationMs: 300 }));
});

test("track-relative energy and rhythm increase colour progress without note pulses", () => {
  const energetic = profile({ timeline: Array.from({ length: 10 }, () => point(.85, .9, .82, .18)), rhythm: Array.from({ length: 10 }, () => [.85, .8, .7]) });
  const config = validateMusicConfig({ enabled: true });
  const calm = computeMusicIntent(calmProfile, 2, config, createMusicIntentState(), 1, 1);
  const active = computeMusicIntent(energetic, 2, config, createMusicIntentState(), 1, 1);
  assert.ok(active.character > calm.character);
  assert.ok(active.targetTransitionSeconds < calm.targetTransitionSeconds);
  assert.ok(active.baseBrightness > calm.baseBrightness);
  assert.equal(active.kick.triggered, false);
});

test("movement relaxation follows the prototype attack and release", () => {
  const energetic = profile({ timeline: Array.from({ length: 10 }, () => point(.9, .92, .85, .2)), rhythm: Array.from({ length: 10 }, () => [.9, .8, .7]) });
  const config = validateMusicConfig({ enabled: true }), state = createMusicIntentState();
  Object.assign(state, computeMusicIntent(calmProfile, 0, config, state, 0, 1));
  const firstRise = computeMusicIntent(energetic, .05, config, state, .05, 1); Object.assign(state, firstRise);
  const laterRise = computeMusicIntent(energetic, .1, config, state, .1, 1); Object.assign(state, laterRise);
  const firstFall = computeMusicIntent(calmProfile, .15, config, state, .15, 1);
  assert.ok(laterRise.stepRate > firstRise.stepRate);
  assert.ok(firstFall.stepRate > 1 / 35);
});

test("exceptional hit requires track energy, rhythm and four-second cooldown", () => {
  const energetic = profile({ timeline: Array.from({ length: 12 }, () => point(.9, .9, .85, .1)),
    rhythm: Array.from({ length: 12 }, () => [.8, .8, .7]), strong: [{ t: 2, strength: .95 }, { t: 4, strength: 1 }, { t: 7, strength: 1 }] });
  const config = validateMusicConfig({ enabled: true }), state = createMusicIntentState();
  Object.assign(state, computeMusicIntent(energetic, 1.9, config, state, 0, 1));
  const first = computeMusicIntent(energetic, 2.1, config, state, .2, 1); Object.assign(state, first);
  Object.assign(state, computeMusicIntent(energetic, 3.1, config, state, 1.2, 1));
  Object.assign(state, computeMusicIntent(energetic, 3.9, config, state, 2, 1));
  const cooledOut = computeMusicIntent(energetic, 4.1, config, state, 2.2, 1); Object.assign(state, cooledOut);
  Object.assign(state, computeMusicIntent(energetic, 5.1, config, state, 3.2, 1));
  Object.assign(state, computeMusicIntent(energetic, 6.1, config, state, 4.2, 1));
  Object.assign(state, computeMusicIntent(energetic, 6.9, config, state, 5, 1));
  const ready = computeMusicIntent(energetic, 7.1, config, state, 5.2, 1);
  assert.equal(first.kick.triggered, true); assert.equal(cooledOut.kick.triggered, false); assert.equal(ready.kick.triggered, true);
  assert.ok(Math.abs(first.kick.transitionSeconds - .560625) < .001);
});

test("START and STOP edges use the prototype structural envelopes", () => {
  const edged = profile({ timeline: Array.from({ length: 10 }, () => point(.6, .65, .6, 0)), rhythm: Array.from({ length: 10 }, () => [.3, .3, .3]),
    edges: [{ t: 2, kind: "STOP", strength: .8 }, { t: 5, kind: "START", strength: .8 }] });
  const config = validateMusicConfig({ enabled: true }), state = createMusicIntentState();
  Object.assign(state, computeMusicIntent(edged, 1.9, config, state, 0, 1));
  const stop = computeMusicIntent(edged, 2.05, config, state, .15, 1); Object.assign(state, stop);
  const beforeStart = computeMusicIntent(edged, 4.9, config, state, 3, 1); Object.assign(state, beforeStart);
  const start = computeMusicIntent(edged, 5.05, config, state, 3.15, 1);
  assert.equal(stop.structure.mode, "STOP"); assert.equal(stop.structure.speedFactor, .08);
  assert.equal(start.structure.mode, "START"); assert.equal(start.structure.speedFactor, 3);
  assert.equal(start.kick.triggered, true); assert.ok(start.brightness > beforeStart.brightness);
});

test("seek suppresses events and diagnostics expose prototype metrics", () => {
  const edged = profile({ timeline: Array.from({ length: 10 }, () => point(.8, .85, .8, .1)), rhythm: Array.from({ length: 10 }, () => [.7, .7, .6]),
    edges: [{ t: 5, kind: "START", strength: .9 }] });
  const config = validateMusicConfig({ enabled: true }), state = createMusicIntentState();
  Object.assign(state, computeMusicIntent(edged, 1, config, state, 0, 1));
  const sought = computeMusicIntent(edged, 6, config, state, .1, 1);
  assert.equal(sought.kick.triggered, false); assert.equal(sampleProfile(edged, 2).phrase, .8);
  assert.match(formatMusicDiagnostic(2, sought.feature, sought), /momentum=.*steps=.*structure=/);
});
