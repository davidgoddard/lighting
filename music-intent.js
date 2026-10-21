const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const approach = (current, target, dt, attack, release) => {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / Math.max(.02, tau)));
};

export const DEFAULT_MUSIC_CONFIG = Object.freeze({
  enabled: false,
  minimumBrightnessPercent: 25,
  maximumBrightnessPercent: 100,
  gamma: 1.05,
  rhythmicMomentumInfluencePercent: 100,
  aboveAverageEnergyInfluencePercent: 75,
  movementRelaxationMs: 2500,
  colourStepSpeedPercent: 220,
  exceptionalKickThresholdPercent: 90,
  exceptionalKickColourTimeMs: 650,
  structureEffectsEnabled: true,
  avDelayMs: 0
});

export function validateMusicConfig(source = {}) {
  const config = { ...DEFAULT_MUSIC_CONFIG, ...source };
  const ranges = {
    minimumBrightnessPercent: [0, 65], maximumBrightnessPercent: [50, 100], gamma: [.4, 2],
    rhythmicMomentumInfluencePercent: [0, 200], aboveAverageEnergyInfluencePercent: [0, 100],
    movementRelaxationMs: [400, 5000], colourStepSpeedPercent: [25, 400],
    exceptionalKickThresholdPercent: [20, 100], exceptionalKickColourTimeMs: [250, 1400], avDelayMs: [-500, 1000]
  };
  if (typeof config.enabled !== "boolean" || typeof config.structureEffectsEnabled !== "boolean") {
    throw new Error("music toggles must be true or false");
  }
  for (const [name, [min, max]] of Object.entries(ranges)) {
    config[name] = Number(config[name]);
    if (!Number.isFinite(config[name]) || config[name] < min || config[name] > max) throw new Error(`music.${name} must be from ${min} to ${max}`);
  }
  if (config.maximumBrightnessPercent < config.minimumBrightnessPercent) throw new Error("music.maximumBrightnessPercent cannot be less than minimumBrightnessPercent");
  return config;
}

export function sampleProfile(profile, time) {
  if (!profile?.timeline?.length) return null;
  const index = Math.max(0, Math.min(profile.timeline.length - 1, Math.floor(clamp(time, 0, profile.duration) / profile.hop)));
  const value = profile.timeline[index];
  return { time, energy: value[0], fastEnergy: value[1], phrase: value[2], development: value[3] };
}

function rhythmSample(profile, time) {
  if (!profile?.rhythm?.length) return { momentum: 0, regularity: 0, pace: 0 };
  const value = profile.rhythm[Math.max(0, Math.min(profile.rhythm.length - 1, Math.floor(time / profile.rhythmHop)))];
  return { momentum: value[0], regularity: value[1], pace: value[2] };
}

function structural(profile, time, enabled) {
  if (!enabled) return { brightnessOffset: 0, speedFactor: 1, mode: "NORMAL", edgeStrength: 0 };
  let brightnessOffset = 0, speedFactor = 1, mode = "NORMAL", edgeStrength = 0;
  for (const edge of profile.edges ?? []) {
    const delta = time - edge.t, amplitude = clamp(edge.strength, .25, 1);
    if (delta < -.75 || delta > 1.7) continue;
    mode = edge.kind; edgeStrength = Math.max(edgeStrength, amplitude);
    if (edge.kind === "STOP") {
      if (delta < 0) { brightnessOffset -= .10 * amplitude * clamp((delta + .75) / .75); speedFactor = .65; }
      else if (delta < .13) { brightnessOffset -= .48 * amplitude; speedFactor = .08; }
      else { brightnessOffset -= .48 * amplitude * Math.exp(-(delta - .13) / .75); speedFactor = .35; }
    } else if (delta < 0) { brightnessOffset -= .16 * amplitude * clamp((delta + .75) / .75); speedFactor = .6; }
    else if (delta < .12) { brightnessOffset += .42 * amplitude; speedFactor = 3; }
    else { brightnessOffset += .42 * amplitude * Math.exp(-(delta - .12) / .7); speedFactor = 2.2; }
  }
  if (mode !== "NORMAL") return { brightnessOffset, speedFactor, mode, edgeStrength };
  const events = [
    ...(profile.breaks ?? []).map(event => ({ ...event, kind: "BREAK", strength: event.drop })),
    ...(profile.entrances ?? []).map(event => ({ ...event, kind: "ENTRANCE", strength: event.rise }))
  ];
  for (const event of events) {
    const delta = time - event.t; if (delta < -2 || delta > 2.4) continue; mode = event.kind;
    if (event.kind === "ENTRANCE") {
      const power = clamp(event.strength);
      if (delta < 0) { brightnessOffset -= power * .28 * clamp((delta + 1.2) / 1.2); speedFactor = .3; }
      else if (delta < .4) { brightnessOffset += power * .35 * (1 - delta / .4); speedFactor = 2.2; }
      continue;
    }
    const amount = clamp(event.strength / .6, .3, 1);
    if (delta < -.8) brightnessOffset -= amount * .22 * clamp((delta + 2) / 1.2);
    else if (delta < -.12) brightnessOffset += amount * (-.22 + .65 * ((delta + .8) / .68));
    else if (delta < .18) brightnessOffset += amount * (.43 - .83 * clamp((delta + .12) / .30));
    else if (delta < 1) brightnessOffset -= amount * .40 * (1 - (delta - .18) / .82);
    speedFactor = delta > -.2 && delta < .6 ? .22 : 1;
  }
  return { brightnessOffset, speedFactor, mode, edgeStrength };
}

export function createMusicIntentState() {
  return { brightness: .45, stepRate: 1 / 35, lastAt: null, lastPosition: null, lastKickPosition: -10 };
}

function crossed(previous, current, eventTime) {
  return previous !== null && current >= previous && eventTime > previous && eventTime <= current;
}

export function computeMusicIntent(profile, position, config, previous, nowSeconds, activation = 1) {
  const feature = sampleProfile(profile, position); if (!feature) return null;
  const dt = previous.lastAt === null ? 0 : clamp(nowSeconds - previous.lastAt, 0, .08);
  const jumped = previous.lastPosition !== null && (position < previous.lastPosition - .15 || Math.abs(position - previous.lastPosition) > 1.2);
  const rhythm = rhythmSample(profile, position), median = profile.phraseMedian ?? .42, upper = profile.phraseUpper ?? .7;
  const aboveAverage = clamp((feature.phrase - median) / Math.max(.12, upper - median));
  const sustainedRise = clamp(feature.development * 2.2), falling = clamp(-feature.development * 2);
  const character = clamp(.45 * aboveAverage * config.aboveAverageEnergyInfluencePercent / 100 +
    .27 * rhythm.momentum * config.rhythmicMomentumInfluencePercent / 100 + .28 * sustainedRise - .22 * falling);
  const structure = structural(profile, position, config.structureEffectsEnabled);
  const demandedStepRate = (1 / 38 + clamp(character) ** 1.65 * .88) * (config.colourStepSpeedPercent / 220) * structure.speedFactor;
  const stepRate = previous.lastAt === null ? 1 / 35 : approach(previous.stepRate, demandedStepRate, dt, .55, config.movementRelaxationMs / 1000);
  const min = config.minimumBrightnessPercent / 100, max = Math.max(min, config.maximumBrightnessPercent / 100);
  const baseRaw = clamp(.27 + .48 * feature.phrase + .18 * aboveAverage + .12 * sustainedRise - .09 * falling);
  const baseBrightness = min + (max - min) * baseRaw ** config.gamma;
  const structuralTarget = clamp(baseBrightness + (max - min) * structure.brightnessOffset, min, max);
  const brightness = previous.lastAt === null ? .45 : approach(previous.brightness, structuralTarget, dt,
    structure.mode === "START" ? .065 : .8, structure.mode === "STOP" ? .085 : 1.9);
  let kickEvent = null;
  if (!jumped) {
    for (const edge of profile.edges ?? []) if (edge.kind === "START" && edge.strength > .55 && crossed(previous.lastPosition, position, edge.t)) kickEvent = edge;
    for (const event of profile.strong ?? []) if (crossed(previous.lastPosition, position, event.t)) {
      const atEvent = sampleProfile(profile, event.t), eventRhythm = rhythmSample(profile, event.t);
      if (event.strength >= config.exceptionalKickThresholdPercent / 100 && atEvent.phrase > upper && atEvent.fastEnergy > .78 && eventRhythm.momentum > .35) kickEvent = event;
    }
  }
  const cooldownReady = position - previous.lastKickPosition >= 4;
  const triggered = Boolean(kickEvent && (kickEvent.kind === "START" || cooldownReady));
  const strength = triggered ? kickEvent.strength : 0;
  const kickDurationSeconds = config.exceptionalKickColourTimeMs / 1000 * (1.1 - .25 * strength);
  const influence = clamp(activation);
  return { feature: { ...feature, rhythm }, character, aboveAverage, sustainedRise, falling, structure,
    stepRate: Math.max(.001, stepRate), targetTransitionSeconds: 1 / Math.max(.001, demandedStepRate),
    effectiveTransitionSeconds: 1 / Math.max(.001, stepRate), baseBrightness,
    brightness: clamp(1 + (brightness - 1) * influence, min, 1), saturation: .97, influence,
    kick: { triggered, active: triggered, strength, transitionSeconds: kickDurationSeconds, retargeted: false },
    lastAt: nowSeconds, lastPosition: position, lastKickPosition: triggered ? position : jumped ? position - 5 : previous.lastKickPosition };
}

export function formatMusicDiagnostic(positionSeconds, feature, intent = null) {
  const minutes = Math.floor(positionSeconds / 60), seconds = String(Math.floor(positionSeconds % 60)).padStart(2, "0");
  if (!intent) return `Music ${minutes}:${seconds} energy=${feature.fastEnergy.toFixed(3)} phrase=${feature.phrase.toFixed(3)} development=${feature.development.toFixed(3)}`;
  return `Music ${minutes}:${seconds} energy=${feature.fastEnergy.toFixed(3)} phrase=${feature.phrase.toFixed(3)} ` +
    `development=${feature.development.toFixed(3)} momentum=${feature.rhythm.momentum.toFixed(3)} ` +
    `character=${intent.character.toFixed(3)} steps=${intent.stepRate.toFixed(3)}/s brightness=${intent.brightness.toFixed(3)} ` +
    `structure=${intent.structure.mode} kick=${intent.kick.triggered ? intent.kick.strength.toFixed(3) : "none"}`;
}
