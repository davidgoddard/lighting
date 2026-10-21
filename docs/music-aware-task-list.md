# Music-aware lighting task list

Updated 20 October 2026. This list combines the original implementation specification with subsequent product decisions.

## Completed for the first draft

- [x] Tanda Forge reports only attached main-output playback; headphone/cue playback is excluded.
- [x] Each playback occurrence has a session ID and ordered sequence numbers.
- [x] Start, pause, resume, stop, end, rate changes, and periodic actual media positions are reported.
- [x] Delivery is optional, limited to one in-flight request plus one latest queued snapshot, and times out after 500 ms.
- [x] Lighting accepts playback events on a loopback-only endpoint and rejects malformed/out-of-order data.
- [x] A Node worker performs full-file FFmpeg analysis once per tango occurrence, with no cache or prefetch.
- [x] Stale analysis results are ignored and the active worker is terminated when superseded or shut down.
- [x] Energy, activity, drive, development, fast features, pause detection, brightness, saturation, and rate curves are represented.
- [x] Profile activation samples the current playback position and blends in over the configured period.
- [x] Automatic DMX fixture hues use independent full-wheel targets, minimum separation, shortest paths, and continuous movement.
- [x] Music advances explicit transition progress against time-based destinations rather than angular distance.
- [x] Positive development drives long-term drama independently of weakening rhythmic drive.
- [x] Relative fast-energy surges create bounded, cooldown-protected acceleration and optional fresh targets.
- [x] RGB-only fixtures scale saturated RGB; fixtures with a dimmer apply musical value once through that dimmer.
- [x] Minimum/maximum brightness, gamma, attack/release, dramatic-pause envelopes, and signed AV delay are live and persisted.
- [x] Manual/static fixtures, lights-up, master brightness, pairing, and cortina priority are retained.
- [x] External master ownership prevents music from retiming its hue transitions.
- [x] At 0% influence, music intent no longer changes destination timing, target selection, saturation, or brightness.
- [x] Table lights receive no new music protocol or direct music brightness control.
- [x] Configured fixture indicators show production hue at full visual brightness; the redundant four-lamp preview was removed.
- [x] Music status shows transport, analysis time, source time, features, drama, destination timing, kick state, brightness, and active pause score.
- [x] Console diagnostics show analysis, intent, and representative renderer progress once per playback second.
- [x] The configured DMX rate remains 40 FPS.

## Accepted first-draft decisions

- [x] Seek-specific clock/event behavior is out of scope because normal DJ operation plays complete songs.
- [x] Music stops by blending back to legacy automatic brightness, not by fading to black. OFF/blackout remains explicit.
- [x] Manual signed AV offset is sufficient for the first draft; no automatic calibration click is played.
- [x] Music remains DMX-only. Table lights may follow only through their existing explicit pair/master mechanism.
- [x] The installation's persisted enabled state is user configuration; the code default remains disabled when the music section is absent.

## Remaining before production sign-off

- [ ] Run listening tests using the agreed Pugliese, De Caro, and quiet piano recordings.
- [ ] Verify real RGB and dedicated-dimmer fixtures across the brightness range and confirm blackout remains zero.
- [ ] Measure actual DMX frame timing and frame drops while FFmpeg analyses a representative long recording.
- [ ] Exercise DMX disconnect/reconnect, missing FFmpeg, corrupt files, cortinas, pairing, and external master on venue hardware.
- [ ] Measure audio/output/fixture latency and record the chosen AV offset for the venue.
- [ ] Confirm no unexpected table-light bridge traffic during individual/master transitions with music enabled.
- [ ] Decide whether to add a dedicated no-hardware command-line flag; disconnected-output operation already provides a practical mock mode.

## Deliberately deferred exploration

- [ ] After first-draft evaluation, investigate stronger but tasteful dramatic-pause and peak-moment treatments.
- [ ] Add any new dramatic controls only after evaluating the current behavior on physical fixtures.
