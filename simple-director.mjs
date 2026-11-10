// Keep each target until arrival; integrate audio-driven speed along the path.
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const hue = x => (x % 360 + 360) % 360;
export function createSimpleDirector(profile, config = {}, fixtureIds = []) {
  const step = profile.samplePeriod || .2;
  const raw = Array.from(profile.traces?.loudness || [0], value =>
    Number.isFinite(value) ? Math.max(0, value) : 0);
  if (!raw.length) raw.push(0);
  const sorted = [...raw].sort((a, b) => a - b);
  const low = sorted[0], high = sorted.at(-1), span = high - low;
  const levels = raw.map(value => span > 0 ? (value - low) / span : .5);
  const middle = Math.floor(sorted.length / 2);
  const rawMedian = (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
  const median = span > 0 ? (rawMedian - low) / span : .5;
  const normalSeconds = config.simpleNormalSeconds ?? 12;
  const fastestSeconds = config.simpleFastestSeconds ?? 3;
  const slowestSeconds = config.simpleSlowestSeconds ?? 24;
  if (![fastestSeconds, normalSeconds, slowestSeconds].every(value => Number.isFinite(value) && value > 0)
      || fastestSeconds > normalSeconds || normalSeconds > slowestSeconds)
    throw new Error('Simple transition times must satisfy fastest <= normal <= slowest');
  const levelAt = t => levels[clamp(Math.floor(t / step), 0, levels.length - 1)];
  const secondsAt = t => {
    const level = levelAt(t);
    let rate = 1 / normalSeconds;
    if (level > median) rate += (1 / fastestSeconds - rate) * (level - median) / (1 - median);
    if (level < median) rate += (1 / slowestSeconds - rate) * (median - level) / median;
    return clamp(1 / rate, fastestSeconds, slowestSeconds);
  };
  // Integrated transition progress makes brief loud passages count even when
  // they occur midway through a long transition. Absolute time preserves seeks.
  const count = Math.ceil(profile.duration / step) + 1;
  const progress = [0];
  for (let i = 1; i <= count; i++) progress.push(progress[i - 1] + step / secondsAt((i - 1) * step));
  const progressAt = time => {
    const index = Math.min(count - 1, Math.floor(time / step));
    return progress[index] + (time - index * step) / secondsAt(index * step);
  };
  const lanes = Object.fromEntries(['master', ...fixtureIds].map(id => {
    let seed = 2166136261;
    for (const c of id) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    let from = random() * 360, start = 0;
    const segments = [];
    while (start <= progress.at(-1)) {

      const delta = (random() < .5 ? -1 : 1) * (60 + random() * 110);
      segments.push({ start, from, delta, target: hue(from + delta) });
      from = hue(from + delta); start += 1;
    }
    return [id, segments];
  }));
  return (position, currentConfig = config) => {
    const time = clamp(Number(position) || 0, 0, profile.duration);
    const travelled = progressAt(time);
    const seconds = secondsAt(time);
    const boost = normalSeconds / seconds;
    const states = Object.fromEntries(Object.entries(lanes).map(([id, segments]) => {
      let lo = 0, hi = segments.length - 1;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (segments[mid].start <= travelled) lo = mid; else hi = mid - 1; }
      const s = segments[lo];
      return [id, { ...s, hue: hue(s.from + s.delta * clamp(travelled - s.start, 0, 1)) }];
    }));
    const master = states.master;
    const feature = Object.fromEntries(['rhythm','dynamics','harmony','timbre','activityDrop','accent','build','salience','activity'].map(k => [k, 0]));
    feature.energy = levelAt(time);
    const cue = 'Simple loudness wandering';
    return { time, scene: cue, explanation: cue, feature, look: {
      hue: master.hue, targetHue: master.target,
      fixtureHues: Object.fromEntries(fixtureIds.map(id => [id, states[id].hue])),
      fixtureTargets: Object.fromEntries(fixtureIds.map(id => [id, states[id].target])),
      brightness: (currentConfig.maximumBrightnessPercent ?? 100) / 100, saturation: 1,
      colourAcceleration: boost, speedBoost: boost, pulseStrength: 0,
      accent: 0, activity: 0, musicalState: 'SIMPLE', cue,
      normalisedMedianLoudness: median, normalTransitionSeconds: normalSeconds, transitionSeconds: seconds,
      colourCueCount: 0, activityDropCount: 0, selectedEventCount: 0, speedEventCount: 0
    } };
  };
}
