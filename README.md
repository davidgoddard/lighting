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
disconnects, the controller continues on the other. At least one configured DMX
output must be available when the application starts.

## Lighting behaviour

In normal operation every automatic fixture moves independently between random,
fully saturated hues. Transitions follow the shortest route around the colour
wheel and use the random duration range in `transitionSeconds`.

The optional virtual master periodically gathers the automatic fixtures onto a
shared hue and timing. It completes a random number of shared transitions and
then returns them to independent wandering. Configure this with `masterMode`.
Fixtures held at a static colour from the web page are not changed by normal or
master wandering.

The separate **lights up** state temporarily overrides all normal and static
colours. Each fixture fades to its own `lightsUpColour`; **lights down** fades
back into the normal behaviour that has continued underneath. The global
`lightsUp.fadeUpSeconds` and `lightsUp.fadeDownSeconds` settings control these
two fade times.

## Installation and startup

Requirements:

- Node.js 18 or newer.
- At least one supported USB DMX adapter.
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

The ESP table-lights bridge is a separate project and is not included in this
repository. It connects over USB serial and can rebroadcast lighting state to
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

### No configured DMX adapter was found

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
  failed; the surviving transport should continue.

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
