// Interpolate loudness before converting to hue: crossing red must not take
// a shortcut through the wheel when the level traverses a large range.
export function createLoudnessColourDirector(profile, config = {}, fixtureIds = []) {
  const mode = config.loudnessColourMode ?? 'shared';
  const bandNames = ['loudnessBass', 'loudnessMid', 'loudnessTreble'];
  const bandDirectors = mode === 'bands' ? bandNames.map(name =>
    createLoudnessColourDirector({ ...profile, traces: { loudness: profile.traces?.[name] ?? profile.traces?.loudness } },
      { ...config, loudnessColourMode: 'shared' })) : [];
  const missingBands = mode === 'bands' && bandNames.some(name => !profile.traces?.[name]?.length);
  const values = Array.from(profile.traces?.loudness || [], value => Number.isFinite(value) ? Math.max(0, value) : 0);
  if (!values.length) values.push(0);
  let min = Infinity, max = -Infinity;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  const sorted = [...values].sort((a, b) => a - b);
  const median = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
  const span = max - min;
  const step = profile.samplePeriod || .2;
  return (position, currentConfig = config) => {
    const time = Math.max(0, Math.min(profile.duration, Number(position) || 0));
    const exact = Math.min(values.length - 1, time / step), i = Math.floor(exact);
    const raw = values[i] + (values[Math.min(i + 1, values.length - 1)] - values[i]) * (exact - i);
    const level = span > 0 ? Math.max(0, Math.min(1, (raw - min) / span)) : 0;
    // Each side of the median makes one reverse turn: above median starts
    // purple; below median approaches red through yellow/orange. An empty
    // half-range (median at an endpoint) remains red without division by zero.
    let fraction = 0;
    if (raw < median && median > min) fraction = (raw - min) / (median - min);
    else if (raw > median && max > median) fraction = (raw - median) / (max - median);
    const hue = (360 * (1 - Math.max(0, Math.min(1, fraction)))) % 360;
    const feature = Object.fromEntries(['rhythm','dynamics','harmony','timbre','activityDrop','accent','build','salience','activity'].map(key => [key, 0]));
    feature.energy = level;
    const fixtureHues = Object.fromEntries(fixtureIds.map((id, index) => [id,
      mode === 'offsets' ? (hue + index * 360 / Math.max(1, fixtureIds.length)) % 360
        : mode === 'bands' ? bandDirectors[index % 3](time, currentConfig).look.hue : hue]));
    const cue = mode === 'offsets' ? 'Loudness wheel: colour offsets'
      : mode === 'bands' ? (missingBands ? 'Frequency bands unavailable: using full loudness; restart and reload track' : 'Loudness wheel: frequency bands') : 'Loudness colour wheel';
    return { time, scene: cue, explanation: cue, feature, look: {
      hue, targetHue: hue, fixtureHues,
      fixtureTargets: { ...fixtureHues }, independentFixtures: mode !== "shared",
      normalisedMedianLoudness: span > 0 ? (median - min) / span : 0,
      absoluteHue: true, brightness: (currentConfig.maximumBrightnessPercent ?? 100) / 100,
      saturation: 1, colourAcceleration: 1, speedBoost: 1, pulseStrength: 0,
      accent: 0, activity: 0, musicalState: 'LOUDNESS_COLOUR', cue,
      colourCueCount: 0, activityDropCount: 0, selectedEventCount: 0, speedEventCount: 0
    } };
  };
}
