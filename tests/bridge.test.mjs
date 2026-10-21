import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { validateMusicConfig } from '../music-intent.js';

// Exercise the real server and serial monitor with hardware replaced at their boundaries.
const source = readFileSync(new URL('../lighting.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(new URL('../lighting.js', import.meta.url).href)).replace(/main\(\)\.catch\([\s\S]*$/, '');
function harness() {
  let handler, port;
  class SerialPort extends EventEmitter {
    static async list() { return [{ path: '/test', vendorId: '1a86' }]; }
    constructor() { super(); port = this; this.writes = []; }
    pipe() { this.parser = new EventEmitter(); return this.parser; }
    open(callback) { this.isOpen = true; callback(); }
    write(data, callback) { this.writes.push(data); callback?.(); }
    close(callback) { this.isOpen = false; this.emit('close'); callback?.(); }
  }
  const context = vm.createContext({
    process: { argv: [], cwd: () => '/tmp' }, URL, Buffer, performance, console,
    setTimeout, clearTimeout, setInterval, clearInterval, SerialPort,
    ReadlineParser: class {}, validateMusicConfig,
    createServer: callback => { handler = callback; return { once() {} }; }
  });
  vm.runInContext(source + '\nglobalThis.api = {createWebServer, createExternalMasterMonitor, validateConfig, createFixtureState, createModeState, renderUniverse, applyMusicMotion, transitionHue, transitionProgress, releaseMusicTransitions, musicCanDriveHue, updateMode, setIndividualMode};', context);
  return { api: context.api, port: () => port, request: async (path, body) => {
    const request = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method: body ? 'POST' : 'GET', url: path });
    let status, result;
    const response = { setHeader() {}, writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); } };
    const pending = handler(request, response);
    await pending;
    return { status, result };
  }};
}

test('bridge-only commands, mixed selection validation, and disconnection', async () => {
  const h = harness();
  const config = { ...JSON.parse(readFileSync(new URL('../config.json', import.meta.url))), externalMaster: {enabled:true, vendorId:0x1a86, baudRate:115200, scanSeconds:5} };
  const mode = {name:'individual', masterTransition:{fromHue:0, toHue:0, startedAt:performance.now(), durationMs:1000}};
  const monitor = h.api.createExternalMasterMonitor(config, [], mode);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.port().writes[0], 'BRIDGE?\n');
  assert.equal(monitor.tableFixture().length, 0, 'legacy firmware must not expose controls');
  h.port().parser.emit('data', 'TABLE: {"static":false,"hue":0}');
  const dmx = { fixture:{id:'floor-1',name:'Floor',address:1}, staticHue:42, pairLeaderId:null,
    transition:{fromHue:42,toHue:60,startedAt:performance.now(),durationMs:1000} };
  h.api.createWebServer(config, [dmx], mode, {}, monitor);
  const initialState = (await h.request('/api/state')).result;
  assert.ok(initialState.fixtures, JSON.stringify(initialState));
  assert.equal(initialState.fixtures.at(-1).kind, 'bridge');
  const selected = { fixtureIds:['@table-lights'], hue:120 };
  assert.equal((await h.request('/api/static', selected)).status, 200);
  assert.equal(h.port().writes.at(-1), 'STATIC 120\n');
  assert.equal(mode.name, 'individual', 'table commands must not change DMX master mode');
  assert.equal(monitor.tableFixture()[0].mode, 'static');
  assert.equal(dmx.staticHue, 42, 'unselected DMX fixture must stay unchanged');
  assert.equal((await h.request('/api/static', {...selected, fixtureIds:['@table-lights','floor-1'], hue:90})).status, 200);
  assert.equal(dmx.staticHue, 90);
  const count = h.port().writes.length;
  assert.equal((await h.request('/api/static', {...selected, fixtureIds:['@table-lights','missing']})).status, 400);
  assert.equal((await h.request('/api/static', {...selected, hue:'bad'})).status, 400);
  assert.equal(h.port().writes.length, count);
  assert.equal((await h.request('/api/wander', {fixtureIds:['@table-lights']})).status, 200);
  assert.equal(h.port().writes.at(-1), 'WANDER\n');
  assert.equal((await h.request('/api/pair', {fixtureIds:['@table-lights','missing']})).status, 400);
  await monitor.close();
  assert.equal(monitor.tableFixture().length, 0);
  assert.equal((await h.request('/api/static', selected)).status, 400);
});

test('mixed pairs follow a DMX leader, support control from either member, and unpair cleanly', async () => {
  const h = harness();
  const config = { ...JSON.parse(readFileSync(new URL('../config.json', import.meta.url))), externalMaster: {enabled:true, vendorId:0x1a86, baudRate:115200, scanSeconds:5} };
  const now = performance.now();
  const mode = {name:'individual', masterTransition:{fromHue:0,toHue:0,startedAt:now,durationMs:1000}};
  const states = ['a','b','c'].map((id, i) => ({fixture:{id,name:id,address:i+1}, staticHue:30+i*60, pairLeaderId:null,
    transition:{fromHue:0,toHue:100,startedAt:now,durationMs:10000}}));
  const monitor = h.api.createExternalMasterMonitor(config, states, mode);
  await new Promise(resolve => setImmediate(resolve));
  h.port().parser.emit('data', 'TABLE: {"static":false,"hue":0}');
  h.api.createWebServer(config, states, mode, {}, monitor);
  const pair = await h.request('/api/pair', {fixtureIds:['@table-lights','a']});
  assert.equal(pair.status, 200);
  assert.equal(pair.result.leaderId, 'a');
  assert.equal(monitor.tableFixture()[0].pairLeaderId, 'a');
  assert.equal(h.port().writes.at(-1), 'STATIC 30\n');
  h.port().parser.emit('data', 'TABLE: {"static":false,"hue":0}');
  await monitor.syncTablePair(now+1000);
  assert.equal(h.port().writes.at(-1), 'STATIC 30\n', 'bridge reboot reasserts paired colour');
  assert.equal((await h.request('/api/static', {fixtureIds:['@table-lights'],hue:180})).status, 200);
  assert.equal(states[0].staticHue, 180);
  assert.equal(states[1].staticHue, 90, 'unselected DMX fixture stays unchanged');
  const dmxChange = await h.request('/api/static', {fixtureIds:['a'],hue:240});
  assert.ok(dmxChange.result.updated.includes('@table-lights'));
  assert.equal(h.port().writes.at(-1), 'STATIC 240\n');
  const resumed = await h.request('/api/wander', {fixtureIds:['@table-lights']});
  assert.equal(resumed.status, 200);
  assert.equal(states[0].staticHue, null);
  assert.equal(monitor.tableFixture()[0].mode, 'wander');
  states[0].transition = {fromHue:0,toHue:100,startedAt:now,durationMs:10000};
  await monitor.syncTablePair(now+5000, true);
  assert.equal(h.port().writes.at(-1), 'STATIC 50\n');
  const writes = h.port().writes.length;
  await monitor.syncTablePair(now+5010);
  assert.equal(h.port().writes.length, writes, 'follow updates are throttled');
  // Extend the pair, then remove its leader: tables follow the remaining DMX member.
  assert.equal((await h.request('/api/pair', {fixtureIds:['a','b']})).status, 200);
  assert.equal((await h.request('/api/unpair', {fixtureIds:['a']})).status, 200);
  assert.equal(monitor.tableFixture()[0].pairLeaderId, 'b');
  assert.equal((await h.request('/api/unpair', {fixtureIds:['@table-lights']})).status, 200);
  assert.equal(monitor.tableFixture()[0].pairLeaderId, null);
  assert.equal(states[1].pairLeaderId, null);
  assert.equal(h.port().writes.at(-1), 'WANDER\n');
  const count = h.port().writes.length;
  await monitor.syncTablePair(now+6000, true);
  assert.equal(h.port().writes.length, count, 'unpaired tables are no longer driven');
  await monitor.close();
});

test('table music master rate-limits destinations, handles kicks and returns to autonomous mode', async () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const mode = h.api.createModeState(config, 0); mode.name = 'master';
  const monitor = h.api.createExternalMasterMonitor(config, [], mode);
  await new Promise(resolve => setImmediate(resolve));
  h.port().parser.emit('data', 'TABLE: {"static":false,"hue":40}');
  const ordinary = {effectiveTransitionSeconds:8,character:.4,structure:{mode:'NORMAL'},kick:{triggered:false}};
  const transition = {fromHue:40,toHue:120,startedAt:1000,durationMs:8000};
  assert.equal(await monitor.syncMusicMaster(transition, ordinary, 1000), true);
  assert.match(h.port().writes.at(-1), /^MASTER [\d.]+ 8000\n$/);
  const count = h.port().writes.length;
  assert.equal(await monitor.syncMusicMaster(transition, ordinary, 1100), false);
  assert.equal(h.port().writes.length, count, 'ordinary frames must be deduplicated');
  const kick = {...ordinary, structure:{mode:'START'}, kick:{triggered:true,transitionSeconds:.55}};
  const kickTransition = {fromHue:50,toHue:240,startedAt:1300,durationMs:550};
  assert.equal(await monitor.syncMusicMaster(kickTransition, kick, 1300), true);
  assert.match(h.port().writes.at(-1), /^MASTER 240 550\n$/);
  assert.equal(await monitor.holdMusicMaster(80, 1500), true);
  assert.match(h.port().writes.at(-1), /^MASTER [\d.]+ 90000\n$/);
  assert.equal(await monitor.holdMusicMaster(80, 1600), false, 'pause hold is sent once');
  assert.equal(await monitor.releaseMusicMaster(), true);
  assert.equal(h.port().writes.at(-1), 'WANDER\n');
  const ordinaryMaster = {fromHue:80,toHue:170,startedAt:1700,durationMs:5000};
  assert.equal(await monitor.syncMusicMaster(ordinaryMaster, null, 1800), true,
    'master mode must mirror DMX even without a ready music intent');
  assert.match(h.port().writes.at(-1), /^MASTER 170 4900\n$/);
  await monitor.close();
  assert.equal(await monitor.syncMusicMaster(transition, ordinary, 2000), false, 'disconnect is harmless');
});

test('music master mode gives every automatic DMX fixture one shared trajectory', () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const states = config.fixtures.slice(0, 3).map((fixture, index) => {
    const state = h.api.createFixtureState(config, fixture, 0);
    state.transition = {fromHue:index * 90,toHue:index * 90 + 30,startedAt:0,durationMs:10000};
    return state;
  });
  const mode = h.api.createModeState(config, 0); mode.name = 'master';
  const intent = {effectiveTransitionSeconds:8,character:.4,structure:{mode:'NORMAL'},kick:{triggered:false}};
  h.api.applyMusicMotion(config, states, mode, 1000, intent, () => 160);
  assert.ok(states.every(state => state.transition.toHue === states[0].transition.toHue));
  h.api.applyMusicMotion(config, states, mode, 2000, intent, () => 260);
  assert.ok(states.every(state => state.transition.progress === states[0].transition.progress));
});

test('master entry and exit use protected subtle blend periods', () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const states = config.fixtures.slice(0, 3).map((fixture, index) => {
    const state = h.api.createFixtureState(config, fixture, 0);
    state.transition = {fromHue:index * 80,toHue:index * 80 + 30,startedAt:0,durationMs:10000};
    return state;
  });
  const mode = h.api.createModeState(config, 0);
  mode.individualUntil = 0;
  h.api.updateMode(config, states, mode, 1000);
  assert.equal(mode.name, 'master');
  assert.ok(mode.masterTransition.durationMs >= 2000 && mode.masterTransition.durationMs <= 5000);
  assert.equal(mode.masterTransition.easing, 'smoothstep');
  assert.ok(states.every(state => state.transition.toHue === states[0].transition.toHue));
  assert.ok(states.every(state => state.transition.easing === 'smoothstep'));
  const entryTarget = mode.masterTransition.toHue;
  const intent = {effectiveTransitionSeconds:.5,character:1,structure:{mode:'START'},
    kick:{triggered:true,retargeted:false,transitionSeconds:.25}};
  h.api.applyMusicMotion(config, states, mode, 1100, intent, () => 300);
  assert.equal(mode.masterTransition.toHue, entryTarget, 'music must not replace the entry blend');

  const exitAt = 2000;
  h.api.setIndividualMode(config, states, mode, exitAt);
  assert.equal(mode.name, 'individual');
  for (const state of states) {
    assert.ok(state.transition.durationMs >= 2000 && state.transition.durationMs <= 10000);
    assert.equal(state.transition.easing, 'smoothstep');
    assert.equal(state.transition.masterExit, true);
  }
  const exitTargets = states.map(state => state.transition.toHue);
  h.api.applyMusicMotion(config, states, mode, exitAt + 100, intent, () => 300);
  assert.deepEqual(states.map(state => state.transition.toHue), exitTargets,
    'music must not replace independent exit blends');
});

test('paired DMX renders changing ESP master colours after releasing a static hold', async () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const now = performance.now();
  const states = [h.api.createFixtureState(config, config.fixtures[0], now)];
  const id = states[0].fixture.id;
  const mode = h.api.createModeState(config, now);
  const controls = {masterBrightness:255, mode};
  const monitor = h.api.createExternalMasterMonitor(config, states, mode);
  await new Promise(resolve => setImmediate(resolve));
  h.port().parser.emit('data', 'TABLE: {"static":false,"hue":0}');
  h.api.createWebServer(config, states, mode, controls, monitor);
  await h.request('/api/static', {fixtureIds:[id],hue:10});
  await h.request('/api/pair', {fixtureIds:[id,'@table-lights']});
  h.port().parser.emit('data', 'UDP: 120,5000,1,true');
  assert.equal(mode.name, 'master');
  assert.equal(states[0].staticHue, 10, 'master messages must respect the user static hold');
  const held = h.api.renderUniverse(config, states, performance.now(), controls);
  const response = await h.request('/api/wander', {fixtureIds:['@table-lights']});
  assert.equal(response.status, 200);
  assert.equal(states[0].staticHue, null);
  assert.equal(states[0].transition.toHue, 120);
  const end = states[0].transition.startedAt + states[0].transition.durationMs;
  const following = h.api.renderUniverse(config, states, end, controls);
  assert.notDeepEqual(following, held, 'actual DMX channel data must change');
  const start = states[0].fixture.address - 1;
  const channels = states[0].fixture.type.channels;
  assert.equal(following[start + channels.green - 1], 255);
  assert.equal(following[start + channels.red - 1], 0);
  await monitor.syncTablePair(end, true);
  assert.equal(h.port().writes.at(-1), 'STATIC 120\n');
  await monitor.close();
});

test('music timing advances smooth independent DMX hues without moving static fixtures', () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const now = 1000;
  const states = config.fixtures.slice(0, 2).map(fixture => h.api.createFixtureState(config, fixture, now));
  states[0].transition = {fromHue: 10, toHue: 130, startedAt: now, durationMs: 30000};
  states[1].transition = {fromHue: 220, toHue: 340, startedAt: now, durationMs: 30000};
  const mode = h.api.createModeState(config, now);
  mode.name = 'individual';
  const controls = {masterBrightness:255, mode, musicIntent:{brightness:.7,saturation:.96,influence:1,accent:null}};
  const intent = {effectiveTransitionSeconds:4, targetTransitionSeconds:4, kick:{triggered:false,retargeted:false}};
  h.api.applyMusicMotion(config, states, mode, now, intent);
  const initial = h.api.renderUniverse(config, states, now, controls);
  h.api.applyMusicMotion(config, states, mode, now + 1000, intent);
  const later = h.api.renderUniverse(config, states, now + 1000, controls);
  assert.notDeepEqual([...later], [...initial], 'music must change successive DMX frames');
  assert.equal(states[0].transition.easing, 'linear');
  assert.notEqual(h.api.transitionHue(states[0].transition, now + 1000), h.api.transitionHue(states[1].transition, now + 1000));
  states[1].staticHue = 42;
  const held = h.api.renderUniverse(config, states, now + 1000, controls);
  h.api.applyMusicMotion(config, states, mode, now + 2000, intent);
  const heldLater = h.api.renderUniverse(config, states, now + 2000, controls);
  const address = states[1].fixture.address - 1;
  assert.deepEqual([...heldLater.subarray(address, address + 3)], [...held.subarray(address, address + 3)]);
});

test('changing musical duration preserves hue continuity and forward progress', () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const state = h.api.createFixtureState(config, config.fixtures[0], 0);
  state.transition = {fromHue:355,toHue:370,startedAt:0,durationMs:10000};
  const mode = h.api.createModeState(config, 0); mode.name='individual';
  const slow = {effectiveTransitionSeconds:20,targetTransitionSeconds:20,kick:{triggered:false,retargeted:false}};
  const picker = () => 10;
  h.api.applyMusicMotion(config,[state],mode,0,slow,picker);
  h.api.applyMusicMotion(config,[state],mode,1000,slow,picker);
  const before = h.api.transitionHue(state.transition,1000), progress = h.api.transitionProgress(state.transition,1000);
  const fast = {effectiveTransitionSeconds:4,targetTransitionSeconds:4,kick:{triggered:false,retargeted:false}};
  h.api.applyMusicMotion(config,[state],mode,1025,fast,picker);
  const after = h.api.transitionHue(state.transition,1025);
  assert.ok(after >= before && after - before < 1, 'duration change must move smoothly forward');
  assert.ok(h.api.transitionProgress(state.transition,1025) > progress);
  assert.ok(after > 355 && after < 370, 'wraparound follows the short 15 degree path');
});

test('strong kick commits to a fresh rapid target until the transition completes', () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const state = h.api.createFixtureState(config, config.fixtures[0], 0);
  state.transition = {fromHue:0,toHue:20,startedAt:0,durationMs:20000};
  const mode = h.api.createModeState(config, 0); mode.name = 'individual';
  const kick = {effectiveTransitionSeconds:12,targetTransitionSeconds:18,
    kick:{triggered:true,retargeted:false,transitionSeconds:.6}};
  h.api.applyMusicMotion(config,[state],mode,1000,kick,() => 120);
  assert.equal(state.transition.toHue, 120);
  assert.equal(state.transition.durationMs, 600);
  assert.equal(state.transition.easing, 'easeOutQuad');
  const ordinary = {effectiveTransitionSeconds:18,targetTransitionSeconds:18,kick:{triggered:false,retargeted:false}};
  h.api.applyMusicMotion(config,[state],mode,1100,ordinary,() => 240);
  assert.equal(state.transition.toHue, 120, 'following analysis frames must not replace the kick target');
  assert.equal(state.transition.durationMs, 600, 'following analysis frames must not lengthen the kick');
});

test('state exposes the final RGB used by web emulation', async () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const states = [h.api.createFixtureState(config, config.fixtures[0], 0)];
  const mode = h.api.createModeState(config, 0);
  const controls = {masterBrightness:255, mode, musicIntent:{brightness:.4,saturation:1,influence:1,accent:null}};
  h.api.createWebServer(config, states, mode, controls, {}, null);
  const state = await h.request('/api/state');
  assert.deepEqual(Object.keys(state.result.fixtures[0].finalRgb), ['red','green','blue']);
});

test('strong drama completes several deterministic colour destinations in twenty seconds', () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const state = h.api.createFixtureState(config, config.fixtures[0], 0);
  state.transition = {fromHue:0,toHue:90,startedAt:0,durationMs:30000};
  const mode = h.api.createModeState(config, 0); mode.name='individual';
  const intent = {effectiveTransitionSeconds:4,targetTransitionSeconds:4,kick:{triggered:false,retargeted:false}};
  const targets = [180,270,20,120,220,320]; let picked = 0, previousHue = 0;
  const picker = () => targets[picked++ % targets.length];
  for (let now = 0; now <= 20_000; now += 25) {
    h.api.applyMusicMotion(config,[state],mode,now,intent,picker);
    const hue = h.api.transitionHue(state.transition,now);
    const delta = Math.abs((((hue - previousHue) % 360) + 540) % 360 - 180);
    assert.ok(delta < 3, `frame-to-frame hue movement must stay smooth, got ${delta}`);
    previousHue = hue;
  }
  assert.ok(picked >= 4, `expected several fresh destinations, got ${picked}`);
});

test('music value uses a dedicated dimmer once rather than dimming RGB twice', () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const fixture = config.fixtures.find(item => 'brightness' in item.type.channels);
  const state = h.api.createFixtureState(config, fixture, 0);
  state.transition = {fromHue: 0, toHue: 0, startedAt: 0, durationMs: 1000};
  const mode = h.api.createModeState(config, 0);
  const universe = h.api.renderUniverse(config, [state], 0, {
    masterBrightness: 255,
    mode,
    musicIntent: {brightness:.5,saturation:.96,influence:1,accent:null},
  });
  const start = fixture.address - 1;
  assert.equal(universe[start + fixture.type.channels.red - 1], 255);
  assert.equal(universe[start + fixture.type.channels.brightness - 1], 128);
});

test('music hue driving follows playback readiness even while table master mode is active', () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const mode = h.api.createModeState(config, 0);
  config.music.enabled = true;
  assert.equal(h.api.musicCanDriveHue(config, mode, 'PAUSED'), false);
  mode.externalControlled = true;
  assert.equal(h.api.musicCanDriveHue(config, mode, 'READY'), true);
});
