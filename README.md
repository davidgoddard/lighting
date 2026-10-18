# uDMX colour wander

A standalone Node.js controller for a uDMX USB adapter that gives every configured RGB fixture an
independent, continuously changing colour. Targets are fully saturated random
hues. Transitions interpolate the hue along the shortest path around the
saturated HSV colour-wheel edge, and each transition lasts a random 2–25 seconds
by default.

A virtual master continuously moves between random hues. When a master session
begins, it randomly chooses between two and six transitions, completes that
many shared colour transitions, then returns the fixtures to individual
wandering for a separately configured random duration.

On switching to master mode, every fixture starts from its current hue and
converges on the newly selected master target using the master's duration. While
remaining in master mode, all later targets and timings are shared. On switching
back, every fixture immediately resumes choosing independent targets and
durations. Master transitions are never shorter than 15 seconds.

If an ESP lighting bridge with USB vendor ID `1a86` is connected, the controller
also listens to it at 115200 baud. Newline-delimited messages in the original
`UDP: hue,durationMilliseconds,brightness,syncMode` format take control of the
automatic lights. A `true` sync mode moves every wandering fixture toward the
received hue over the received duration; `false` resumes individual wandering.
Static colours selected in the web interface remain overrides. If the bridge is
connected, it is the sole master authority and the local virtual master is
suspended. If the bridge is missing or disconnects, the existing local
virtual-master behaviour resumes.

The top-right **Lights up / Lights down** switch temporarily fades every fixture
to its configured `lightsUpColour`, then fades back to the normal static or
wandering output. The global `lightsUp.fadeUpSeconds` and
`lightsUp.fadeDownSeconds` values set those transition times. Switching state
also sends `1\n` or `0\n` to the ESP bridge, which may rebroadcast the state to
ESP-NOW lights. The same state is available to local integrations through
`POST /api/lights` with `{ "up": true }` or `{ "up": false }`.

`masterMode.transitionCount` controls the minimum and maximum number of shared
transitions in each local master session, and `transitionSeconds` controls the
virtual master's target durations. `masterMode.individualModeSeconds` controls
how long the lights remain in individual mode before the next master session.
`externalMaster` controls serial bridge discovery and can be disabled entirely.

## Setup

Requires Node.js 18 or newer and at least one configured uDMX or FTDI-based Open
DMX USB adapter.

The same universe can also be mirrored to an FTDI-based Open DMX adapter. Enable
`openDmx` in `config.json` and set its `serialNumber` (preferred) or `path`. The
controller starts when either configured output is available, sends every frame
to all connected outputs, and keeps running on the remaining output if one
disconnects.

uDMX control transfers are retried briefly before an output is considered lost.
For reliable continuous output, connect USB DMX adapters directly or use a
powered hub; low-speed uDMX hardware can be unreliable behind cascaded,
bus-powered hubs.

```sh
npm install
npm start
```

Press Ctrl-C to send a blackout frame and close the adapter. A different config
can be supplied with `node lighting.js path/to/config.json`.

While the controller is running, open `http://localhost:8080`. Select one or
more lights and drag the colour-wheel handle to hold them at a static hue.
"Resume wandering" returns the selected lights to the automatic colour mode.
The master-brightness slider applies immediately to every fixture in every
colour mode. Fixtures with a dimmer channel use it directly; RGB-only fixtures
are dimmed by scaling their RGB channel values.

Select two or more fixtures and use **Pair / add** to make them behave as one.
The first existing pair leader in the selection remains the leader; otherwise
the first selected fixture becomes the leader. To extend a pair, select any one
of its members together with the new fixtures and click **Pair / add**. Use
**Unpair** to detach selected members without selecting the rest of their group.
Change `webPort` in `config.json` if port 8080 is already in use.

To verify a fixture's address and channel layout without any animation, run:

```sh
node lighting.js --diagnose
```

This holds blackout, isolated red, isolated green, isolated blue, and blackout
for four seconds each while printing the exact transmitted fixture channels.

## Configuration

Edit `config.json`. DMX fixture addresses and channel offsets are one-based.
Define each physical channel layout once under `fixtureTypes`, then associate
fixtures with that type under `fixtures`.

Each fixture may define its own RGB lights-up colour, for example
`"lightsUpColour": { "red": 255, "green": 220, "blue": 170 }` for a warm
white. It defaults to full RGB white when omitted. RGB is used instead of only
hue and brightness because a hue-wheel colour is fully saturated and therefore
cannot represent white.

The same value can be changed without hand-editing JSON: select one or more
fixtures in the web interface, choose **Cortina colour**, and press **Apply to
selected**. The controller applies it immediately and saves it to the active
configuration file for future runs.

`channelCount` is the entire footprint of the fixture, including channels this
program does not use. Unmapped channels are sent as zero. The supported mapped
roles are `red`, `green`, `blue`, and optional `brightness`. `fixedChannels`
can also state required values explicitly; its keys are one-based offsets.

The common Anyma/uDMX USB ID is `16c0:05dc`. If the adapter has a different ID,
replace `usb.vendorId` and `usb.productId`. On macOS, it can be found with:

```sh
system_profiler SPUSBDataType
```

Only one program can control the adapter at a time. Stop QLC+, FreeStyler, or
other DMX software before starting this script.
