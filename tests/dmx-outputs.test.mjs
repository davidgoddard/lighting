import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDmxOutputs, findOpenDmxPort } from '../dmx-outputs.js';
const log = { log() {}, warn() {} };

test('Open DMX accepts either configured adapter without selecting unrelated FTDI ports', () => {
  const old = {path:'/old', serialNumber:'BG00QGXZ', manufacturer:'FTDI'};
  const current = {path:'/current', serialNumber:'B002K1F3', manufacturer:'FTDI'};
  const other = {path:'/other', serialNumber:'OTHER', manufacturer:'FTDI'};
  const config = {serialNumbers:[old.serialNumber, current.serialNumber]};
  assert.equal(findOpenDmxPort([other, old], config), old);
  assert.equal(findOpenDmxPort([other, current], config), current);
  assert.equal(findOpenDmxPort([other], config), undefined);
  assert.equal(findOpenDmxPort([current, old], config), current);
  assert.equal(findOpenDmxPort([current, old], {serialNumber:old.serialNumber}), old);
  assert.equal(findOpenDmxPort([old], {serialNumbers:[current.serialNumber], serialNumber:old.serialNumber}), old);
  assert.equal(findOpenDmxPort([other, old], {...config, path:other.path}), other);
  assert.equal(findOpenDmxPort([other], {}), other);
  for (const serialNumbers of [[], 'invalid', [null], [' ']]) {
    assert.throws(() => findOpenDmxPort([], {serialNumbers}), /serialNumbers/);
  }
});

test('last output disconnects without rejecting frames; reconnect sends current frame', async () => {
  let now = 0, opens = 0, closes = 0, connected = true, detached = false;
  const frames = [];
  const outputs = await createDmxOutputs([async () => {
    opens++;
    if (!connected) return null;
    return { name:'uDMX', send: async frame => {
      if (detached) throw new Error('LIBUSB_ERROR_NO_DEVICE');
      frames.push([...frame]);
    }, close: async () => { closes++; } };
  }], {now:() => now, log});
  await outputs.send(Buffer.from([1]));
  detached = true;
  connected = false;
  assert.equal(await outputs.send(Buffer.from([2])), false);
  assert.equal(outputs.status.connected, false);
  assert.equal(closes, 1);
  now = 4999;
  await outputs.send(Buffer.from([3]));
  assert.equal(opens, 1);
  now = 5000;
  await outputs.send(Buffer.from([4]));
  assert.equal(opens, 2);
  connected = true;
  detached = false;
  now = 10000;
  assert.equal(await outputs.send(Buffer.from([5])), true);
  assert.deepEqual(frames, [[1], [5]]);
  await outputs.close();
  now += 5000;
  assert.equal(await outputs.send(Buffer.from([6])), false);
  assert.equal(opens, 3);
});

test('offline startup recovers; a healthy mirrored output keeps receiving frames', async () => {
  let now = 0, online = false, failed = false, received = 0;
  const outputs = await createDmxOutputs([
    async () => online ? {name:'A', send:async () => { if (failed) throw Error('gone'); }, close:async () => {}} : null,
    async () => online ? {name:'B', send:async () => { received++; }, close:async () => {}} : null
  ], {now:() => now, log});
  assert.equal(outputs.status.connected, false);
  online = true;
  now = 5000;
  await outputs.send(Buffer.alloc(1));
  assert.deepEqual(outputs.status.outputs, ['A','B']);
  failed = true;
  assert.equal(await outputs.send(Buffer.alloc(1)), true);
  assert.deepEqual(outputs.status.outputs, ['B']);
  assert.equal(received, 2);
  await outputs.close();
});

test('a late-enumerating adapter is found during the fast startup retry window', async () => {
  let now = 0, online = false, opens = 0;
  const outputs = await createDmxOutputs([async () => {
    opens++;
    return online ? {name:'uDMX', send:async () => {}, close:async () => {}} : null;
  }], {now:() => now, retryMs:500, log});
  assert.equal(outputs.status.connected, false);
  online = true;
  now = 499;
  await outputs.send(Buffer.alloc(1));
  assert.equal(opens, 1);
  now = 500;
  await outputs.send(Buffer.alloc(1));
  assert.equal(outputs.status.connected, true);
  assert.equal(opens, 2);
  await outputs.close();
});

test('shutdown waits for an in-flight transfer before closing hardware', async () => {
  let finish, started;
  const entered = new Promise(resolve => { started = resolve; });
  const transfer = new Promise(resolve => { finish = resolve; });
  let closed = false;
  const outputs = await createDmxOutputs([async () => ({name:'A', send:async () => { started(); await transfer; }, close:async () => { closed = true; }})], {log});
  const send = outputs.send(Buffer.alloc(1));
  await entered;
  const close = outputs.close();
  assert.equal(closed, false);
  finish();
  await Promise.all([send, close]);
  assert.equal(closed, true);
});
