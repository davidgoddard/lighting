# Music-aware DMX Lighting — Claude implementation specification v3

**Date:** 19 October 2026  
**Repositories:** https://github.com/davidgoddard/tanda-forge and https://github.com/davidgoddard/lighting  
**Reference implementation:** the supplied `tango-analyse.js` and `dashboard.html`.
**Priority:** deliver a working DMX-only music-reactive mode without disturbing existing milonga controls.

> **Instructions to Claude:** Inspect both current repositories and the supplied reference implementation before editing anything. Treat its actual source, not descriptions of it, as normative for audio extraction, feature timescales, pause detection, HSV behaviour and ramp curves. This document defines production integration, precedence and acceptance criteria. Create small, testable changes. Preserve all existing lighting/bridge operations. Document any implementation differences.

## 1. Decisions and scope (fixed)

1. Tanda Forge announces **only the currently playing main-output track** with local file path, position, transport state, and enough identity to reject stale events. No next tracks or queue. Headphone/cue playback must not drive lights.
2. Lighting analyses the complete audio file **only when a new main-output track starts**, using the JavaScript analyser in a Node worker. **No persistent profile cache, prefetching, playlist processing, or background preprocessing.** Analyse once per occurrence of a track; hold the profile in memory only while applicable.
3. **During analysis:** hold existing effective visual settings: current hues, currently active fades, brightness target, transition pace and mode. Do not black out, reset, jump hues or revert to a default scene. If decoding fails, stay in safe legacy behaviour, without repeated analysis loops.
4. On analysis completion, sample at the **current actual playback position** and blend the music influence in over **2–5 s** (default 3 s). Ignore profiles completing for a superseded track. Never reset the playback clock to zero when analysis completes.
5. Music drives **DMX fixtures only**. ESP-NOW table lights continue autonomous operation. Preserve the existing periodic master mode, bridge election/control, explicit pairing and lights-up features. When table lights already follow a master/DMX hue, allow that established mechanism to continue; do **not** introduce new audio packets, table-light brightness control, or firmware changes.
6. Existing manual fixture controls, pairing, master-mode behaviour and cortina/lights-up overrides retain their previous semantics and priority. Music mode is opt-in, separately enabled/disabled and reversible at runtime.
7. DMX render rate must remain the user's configured **40 FPS** (25 ms nominal interval); never change configuration defaults that belong to the original app just to achieve this. Do not block the render loop with file decoding.
8. Browser dashboard provides live values, a light preview, configurable music influence, speed and brightness controls, and a signed AV synchronization offset.

## 2. Reference analysis behavior

Preserve the supplied analysis algorithms rather than inventing a new classifier. In particular:

- Full-file FFmpeg decode and frame analysis from `tango-analyse.js`; intensity, rhythmic drive, development, fastEnergy, fastActivity, pause intervals/scores. No genre recognition and no requirement for accurate BPM.
- Each fixture chooses a random destination hue over **0–360°**, excluding trivially nearby destinations (55° minimum by default), and follows the shortest circular route. Production supports any number of fixtures.
- Long-term drama combines intensity, positive development, and drive to control destination time. Short relative fast-energy surges temporarily accelerate progress and may select a fresh target. Progress remains continuous when timing changes.
- Brightness: `expressiveEnergy = clamp(0.72 * fastEnergy + 0.28 * intensity, 0, 1)`. `value = min + (max - min) * expressiveEnergy ** gamma`; interpolate toward a standby brightness when influence is zero; exponential rise/fall time constants **0.42 s and 0.70 s**, respectively. Cap floor/ceiling **after** break effects. Use HSV value or RGB/dedicated dimmer channel scaling; do not whiten bright colours.
- Saturation remains high, typically `0.92 + 0.07 * intensity` blended from `.96`, approximately **92–99%**. Do not blend towards white to increase apparent luminosity.
- Significant pauses only (`score >= 0.58`) receive a coordinated effect. The envelope starts **8 s before** pause; the first **2 s** dims, followed by a **6 s** build; it holds until **0.5 s after** pause end and returns over **4.5 s**. Break brightness ramps to `1.27` then is clamped to safe max; hue blends toward an accent hue, with per-fixture offsets. This is a longer cinematic cue, not a flash.
- The reference browser preview is a **simulation**: rendering its gradients/shadows isn't required in DMX, only its physical output intentions (hue, saturation, value and timing). Keep analysis vs mapping vs hardware output independently testable.

### Default settings from the user's observed reference screen

| Setting | Default | Unit |
|---|---:|---|
| Music influence | **100** | percent |
| Transition speed | **220** | percent |
| Minimum brightness | **25** | percent HSV value or equivalent fixture output minimum |
| Maximum brightness | **100** | percent |
| Gamma | **1.05** | exponent |
| DMX frame rate | **40** | fps (existing user config) |
| Audio/lighting delay | **0** | ms; signed and adjustable live |
| Analysis activation fade | **3** | seconds |

Minimum brightness is mandatory and distinct from existing `masterBrightness`; `max` cannot be less than `min`. Percent values describe the music-mapping range, not the fixture's guaranteed physical brightness. Off/blackout and manually commanded lights-off bypass the music floor.

## 3. Architecture

```text
Tanda Forge [main-output player only]
   | POST track/current and transport changes + periodic position
   v
Lighting local HTTP integration
   | playback clock estimator (authoritative track position, seeks, pause)
   | new track id -> background Node worker -> in-memory music profile
   |                  (no cache / no next track / no pre-analysis)
   +--> music intent sampler (time + sync offset)
   |       - energy / drive / trend / spectral activity
   |       - individual random-hue targets and variable rates
   |       - pause anticipations and held accents
   |       - brightness floor/ceiling/gamma + smoothing
   v
Existing Lighting mode arbitration + fixture state
   | manual/cortina/blackout > ordinary automatic music influence
   v
Existing renderUniverse() at configured 40 FPS
   +--> existing DMX output adapters (RGB or dimmer)
   +--> existing bridge behaviour **unchanged**
```

Implement as separable modules where practical: `playback-integration`, `audio-analysis-worker`, `music-profile`, `music-intent`, `music-controls`. File names are recommendations, not assumptions about current repo. The core music mapping should be a pure function or well-encapsulated stateful renderer accepting (musical features, time, previous fixture state, configuration) and returning bounded DMX intent. The worker may use FFmpeg as a process; handle missing executable, corrupt file, unsupported codec and termination cleanly. No Python, Docker or package-managed audio decoding required for first release.

## 4. Tanda Forge low-level design

**Inspect actual playback code and the existing cortina integration before choosing call sites.** Extend the existing localhost Lighting connection, avoiding any network operation on the audio-critical playback thread. Do not send track paths from headphone preview.

Recommended versioned events (adjust exact endpoint naming to current server conventions):

```json
{
  "schemaVersion": 1,
  "event": "playback",
  "sessionId": "unique-current-play-occurrence",
  "sequence": 18,
  "kind": "tango",
  "state": "playing",
  "path": "/absolute/path/to/current-recording.mp3",
  "positionSeconds": 18.35,
  "durationSeconds": 164.2,
  "playbackRate": 1,
  "sentAtUnixMs": 1792420000000
}
```

- `path` is a real local path accessible to Lighting on the same machine. If Lighting is on a different host, explicitly report unsupported local path access in v1; do not silently guess path translations.
- New `sessionId` for each play occurrence, including replay of the same file. Monotonically increasing `sequence` within session. Main-output start announces current file immediately; no next track property.
- Publish position snapshots initially about every **500–1000 ms**, plus immediately on start/pause/resume/seek/stop/end. The update rate may be reduced after measured timing tests. Position must reflect the main playback engine's effective media time, accounting for silence trimming and rate if active; never derive position simply from wall-clock since click.
- On pause/stop send explicit transport status; Lighting must pause its own scheduler and suppress one-shot accents already in the past after a seek.
- Local HTTP POST timeouts, transient network failures and Lighting not running must not affect audio performance. Use fire-and-forget async delivery with bounded queue and throttled logging. Reuse existing lights-up/cortina messages unchanged.
- Identity/authorization: loopback-only by default; validate request bodies and file paths. Do not accept arbitrary remote URL or file reads on a public interface.

**Tanda Forge acceptance:** correct source path, cue never reported, seek positions updated, pause/resume exact, no next-track data, no playback stall with Lighting offline, cortina controls still work.

## 5. Lighting playback coordinator and analysis lifecycle

Keep states simple: `NO_TRACK`, `ANALYSING`, `READY`, `PAUSED`, `UNAVAILABLE`; these describe transport/analysis, not musical moods. On new session increment an internal generation token, cancel/ignore stale workers, keep the *currently visible fixture states* (hue, fades, brightness/speed) unmodified, launch one worker. Avoid double-running when a periodic position message repeats the same session.

A worker returns a normalized immutable profile with frame measurements, per-second derived measures, pause events, source duration, and any decoder metadata necessary to align with the track. It must not contain absolute playback-clock timestamps or venue offset. Store only in memory; delete/discard when replaced. Once READY, sample at current timeline time and crossfade the influence in over default 3 seconds while preserving continuity of each fixture's current hue and transition.

Clock: anchor source position to monotonic receipt time; use a received-at clock and extrapolate only while playing; periodically correct small discrepancies smoothly, but snap/rebase appropriately on seek/session change. Robustly reject out-of-order sequence numbers and position reports. Calibration `delayMs`: with positive delay, visual response happens **later** than source event; effective visual music position is playback position minus delay/1000. Keep this shift out of analysis and stored events. Distinguish audio-output, app-position-reporting, and fixture latency. Browser and main-light simulation should read the same clock state.

If a track ends or stops, do not darken it abruptly: hand control back to existing automatic-mode logic smoothly, respecting explicit lights-up and manual scenes. If analysis finishes near the end of the song, don't run past events or restart effects.

## 6. Musical feature extraction

Use the specified FFT/frame-processing and aggregation, including energy normalization by robust per-track loudness quantiles, spectral activity, periodic-drive proxy, short-term fast energy and fast activity, intensity, rising/falling/stable development, and pause detection. Lighting does **not** directly analyze Tanda Forge's normalized digital output. Avoid claims of measured BPM or mood/genre recognition. The implementation can keep FFmpeg WAV/PCM pipe decoding and the current heuristic thresholds. Ensure tracks of varying lengths and formats are bounded in memory and worker cancellation works.

Operational requirements: log `analysisMs`, input duration, feature summary, detected pause count, decode failure; do not log entire local path in routine dashboard telemetry unless needed. Provide `--no-hardware`/mock mode for regression testing. Track normalized relative loudness is not the same as Tanda Forge's playback gain; no gain integration required in v1. Do not introduce extra mastering correction until independently validated.

## 7. DMX renderer / lighting behaviour: source-of-truth separation

**Inspect actual code:** current `lighting.js` already has `randomTargetHue`, `transitionTo`, `newIndividualTransition`, `createFixtureState`, `updateMode`, `setLightsUp`, and the DMX universe generator. Reuse them where semantically compatible. The current hue transitions already take the shortest circular route and preserve saturated RGB. <https://github.com/davidgoddard/lighting/blob/main/lighting.js>.

### 7.1 Independent colours

- Each configured DMX fixture (or pair leader if paired) chooses its own random hue target anywhere in the wheel, with a configurable minimum movement target. Its hue evolves smoothly towards that target. In existing master or paired mode, **retain existing master/pair semantics**, rather than force independence and break pairing.
- Music changes explicit normalized progress against a destination time. Do not continuously recreate transition objects merely because the input value changes. Ensure hue continuity when changing timing or switching manual/music modes.
- Do not impose fixed music-dependent cool/warm hue regions in v1. The user found that blue/green bias unattractive; full-wheel random colours are a deliberate requirement. Break events may temporarily steer colours towards a theme, then fade back without discontinuities.

### 7.2 Music-dependent movement speed

Speed percent defaults to 220% and inversely scales destination time. Positive development must accelerate colour changes even when drive weakens. Hue distance does not determine completion time. Bound the minimum duration to avoid fast strobing or unnatural jumps.

### 7.3 Brightness / saturation / physical DMX handling

Compute brightness with **min 25%, max 100%, gamma 1.05**. Apply the **0.42s rise / 0.70s fall** response and relative fast musical energy. Keep 92–99% saturation; RGB outputs must be scaled, not mixed with white. A separate brightness/dimmer channel should be used where fixture type supports it; fixture-specific mapping and existing global master brightness must be respected. Music brightness is a bounded normalized fixture intent *before* existing global master controls, but never overrides blackout or lights-up. A music minimum is **not** a reason to raise an explicitly zeroed fixture.

At 0% Music Influence, legacy brightness/colour movement should be identical to current behaviour. At 100%, music mapping fully applies inside configured bounds. Avoid a discontinuity when influence changes.

### 7.4 Dramatic pauses

Only confidently detected pauses get the prepared 8-second envelope. Use real source time, signed delay, fixture-output timing. The accent should appear intentional (dimming, growing/steering towards the event colour, brief hold, gentle release); no single-frame yellow flash. Rare effect; optional enable switch. Do not trigger previously elapsed events at analysis completion/seek. Manual and lights-up overrides must trump event effects. Pause event overlay can temporarily steer a group of DMX lights while otherwise independent hues resume from their then-current colour.

### 7.5 Table lights / bridge / master mode

**No ESP firmware changes in v1.** Don't add new ESP-NOW music events or brightness. Existing bridge should retain its existing master-election and sync packets. Keep table lights autonomous outside the established master windows. During master mode, allow legacy behaviour to follow existing DMX/bridge master colour or paired leader, subject to what the current bridge code actually supports. Music should never force the bridge into permanent master mode; existing explicit master behaviour and automatic master timing remain intact. Add tests for transitions individual -> master -> individual while music influence is active.

## 8. Control arbitration

Keep existing precedence, and formalize it with tests. Suggested hierarchy, highest first:

1. hardware shutdown/blackout/explicit OFF;
2. cortina / Tanda Forge `lightsUp` and explicit DJ manual fixture commands;
3. existing pair/master coordination policy (determines relationships among fixtures);
4. enabled music-derived DMX intent (modifies automatic destination timing and brightness);
5. existing automatic wandering default.

Music mode should **not** modify any manually fixed hue or manually overridden brightness unless explicitly allowed by existing UI semantics. On removal of override, transition smoothly back. Treat the current bridge's external-master `externalControlled` state carefully: don't steal ownership of the master/wander decision.

## 9. Web UI

Extend the existing Lighting page. Controls: Music enabled toggle; Music influence (default 100%); Transition speed (220%); Minimum brightness (25%); Maximum brightness (100%); Gamma (1.05); optional pause accents enabled and AV delay ± ms. Show track title or basename, transport status, analysis duration/error, current musical intensity, rhythmic drive, development, fastEnergy, drama, destination timing, kick state, and brightness intent. Controls apply live and are persisted in Lighting config with validation. Provide `Reset defaults` and test/calibration utilities.

### AV sync and calibration

Offset defaults 0 ms; positive means later light. Allow e.g. -500 to +1000 ms, step 10 ms, with fine controls. Calibration should use the actual Tanda Forge **main audio path** (not computer notification sound) and a deliberately triggered DMX colour change so the DJ can align them; calibration must not play automatically during public music. If implementing a full test click in Tanda Forge is too invasive, deliver manual signed offset first and mark click calibration as a separately testable follow-up, not silently fabricate timing precision. The 40 FPS DMX nominal frame period is 25 ms; real USB/device delay and OS scheduling require measurement.

## 10. Config sketch (new fields only)

```json
{
  "music": {
    "enabled": false,
    "colourMotionEnabled": true,
    "influencePercent": 100,
    "transitionSpeedPercent": 220,
    "minimumBrightnessPercent": 25,
    "maximumBrightnessPercent": 100,
    "gamma": 1.05,
    "avDelayMs": 0,
    "activationBlendSeconds": 3,
    "dramaticPausesEnabled": true,
    "dramaticPauseMinimumScore": 0.58,
    "response": {
      "calmTransitionSeconds": 38,
      "dramaticTransitionSeconds": 4,
      "riseSensitivity": 1,
      "fallSlowdown": 0.5,
      "kickEnabled": true,
      "kickThreshold": 0.55,
      "kickCooldownSeconds": 1.2,
      "kickDecaySeconds": 0.9,
      "kickSpeedMultiplier": 2.2,
      "kickRetargetEnabled": true,
      "minimumHueDistanceDegrees": 55
    }
  }
}
```

Merge these into existing config without deleting existing keys. Keep existing `fps: 40` as provided by the user's installation. Defaults are specified even though `music.enabled` initially remains false to preserve historical behaviour until explicitly turned on.

## 11. Test plan and acceptance

**Automated tests** using mocked clock, profile and DMX writer:

- Valid track start, duplicate progress, pause/resume, seek, replay same path/new session, out-of-order event, silence-trim position alignment, preview/cue ignored, no next-track field.
- Exactly one analysis per new session; no work before start; no files/caches created; stale worker result ignored; long/invalid/missing file preserves lighting and does not freeze DMX output.
- During analysis, hold current hue target, progress, brightness and transition speed (allow ongoing already-scheduled visual fades to finish normally); on READY, smoothly blend over 3 s at actual current source position.
- Music influence 0% reproduces existing baseline and table-light logic; 100% applies music mappings within rounding and fixture-output transformations. Support a variable number of actual DMX fixtures, random destination separation, and shortest circular routes.
- Max brightness 100%, min 25%, gamma 1.05 and slider live changes; explicit OFF remains 0%; gamma curve monotonically increasing; saturation remains high and no white injection.
- Fast sustained music accelerates transitions meaningfully; quiet music stays slow; quick energy drops use fall smoothing; no colour discontinuity occurs when rate changes.
- Strong pause causes 8 s prepared effect and sustained hold/recovery; sub-threshold breaks do not trigger accent; seek past break does not replay accent.
- 40 FPS configured DMX interval; nonblocking worker; no frame drop during file decode on a representative machine; no unscheduled bridge packets caused by music mode.
- Existing cortina fade, manual overrides, pairing/master transitions, device discovery, disconnected DMX, no FFmpeg, and stopped player retain expected behaviour.

**Manual listening tests:** Run Pugliese *El Pañuelito*, De Caro *El Espiante*, and a quiet piano/alternative tango against real DMX fixtures. Note whether dynamic brightness tracks singer entrances/exits, whether brisk passages accelerate target changes, and whether pause effects feel intentional. Do not require genre classification.

**Operational guardrails:** no hardware output above configured ceilings; no music floor applied to blackout; never expose arbitrary local file reading to untrusted remote callers; terminate worker/decoder subprocesses on shutdown and track replacement; log errors without disturbing DJ playback.

## 12. Claude implementation plan / PR sequence

1. **PR A — Tanda Forge main-output-only playback notices.** Reuse existing integration, add tests, keep current cortina contract intact.
2. **PR B — Lighting receiver, clock and analysis worker.** Analyze on notice, no cache/next tracks; expose profile/worker diagnostics; mock hardware tests.
3. **PR C — Music intent and DMX output integration.** Time-based random destinations and HSV brightness mapping, preserving pairing/master/manual precedence. Tests with mocked DMX frames.
4. **PR D — Pause envelopes, signed AV delay, browser controls/preview.** Events and smooth ramps, calibration UI, settings persistence.
5. **PR E — Integrated hardware verification.** Test 40 FPS, abort/disconnect, cortinas, external master and real fixtures; document limitations and provide rollback switch.

Deliver each PR with a summary of changed files, any unresolved assumptions, exact manual verification steps, and proof that turning off music mode returns all existing operations to their previous state. Do not refactor unrelated Lighting features. The first deployable milestone is DMX-only music mode with baseline brightness/rate mapping; calibration improvements can follow without blocking it.

## 13. Source notes / verification boundary

- Public Lighting `lighting.js` currently shows `validateConfig`, `randomTargetHue`, shortest-path `transitionTo`, individual/master state and cortina `setLightsUp` code. Source: https://github.com/davidgoddard/lighting/blob/main/lighting.js.
- Public Lighting README: https://github.com/davidgoddard/lighting/blob/main/README.md.
- Public Tanda Forge README: https://github.com/davidgoddard/tanda-forge/blob/main/README.md. This specification does not claim verified knowledge of its internal playback function; Claude must inspect that code.
- Retain `tango-analyse.js` and `dashboard.html` as historical implementation references for feature windows, filtering constants, and envelope timing.
