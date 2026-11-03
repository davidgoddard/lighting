import test from "node:test";
import assert from "node:assert/strict";
import { createTangoDirector } from "../tango-director.mjs";

const names=["rhythm","dynamics","harmony","timbre","activityDrop","accent","build","salience","energy","activity"];
function profile(length=40){const traces={time:Array.from({length},(_,i)=>i*.2)};for(const name of names)traces[name]=Array(length).fill(0);
  return{duration:length*.2,samplePeriod:.2,traces};}
const settings={minimumBrightnessPercent:62,maximumBrightnessPercent:100,tangoColourChangeSensitivity:.45,
  tangoAccentFallbackDelaySeconds:1,tangoEventSensitivity:.49,
  tangoMinimumHueDisplacementDegrees:55,tangoSpeedBoostMultiplier:6,
  tangoSpeedBoostDecayMs:1200,tangoMaximumSpeedMultiplier:18,tangoPulseDelayMs:0};

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

test("nearby salience peaks are all counted, without a spacing gate",()=>{
  const source=profile(60);for(const index of [10,15,30])source.traces.salience[index]=.8;
  const look=createTangoDirector(source,settings,["one"])(1).look;
  assert.equal(look.selectedEventCount,3);
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


test("a speed impulse decays over the configured interval",()=>{
  const source=profile(60);source.traces.salience[10]=1;
  const config={...settings,tangoColourChangeSensitivity:.95,tangoSpeedBoostMultiplier:10,tangoSpeedBoostDecayMs:1000,tangoMaximumSpeedMultiplier:30};
  const director=createTangoDirector(source,config,["one"]);
  assert.equal(director(1.8).look.speedBoost,1);
  assert.ok(director(2).look.speedBoost>=9.99);
  assert.ok(director(2.4).look.speedBoost<4 && director(2.4).look.speedBoost>1);
  assert.ok(director(3).look.speedBoost<1.25);
});

test("closely spaced events add their speed boosts rather than displacing one another",()=>{
  const source=profile(70);source.traces.salience[10]=1;source.traces.salience[12]=1;
  const director=createTangoDirector(source,{...settings,tangoColourChangeSensitivity:.95,
    tangoSpeedBoostMultiplier:10,tangoSpeedBoostDecayMs:1600,tangoMaximumSpeedMultiplier:30},["one"]);
  const combined=director(2.4).look.speedBoost;
  assert.ok(combined>10,`expected compounding, got ${combined}`);
  assert.equal(director(2.4).look.selectedEventCount,2);
});

test("combined acceleration has a configurable hard ceiling",()=>{
  const source=profile(70);source.traces.build.fill(1);
  for(const i of [10,12,14])source.traces.salience[i]=1;
  const director=createTangoDirector(source,{...settings,tangoSpeedBoostMultiplier:12,
    tangoSpeedBoostDecayMs:3500,tangoMaximumSpeedMultiplier:5},["one"]);
  assert.equal(director(2.8).look.colourAcceleration,5);
});

test("higher minimum hue displacement produces a larger nudge",()=>{
  const source=profile(50);source.traces.rhythm[10]=1;
  const low=createTangoDirector(source,{...settings,tangoMinimumHueDisplacementDegrees:30},["one"]);
  const high=createTangoDirector(source,{...settings,tangoMinimumHueDisplacementDegrees:120},["one"]);
  const delta=(a,b)=>Math.abs(((a-b+540)%360)-180);
  assert.ok(delta(high(2).look.fixtureHues.one,high(1.3).look.fixtureHues.one)>=120);
  assert.notEqual(low(2).look.fixtureHues.one,high(2).look.fixtureHues.one);
});

test("new cue-control changes rebuild deterministic frames",()=>{
  const source=profile(60);source.traces.salience[10]=1;
  const slow=createTangoDirector(source,{...settings,tangoSpeedBoostMultiplier:1},["one"]);
  const fast=createTangoDirector(source,{...settings,tangoSpeedBoostMultiplier:10},["one"]);
  assert.notEqual(fast(4).look.fixtureHues.one,slow(4).look.fixtureHues.one);
});


test("pulse-specific delay moves brightness peak later without moving wandering or hue cues",()=>{
  const source=profile(55); source.traces.accent[20]=1;source.traces.energy.fill(.85);
  source.traces.rhythm[11]=1;
  const zero=createTangoDirector(source,{...settings,tangoPulseDelayMs:0},["one"]);
  const late=createTangoDirector(source,{...settings,tangoPulseDelayMs:200},["one"]);
  assert.ok(zero(4).look.pulseStrength>late(4).look.pulseStrength);
  assert.ok(late(4.2).look.pulseStrength>zero(4.2).look.pulseStrength);
  assert.equal(late(4.2).look.pulseDelayMs,200);
  for(const t of [1.8,2.2,4,4.2,5]){
    assert.equal(zero(t).look.fixtureHues.one,late(t).look.fixtureHues.one);
    assert.equal(zero(t).look.colourAcceleration,late(t).look.colourAcceleration);
  }
});

test("raw-audio terminal collapse suppresses late colour and speed impulses",()=>{
  const source=profile(100);source.terminalCollapseStartSeconds=19.1;
  source.traces.energy.fill(.8);
  for(let i=95;i<100;i++)source.traces.energy[i]=.05;
  source.traces.rhythm[97]=1;
  source.traces.salience[97]=1;
  source.traces.accent[97]=1;
  source.traces.salience[70]=1;
  const d=createTangoDirector(source,settings,["one"]);
  assert.equal(d(19.4).look.colourCueCount,0);
  assert.ok(d(19.4).look.speedBoost < 1.001);
  assert.equal(d(19.4).look.pulseStrength,0);
  assert.ok(d(14).look.speedBoost>1);
  assert.match(d(19.4).look.cue,/Terminal drop ignored/);
});

test("ending edge is vetoed if centred features peak shortly before terminal silence",()=>{
  const source=profile(100);source.terminalCollapseStartSeconds=19.2;
  source.traces.energy.fill(.85);
  for(let i=96;i<100;i++)source.traces.energy[i]=.01;
  source.traces.harmony[94]=1; // 18.8s, anticipatory colour start at 18.2s
  source.traces.salience[94]=1;
  const d=createTangoDirector(source,settings,["one"]);
  assert.equal(d(18.5).look.colourCueCount,0);
  assert.equal(d(19).look.speedBoost,1);
});


test("file boundary is never an impulse even without a detectable quiet tail",()=>{
  const source=profile(100);
  source.traces.energy.fill(.75);
  source.traces.rhythm[98]=1; source.traces.salience[98]=1; source.traces.accent[98]=1;
  const d=createTangoDirector(source,settings,["one"]);
  assert.equal(d(19.6).look.colourCueCount,0);
  assert.ok(d(19.6).look.speedBoost < 1.001);
  assert.equal(d(19.6).look.pulseStrength,0);
});
