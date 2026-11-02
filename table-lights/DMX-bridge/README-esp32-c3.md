# Combined ESP32-C3 bridge

Upload `tango_light_3_esp32_c3_bridge/tango_light_3_esp32_c3_bridge.ino`.
The original ESP8266 firmware and standalone C3 test are retained.

## Board and wiring

Use Arduino-ESP32 3.x (compiled with 3.3.5), board **ESP32C3 Dev Module**,
**USB CDC On Boot: Enabled**, and the module's native USB connection.
No external DMX library is required.

Keep the wiring that worked with the test sketch:

- GPIO 4 to DI on both MAX485 modules.
- GPIO 5 to DE on both modules.
- Receive disabled, RO disconnected, shared ground; retain the tested power wiring.
- Each module's A/B pair feeds its own DMX line (wired socket or wireless transmitter).

Both outputs continuously transmit the **same 512-channel universe**, with
start code zero, 250 kbaud / 8N2, 120 us break and at least 16 us mark-after-break.
These are separate line drivers, not separate universes or isolated outputs.

## App connection

Run `npm start` with `externalMaster.enabled: true` (the existing default).
The app prefers Espressif native USB vendor `303a`, then the configured legacy
vendor. If multiple boards are connected, set `externalMaster.path` in
`config.json` to this board's serial device path. An explicit path is authoritative.
Close Arduino Serial Monitor before starting the app.

The app opens this USB port once for both table commands and binary DMX frames.
`BRIDGE?` returns `TABLE: {"static":false,"master":false,"hue":0,"dmxProtocol":1}`
(with current values). Binary output starts only after capability version 1 is
reported. The handshake retries during startup; unplug/replug is rediscovered.
The original ESP8266 remains usable for table control without receiving binary DMX.
Connected uDMX and enabled Open DMX adapters also receive the same universe.

Table-light ESP-NOW messages preserve the ESP8266 structures, including padding,
on Wi-Fi channel 1. Existing STATIC, WANDER, MASTER and white override commands
remain available. A queue transfers received neighbour announcements out of the
Wi-Fi callback; DMX runs in its own UART task.

USB DMX packet: `A5 5A 01`, 512 channel bytes, then little-endian CRC16-CCITT-FALSE
(poly 0x1021, initial 0xFFFF) over the type byte and channels. Short app universes
are padded with zeros. Invalid CRC frames are ignored; incomplete packets expire
after a 500 ms input gap. There is no per-frame acknowledgement. The USB receive queue is 4096 bytes;
the Arduino default of 256 bytes is too small for a 517-byte packet burst.

On boot DMX is black. If the app disappears unexpectedly, DMX holds its last frame;
a normal app shutdown sends blackout before closing USB. Table lights retain the
old autonomous master/wander behaviour.

## Bench verification

1. Before starting the app, use Serial Monitor at 115200 and send `BRIDGE?`,
   `STATUS`, `SET 1 255`, and `BLACKOUT`. `STATUS` includes DMX frame, valid USB
   frame and neighbour reception counters, plus `crc_errors` and `timeouts`.
   After running the app, `usb_frames` must increase; increasing error counters
   indicate damaged or incomplete USB packets. `ALL n`, `TEST ON`, `TEST OFF` and
   `HELP` are also retained from the test sketch.
2. Close Serial Monitor, start the app, and check its connected outputs include
   `ESP32-C3 DMX`. Move a DMX fixture colour and confirm wired/wireless fixtures
   on the same addresses match. Connect uDMX and confirm it mirrors them too.
3. Select Table lights in the app: test static colour, wander, pairing and white
   override. Confirm the existing ESP8266 table lights follow.
4. Unplug/reconnect USB and confirm the app rediscovers the bridge and resumes
   current channel values; stop the app normally and confirm DMX blackout.

Firmware compilation and automated app tests do not replace these hardware checks.
