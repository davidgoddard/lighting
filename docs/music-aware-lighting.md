# Music-aware DMX implementation

The implementation ports V10's 11,025 Hz / 1,024-sample FFT analysis, robust loudness normalization, spectral activity, periodic-drive proxy, development hysteresis, fast energy/activity, pause scoring, colour-rate weighting, brightness response, high saturation, and dramatic-pause envelope. Analysis runs in a worker and profiles remain in memory for one playback occurrence.

Production differences from the prototype are intentional:

- Defaults are influence 100%, speed 220%, brightness 25–100%, and gamma 1.05, as required by the production specification rather than V10's checked-in sliders.
- Playback comes from Tanda Forge's main-output clock; Lighting does not start audio or use FFplay.
- Music intent is applied before the existing master-brightness and lights-up controls. Static/manual fixtures are excluded. Pair/master relationships remain authoritative.
- Profile activation and release use the configured three-second blend. Positive AV delay samples an earlier profile position so the visible response occurs later.
- The browser preview is deliberately illustrative. It reports the production intent and four saturated lamps rather than copying V10's decorative gradients.
- No automatic click calibration is included in this milestone; signed manual AV offset is available live.

## Manual verification

1. Start Lighting with FFmpeg available and confirm the dashboard reports DMX status while music remains disabled.
2. Start a main-output tango in Tanda Forge. Confirm `ANALYSING` changes to `READY`, with no lighting jump when the profile completes.
3. Enable music and compare Pugliese *El Pañuelito*, De Caro *El Espiante*, and a quiet piano tango against the dashboard values and physical fixtures.
4. Seek, pause, resume, and replay the same file. Confirm the clock follows each action, paused transitions remain still, and replay causes one new analysis.
5. Exercise static colour, pair/master changes, cortina lights-up, global brightness zero, disconnected DMX, and table lights. These controls must retain priority and music must not create bridge packets.
6. Stop playback or set influence to zero and confirm a smooth return to legacy automatic wandering.
