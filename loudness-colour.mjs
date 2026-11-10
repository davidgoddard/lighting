// Interpolate loudness before converting to hue: crossing red must not take
// a shortcut through the wheel when the level traverses a large range.
export function createLoudnessColourDirector(profile, config = {}, fixtureIds = [], assignments = {}) {
  const mode = config.loudnessColourMode ?? 'shared';
  const bandNames = ['loudnessBass', 'loudnessMid', 'loudnessTreble'];
  const needsBands = mode === 'bands' || Object.values(assignments).some(value =>
    value?.mode === 'audio' && ['bass', 'middle', 'treble'].includes(value.band));
  const bandDirectors = needsBands ? bandNames.map(name =>
    createLoudnessColourDirector({ ...profile, traces: { loudness: profile.traces?.[name] ?? profile.traces?.loudness } },
      { ...config, loudnessColourMode: 'shared' })) : [];
  const missingBands = needsBands && bandNames.some(name => !profile.traces?.[name]?.length);
  const values = Array.from(profile.traces?.loudness || [], value => Number.isFinite(value) ? Math.max(0, value) : 0);
  if (!values.length) values.push(0);
  let min = Infinity, max = -Infinity;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  const sorted = [...values].sort((a, b) => a - b);
  const median = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
  const span = max - min;
  const step = profile.samplePeriod || .2;
  // A classic meter responds immediately to a rising signal but lets peaks
  // fall away more slowly. Precompute this from the trace so playback seeks
  // remain deterministic and do not depend on render-frame timing.
  const vuValues = Array.from(profile.traces?.loudnessVu || values,
    value => Number.isFinite(value) ? Math.max(0, value) : 0);
  if (!vuValues.length) vuValues.push(0);
  const vuMin = Math.min(...vuValues), vuMax = Math.max(...vuValues), vuSpan = vuMax - vuMin;
  const vuLevels = [];
  let vuEnvelope = vuSpan > 0 ? (vuValues[0] - vuMin) / vuSpan : 0;
  const vuRelease = Math.exp(-step / .9);
  for (const value of vuValues) {
    const next = vuSpan > 0 ? Math.max(0, Math.min(1, (value - vuMin) / vuSpan)) : 0;
    vuEnvelope = next >= vuEnvelope ? next : next + (vuEnvelope - next) * vuRelease;
    vuLevels.push(vuEnvelope);
  }
  return (position, currentConfig = config) => {
    const time = Math.max(0, Math.min(profile.duration, Number(position) || 0));
    const exact = Math.min(values.length - 1, time / step), i = Math.floor(exact);
    const raw = values[i] + (values[Math.min(i + 1, values.length - 1)] - values[i]) * (exact - i);
    const level = span > 0 ? Math.max(0, Math.min(1, (raw - min) / span)) : 0;
    const vuIndex = Math.min(i, vuLevels.length - 1);
    const vuNext = vuLevels[Math.min(vuIndex + 1, vuLevels.length - 1)];
    const vuFraction = vuNext > vuLevels[vuIndex] ? Math.min(1, (exact - i) * 4) : exact - i;
    const vuLevel = vuLevels[vuIndex] + (vuNext - vuLevels[vuIndex]) * vuFraction;
    // Make one complete turn from the song minimum to its statistical median,
    // then a second complete turn from the median to the maximum. This keeps
    // the selected base colour fixed at all three anchors even when the song's
    // loudness distribution is asymmetric.
    let fraction = 0;
    if (raw < median && median > min) fraction = (raw - min) / (median - min);
    else if (raw > median && max > median) fraction = (raw - median) / (max - median);
    const hue = (360 * (1 - Math.max(0, Math.min(1, fraction)))) % 360;
    const feature = Object.fromEntries(['rhythm','dynamics','harmony','timbre','activityDrop','accent','build','salience','activity'].map(key => [key, 0]));
    feature.energy = level;
    const fixtureHues = Object.fromEntries(fixtureIds.map((id, index) => {
      const assignment = assignments[id];
      if (assignment?.mode === 'audio') {
        if (assignment.band === 'vu') return [id, 120 * (1 - vuLevel)];
        const rangeHue = assignment.band === 'all' ? hue
          : bandDirectors[Math.max(0, ['bass', 'middle', 'treble'].indexOf(assignment.band))](time, currentConfig).look.hue;
        return [id, (rangeHue + (Number(assignment.baseHue) || 0)) % 360];
      }
      return [id, mode === 'offsets' ? (hue + index * 360 / Math.max(1, fixtureIds.length)) % 360
        : mode === 'bands' ? bandDirectors[index % 3](time, currentConfig).look.hue : hue];
    }));
    const cue = mode === 'offsets' ? 'Loudness wheel: colour offsets'
      : mode === 'bands' ? (missingBands ? 'Frequency bands unavailable: using full loudness; restart and reload track' : 'Loudness wheel: frequency bands') : 'Loudness colour wheel';
    return { time, scene: cue, explanation: cue, feature, look: {
      hue, targetHue: hue, fixtureHues,
      fixtureTargets: { ...fixtureHues }, independentFixtures: mode !== "shared",
      normalisedMedianLoudness: span > 0 ? (median - min) / span : 0,
      absoluteHue: true, brightness: 1,
      saturation: 1, colourAcceleration: 1, speedBoost: 1, pulseStrength: 0,
      accent: 0, activity: 0, musicalState: 'LOUDNESS_COLOUR', cue,
      colourCueCount: 0, activityDropCount: 0, selectedEventCount: 0, speedEventCount: 0
    } };
  };
}
