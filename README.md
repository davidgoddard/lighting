# Lighting controller

Lighting is a small Node.js application that drives room lighting through USB
DMX adapters. It gives configured RGB fixtures continuously wandering colours,
provides a browser control page, coordinates with an optional ESP table-lights
bridge, and raises the room lights automatically while Tanda Forge plays a
cortina.

The controller can send the same DMX universe to one or both supported USB
adapter types:

- **Anyma/uDMX-compatible adapter** using USB control transfers. The usual USB
  identity is `16c0:05dc`.
- **FTDI Open DMX adapter** using a 250000-baud serial DMX stream. Select this by
  serial number where possible, or by device path.

When both adapters are connected, each frame is mirrored to both. If one output
disconnects, the controller continues on the other. Missing DMX outputs are retried every five seconds, including at startup. The
web controls and ESP bridge remain available while DMX is disconnected.

## Lighting behaviour

In normal operation every automatic fixture moves independently between random,
fully saturated hues. Transitions follow the shortest route around the colour
wheel and use the random duration range in `transitionSeconds`.

The optional virtual master periodically gathers the automatic fixtures onto a
shared hue and timing. It completes a random number of shared transitions and
then returns them to independent wandering. Configure this with `masterMode`.
Fixtures held at a static colour from the web page are not changed by normal or
master wandering.

## Music-aware DMX mode

Tanda Forge posts versioned snapshots of its main-output playback to
`POST /api/playback`. Lighting reacts only to normal tango playback on that
output. Headphone previews never drive the lights, and cortinas continue to use
the higher-priority lights-up behavior.

Music mode is disabled when the `music` section is absent or uses
`"enabled": false`. Enabling it affects automatic DMX fixtures only. Static
colours, explicit lights-up, fixture pairing, master mode, global brightness,
and external-master ownership keep their existing priority. Table lights do not
receive audio data or music brightness commands.

### Analysis lifecycle

When a new main-output tango starts, Lighting:

1. Keeps the currently visible lighting behavior running while analysis takes
   place. It does not black out, reset hues, or restart the playback clock.
2. Starts a Node worker which asks FFmpeg to decode the complete local recording
   to mono floating-point PCM at 11,025 Hz.
3. Analyses 1,024-sample windows, approximately 92.9 ms each. Decoding and FFT
   work occur outside the configured 40 FPS DMX loop.
4. Keeps the resulting profile in memory for that playback occurrence only.
   There is no profile cache, queue pre-analysis, or disk output.
5. Samples the profile at Tanda Forge's current actual media position and blends
   the music response in over `activationBlendSeconds`, normally three seconds.

A replay is a new occurrence and is analysed again. Superseded worker results
are ignored. Missing FFmpeg, an inaccessible file, an unsupported codec, or a
decode failure leaves legacy wandering active and reports the problem in the
web page and terminal.

The analyser derives expressive lighting inputs rather than identifying genre,
mood, or a precise BPM:

- **Energy** is normalized within each recording using robust loudness
  percentiles, so quiet and loud recordings can both use the configured range.
- **Fast energy** follows short sung and instrumental phrases more closely and
  supplies most of the brightness response.
- **Spectral activity** measures positive changes across frequency bands.
- **Rhythmic drive** is an autocorrelation-based periodic-accent proxy, not a
  BPM estimate.
- **Development** describes sustained rising, falling, or stable intensity.
- **Pause candidates** identify short, confident drops followed by a clear
  musical return. Only scores at or above the configured threshold receive an
  accent.

The web page reports the current analysis/transport state, track basename,
analysis duration, source position, intensity, fast energy/activity, rhythmic
drive, development, output brightness, hue rate, and any active pause accent.

### Effect on colour and transitions

Music does not select fixed warm, cool, or genre-based palettes. In individual
mode, every automatic fixture or pair leader continues choosing an independent
random destination over the complete 0–360° hue wheel. Music-aware destinations
are kept at least approximately 48° away so a new transition is visibly
meaningful. Hues travel by the shortest circular route with smoothstep easing.

The music changes how quickly each fixture progresses towards its existing
destination; it does not choose a new target on every DMX frame. Rhythmic drive,
fast activity, sustained intensity, and short phrase lift are combined and
nonlinearly mapped to approximately 1.7–38° per second before applying the
Transition speed percentage. Acceleration into energetic material is faster
than deceleration back into calm passages, which avoids nervous speed changes.

In master mode, fixtures retain their shared target and timing. Paired fixtures
continue following their pair leader. If an external ESP master owns the
master/wander decision, music does not retime its hue transitions.

At 0% Music influence, legacy target selection, colour, brightness, saturation,
and transition timing are retained. Disabling music or stopping playback blends
back to legacy automatic operation rather than fading the room to black.

### Effect on brightness and saturation

The principal brightness input is:

```text
expressiveEnergy = 0.72 × fastEnergy + 0.28 × intensity
value = minimum + (maximum - minimum) × expressiveEnergy ^ gamma
```

The default range is 25–100% with gamma 1.05. Brightness rises with a 0.42 s
time constant and falls with a slower 0.70 s time constant. This produces
visible musical phrasing without turning every short accent into a flash.

Saturation normally remains around 92–99%. Brightness is adjusted as HSV value,
not by mixing towards white, so bright fixtures remain strongly coloured.
RGB-only fixtures scale their red, green, and blue channels together. Fixtures
with a dedicated dimmer retain saturated RGB and apply the musical value once
through the dimmer channel. The existing `masterBrightness` is applied after
the music value. Static/manual fixtures are not given a music brightness floor,
and explicit zero/blackout remains zero.

The fixture indicators on the web page show the production hue at full visual
brightness so they match the colour wheel. Current musical brightness is shown
in the music-output status and still applies to the physical DMX output.

Colour transitions use a deliberately wide dynamic range: steady, simple music
wanders slowly, while strong combined drive, activity, and intensity accelerates
transitions and therefore selects new colour targets more often. Acceleration is
quick and deceleration remains gradual to avoid nervous changes.

### Dramatic pauses

Confident pause events can temporarily coordinate the otherwise independent
DMX colours. The default V10-derived envelope begins eight seconds before the
pause with a 35% dim, builds over the final six seconds, holds through the
pause and for 0.5 seconds after the return, then releases over 4.5 seconds.
Brightness remains within the configured minimum and maximum after the effect
is applied. Manual/static colours, lights-up, and other higher-priority controls
continue to win.

The timing remains V10-derived apart from the stronger lead dim and shorter
post-return hold. Stronger pause or peak-moment effects are deferred until the
baseline has been evaluated on physical fixtures.

### Music controls

The web page persists these controls into the active configuration file:

- **Enabled** turns music-derived DMX intent on or off.
- **Influence** blends between exact legacy behavior at 0% and the complete
  music mapping at 100%.
- **Transition speed** scales the requested hue movement rate; the default is
  220%.
- **Minimum/maximum brightness** bound the musical HSV value; defaults are
  25% and 100%.
- **Gamma** shapes the energy-to-brightness curve; the default is 1.05.
- **AV delay** shifts profile sampling. A positive value makes the visible
  response happen later; the default is 0 ms.
- **Dramatic pause accents** enables or suppresses the prepared pause envelope.
- **Reset defaults** restores the production control defaults.

The corresponding configuration is:

```json
"music": {
  "enabled": false,
  "influencePercent": 100,
  "transitionSpeedPercent": 220,
  "minimumBrightnessPercent": 25,
  "maximumBrightnessPercent": 100,
  "gamma": 1.05,
  "avDelayMs": 0,
  "activationBlendSeconds": 3,
  "dramaticPausesEnabled": true,
  "dramaticPauseMinimumScore": 0.58
}
```

FFmpeg must be available on `PATH`. Positive AV delay means later light. Venue
audio, OS, USB, and fixture latency should be measured before relying on a final
offset.

### Individual and master modes

In individual wandering mode, each fixture chooses and follows its own colour
target:

![Lighting web page showing fixtures in individual wandering mode, each with a different colour](docs/images/individual-wandering-mode.png)

In synchronised master mode, every automatic fixture follows the shared master
target and timing:

![Lighting web page showing fixtures synchronised in master mode with the same colour](docs/images/synchronised-master-mode.png)

The separate **lights up** state temporarily overrides all normal and static
colours. Each fixture fades to its own `lightsUpColour`; **lights down** fades
back into the normal behaviour that has continued underneath. The global
`lightsUp.fadeUpSeconds` and `lightsUp.fadeDownSeconds` settings control these
two fade times.

## Installation and startup

Requirements:

- Node.js 18 or newer.
- A supported USB DMX adapter for DMX fixtures (optional for table-light control).
- A valid `config.json` with non-overlapping fixture addresses.

Install and start:

```sh
npm install
npm start
```

To use a different configuration file:

```sh
node lighting.js path/to/config.json
```

The terminal reports the detected DMX output or outputs, the web address, and
the ESP bridge status. Press Ctrl-C for an orderly shutdown: the application
sends a blackout frame and closes its USB and serial devices.

## Web control page

While Lighting is running, open:

```text
http://localhost:8080
```

The server listens on all network interfaces, so another device on the same
network can use `http://<lighting-computer-address>:8080`. Change `webPort` if
port 8080 is already occupied.

The page provides:

- **Lights up / Lights down** in the top-right corner. This fades the DMX
  fixtures and also sends the state to the ESP bridge when connected.
- **ESP status**, showing whether the table-lights bridge is detected and
  whether it is supplying master or wandering targets.
- **Fixture selection** and **Select all**.
- A **colour wheel**. Moving it holds the selected fixtures at a static hue.
- **Resume wandering**, which removes the static override from the selection.
- **Pair / add**, which makes selected fixtures follow one leader, and
  **Unpair**, which detaches selected members.
- **Cortina colour**, an RGB picker for the selected fixtures' lights-up colour.
  Press **Apply to selected** to apply it immediately and save it into the
  active configuration file. RGB permits pure white, warm white, or a calibrated
  colour for fixtures whose RGB white is unattractive.
- **Master brightness**, which affects every fixture in every mode. Fixtures
  with a brightness/dimmer channel receive this value directly; RGB-only
  fixtures have their RGB values scaled.

When several fixtures are selected, applying a cortina colour sets all of them
to the chosen RGB value. Selecting a single fixture loads its saved cortina
colour into the picker.

## Fixture and channel configuration

DMX addresses and channel offsets are one-based. Define a reusable physical
layout under `fixtureTypes`, then assign that type and a start address to each
entry in `fixtures`.

The supplied configuration contains two example layouts:

| Fixture type | Footprint | Channel mapping used by Lighting |
| --- | ---: | --- |
| `4ch-rgbw` | 4 channels | Red, green, blue; channel 4 (white) held at 0 |
| `8ch-dimmer-rgbw` | 8 channels | Master brightness, red, green, blue; channels 5–8 held at 0 |

These names describe the included fixture profiles, not hard-coded limits. A
fixture type declares its entire `channelCount`, mapped `channels`, and any
`fixedChannels`. Supported mapped roles are `red`, `green`, `blue`, and optional
`brightness`. Unmapped channels are sent as zero. Fixed channels are useful for
mode, strobe, or unused white channels that must stay at a known value.

Example fixtures:

```json
{
  "fixtureTypes": {
    "4ch-rgbw": {
      "channelCount": 4,
      "channels": { "red": 1, "green": 2, "blue": 3 },
      "fixedChannels": { "4": 0 }
    },
    "8ch-dimmer-rgbw": {
      "channelCount": 8,
      "channels": { "brightness": 1, "red": 2, "green": 3, "blue": 4 },
      "fixedChannels": { "5": 0, "6": 0, "7": 0, "8": 0 }
    }
  },
  "fixtures": [
    {
      "id": "floor-1",
      "name": "Floor light",
      "address": 1,
      "type": "4ch-rgbw",
      "lightsUpColour": { "red": 255, "green": 220, "blue": 170 }
    },
    {
      "id": "washer-1",
      "name": "Wall washer",
      "address": 11,
      "type": "8ch-dimmer-rgbw",
      "lightsUpColour": { "red": 255, "green": 255, "blue": 255 }
    }
  ]
}
```

`lightsUpColour` defaults to full RGB white if omitted. Hue plus brightness is
not sufficient for this setting: the normal hue wheel is fully saturated, while
white requires the RGB channels to be mixed together.

Ensure fixture footprints do not overlap and do not extend beyond DMX channel
512. For example, an eight-channel fixture beginning at address 121 occupies
channels 121–128.

## USB DMX adapters

### Anyma/uDMX

Configure the USB vendor and product IDs:

```json
"usb": {
  "vendorId": "0x16c0",
  "productId": "0x05dc"
}
```

Lighting finds this device through USB rather than through a serial device path.
Transfers are retried briefly before the output is treated as disconnected.
Low-speed uDMX hardware can be unreliable behind cascaded bus-powered hubs; use
a direct port or powered hub when possible.

### FTDI Open DMX

Enable the Open DMX output and identify it by serial number (preferred):

```json
"openDmx": {
  "enabled": true,
  "serialNumber": "BG00QGXZ"
}
```

Alternatively specify its operating-system device `path`. A serial number is
more stable because device paths can change after reconnection or reboot.

On macOS, USB identities and serial numbers can be inspected with:

```sh
system_profiler SPUSBDataType
```

Only one application can own an adapter at a time. Stop QLC+, FreeStyler, or any
other DMX program before starting Lighting.

## ESP table-lights bridge

The ESP table-lights bridge sketch is included at
`table-lights/DMX-bridge/tango_light_3_DMX_bridge.ino`. It connects over USB serial and can rebroadcast lighting state to
ESP-NOW-connected table lights.

Lighting scans for the configured USB vendor ID (normally `1a86`) and opens the
bridge at 115200 baud. Configure or disable it under `externalMaster`:

```json
"externalMaster": {
  "enabled": true,
  "vendorId": "0x1a86",
  "baudRate": 115200,
  "scanSeconds": 5
}
```

The bridge and Lighting exchange newline-delimited messages:

- Lighting sends `1` plus a newline for lights up and `0` plus a newline for
  lights down. The bridge can rebroadcast that state to the table lights.
- Lighting accepts `1`, `up`, or `lightsUp` as an incoming lights-up state and
  `0`, `down`, or `lightsDown` as lights down.
- The bridge can report an ESP-NOW colour target as
  `UDP: hue,durationMilliseconds,brightness,syncMode`.

When `syncMode` is `true`, automatic DMX fixtures move to the received hue over
the supplied duration. When it is `false`, they resume individual wandering.
While the bridge is connected it owns the master/wander decision, so the local
virtual master is suspended. If it disconnects, local master operation resumes.
Static web-page colour overrides remain in place.

The ESP indicator initially says **awaiting data** because connection alone does
not provide a colour target. It changes after a valid bridge message arrives.

## Tanda Forge integration

Tanda Forge treats Lighting as an optional local companion service:

- Normal main-output tracks send versioned playback snapshots to
  `POST http://127.0.0.1:8080/api/playback`, including the source path, actual
  media position, duration, playback rate, transport state, session identity,
  and ordered sequence number.
- Playing snapshots arrive approximately every 750 ms and immediately on
  transport changes. Lighting extrapolates the position only while playing.
- Delivery is bounded and times out quickly; an unavailable Lighting process
  never delays audio playback.
- Headphone/cue playback is not published.

- When main-output cortina playback starts, Tanda Forge sends
  `POST http://127.0.0.1:8080/api/lights` with `{ "up": true }`.
- When the cortina pauses or finishes, or normal main playback takes over, it
  sends `{ "up": false }`.
- Lighting fades its DMX fixtures and forwards the same state to the ESP bridge,
  keeping DMX room lights and ESP-NOW table lights together.
- If Lighting is not running, Tanda Forge playback continues normally.

Both applications must be running on the same computer when using the default
localhost address, and Lighting must use port 8080. Restart both applications
after changing their integration code or configuration.

The `/api/lights` endpoint is also available to other local integrations. Send a
JSON body containing a Boolean `up` property.

## Diagnostics and operational help

### Verify fixture addressing

Use diagnostic mode with a configuration containing exactly one fixture:

```sh
node lighting.js --diagnose
```

It holds blackout, isolated red, isolated green, isolated blue, and blackout for
four seconds each while printing the exact transmitted fixture channels. Use it
to confirm the start address, channel order, dimmer channel, and polarity before
enabling animation.

### No DMX output connected

- Confirm that at least one adapter is connected before startup.
- Check the uDMX vendor/product IDs or the FTDI serial number/path.
- Close other DMX software that may own the device.
- Try a direct USB port or powered hub.
- On macOS, inspect the hardware with `system_profiler SPUSBDataType`.

### DMX output stops or flickers

- Avoid an unpowered or cascaded USB hub, especially with uDMX hardware.
- Check USB and DMX cabling and termination.
- Reduce `fps` temporarily to determine whether the adapter or host cannot
  sustain the configured frame rate.
- If two adapters are enabled, read the terminal output to see which transport
  failed; the surviving transport continues. Disconnected outputs are retried
  every five seconds and receive the current lighting state after reconnecting.
- `LIBUSB_ERROR_NO_DEVICE` means the USB adapter became unavailable. The app
  keeps the web controls and ESP bridge running while retrying the adapter.
  The Lights panel displays the current DMX connection status.

### ESP not detected

- Confirm `externalMaster.enabled` is `true`.
- Check that the bridge's USB vendor ID matches `externalMaster.vendorId`.
- Confirm its firmware uses the configured baud rate and newline termination.
- Wait at least `scanSeconds` after connecting it; Lighting rescans while running.
- Check that no serial monitor has already opened the bridge port.

### Tanda Forge does not raise the lights

- Confirm the Lighting web page works at `http://127.0.0.1:8080` on the same
  computer as Tanda Forge.
- Test the web-page lights-up switch first; this separates Lighting/DMX/ESP
  problems from the Tanda Forge notification.
- Fully restart both applications after updating them.
- Ensure Tanda Forge is playing the cortina on its **main output**, not merely a
  headphone preview.
- Inspect the Tanda Forge developer console for
  `Could not notify the Lighting controller`.

### Web page is unavailable

- Confirm the terminal printed `Lighting controls: http://localhost:<port>`.
- Check `webPort` and use that same port in the browser.
- If controlling from another device, use the Lighting computer's LAN address
  rather than `localhost`, and allow the port through its firewall.

### Configuration errors

Lighting validates the configuration at startup and prints an actionable error
for invalid ranges, unknown fixture types, duplicated IDs, overlapping DMX
addresses, or fixtures extending past channel 512. Correct the reported entry
and restart the controller.

Run the JavaScript syntax checks without opening hardware:

```sh
npm run check
```

## Example hardware

The following third-party product photographs are included only as visual
examples. They are not project-owned images, endorsements, or purchasing
recommendations. Check that any hardware you use meets the USB and DMX
requirements described above.

### USB DMX adapter

A typical USB-to-DMX adapter with a three-pin XLR DMX connector:

![Example USB-to-DMX adapter with a USB plug and three-pin XLR connector](docs/images/example-usb-dmx-adapter.webp)

### Connection to a DMX light

An example of the kind of computer-to-fixture connection used in a small DMX
lighting setup:

![Example laptop running Lighting's wandering-mode controls while connected to a DMX lighting fixture](docs/images/example-dmx-fixture-connection-with-lighting-app.png)

### Table lights colour control

With the updated bridge firmware, a **Table lights** panel appears automatically
when the bridge reports its capabilities. Select its card (alone or alongside DMX
fixtures) and use the colour wheel to hold the whole wireless group at a hue.
**Resume wandering** restores the bridge's automatic sync/wander cycle. The table
lights' firmware does not need changing.

The bridge sends the held hue every 50 ms with a fresh 250 ms transition. It keeps
its normal automatic sequence running separately for unselected DMX fixtures.
The panel shows the requested group colour, not measured feedback from each light;
individual wandering colours cannot be displayed. Master brightness and custom
cortina RGB settings remain DMX-only. Global lights up/down still controls
the table lights' existing white override.

Select **Table lights** together with one or more DMX fixtures and click
**Pair / add** to make the wireless group follow a DMX leader. Existing DMX pairs
can be extended in the same way. Selecting either the tables or a DMX member then
controls the whole pair: the colour wheel holds their colour and **Resume
wandering** makes them follow the leader's automatic transitions. The app sends
the leader's current hue to the bridge at most every 50 ms, so the table lights
follow with a small smoothing delay rather than exact frame synchronisation.

**Unpair** on Table lights restores the bridge's automatic behaviour. If you
remove a DMX leader from a larger pair, the tables follow the remaining DMX
leader; removing the last DMX member releases the tables. Pairing is kept during
a bridge reconnect while the app runs, but is not saved across app restarts.
An orderly app shutdown releases paired tables back to automatic mode. This uses
the existing colour-control bridge firmware; no further upload is needed.

USB commands are newline-delimited: `STATIC <hue>` (0–359.999), `WANDER`,
`BRIDGE?`, and the existing `1`/`0` lights-up/down commands. The bridge responds
with `TABLE: {"static":true,"hue":120}` status reports. Existing `UDP:` reports
continue to describe the automatic sequence. Old bridge firmware remains usable
for automatic lighting but does not expose the new panel. A bridge reboot clears
the static override; reconnecting queries its current state.

To build in Arduino IDE, put the sketch in a folder named
`tango_light_3_DMX_bridge`, select your ESP8266 board/settings, and export the
compiled binary. Only upload to the bridge, not the table lights.

Run `node --test tests/bridge.test.mjs` to check serial capability detection,
static/wander commands, invalid selection handling, and disconnection without
opening real hardware.
