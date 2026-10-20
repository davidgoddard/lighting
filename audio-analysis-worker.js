import { spawn } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";

const SAMPLE_RATE = 11025, WINDOW = 1024, WINDOW_SEC = WINDOW / SAMPLE_RATE;
const clamp = (n, a = 0, b = 1) => Math.min(b, Math.max(a, n));
const avg = (array, from, to, key) => {
  const start = Math.max(0, Math.floor(from)), end = Math.min(array.length, Math.ceil(to));
  if (end <= start) return 0;
  let sum = 0; for (let index = start; index < end; index += 1) sum += key ? array[index][key] : array[index];
  return sum / (end - start);
};
const percentile = (sorted, q) => {
  if (!sorted.length) return 0;
  const index = clamp(q, 0, 1) * (sorted.length - 1), a = Math.floor(index), b = Math.ceil(index);
  return sorted[a] + (sorted[b] - sorted[a]) * (index - a);
};

function spectralFrame(samples, previousBands) {
  const real = new Float64Array(WINDOW), imag = new Float64Array(WINDOW); let power = 0;
  for (let index = 0; index < WINDOW; index += 1) {
    const sample = samples[index]; power += sample * sample;
    real[index] = sample * (.5 - .5 * Math.cos(2 * Math.PI * index / (WINDOW - 1)));
  }
  for (let j = 0, index = 1; index < WINDOW; index += 1) {
    let bit = WINDOW >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (index < j) { [real[index], real[j]] = [real[j], real[index]]; [imag[index], imag[j]] = [imag[j], imag[index]]; }
  }
  for (let length = 2; length <= WINDOW; length <<= 1) {
    const angle = -2 * Math.PI / length, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let offset = 0; offset < WINDOW; offset += length) {
      let cr = 1, ci = 0;
      for (let k = 0; k < length / 2; k += 1) {
        const u = offset + k, v = u + length / 2;
        const vr = real[v] * cr - imag[v] * ci, vi = real[v] * ci + imag[v] * cr;
        real[v] = real[u] - vr; imag[v] = imag[u] - vi; real[u] += vr; imag[u] += vi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
  const bands = new Float64Array(24);
  for (let k = 3; k < WINDOW / 2; k += 1) {
    const hz = k * SAMPLE_RATE / WINDOW; if (hz > 4500) break;
    const band = Math.max(0, Math.min(23, Math.floor(Math.log2(hz / 30) / Math.log2(4500 / 30) * 24)));
    bands[band] += Math.hypot(real[k], imag[k]);
  }
  let positive = 0, total = 0;
  for (let index = 0; index < bands.length; index += 1) {
    positive += Math.max(0, bands[index] - (previousBands?.[index] || 0)); total += bands[index];
  }
  return { db: 20 * Math.log10(Math.sqrt(power / WINDOW) + 1e-9), flux: positive / (total + 1e-8), bands };
}

function decode(input) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", input,
      "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const frames = []; let buffer = Buffer.alloc(0), previous = null, stderr = "", settled = false;
    child.once("error", error => { settled = true; reject(new Error(`Cannot launch ffmpeg: ${error.message}`)); });
    child.stderr.on("data", data => { if (stderr.length < 4096) stderr += data.toString(); });
    child.stdout.on("data", data => {
      buffer = Buffer.concat([buffer, data]); const bytes = WINDOW * 4; let offset = 0;
      while (buffer.length - offset >= bytes) {
        const samples = new Float32Array(WINDOW);
        for (let index = 0; index < WINDOW; index += 1) samples[index] = buffer.readFloatLE(offset + index * 4);
        const frame = spectralFrame(samples, previous); frames.push({ t: frames.length * WINDOW_SEC, db: frame.db, flux: frame.flux });
        previous = frame.bands; offset += bytes;
      }
      if (offset) buffer = buffer.subarray(offset);
    });
    child.once("close", code => {
      if (settled) return; if (code !== 0) reject(new Error(`ffmpeg failed (${code}): ${stderr.trim()}`));
      else if (!frames.length) reject(new Error("No decodable audio samples")); else resolve(frames);
    });
  });
}

function generateProfile(frames) {
  const fps = 1 / WINDOW_SEC;
  const dbs = frames.map(frame => frame.db).filter(n => n > -85).sort((a, b) => a - b);
  const floor = percentile(dbs, .12), ceiling = percentile(dbs, .92), span = Math.max(10, ceiling - floor);
  const fluxes = frames.map(frame => frame.flux).sort((a, b) => a - b);
  const fluxLo = percentile(fluxes, .25), fluxHi = percentile(fluxes, .9), fluxRange = Math.max(.06, fluxHi - fluxLo);
  const enriched = frames.map(frame => ({ ...frame, energy: clamp((frame.db - floor) / span), activity: clamp((frame.flux - fluxLo) / fluxRange) }));
  const duration = frames.length * WINDOW_SEC, initial = [];
  for (let second = 0; second < Math.ceil(duration); second += 1) {
    const start = second * fps, energy = avg(enriched, start, start + fps, "energy"), activity = avg(enriched, start, start + fps, "activity");
    initial.push({ energy, activity });
  }
  const envelope = enriched.map((frame, index) => .7 * clamp((frame.flux - fluxLo) / fluxRange) + .3 * clamp((frame.db - (enriched[index - 1]?.db ?? frame.db)) / 12));
  const getDrive = center => {
    const radius = Math.round(4.5 * fps), lo = Math.max(0, center - radius), hi = Math.min(envelope.length, center + radius), n = hi - lo;
    if (n < 24) return 0; const mean = avg(envelope, lo, hi); let variance = 0;
    for (let index = lo; index < hi; index += 1) variance += (envelope[index] - mean) ** 2;
    variance /= n; if (variance < .0008 || mean < .025) return 0; let best = 0;
    for (let lag = Math.ceil(.28 * fps); lag <= Math.min(Math.floor(1.15 * fps), Math.floor(n / 3)); lag += 1) {
      let numerator = 0, left = 0, right = 0;
      for (let index = lo + lag; index < hi; index += 1) { const x = envelope[index] - mean, y = envelope[index - lag] - mean; numerator += x * y; left += x * x; right += y * y; }
      best = Math.max(best, numerator / Math.sqrt(left * right + 1e-12));
    }
    return clamp((best - .12) / .53) * clamp(Math.sqrt(variance) / .12);
  };
  const smoothEnergy = initial.map((_, i) => avg(initial.map(x => x.energy), i - 3, i + 4));
  const smoothActivity = initial.map((_, i) => avg(initial, i - 3, i + 4, "activity"));
  const drive = initial.map((_, i) => getDrive(Math.round((i + .5) * fps))).map((_, i, all) => avg(all, i - 2, i + 3));
  const intensity = initial.map((_, i) => clamp(.83 * smoothEnergy[i] + .17 * smoothActivity[i]));
  const developmentRaw = initial.map((_, i) => clamp((avg(intensity, i + 2, i + 7) - avg(intensity, Math.max(0, i - 6), Math.max(1, i - 2))) * 2, -1, 1));
  const development = developmentRaw.map((_, i) => avg(developmentRaw, i - 2, i + 3));
  let trend = "STABLE", pending = null, pendingCount = 0;
  const steps = initial.map((step, i) => {
    let candidate = "STABLE"; if (development[i] > .16 || (trend === "RISING" && development[i] > .07)) candidate = "RISING";
    if (development[i] < -.16 || (trend === "FALLING" && development[i] < -.07)) candidate = "FALLING";
    if (candidate === trend) { pending = null; pendingCount = 0; } else if (candidate !== pending) { pending = candidate; pendingCount = 1; }
    else if (++pendingCount >= 3) { trend = candidate; pending = null; pendingCount = 0; }
    const rounded = value => +value.toFixed(3);
    return { time: i, energy: rounded(smoothEnergy[i]), fastEnergy: rounded(avg(initial.map(x => x.energy), i - 1, i + 2)),
      fastActivity: rounded(avg(initial.map(x => x.activity), i - 1, i + 2)), activity: rounded(smoothActivity[i]),
      intensity: rounded(intensity[i]), drive: rounded(drive[i]), development: rounded(development[i]), trend };
  });
  const pauses = [];
  for (let i = Math.ceil(fps * 3); i < frames.length - Math.ceil(fps * .3); i += 1) {
    const preceding = avg(enriched, i - 2 * fps, i - .25 * fps, "db");
    if (preceding < floor + .4 * span || enriched[i].db > preceding - 10 || enriched[i - 1].db <= preceding - 10 || avg(enriched, i, i + 3, "db") > preceding - 12) continue;
    let j = i; while (j < frames.length && j - i <= Math.ceil(1.3 * fps) && enriched[j].db < preceding - 10) j += 1;
    const length = (j - i) * WINDOW_SEC; if (length < .17 || length > 1.25 || avg(enriched, j, j + .4 * fps, "db") < preceding - 8) continue;
    const rise = clamp((avg(enriched, i - 4 * fps, i, "energy") - avg(enriched, i - 12 * fps, i - 6 * fps, "energy")) * 2);
    const score = clamp(.45 * clamp((preceding - enriched[i].db - 12) / 18) + .35 * rise + .2 * clamp((preceding - floor) / span));
    if (score >= .35) pauses.push({ time: +(i * WINDOW_SEC).toFixed(2), end: +(j * WINDOW_SEC).toFixed(2), score: +score.toFixed(2), leadInRise: +rise.toFixed(2) });
    i = j;
  }
  pauses.sort((a, b) => b.score - a.score); const chosen = [];
  for (const pause of pauses) if (!chosen.some(other => Math.abs(other.time - pause.time) < 8)) chosen.push(pause);
  chosen.sort((a, b) => a.time - b.time);
  return { version: 3, duration: +duration.toFixed(2), analysis: { frameSeconds: +WINDOW_SEC.toFixed(5), energyFloorDb: +floor.toFixed(2), energyCeilingDb: +ceiling.toFixed(2) }, steps, pauses: chosen };
}

try { parentPort.postMessage({ ok: true, profile: generateProfile(await decode(workerData.input)) }); }
catch (error) { parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
