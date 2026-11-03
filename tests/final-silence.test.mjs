import test from "node:test";
import assert from "node:assert/strict";
import {detectTerminalCollapse} from "../final-silence.mjs";
const dt=.05;
const wave=(length,fn)=>Array.from({length:Math.ceil(length/dt)},(_,i)=>fn(i*dt));
test("terminal collapse recognises an abrupt noisy ending",()=>{
  const rms=wave(12,t=>t<11.3?.18:.025);
  const at=detectTerminalCollapse(rms,dt,12);
  assert.ok(at>11.0&&at<11.5,`detected ${at}`);
});
test("a musical break well before the ending is not terminal",()=>{
  const rms=wave(12,t=>t>7&&t<7.8?.01:.18);
  assert.equal(detectTerminalCollapse(rms,dt,12),null);
});
test("no audible terminal drop requires no ending veto",()=>{
  const rms=wave(12,t=>.12+.02*Math.sin(t));
  assert.equal(detectTerminalCollapse(rms,dt,12),null);
});
