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

test("activity drops never cause brightness pulses",()=>{
  const source=profile();source.traces.activityDrop[10]=1;
  const director=createTangoDirector(source,settings,["one"]);
  assert.equal(director(2).look.brightness,.62);
  assert.equal(director(2).look.activityDropCount,0);
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

test("rhythmic accents produce rounded half-second pulses during high energy",()=>{
  const source=profile(50);
  source.traces.energy.fill(.85);
  source.traces.accent[20]=1;
  const director=createTangoDirector(source,settings,["one"]);
  const before=director(3.71).look.brightness;
  const shoulder=director(3.85).look.brightness;
  const peak=director(4).look.brightness;
  const after=director(4.15).look.brightness;
  assert.ok(peak>shoulder && shoulder>before);
  assert.ok(peak>after);
  assert.equal(director(4).look.musicalState,"DRAMATIC");
  assert.match(director(4).look.cue,/accent pulse/i);
});

test("terminal drop vetoes ending cues but does not stop build or ordinary wandering",()=>{
  const source=profile(100);
  source.finalSilenceStartSeconds=19.1;
  source.traces.rhythm[96]=1;source.traces.accent[96]=1;
  source.traces.activityDrop[97]=1;
  source.traces.energy.fill(.7);source.traces.build.fill(1);
  const director=createTangoDirector(source,settings,["one"]);
  const ending=director(19.4).look;
  assert.equal(ending.colourCueCount,0);
  assert.equal(ending.activityDropCount,0);
  assert.equal(ending.pulseStrength,0);
  assert.equal(ending.colourAcceleration,2.8);
  assert.match(ending.cue,/Terminal drop ignored/);
  assert.notEqual(director(19.1).look.fixtureHues.one,director(19.8).look.fixtureHues.one);
});

test("terminal drop without a silent tail is ignored while preceding accent survives",()=>{
  const source=profile(100);
  source.traces.energy.fill(.8);
  for(let i=95;i<100;i++)source.traces.energy[i]=0;
  source.traces.rhythm[96]=1;
  source.traces.accent[80]=1;
  source.traces.accent[97]=1;
  const director=createTangoDirector(source,settings,["one"]);
  assert.ok(director(16).look.pulseStrength>0);
  assert.equal(director(19.4).look.pulseStrength,0);
  assert.match(director(19.4).look.cue,/Terminal drop ignored/);
});

test("no detected final silence means cues remain active even in last three seconds",()=>{
  const source=profile(100);
  source.traces.rhythm[91]=1; source.traces.accent[91]=1;
  const director=createTangoDirector(source,settings,["one"]);
  assert.equal(director(18.2).look.colourCueCount,1);
  assert.doesNotMatch(director(19.8).look.cue,/Final silence/);
});
