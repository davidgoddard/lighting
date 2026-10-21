# Tango table lights

This document describes the four `.ino` files under `table-lights`, including
[the USB bridge](../DMX-bridge/tango_light_3_DMX_bridge.ino). It is an analysis of
the checked-in source, not a record of hardware testing. The sketches target
**ESP8266**, using `ESP8266WiFi.h` and the older `espnow.h` API; they are not
ESP32 sketches as supplied.

The intended installation consists of battery-powered table lamps or vertical
LED strips which slowly change colour. They can run independently, periodically
converge on shared colours, and show white during a cortina. An optional USB
bridge lets the [Lighting application](../../README.md) coordinate them with
DMX fixtures and Tanda Forge. The bridge itself does not generate electrical DMX.

The supplied STL designs were described as approximately 11 cm across the base,
9 cm across the shade and 9 cm high. Earlier project notes describe 18650-powered
ring lamps and 21700-powered single-LED lamps, with an intended runtime exceeding
eight hours. Those are historical hardware descriptions: these sketches contain
no battery monitoring, runtime measurement, charging control, or single-LED
constant-current/PWM driver implementation.

## Sketch inventory

| Sketch | Role and current behaviour |
| --- | --- |
| [`tango_light_3_1m_strip`](tango_light_3_1m_strip/tango_light_3_1m_strip.ino) | Complete wireless light. Gamma-corrected, constant-sum RGB animation; dedicated white-channel sweep, nominally 4 seconds. Local serial `1`/`0` also controls white. |
| [`tango_light_3_table_white_sweep`](tango_light_3_table_white_sweep/tango_light_3_table_white_sweep.ino) | Complete wireless light. HSL animation with RGB sum limiting; white is mixed from RGB, with a nominal 10-second sweep. Includes abnormal-reset red flashing and serial reset diagnostics. |
| [`tango_light_3_strip`](tango_light_3_strip/tango_light_3_strip.ino) | Standalone rendering demo. Continuous hue rotation; white-channel sweep code exists, but `lightsUp` stays false because there is no command handler. Wi-Fi headers are included, but there is no ESP-NOW initialisation, reception, or master logic. |
| [`tango_light_3_DMX_bridge`](../DMX-bridge/tango_light_3_DMX_bridge.ino) | USB serial to ESP-NOW controller, always acting as master. Supports automatic sync/wander, held group hue, and white commands. No LEDs attached or rendered. |

## LEDs, wiring assumptions and build configuration

All three LED sketches currently configure **144 addressable RGBW pixels** on
**GPIO4** (D2 on NodeMCU), with `NEO_GRBW + NEO_KHZ800` and global NeoPixel
brightness 255. The demo exposes the order as `PIXEL_ORDER`; the other two put it
directly in the constructor. Pixel index 0 is assumed to be the bottom of a
vertical strip. A ring uses the same index-based sweep around its circumference.

The implemented interface is an 800 kHz NeoPixel-compatible RGBW data stream in
GRBW order. The source does not identify or verify a particular LED chip model.
Other NeoPixel-compatible orders, pixel counts, strips or rings require matching
the constructor and `NUM_PIXELS` to the actual hardware. RGB-only pixels require
an RGB order and a replacement for the dedicated-W sweep in the 1 m/demo sketches;
changing the order alone does not provide RGB white. Clocked strips, analogue
RGB strips, discrete high-power LEDs and DMX fixtures have no direct driver here.

Build the light sketches with an ESP8266 Arduino board package and the
`Adafruit_NeoPixel` library. The bridge needs the ESP8266 package but no NeoPixel
library. Each sketch should be in an Arduino folder with the same name as its
`.ino`; the bridge currently needs moving/copying into a
`tango_light_3_DMX_bridge` folder for that convention. Exact board package and
library versions are not pinned. All sketches use serial at **115200 baud**.

There is no runtime hardware configuration: edit constants before uploading.
LED supply voltage, power conversion, current capacity and battery protection
are not specified by the firmware. Its RGB arithmetic is an output-level limit,
not a measured electrical current limit or battery protection mechanism.

## Overall operation and modes

The two wireless light sketches initialise the strip, seed randomness from A0,
select Wi-Fi station mode, register an ESP-NOW receive callback, and add the
broadcast peer `FF:FF:FF:FF:FF:FF` with channel argument 1 and no encryption key.
They do not join an access point. All devices need a compatible radio channel;
the source does not explicitly set the local radio channel separately from the
peer configuration.

1. **Independent wandering:** each lamp chooses random hue targets and transition
   lengths, initially without waiting for a master. All non-white pixels on a
   lamp show the same animated colour.
2. **Lamp acting as master:** after more than 20 seconds without processing a
   master message, a lamp promotes itself. It broadcasts targets and alternates
   between shared and independent operation.
3. **Synchronised follower:** an `IM_MASTER` message with `syncMode=true` makes
   the lamp move from its own current hue toward the supplied target over the
   supplied remaining duration. This is convergence toward a target, not an
   identical starting colour or a shared frame clock.
4. **Return to wandering:** when a follower changes from sync to non-sync, it
   clears its transition countdown and chooses a fresh independent target.
5. **White override:** `LIGHTS_UP_DOWN` changes the sweep direction. The normal
   colour animation continues underneath, so lowering the lights reveals its
   current colour rather than restoring a saved pre-white colour.
6. **Bridge-held hue:** `STATIC` makes the bridge repeatedly send a sync target
   for the entire group. White still overrides that colour. There is no
   individual lamp addressing in the command set.

### Master selection and timing

Lamp master selection is a timeout mechanism, not a ranked election. Any valid
queued master announcement makes a lamp relinquish master status; there is no
MAC-address priority or tie-break. Simultaneous promotions can therefore cause
competing masters or repeated promotion/demotion. The bridge ignores other
masters and continually announces itself, so normally dominates when present.
Multiple bridges would compete; there is no arbitration between them.

| Timing or capacity | Wireless lamps | Bridge |
| --- | --- | --- |
| Main loop delay | 40 ms, nominally 25 frames/s before other work | 10 ms |
| Colour transition | Random 5,000–24,999 ms | Same range |
| Sync/wander interval | Random 30,000–119,999 ms, checked only when choosing the next target | Same range, checked each loop |
| Master announcement | At new targets and when presence is overdue | Every 200 ms automatically; every 50 ms while static, plus immediate command/mode announcements |
| Presence | After more than 15 seconds; master sends `IM_MASTER`, others `HELLO` | `HELLO` every 2 seconds |
| Neighbour expiry | More than 15 seconds | More than 120 seconds |
| Master expiry | More than 20 seconds | Never relinquishes master role |
| Neighbour storage | 33 entries | 33 entries |

A lamp's first master announcement waits until its next target selection or
presence check. Its first target selection as master normally toggles into sync
because `nextSyncModeChange` starts at zero. The bridge starts in wandering mode
and schedules its first sync toggle 30–120 seconds later.

## Colour and sweep algorithms

### Shared wireless transition algorithm

A lamp chooses an integer hue from 0–359 degrees, retrying while its absolute
numeric difference from the current hue is less than 5 degrees. That threshold
is not circular: hues near 0 and 359 can pass despite being visually adjacent.
For interpolation, however, the difference is wrapped into the shortest route
around the wheel (within ±180 degrees), then divided by the requested duration.
Each rendered loop adds `colourStepPerMs * 40` and reduces the remaining duration
by 40 ms. Non-positive received durations are guarded when calculating the step,
but received values are otherwise not comprehensively validated.

These counters assume each loop takes exactly 40 ms. Rendering, forwarding
jitter, serial output and other work add time, so actual fades and sweeps can be
slower. Incoming sync announcements recalculate the step using the current local
hue. There is no explicit final snap to the target and no transmission-delay
compensation. The bridge instead counts its automatic transition down using
elapsed `millis()` time, and only advances that countdown while in sync mode.
Its target selection shifts a candidate by 60 degrees if its absolute difference
from the previous target is less than 30 degrees.

### 1 m strip: gamma-corrected RGB and dedicated W

The hue is converted to a 16-bit NeoPixel HSV hue at full saturation and value.
Each RGB channel is gamma-corrected with `gamma8`, then the channels are rescaled
to a sum of 255, with a rounding correction. This aims to keep the total RGB drive
roughly constant across hues; it does not guarantee equal perceived brightness
or equal electrical current between RGB and the white emitter.

White pixels use `(R,G,B,W) = (0,0,0,255)` through `WHITE_W_MAX`. The white boundary
moves by `NUM_PIXELS * 40 / 4000` pixels per loop. Pixels below the integer boundary
are white; the rest use animated RGB with W=0. Raising fills from index 0 upward;
lowering removes white from the highest filled index downward. There is no
per-pixel crossfade at the boundary. Reversing mid-sweep continues from the
current boundary position.

`RGB_ANIM_V`, `SCALED_BRIGHTNESS`, the HSL conversion helper and `brightness()`
remain in this sketch but are not used by the active rendering path. Changing
those values/functions will not adjust the displayed animation.

### Table white sweep: HSL and mixed RGB white

Normal colour uses HSL with saturation 1 and lightness `BASE_LIGHTNESS = 0.75`,
then proportionally scales RGB down whenever its sum exceeds 255. There is no
gamma correction in this path. White starts as `(255,255,255)` and is limited to
`(85,85,85)`. Although the strip is configured as RGBW, **the W channel is unused**.
The sweep uses the same integer boundary algorithm with a 10,000 ms duration.
`SCALED_BRIGHTNESS` is unused here too.

### Standalone strip demo

The demo converts HSV to RGB with `ColorHSV` and applies `gamma32`; it has no
constant-sum RGB limit. `RGB_ANIM_V` controls its animation value. Its hue increment
computes a full revolution in **4 seconds**, despite a comment saying 10 seconds.
Its optional W sweep also takes nominally 4 seconds with `WHITE_W_MAX = 255`, but
cannot be triggered without adding control code or changing `lightsUp` in source.

## ESP-NOW message protocol

Messages are broadcasts of raw C++ structs using `sizeof(struct)`. They are not
JSON, UDP/IP packets, or a portable packed wire format. Compiler padding,
inheritance layout, `unsigned long`, `bool` and float representation are part of
the effective protocol. Keep sender and receiver layouts compatible; do not
assume that porting to another architecture preserves their binary layout.
There is no protocol version, application acknowledgement or encryption key.
The `0xDA` signature identifies a frame but does not authenticate its sender.

Every message inherits or contains this `HelloMessage` header:

| Field | Source type | Meaning |
| --- | --- | --- |
| `signature` | `uint8_t` | `0xDA` |
| `type` | `uint8_t` | 1 = `HELLO`, 2 = `IM_MASTER`, 3 = `LIGHTS_UP_DOWN` |
| `messageTime` | `unsigned long` | Originating device's `millis()`; not wall-clock time |
| `senderMac` | `uint8_t[6]` | Originator MAC, retained when forwarding |

`HELLO` has no additional fields. `IM_MASTER` adds:

| Field | Source type | Meaning |
| --- | --- | --- |
| `syncMode` | `bool` | Follow shared target when true; wander when false |
| `colour` | `float` | Target hue in degrees |
| `duration` | `float` | Remaining transition time in milliseconds, not an absolute timestamp |
| `numNeighbours` | `uint8_t` | Number of populated neighbourhood entries |
| `neighbourhood` | `uint8_t[33][6]` | MAC list used to decide whether to rebroadcast |

`LIGHTS_UP_DOWN` adds a single `bool lightsUp`. There is **no brightness, RGB
value, white level, pixel count, destination lamp ID, or sweep duration** in the
radio payload. Each light renders the shared hue using its own compiled settings.

### Discovery, duplicate suppression and forwarding

Receivers update neighbour presence from the payload's originator MAC, rather
than the immediate radio sender. A relayed originator is therefore not necessarily
a directly reachable neighbour. Lamps remember 30 `(senderMac, messageTime)` pairs
for master-message duplicate suppression. New master messages enter a ring queue
with 10 slots and an effective capacity of 9; a full queue silently drops arrivals.

When processing a master message, a lamp adds any locally known MACs absent from
its neighbourhood list. It rebroadcasts **only if it added an entry**, after a
random 10–49 ms delay. It retains the original timestamp and duration. This is
conditional flooding, not a routing protocol or guaranteed mesh delivery. There
is no hop limit, retry acknowledgement or persistent duplicate history.

`HELLO` and `LIGHTS_UP_DOWN` are not forwarded by the lamps. The bridge sends each
white command three times, 20 ms apart, but does not periodically resend the
white state. A lamp outside direct range, one that misses all three packets, or
one powered on afterwards may not receive the intended white state even if it
can receive relayed master targets.

## USB serial protocol

### Bridge commands (host to bridge)

Commands are case-sensitive, newline-delimited text at 115200 baud. CR characters
are ignored, so CRLF also works. The line buffer holds 63 characters; an overlong
line is discarded through its terminating newline. Unknown or invalid commands
are silently ignored.

| Line | Effect |
| --- | --- |
| `1` | Broadcast lights up / white, three copies |
| `0` | Broadcast lights down / return to colour, three copies |
| `STATIC 120` | Hold the entire table group at hue 120; accepts a finite float in `0 <= hue < 360` |
| `WANDER` | Clear static override, force automatic non-sync mode, schedule the next sync toggle |
| `BRIDGE?` | Report current table override state |

`STATIC` broadcasts a fresh 250 ms transition every 50 ms, smoothing the approach
to a held or repeatedly updated hue. The automatic sync/wander sequence continues
underneath a static override and still supplies USB reports for the host's DMX
behaviour. `WANDER` explicitly resets that automatic mode to non-sync. Overrides
are RAM-only and disappear on reboot. White is an independent state on receivers;
`STATIC` and `WANDER` do not themselves lower white lights.

### Bridge reports (bridge to host)

```text
TABLE: {"static":true,"hue":120.00}
UDP: 240,15000,1,true
UDP: 0,0,0,false
```

`TABLE:` reports are emitted on startup, `BRIDGE?`, accepted `STATIC`, and `WANDER`.
They describe the bridge's requested override, not feedback from lamps. When
`static` is false, `hue` can still contain the previous held hue.

`UDP:` is a historical label for a **serial text line**, not a network UDP packet.
Its fields are `hue,durationMilliseconds,brightness,syncMode`. Reports occur on
entering sync and on each new automatic sync target, and a zero/false tuple is
sent on leaving sync or receiving `WANDER`. They are not emitted for every radio
announcement. Brightness is a USB-only constant of 1 for sync reports and 0 in
the non-sync tuple; it is not transmitted to lamps. While static is active,
`UDP:` continues to describe the separate automatic sequence, not the held hue.
Startup/debug text also appears on serial, so a host should recognise prefixes.

### Serial on the light sketches

The 1 m wireless sketch reads individual characters: `1` raises and `0` lowers
that lamp locally, without broadcasting. The table-white-sweep sketch explicitly
ignores serial `1`/`0`; `r` prints its recorded reset reason. The demo starts its
serial port but does not read commands. None implements the bridge's line parser.

## Reset diagnostics and implementation limitations

The table-white-sweep sketch treats any reset reason other than the exact strings
`Power On` and `External System` as abnormal. It then alternates all pixels between
red and off every 500 ms indefinitely. This bypasses normal rendering, neighbour
cleanup, queued-master processing and presence transmission, although the receive
callback remains registered. There is no serial command to clear the latch; `r`
only prints the reason. The other sketches have no equivalent diagnostic mode.

The following source-level limitations matter when extending or diagnosing the
system; they have not been changed as part of this documentation review:

- Lamp receive callbacks copy a header before checking the packet length. Master
  payload length is checked later, but incoming neighbour counts, hue and duration
  are not fully validated.
- Lamp `sendImMaster()` inserts itself and then up to 33 neighbours into a
  33-entry array without a capacity check, potentially writing beyond the array.
  The bridge's corresponding sender does enforce the limit.
- Neighbour storage uses a first MAC byte of zero as an empty-slot marker. The
  lamp insertion loop can also insert a duplicate into an earlier empty slot
  before finding an existing entry later in the array.
- A processed master message always demotes a lamp. There is no explicit rejection
  of its own announcement returning through a relay.
- Duplicate suppression, finite queues and conditional forwarding can drop useful
  updates. The firmware does not inspect send results or expose delivery status.
- Initialisation failure returns from `setup()` but does not provide a recovery
  loop or prevent Arduino from subsequently calling `loop()`.
- Animation timing is nominal; the 25 Hz software update rate does not establish
  the LEDs' internal PWM frequency or prove flicker-free operation.

For integration setup, DMX configuration, pairing the table group to a DMX leader,
and Tanda Forge cortina handling, see the [main Lighting README](../../README.md).
Those host-side features use the bridge protocol above; they are not additional
modes or audio-analysis algorithms implemented in the lamp firmware.
