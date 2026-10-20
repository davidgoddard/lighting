# Music-aware DMX implementation

The implementation directly ports `tango-light-momentum-edges-prototype`: 11,025 Hz audio, overlapping 1,024-sample FFT windows with a 256-sample hop, track-relative phrase energy, rolling rhythmic momentum, development, exceptional hits, relative breaks, entrances, and START/STOP edges. Analysis runs in a worker and profiles remain in memory for one playback occurrence.

Production behavior:

- Controls and defaults match the prototype: brightness 25–100%, gamma 1.05, rhythm 100%, above-average energy 75%, relaxation 2500 ms, speed 220%, kick threshold 90%, kick time 650 ms, and structure effects enabled.
- Playback comes from Tanda Forge's main-output clock; Lighting does not start audio or use FFplay.
- Music intent is applied before existing master-brightness and lights-up controls. Static/manual fixtures are excluded; every automatic DMX leader keeps an independent colour trajectory.
- Ordinary accents affect rolling momentum, not brightness. Phrase brightness and structural envelopes use the prototype formulas. Rare qualified hits choose per-fixture targets at least 100° away with a four-second cooldown.
- During every master mode, automatic DMX fixtures share one trajectory and the bridge receives that exact target hue and remaining duration, including before music analysis is ready or when music response is disabled. Commands are deduplicated and rate-limited; pause holds and master exit restores autonomous behavior.
- The browser preview reports production intent without decorative simulation effects.
- No automatic click calibration is included in this milestone; signed manual AV offset is available live.

## Manual verification

1. Start Lighting with FFmpeg available and confirm the dashboard reports DMX status while music remains disabled.
2. Start a main-output tango in Tanda Forge. Confirm `ANALYSING` changes to `READY`, with no lighting jump when the profile completes.
3. Enable music and compare Pugliese *El Pañuelito*, De Caro *El Espiante*, and a quiet piano tango against the dashboard values and physical fixtures.
4. Seek, pause, resume, and replay the same file. Confirm the clock follows each action, paused transitions remain still, and replay causes one new analysis.
5. Exercise static colour, master entry/exit, cortina lights-up, global brightness zero, disconnected DMX, and table lights. Confirm bridge commands occur only in music master mode.
6. Stop playback and confirm DMX returns to legacy wandering while table lights return to autonomous behavior.
