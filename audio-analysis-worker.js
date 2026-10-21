import { spawn } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";

// Direct server-side port of tango-light-momentum-edges-prototype.
const RATE = 11025, N = 1024, HOP = 256, BANDS = [[40, 200], [200, 2000], [2000, 5000]];
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function fft(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; } }
  for (let length = 2; length <= n; length <<= 1) {
    const theta = -2 * Math.PI / length, wr = Math.cos(theta), wi = Math.sin(theta);
    for (let offset = 0; offset < n; offset += length) { let ar = 1, ai = 0;
      for (let j = 0; j < length / 2; j += 1) { const a = offset + j, b = a + length / 2;
        const tr = real[b] * ar - imag[b] * ai, ti = real[b] * ai + imag[b] * ar;
        real[b] = real[a] - tr; imag[b] = imag[a] - ti; real[a] += tr; imag[a] += ti;
        const nr = ar * wr - ai * wi; ai = ar * wi + ai * wr; ar = nr; } }
  }
}

function decode(input) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", input,
      "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = []; let stderr = "", settled = false;
    child.once("error", error => { settled = true; reject(new Error(`Cannot launch ffmpeg: ${error.message}`)); });
    child.stderr.on("data", data => { if (stderr.length < 4096) stderr += data.toString(); });
    child.stdout.on("data", data => chunks.push(data));
    child.once("close", code => { if (settled) return;
      if (code !== 0) reject(new Error(`ffmpeg failed (${code}): ${stderr.trim()}`));
      else { const decoded = Buffer.concat(chunks);
        if (decoded.length < N * 4) reject(new Error("No decodable audio samples"));
        else resolve(new Float32Array(decoded.buffer, decoded.byteOffset, Math.floor(decoded.byteLength / 4))); } });
  });
}

function generateProfile(pcm) {
  const startedAt = Date.now(), duration = pcm.length / RATE, count = Math.floor((pcm.length - N) / HOP) + 1;
  const rows = new Array(count), real = new Float64Array(N), imag = new Float64Array(N), sums = [0, 0, 0];
  const smooth = [0, 0, 0], slow = [0, 0, 0], previous = [0, 0, 0];
  const frequencies = BANDS.map(([lo, hi]) => [Math.max(1, Math.floor(lo * N / RATE)), Math.min(N / 2 - 1, Math.ceil(hi * N / RATE))]);
  const window = Float64Array.from({ length: N }, (_, index) => .5 - .5 * Math.cos(2 * Math.PI * index / (N - 1)));
  for (let frame = 0; frame < count; frame += 1) { const offset = frame * HOP; let square = 0;
    for (let index = 0; index < N; index += 1) { const value = pcm[offset + index]; square += value * value; real[index] = value * window[index]; imag[index] = 0; }
    fft(real, imag);
    for (let band = 0; band < 3; band += 1) { let power = 0; const [lo, hi] = frequencies[band];
      for (let bin = lo; bin <= hi; bin += 1) power += real[bin] ** 2 + imag[bin] ** 2;
      sums[band] = Math.log1p(power); smooth[band] = smooth[band] * .80 + sums[band] * .20; slow[band] = slow[band] * .983 + sums[band] * .017; }
    const onset = sums.map((value, band) => clamp((value - previous[band] - .045) / .90, 0, 2));
    const relative = sums.map((value, band) => clamp((value - slow[band] - .18) / 1.35, 0, 2));
    for (let band = 0; band < 3; band += 1) previous[band] = smooth[band];
    rows[frame] = { t: offset / RATE, rms: Math.sqrt(square / N), onset, relative };
  }
  const dbValues = rows.map(row => 20 * Math.log10(Math.max(row.rms, 1e-7))).sort((a, b) => a - b);
  const percentile = q => dbValues[Math.floor((dbValues.length - 1) * q)], floorDb = percentile(.08), peakDb = percentile(.94), span = Math.max(4, peakDb - floorDb);
  let fast = 0, phrase = 0, trend = 0;
  const frames = rows.map(row => { const energy = clamp((20 * Math.log10(Math.max(row.rms, 1e-7)) - floorDb) / span);
    fast += (energy - fast) * .24; phrase += (energy - phrase) * .009; trend += (phrase - trend) * .005;
    return { t: row.t, energy, fast, phrase, development: clamp((phrase - trend) * 5, -1, 1), onset: row.onset, relative: row.relative }; });
  const events = [], last = [-10, -10, -10];
  for (let index = 2; index < frames.length - 2; index += 1) { const current = frames[index];
    for (let band = 0; band < 3; band += 1) { const onset = current.onset[band], score = clamp(onset * .68 + current.relative[band] * .35, 0, 1.5);
      if (score < .24 || onset < frames[index - 1].onset[band] || onset < frames[index + 1].onset[band] || current.t - last[band] < .14) continue;
      const strength = clamp((score - .19) / .75); if (strength < .08) continue;
      last[band] = current.t; events.push({ t: +current.t.toFixed(3), band, strength: +strength.toFixed(3) }); } }
  const strong = [];
  for (const event of events.filter(event => event.strength >= .53).sort((a, b) => a.t - b.t)) { const nearby = strong.at(-1);
    if (nearby && event.t - nearby.t < .32) { if (event.strength > nearby.strength) Object.assign(nearby, event); continue; } strong.push({ ...event }); }
  const lookup = time => frames[Math.max(0, Math.min(frames.length - 1, Math.round(time * RATE / HOP)))];
  const breaks = [];
  for (let time = 2; time < duration - 1; time += .1) { const before = (lookup(time - .95).fast + lookup(time - .55).fast) / 2;
    const after = (lookup(time + .12).fast + lookup(time + .35).fast) / 2, drop = before - after;
    if (before < .62 || drop < .43 || (breaks.length && time - breaks.at(-1).t < 3)) continue;
    let lowest = after, at = time + .2; for (let delta = .2; delta < 1.6; delta += .1) if (lookup(time + delta).fast < lowest) { lowest = lookup(time + delta).fast; at = time + delta; }
    const recovered = lookup(Math.min(duration - .1, at + 1.15)).fast;
    breaks.push({ t: +time.toFixed(2), lowAt: +at.toFixed(2), drop: +drop.toFixed(2), reentry: recovered - lowest > .23 ? +(at + 1.15).toFixed(2) : null }); }
  const entrances = [];
  for (let time = 2; time < duration - 1; time += .1) { const quiet = (lookup(time - 1.15).fast + lookup(time - .65).fast) / 2;
    const loud = (lookup(time + .1).fast + lookup(time + .3).fast) / 2, rise = loud - quiet;
    if (quiet > .47 || loud < .69 || rise < .38 || (entrances.length && time - entrances.at(-1).t < 4)) continue;
    entrances.push({ t: +time.toFixed(2), rise: +rise.toFixed(2) }); }
  const edges = [];
  for (let time = 1; time < duration - .7; time += .05) { const pre = (lookup(time - .38).fast + lookup(time - .19).fast) / 2, post = (lookup(time + .16).fast + lookup(time + .36).fast) / 2;
    const change = post - pre, amplitude = Math.abs(change); if (amplitude < .30) continue;
    const localBefore = (lookup(time - .75).fast + lookup(time - .55).fast + pre) / 3, localAfter = (post + lookup(time + .5).fast + lookup(time + .7).fast) / 3;
    if (Math.abs(localAfter - localBefore) < .26) continue;
    const kind = change < 0 ? "STOP" : "START", strength = clamp((amplitude - .23) / .57, .25, 1), prior = edges.at(-1);
    if (prior && prior.kind === kind && time - prior.t < .9) { if (amplitude > prior.amplitude) Object.assign(prior, { t: +time.toFixed(2), strength: +strength.toFixed(3), amplitude }); continue; }
    edges.push({ t: +time.toFixed(2), kind, strength: +strength.toFixed(3), amplitude }); }
  edges.forEach(edge => delete edge.amplitude);
  const phraseValues = frames.map(frame => frame.phrase).sort((a, b) => a - b), phraseAt = q => phraseValues[Math.floor((phraseValues.length - 1) * q)];
  const phraseMedian = phraseAt(.5), phraseUpper = phraseAt(.85), rhythm = [], salient = events.filter(event => event.strength > .35).sort((a, b) => a.t - b.t); let left = 0, right = 0;
  for (let time = 0; time < duration; time += .25) { while (left < salient.length && salient[left].t < time - 3.5) left += 1; while (right < salient.length && salient[right].t <= time) right += 1;
    const unique = []; for (let index = left; index < right; index += 1) if (!unique.length || salient[index].t - unique.at(-1) > .115) unique.push(salient[index].t);
    const intervals = []; for (let index = 1; index < unique.length; index += 1) { const gap = unique[index] - unique[index - 1]; if (gap > .15 && gap < 1.4) intervals.push(gap); }
    const mean = intervals.length ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : 0;
    const cv = mean ? Math.sqrt(intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length) / mean : 2;
    const regularity = clamp((.85 - cv) / .65) * clamp(intervals.length / 5), density = clamp((unique.length / 3.5 - 1.3) / 4.5), pace = mean ? clamp((.8 - mean) / .52) : 0;
    rhythm.push([+clamp(.52 * regularity + .32 * density + .16 * pace * regularity).toFixed(3), +regularity.toFixed(3), +pace.toFixed(3)]); }
  return { version: 4, duration: +duration.toFixed(2), hop: HOP / RATE,
    timeline: frames.map(frame => [+frame.energy.toFixed(3), +frame.fast.toFixed(3), +frame.phrase.toFixed(3), +frame.development.toFixed(3)]),
    rhythm, rhythmHop: .25, phraseMedian, phraseUpper, events, strong, breaks, entrances, edges,
    info: { floorDb: +floorDb.toFixed(1), peakDb: +peakDb.toFixed(1), analysisMs: Date.now() - startedAt } };
}

try { parentPort.postMessage({ ok: true, profile: generateProfile(await decode(workerData.input)) }); }
catch (error) { parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
