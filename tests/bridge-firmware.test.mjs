import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeBridgeDmx } from '../bridge-dmx.js';

test('real firmware parser accepts app frames with RX capacity and rejects truncated or corrupt input', t => {
  const compiler = spawnSync('c++', ['--version']);
  if (compiler.error?.code === 'ENOENT') return t.skip('C++ compiler unavailable');
  assert.equal(compiler.status, 0);
  const firmware = readFileSync(new URL('../table-lights/DMX-bridge/tango_light_3_esp32_c3_bridge/tango_light_3_esp32_c3_bridge.ino', import.meta.url), 'utf8');
  const capacity = Number(/Serial\.setRxBufferSize\((\d+)\)/.exec(firmware)[1]);
  const crc = firmware.slice(firmware.indexOf('uint16_t crc16('), firmware.indexOf('// IDF sends'));
  const parser = firmware.slice(firmware.indexOf('// Input parser:'), firmware.indexOf('void setup()'));
  const frame = encodeBridgeDmx(Buffer.from(Array.from({length:512}, (_, i) => i % 256)));
  const source = `
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <cassert>
#include <algorithm>
uint32_t clockMs = 0;
uint32_t millis() { return clockMs; }
uint8_t universe[513] = {};
int universeMutex = 0, portMAX_DELAY = 0;
void xSemaphoreTake(int, int) {}
void xSemaphoreGive(int) {}
bool testMode = false;
uint32_t appliedUsbFrames = 0, rejectedUsbFrames = 0, usbPacketTimeouts = 0;
char serialCommand[96];
size_t serialLength = 0;
int commands = 0;
void handleSerialCommand() { commands++; }
${crc}
${parser}
uint8_t frame[] = {${[...frame].join(',')}};
void burst(size_t capacity) {
  // Model the HWCDC ISR: bytes arriving while the loop is busy fill its queue;
  // excess bytes are dropped, then the loop consumes what was retained.
  for (size_t i = 0; i < std::min(capacity, sizeof(frame)); i++) processByte(frame[i]);
}
int main() {
  burst(256);
  assert(appliedUsbFrames == 0);
  clockMs += 501;
  burst(${capacity});
  assert(usbPacketTimeouts == 1);
  assert(appliedUsbFrames == 1);
  assert(universe[0] == 0);
  assert(memcmp(universe + 1, frame + 3, 512) == 0);
  assert(commands == 0); // Binary newline / '1' / '0' bytes are not text commands.
  frame[20] ^= 1;
  burst(${capacity});
  assert(rejectedUsbFrames == 1 && appliedUsbFrames == 1);
  frame[20] ^= 1;
  burst(${capacity});
  assert(appliedUsbFrames == 2);
  for (const char *c = "BRIDGE?\\n"; *c; c++) processByte(*c);
  assert(commands == 1);
  for (int i = 0; i < 200; i++) processByte('x');
  processByte('\\n');
  assert(commands == 1); // Overlong text must not execute a truncated command.
}
`;
  const dir = mkdtempSync(join(tmpdir(), 'lighting-parser-'));
  try {
    writeFileSync(join(dir, 'parser.cpp'), source);
    const build = spawnSync('c++', ['-std=c++11', join(dir, 'parser.cpp'), '-o', join(dir, 'parser')], {encoding:'utf8'});
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync(join(dir, 'parser'), [], {encoding:'utf8'});
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(dir, {recursive:true, force:true});
  }
});
