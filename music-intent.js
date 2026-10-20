const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const smoothstep = value => {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
};
const mix = (from, to, amount) => from + (to - from) * amount;

export const DEFAULT_MUSIC_CONFIG = Object.freeze({
  enabled: false,
  influencePercent: 100,
  transitionSpeedPercent: 220,
  minimumBrightnessPercent: 25,
  maximumBrightnessPercent: 100,
  gamma: 1.05,
  avDelayMs: 0,
  activationBlendSeconds: 3,
  dramaticPausesEnabled: true,
  dramaticPauseMinimumScore: 0.58
});

export function validateMusicConfig(source = {}) {
  const config = { ...DEFAULT_MUSIC_CONFIG, ...source };
  if (typeof config.enabled !== "boolean") throw new Error("music.enabled must be true or false");
  if (typeof config.dramaticPausesEnabled !== "boolean") throw new Error("music.dramaticPausesEnabled must be true or false");
  const ranges = {
    influencePercent: [0, 100], transitionSpeedPercent: [50, 300],
    minimumBrightnessPercent: [0, 100], maximumBrightnessPercent: [0, 100],
    gamma: [0.4, 2], avDelayMs: [-500, 1000], activationBlendSeconds: [2, 5],
    dramaticPauseMinimumScore: [0, 1]
  };
  for (const [name, [min, max]] of Object.entries(ranges)) {
    config[name] = Number(config[name]);
    if (!Number.isFinite(config[name]) || config[name] < min || config[name] > max) {
      throw new Error(`music.${name} must be from ${min} to ${max}`);
    }
  }
  if (config.maximumBrightnessPercent < config.minimumBrightnessPercent) {
    throw new Error("music.maximumBrightnessPercent cannot be less than minimumBrightnessPercent");
  }
  return config;
}

export function sampleProfile(profile, positionSeconds) {
  if (!profile?.steps?.length) return null;
  const position = clamp(positionSeconds, 0, Math.max(0, profile.duration));
  const index = Math.min(profile.steps.length - 1, Math.floor(position));
  const next = Math.min(profile.steps.length - 1, index + 1);
  const fraction = position - Math.floor(position);
  const a = profile.steps[index], b = profile.steps[next];
  const numeric = name => mix(Number(a[name] ?? 0), Number(b[name] ?? a[name] ?? 0), fraction);
  return { time: position, energy: numeric("energy"), fastEnergy: numeric("fastEnergy"),
    fastActivity: numeric("fastActivity"), activity: numeric("activity"), intensity: numeric("intensity"),
    drive: numeric("drive"), development: numeric("development"), trend: fraction < .5 ? a.trend : b.trend };
}

export function pauseEnvelope(profile, position, config) {
  if (!config.dramaticPausesEnabled) return null;
  let chosen = null;
  for (let index = 0; index < (profile?.pauses ?? []).length; index += 1) {
    const pause = profile.pauses[index];
    if (pause.score < config.dramaticPauseMinimumScore || position < pause.time - 8 || position > pause.end + 7) continue;
    let shape, brightness, phase;
    if (position < pause.time - 6) {
      const q = smoothstep((position - (pause.time - 8)) / 2); shape = .12 * q; brightness = 1 - .28 * q; phase = "preparing";
    } else if (position < pause.time) {
      const q = smoothstep((position - (pause.time - 6)) / 6); shape = mix(.12, 1, q); brightness = mix(.72, 1.27, q); phase = "building";
    } else if (position < pause.end + 2.5) {
      shape = 1; brightness = 1.27; phase = "holding";
    } else {
      const q = smoothstep((position - (pause.end + 2.5)) / 4.5); shape = 1 - q; brightness = mix(1.27, 1, q); phase = "returning";
    }
    const candidate = { shape, brightness, phase, hue: [44, 315, 190][index % 3], score: pause.score };
    if (!chosen || candidate.shape > chosen.shape) chosen = candidate;
  }
  return chosen;
}

export function createMusicIntentState() {
  return { hueRate: 0, brightness: null, saturation: 1, lastAt: null };
}

export function computeMusicIntent(profile, position, config, previous, nowSeconds, activation = 1) {
  const feature = sampleProfile(profile, position);
  if (!feature) return null;
  const dt = previous.lastAt === null ? 0 : clamp(nowSeconds - previous.lastAt, 0, .1);
  const influence = clamp(config.influencePercent / 100) * clamp(activation);
  const driveWeight = smoothstep((feature.drive - .28) / .46);
  const busyWeight = smoothstep((feature.fastActivity - .23) / .34);
  const powerWeight = smoothstep((feature.intensity - .36) / .44);
  const liftWeight = smoothstep(Math.max(0, feature.fastEnergy - feature.intensity) / .20);
  const urgency = clamp(.32 * driveWeight + .32 * busyWeight + .26 * powerWeight + .10 * liftWeight);
  const baseRate = 1.7 + 36.3 * smoothstep((urgency - .10) / .70);
  const requestedRate = baseRate * config.transitionSpeedPercent / 100;
  const targetRate = mix(1.7, requestedRate, influence);
  const rateTau = targetRate > previous.hueRate ? .55 : 2.7;
  const hueRate = previous.lastAt === null ? targetRate : previous.hueRate + (targetRate - previous.hueRate) * (1 - Math.exp(-dt / rateTau));
  const expressiveEnergy = clamp(.72 * feature.fastEnergy + .28 * feature.intensity);
  const min = config.minimumBrightnessPercent / 100, max = config.maximumBrightnessPercent / 100;
  const mapped = min + (max - min) * expressiveEnergy ** config.gamma;
  const targetBrightness = mix(1, mapped, influence);
  const brightnessTau = targetBrightness > (previous.brightness ?? targetBrightness) ? .42 : .70;
  let brightness = previous.brightness === null ? targetBrightness : previous.brightness + (targetBrightness - previous.brightness) * (1 - Math.exp(-dt / brightnessTau));
  const saturationTarget = mix(1, .92 + .07 * feature.intensity, influence);
  const saturation = previous.saturation + (saturationTarget - previous.saturation) * (1 - Math.exp(-dt / 2));
  const accent = pauseEnvelope(profile, position, config);
  brightness = clamp(brightness * (1 + ((accent?.brightness ?? 1) - 1) * influence), min, max);
  return { feature, hueRate, brightness, saturation, accent, influence, lastAt: nowSeconds };
}
