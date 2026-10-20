import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

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
    ReadlineParser: class {},
    createServer: callback => { handler = callback; return { once() {} }; }
  });
  vm.runInContext(source + '\nglobalThis.api = {createWebServer, createExternalMasterMonitor, validateConfig, createFixtureState, createModeState, renderUniverse, applyMusicRate, transitionHue, transitionProgress, releaseMusicTransitions, musicCanDriveHue};', context);
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
  assert.equal((await h.request('/api/state')).result.fixtures.at(-1).kind, 'bridge');
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

test('music rate advances smooth independent DMX hues without moving static fixtures', () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const now = 1000;
  const states = config.fixtures.slice(0, 2).map(fixture => h.api.createFixtureState(config, fixture, now));
  states[0].transition = {fromHue: 10, toHue: 130, startedAt: now, durationMs: 30000};
  states[1].transition = {fromHue: 220, toHue: 340, startedAt: now, durationMs: 30000};
  const mode = h.api.createModeState(config, now);
  mode.name = 'individual';
  const controls = {masterBrightness:255, mode, musicIntent:{brightness:.7,saturation:.96,influence:1,accent:null}};
  h.api.applyMusicRate(states, mode, now, 44);
  const initial = h.api.renderUniverse(config, states, now, controls);
  const later = h.api.renderUniverse(config, states, now + 1000, controls);
  assert.notDeepEqual([...later], [...initial], 'music must change successive DMX frames');
  assert.equal(states[0].transition.easing, 'smoothstep');
  assert.notEqual(h.api.transitionHue(states[0].transition, now + 1000), h.api.transitionHue(states[1].transition, now + 1000));
  states[1].staticHue = 42;
  const held = h.api.renderUniverse(config, states, now + 1000, controls);
  h.api.applyMusicRate(states, mode, now + 2000, 70);
  const heldLater = h.api.renderUniverse(config, states, now + 2000, controls);
  const address = states[1].fixture.address - 1;
  assert.deepEqual([...heldLater.subarray(address, address + 3)], [...held.subarray(address, address + 3)]);
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

test('zero influence and external master ownership prevent music hue driving', () => {
  const h = harness();
  const config = h.api.validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url))));
  const mode = h.api.createModeState(config, 0);
  config.music.enabled = true;
  config.music.influencePercent = 0;
  assert.equal(h.api.musicCanDriveHue(config, mode, 'READY'), false);
  config.music.influencePercent = 100;
  mode.externalControlled = true;
  assert.equal(h.api.musicCanDriveHue(config, mode, 'READY'), false);
  mode.externalControlled = false;
  assert.equal(h.api.musicCanDriveHue(config, mode, 'READY'), true);
});
