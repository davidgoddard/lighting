import test from "node:test";
import assert from "node:assert/strict";
import { createTangoDirector } from "../tango-director.mjs";

const names=["rhythm","dynamics","harmony","timbre","activityDrop","accent","build","salience","energy","activity"];
function profile(length=40){const traces={time:Array.from({length},(_,i)=>i*.2)};for(const name of names)traces[name]=Array(length).fill(0);
  return{duration:length*.2,samplePeriod:.2,traces};}
const settings={minimumBrightnessPercent:62,maximumBrightnessPercent:100,tangoColourChangeSensitivity:.45,
  tangoAccentFallbackDelaySeconds:1,tangoEventSensitivity:.49,tangoEventMinimumSpacingSeconds:3};

test("director requires the salience-player trace profile",()=>{
  assert.throws(()=>createTangoDirector({timeline:[[0,0,0,0]]}),/profile\.traces/);
});

test("a change-family peak creates a smooth anticipatory colour nudge",()=>{
  const source=profile();source.traces.rhythm[10]=.9;
  const active=createTangoDirector(source,settings,["one"]),quiet=createTangoDirector(source,{...settings,tangoColourChangeSensitivity:.95},["one"]);
  assert.equal(active(1.1).look.fixtureHues.one,quiet(1.1).look.fixtureHues.one);
  assert.notEqual(active(1.7).look.fixtureHues.one,quiet(1.7).look.fixtureHues.one);
  assert.equal(active(2).look.colourCueCount,1);
  assert.match(active(1.7).look.cue,/Arriving at rhythm/);
});

test("activity drops pulse to maximum then recover to background over two seconds",()=>{
  const source=profile();source.traces.activityDrop[10]=.9;
  const director=createTangoDirector(source,settings,["one"]);
  assert.equal(director(2).look.brightness,1);
  assert.ok(Math.abs(director(3).look.brightness-.81)<1e-9);
  assert.equal(director(4).look.brightness,.62);
});

test("idle accents pulse brightness after the configured fallback delay",()=>{
  const source=profile();source.traces.accent[10]=.9;
  const director=createTangoDirector(source,settings,["one"]);
  assert.ok(director(2).look.brightness>.8);
  assert.equal(director(2.5).look.brightness,.62);
  assert.match(director(2).look.cue,/Accent pulse/);
});

test("visible feature activity suppresses accent fallback",()=>{
  const source=profile();source.traces.accent[10]=.9;source.traces.rhythm.fill(.5);
  const director=createTangoDirector(source,settings,["one"]);
  assert.equal(director(2).look.brightness,.62);
});

test("build accelerates independent deterministic wandering lanes",()=>{
  const source=profile();source.traces.build.fill(1,15);
  const director=createTangoDirector(source,settings,["left","right"]),before=director(1),during=director(4);
  assert.equal(before.look.colourAcceleration,1);
  assert.equal(during.look.colourAcceleration,2.8);
  assert.notEqual(during.look.fixtureHues.left,during.look.fixtureHues.right);
  assert.equal(createTangoDirector(source,settings,["left","right"])(4).look.fixtureHues.left,during.look.fixtureHues.left);
});

test("master and fixture trajectories remain separately available",()=>{
  const source=profile(),look=createTangoDirector(source,settings,["left","right"])(3).look;
  assert.notEqual(look.hue,look.fixtureHues.left);
  assert.notEqual(look.fixtureTargets.left,look.fixtureTargets.right);
});

test("screenshot control values select combined events three seconds apart",()=>{
  const source=profile(60);for(const index of [10,15,30])source.traces.salience[index]=.8;
  const look=createTangoDirector(source,settings,["one"])(1).look;
  assert.equal(look.selectedEventCount,2);
});
