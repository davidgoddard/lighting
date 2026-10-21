# Codex implementation brief — expressive, music-responsive DMX lighting

**Target:** `https://github.com/davidgoddard/lighting` (inspect the working checkout before editing).  
**Scope:** Lighting only. Do not change Tanda Forge, ESP bridge firmware, playback protocol, audio analysis worker, or table-light autonomy.  
**Goal:** Preserve the working responsive intensity/brightness and fast energy 'kick', while making sustained rising/falling sections change the *frequency of distinct colour destinations* much more strongly.

## 0. What was verified (source review)

Files in the currently published repository include `lighting.js`, `music-intent.js`, `audio-analysis.js`, `audio-analysis-worker.js`, `playback-integration.js`, `config.json`, and `tests/`. Important exact integration points:

- `music-intent.js` `sampleProfile()` already makes `fastEnergy`, `intensity`, `drive`, `fastActivity`, and **signed** `development` available. `computeMusicIntent()` produces `hueRate`, `brightness`, `saturation`, `accent` and `feature`.
- `music-intent.js` computes `urgency` using drive 0.32, fastActivity 0.32, intensity 0.26, and short-term lift 0.10. **It does not directly use `feature.development` in hue-rate selection.** `hueRate` is expressed in degrees/second, with a slow base near 1.7.
- `lighting.js` `newIndividualTransition()` chooses a random hue, with minimum separation 48° under music mode. `transitionTo()`, `transitionHue()` and `transitionProgress()` control the actual hue journey. `updateMode()` only selects a new individual target when the previous transition completes.
- `lighting.js` `applyMusicRate()` derives active transition duration from **angular distance / requested deg/s**, retiming existing transitions every render tick. Master mode follows its separate shared target scheduler. The browser/logged hue rate alone does not describe how often destinations are actually reached.
- `lighting.js` `renderUniverse()` renders highly saturated HSV, applies the existing pause accent, supports both dedicated dimmer-channel and RGB-only fixtures, and prioritises lights-up blending.
- `lighting.js` main loop runs at `config.fps` (checked-in config: 40 FPS), samples the current playback profile, calls `computeMusicIntent`, then `applyMusicRate`, then renders DMX.
- Checked-in `config.json` at time of review: `masterMode.enabled=false`, `externalMaster.enabled=true`, `music.enabled=true`, `transitionSpeedPercent=300`, `minimumBrightnessPercent=1`, `maximumBrightnessPercent=100`, `gamma=1.05`. **Do not silently change these user's active values.** Earlier experiments used a 25% minimum; that is a user choice, not a reason to overwrite their current 1% configuration.

Use the current checkout as the source of truth if code has advanced since this review.

## 1. Observed mismatch and desired behavior

User's *Assassin's Tango* log shows:

- `0:44–0:50`: marked `RISING`, development ~+0.38 → +0.24, energy rises, but hue rate stays about **2°/s**.
- `2:23–2:28`: `RISING`, intensity increasing, yet hue rate decelerates **11.6 → 3.7°/s**, apparently because drive/activity fall.
- `3:23–3:35`: stronger energy finally drives **~34–38°/s**, demonstrating that responsive speed is possible.
- Brightness follows short-term energy reasonably well. **Preserve this effect** rather than flatten it in a long smoothing window.
- The user explicitly wants *short energy bursts to kick the lights*, including a **brief rapid hue transition or acceleration**, not just a brief brightness flash. Preserve/enhance this as a separate fast layer. Avoid rapid strobing.

Desired examples:

1. **Low/medium energy and stable:** slowly wander among random, fully saturated hues; moderate but responsive brightness.
2. **Sustained rising development:** accelerate the selection and completion of *new distinct colour destinations* (even when rhythmic drive happens to weaken), while brightness rises according to energy.
3. **High intensity / rising:** several independently selected hues over a short interval; clearly more animated, still smooth and saturated, not a hard-cut disco sequence.
4. **Falling:** gradually lengthen transitions and dim as the energy actually declines; do not force instant darkness just because slope goes negative.
5. **Short high-energy surge:** a visible 'kick': briefly increase the rate of change and/or select a fresh random destination, while retaining the working fast brightness response. A brief kick must not derail longer-term behavior.
6. **Dramatic pause:** retain the existing anticipatory pause envelope/colour effect and configured eligibility threshold. Do not treat every word/phrase boundary as a major event.

## 2. Architectural requirement: three independent response layers

Do NOT replace all behavior with a single classification enum or a single speed formula.

### 2.1 Long-term musical *drama*

Derive a continuous `drama` (0..1) using `intensity`, **positive** `development`, and `drive`. Start with:

```js
const rising = smoothstep((feature.development - 0.06) / 0.35);
const intense = smoothstep((feature.intensity - 0.25) / 0.55);
const rhythm = smoothstep((feature.drive - 0.20) / 0.55);
const drama = clamp(0.38 * intense + 0.42 * rising + 0.20 * rhythm);
```

Treat these weights/thresholds as *tunable hypotheses*; preserve the feature values, do not change the analyser. Rising must have enough weight that the 0:44–0:50 scenario visibly accelerates despite weakening drive. A negative development should not automatically make a high-intensity passage calm; intensity still contributes.

The `drama` output primarily determines **time to the next random target**, not angular velocity.

### 2.2 Short-term energy *kick*

Calculate positive energy surges independently, using `fastEnergy` compared with a medium-term baseline (e.g. `intensity` and/or smoothed `fastEnergy`). If a stable baseline is introduced, update it continuously and keep its time constant ~2–4s. Do not trigger solely on high absolute loudness; seek a positive change. Suggested starter:

```js
const relativeSurge = Math.max(0, feature.fastEnergy - feature.intensity);
const kickStrength = smoothstep((relativeSurge - 0.08) / 0.22);
```

Optionally combine with positive difference from a short rolling history so kicks represent rising bursts rather than a long sustained note. Add an attack (~0.1–0.2s), decay (~0.6–1.2s), and refractory interval (~0.8–1.5s) for **new destination triggers**, but retain fast brightness movement on every relevant energy fluctuation. Generate deterministic event transitions from time and features, not random triggering independently on every 40 FPS frame.

Kick behavior: briefly increase effective colour-transition progress/speed **and optionally retarget one or more lamps**. Do not hard-snap hue. Limit per-lamp forced retargets (e.g. >= 1.0 s apart); if a fast transition is already under way, boost it rather than constantly restarting. Avoid all fixtures jumping to the same hue.

### 2.3 Brightness

Keep the existing 72% `fastEnergy` / 28% `intensity` expressive-energy blend, existing gamma, min/max, live influence, and asymmetric ~0.42s attack / ~0.70s release as a starting point. Only adjust if tests show an actual output defect. Consider an *optional* longer-term brightness rise/fall bias, bounded to perhaps ±10%, but make it off by default initially: current brightness is reportedly good. Do not conflate visual drama with raw output brightness.

## 3. Replace distance-based hue speed with time-based destinations

**Root behavior to fix:** the current `applyMusicRate()` changes `durationMs` using `distance / degreesPerSecond`. This can make a close random target finish rapidly and a distant target take much longer. What matters aesthetically is **how often an observer sees a new colour**.

Produce `targetTransitionSeconds` (or `targetChangesPerMinute`) in the intent layer. Suggested initial anchor ranges (editable in config):

| Situation | Target time per destination |
|---|---:|
| Calm / stable | 25–45s |
| Moderate / stable | 12–25s |
| Moderate / clearly rising | 6–12s |
| Strong rising / high energy | 3–6s |
| Intense but stable | 5–10s |
| Sustained falling | gradually return toward 20–40s |
| Kick | temporary acceleration toward ~0.8–2.0s, then recover |

Use a continuous nonlinear interpolation of these ranges (not a classification state machine). Example initial mapping:

```js
const baseDurationSeconds = mix(38, 4, Math.pow(drama, 1.1));
const falling = smoothstep((-feature.development - 0.07) / 0.35);
const durationSeconds = clamp(
  baseDurationSeconds * (1 + 0.5 * falling), 2.5, 48
);
```

Adjust parameters after comparing log sections; this formula is a proposal, not a mandatory exact aesthetic. Keep the existing `transitionSpeedPercent` as a clear multiplier: above 100% means *shorter* duration, below 100% means longer duration; decide whether it should scale an anchor calibrated at 220% or 100%, document it, and avoid accidentally speeding everything to an unsafe/ugly rate at the checked-in 300%.

### 3.1 Continuous progress rather than retiming `startedAt` each frame

Prefer a per-transition **normalized progress accumulator** driven by wall-clock delta:

```js
transition.progress = Math.min(1, transition.progress + dtSeconds / effectiveDurationSeconds);
```

Then interpolate hue along shortest arc from `fromHue` to `toHue`. Changing `effectiveDurationSeconds` should change the forward progress rate **without resetting position or moving backward**. The existing method of recomputing `startedAt = now - progress * durationMs` can preserve raw progress, but can interact awkwardly with smoothstep and other schedulers. Prefer explicit progress and single ownership of updates under music mode.

If preserving existing transition objects, create a *music-specific controller* that stores `fromHue`, `toHue`, `progress`, `lastUpdate`, and optionally `easing`, with a clear conversion path when entering/leaving music mode. Never recalculate random destinations on every frame.

Use easing that produces visually continuous changes but does not nearly stop at every endpoint during high drama. Consider linear hue progress with a small ease or smoothstep used only when gentle; full smoothstep can spend excessive time near the ends of short transitions.

### 3.2 Retarget without a visible jump

When a transition completes, sample the current actual output hue, choose a new independent target anywhere on the wheel (minimum meaningful distance e.g. 45–65°, configurable), and start a new transition. When an energy kick explicitly forces a new target, begin from the **current interpolated hue**, never the previous target or stale start hue.

Keep the existing random destination + shortest-arc behavior. Four fixtures should generally be independent, using a shared drama/speed envelope. Pair followers continue following their leader as before.

### 3.3 Master and external-master modes

Review `updateMode()`, `applyMusicRate()`, `applyMasterTransition()`, `applyExternalMasterMessage()`, `releaseMusicTransitions()` and `musicCanDriveHue()` together. Preserve table-light/ESP protocol exactly. A bridge external master can retain authority over synchronisation. **Music-responsive colour retargeting must not unexpectedly wrest control from the bridge**; if external control is active, maintain current policy and log that hue motion is bridge-controlled. Brightness can still be music-responsive on DMX lights where not overridden.

For local DMX virtual master mode: ensure music can affect timing of the shared target, or explicitly disable local master gathering while music mode is active (configurable) if the desired priority is independent visual drama. Do not silently alter all session scheduling. User currently has `masterMode.enabled=false` in checked-in config; nevertheless test this mode, because historic logs show master sessions.

## 4. Genuine fast 'kick' without flash artifacts

Add a short-lived `kick` output to `computeMusicIntent()` with `strength` (0..1) and `phase`/`remainingSeconds`, or a separately managed timed event. Its two effects:

1. **Temporary hue acceleration**: multiply base progress speed for around 0.5–1.0s (for example 1.5x–3x depending on strength), bounded by a configurable minimum transition time. Optionally choose a fresh target on a large surge if not already moving briskly.
2. **Brightness pulse**: preserve existing fast-energy brightness dynamics. If an additive pulse is desirable, use a small bounded increment (start at 0; no extra pulse initially because existing brightness works). No white-channel injection, no saturation washout, no full-intensity flashes.

Kicks should occur during energetic passages, not every little accent in a gentle piece. Gate by absolute/relative intensity and `kickStrength`, and log when a kick actually triggers. Keep a cooldown and damping. Musical energy and actual light pulse needn't be sample-accurate, but use the current playback time and AV offset rather than naive local audio arrival.

## 5. Brightness and DMX safety

Preserve `renderUniverse()` and its dimmer-channel vs RGB scaling behavior. Verify final DMX output channels:

- The output must respect `minimumBrightnessPercent` and `maximumBrightnessPercent` for music mode, except **intentional overrides** (lights up/down, static fixture configuration, master brightness, explicit off/blackout).
- Distinguish `intent.brightness` from `masterBrightness / 255` and fixture channel values. A global master brightness of zero must still turn lights off even if music has a floor.
- Saturation should remain high (HSV), with no added white for energetic passages.
- Cortina lights-up fades must remain authoritative and visually continuous.
- Changes must not bypass the existing 40 FPS DMX scheduler or produce packets faster than the configured DMX refresh.

## 6. Music influence, handoff, and usability

- Music Influence 0% must exactly reproduce the existing non-music wander behavior; 100% allows full music effects.
- When playback enters `ANALYSING`, retain previous visual intent until ready (existing agreed behavior). Blend from current physical hue/brightness after analysis; do not reset hue targets.
- On pause, freeze/hold musical timeline as existing system intends. On seek, resample position and reset or rebase kick event bookkeeping to avoid replaying old kicks unpredictably.
- On track stop/loss, return smoothly to legacy lighting. Manual static colours, pairing, lights-up, Tanda Forge cortina, and external master controls must retain priority.
- Provide a simple on/off for music-driven **colour motion** separately from music-driven **brightness** if minimal to add, so the DJ can A/B compare effects.

## 7. Expose useful diagnostic values

Extend existing `/api/state` music intent diagnostics and optional 1Hz console logging to include:

- `feature.intensity`, `feature.fastEnergy`, `feature.drive`, `feature.fastActivity`, **signed `feature.development`**
- `drama`, `kickStrength`, `kickActive`, last kick time and whether it triggered a new destination
- desired destination time (seconds), effective current time after influence/speed/kick modifiers
- per fixture (or representative fixture) current hue, target hue, progress, remaining time, actual output hue, and controller ownership (`individual music`, `local master`, `external master`, `static`, etc.)
- `intent.brightness`, final dimmer DMX value and RGB scaling or equivalent final output data

Do not mistake a high `hueRate` log entry for proven physical movement. Make logs trace actual renderer state.

## 8. Configuration

Keep existing config values unchanged. Add a small validated optional block for response tuning, with defaults if absent, e.g.:

```json
"music": {
  "...existing properties...": "unchanged",
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
```

Illustrative JSON: the `"...existing properties..."` entry is explanatory only and **must not** be written to the real file. Choose clear field names, validate ranges, avoid hardcoded scattered values. Do not overwrite current `music.transitionSpeedPercent=300` or `minimumBrightnessPercent=1` as part of this patch.

## 9. Tests required before declaring success

Write unit tests for pure response functions and deterministic render/transition tests using a seeded random generator or injected target-picker. No DMX adapter or Tanda Forge required for these tests.

1. **Rising despite drive drop**: intensity .43→.55, development .40→.24, drive .37→.25; effective transition time should still be materially shorter than calm baseline (no 2°/s equivalent).
2. **Quiet stable**: modest intensity, development near 0, low drive: durations remain long and brightness moderate (subject to user's configured min).
3. **High stable**: high intensity, development near 0: more movement than quiet stable.
4. **Strong rising**: high intensity and positive development: multiple distinct colour destinations in a ~20s deterministic simulation.
5. **Falling**: time to next target lengthens progressively; no colour jumps or immediate brightness blackout.
6. **Kick**: synthetic brief positive fastEnergy surge causes a bounded, short acceleration/new-target event, no rapid repeat while surge persists, and recovery after decay.
7. **No kick**: ordinary small noise near threshold does not repeatedly retarget.
8. **Continuity**: changing requested duration mid-transition does not cause hue jumps or reverse progress.
9. **Wraparound**: 355°→10° and 10°→355° take shortest hue path.
10. **Ownership**: static fixture remains static; pair follower follows leader; external master remains authoritative; table bridge serial protocol unchanged.
11. **Brightness**: gamma/floor/ceiling, dimmer fixture vs RGB-only fixture, master brightness off, cortina lights up/down.
12. **Playback**: analysis activation, pause, seek, next track, stop/release, music disabled.
13. **40 FPS rendering**: timers remain responsive and DMX write frequency unchanged; no unbounded repeated retargeting.

Provide a deterministic **trace/replay test** that loads numeric music features from a JSON fixture representing the user's *Assassin's Tango* log (or a small hand-created subset) and records effective destination durations and kick events at 0:44–0:50, 2:23–2:28, and 3:23–3:35. A regression test must show greater colour activity during the first two rises than the old implementation.

## 10. Implementation sequence / deliverables

1. Baseline tests and instrumentation; record current behavior on deterministic traces.
2. Refactor `music-intent.js`: expose independent `drama`, `targetTransitionSeconds`, and `kick` while **preserving brightness mapping and pause envelope**.
3. Refactor music-driven transition progress in `lighting.js` so colour destinations complete on musical **time schedules** instead of distance/deg/s. Preserve non-music behavior exactly.
4. Add bounded fast kick event: brief acceleration and optional fresh target, no hard hue snap.
5. Integrate control precedence and any local master-mode choice; leave bridge firmware untouched.
6. Add config validation, optional UI controls / clear readouts and tests.
7. Run `npm test` (or project's test command), static validation, and a simulated no-hardware 40 FPS replay. Report tests, changed files, and remaining limitations. Do not claim acoustic or actual fixture visual verification without testing hardware.

## 11. Definition of done

- A steady gentle passage still has tasteful, saturated, independently wandering colours, medium brightness and occasional modest musical response.
- A moderate *rising* passage causes noticeable **faster new colours** even as the separate rhythm metric falls.
- Strong sustained energy yields several fresh random destinations within 15–25 seconds, rather than spending a minute crossing the wheel.
- A short high-energy burst produces a visible, brief **kick** in colour movement as well as the existing faster brightness reaction; no glitch-like instant hue snap.
- Falling passages slow and dim gradually.
- Existing pause effects, 40 FPS, manual controls, cortinas, DMX device handling, and ESP/table-light behavior still work.
- Logs show renderer movement, not merely theoretical analytical requests.

### Codex starting instruction

> Inspect the current repository and compare it to the function names and notes above. Implement the smallest coherent change set to make musical development and short energy bursts produce visible, smooth, time-based DMX colour motion, while preserving existing responsive brightness, pause envelopes, manual overrides, and bridge behavior. Start with tests exposing the logged failure scenarios; then refactor the music-intent and hue-transition controller. Do not change the audio-analysis algorithm, Tanda Forge, or ESP code. Do not modify the user's existing live configuration values without explaining and asking.
