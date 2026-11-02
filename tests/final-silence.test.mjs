import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFinalSilence } from '../final-silence.mjs';
const step=.05;
test('recognises quiet tail after music, including hiss',()=>{
  const rms=Array.from({length:200},(_,i)=>i<174?.14+.01*Math.sin(i):.004);
  const at=detectFinalSilence(rms,step,10);
  assert.ok(at!==null && at>=8.5 && at<=9.1,`silence=${at}`);
});
test('does not cut off a loud final chord with no silence',()=>{
  assert.equal(detectFinalSilence(Array.from({length:200},()=>.16),step,10),null);
});
test('a middle pause does not count as terminal silence',()=>{
  const rms=Array.from({length:200},(_,i)=>i>=110&&i<150?.002:.2);
  assert.equal(detectFinalSilence(rms,step,10),null);
});
