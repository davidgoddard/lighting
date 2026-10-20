import { createDmxOutputs } from "./dmx-outputs.js";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import process from "node:process";
import { ReadlineParser } from "@serialport/parser-readline";
import { SerialPort } from "serialport";
import usb from "usb";
import { createAudioAnalyser } from "./audio-analysis.js";
import { PlaybackCoordinator } from "./playback-integration.js";
import { computeMusicIntent, createMusicIntentState } from "./music-intent.js";

const argumentsList = process.argv.slice(2);
const diagnosticMode = argumentsList.includes("--diagnose");
const configArgument = argumentsList.find(argument => !argument.startsWith("--"));
const CONFIG_PATH = new URL(configArgument ?? "./config.json", `file://${process.cwd()}/`);
const UDMX_SET_CHANNEL_RANGE = 0x02;
const USB_VENDOR_DEVICE_OUT = 0x40;
const DMX_CHANNELS = 512;
const TABLE_LIGHTS_ID = "@table-lights";

function fail(message) {
  throw new Error(message);
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function parseUsbId(value, name) {
  const parsed = typeof value === "string" ? Number.parseInt(value, 0) : value;
  return integer(parsed, name, 0, 0xffff);
}

function validateMusicConfig(source = {}) {
  const config = { enabled: false, influencePercent: 100, transitionSpeedPercent: 220,
    minimumBrightnessPercent: 25, maximumBrightnessPercent: 100, gamma: 1.05, avDelayMs: 0,
    activationBlendSeconds: 3, dramaticPausesEnabled: true, dramaticPauseMinimumScore: .58, ...source };
  if (typeof config.enabled !== "boolean" || typeof config.dramaticPausesEnabled !== "boolean") fail("music toggles must be true or false");
  const ranges = { influencePercent: [0, 100], transitionSpeedPercent: [50, 300], minimumBrightnessPercent: [0, 100],
    maximumBrightnessPercent: [0, 100], gamma: [.4, 2], avDelayMs: [-500, 1000], activationBlendSeconds: [2, 5], dramaticPauseMinimumScore: [0, 1] };
  for (const [name, [min, max]] of Object.entries(ranges)) {
    config[name] = Number(config[name]);
    if (!Number.isFinite(config[name]) || config[name] < min || config[name] > max) fail(`music.${name} must be from ${min} to ${max}`);
  }
  if (config.maximumBrightnessPercent < config.minimumBrightnessPercent) fail("music.maximumBrightnessPercent cannot be less than minimumBrightnessPercent");
  return config;
}

function validateConfig(config) {
  if (!config || typeof config !== "object") fail("Config must be a JSON object");
  if (!config.fixtureTypes || typeof config.fixtureTypes !== "object") fail("fixtureTypes is required");
  if (!Array.isArray(config.fixtures) || config.fixtures.length === 0) fail("fixtures must be a non-empty array");

  config.fps = integer(config.fps ?? 20, "fps", 1, 100);
  config.masterBrightness = integer(config.masterBrightness ?? 255, "masterBrightness", 0, 255);
  config.webPort = integer(config.webPort ?? 8080, "webPort", 1, 65535);
  config.lightsUp ??= {};
  config.lightsUp.fadeUpSeconds = Number(config.lightsUp.fadeUpSeconds ?? 3);
  config.lightsUp.fadeDownSeconds = Number(config.lightsUp.fadeDownSeconds ?? 3);
  for (const direction of ["fadeUpSeconds", "fadeDownSeconds"]) {
    if (!Number.isFinite(config.lightsUp[direction]) || config.lightsUp[direction] < 0) {
      fail(`lightsUp.${direction} must be zero or a positive number`);
    }
  }
  config.transitionSeconds ??= { min: 2, max: 25 };
  const min = Number(config.transitionSeconds.min);
  const max = Number(config.transitionSeconds.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    fail("transitionSeconds must contain positive min and max values, with max >= min");
  }
  config.masterMode ??= {};
  config.masterMode.enabled ??= true;
  if (typeof config.masterMode.enabled !== "boolean") fail("masterMode.enabled must be true or false");
  config.masterMode.transitionCount ??= { min: 2, max: 6 };
  config.masterMode.transitionCount.min = integer(
    config.masterMode.transitionCount.min,
    "masterMode.transitionCount.min",
    1,
    100
  );
  config.masterMode.transitionCount.max = integer(
    config.masterMode.transitionCount.max,
    "masterMode.transitionCount.max",
    config.masterMode.transitionCount.min,
    100
  );
  config.masterMode.transitionSeconds ??= { min: 15, max: 60 };
  for (const sectionName of ["transitionSeconds"]) {
    const section = config.masterMode[sectionName];
    section.min = Number(section.min);
    section.max = Number(section.max);
    if (!Number.isFinite(section.min) || !Number.isFinite(section.max) || section.min <= 0 || section.max < section.min) {
      fail(`masterMode.${sectionName} must contain positive min and max values, with max >= min`);
    }
  }
  if (config.masterMode.transitionSeconds.min < 5) {
    fail("masterMode.transitionSeconds.min must be at least 5 seconds");
  }
  config.masterMode.individualModeSeconds ??= { min: 30, max: 180 };
  config.masterMode.individualModeSeconds.min = Number(config.masterMode.individualModeSeconds.min);
  config.masterMode.individualModeSeconds.max = Number(config.masterMode.individualModeSeconds.max);
  if (
    !Number.isFinite(config.masterMode.individualModeSeconds.min) ||
    !Number.isFinite(config.masterMode.individualModeSeconds.max) ||
    config.masterMode.individualModeSeconds.min <= 0 ||
    config.masterMode.individualModeSeconds.max < config.masterMode.individualModeSeconds.min
  ) {
    fail("masterMode.individualModeSeconds must contain positive min and max values, with max >= min");
  }
  config.externalMaster ??= {};
  config.externalMaster.enabled ??= true;
  if (typeof config.externalMaster.enabled !== "boolean") fail("externalMaster.enabled must be true or false");
  config.externalMaster.vendorId = parseUsbId(
    config.externalMaster.vendorId ?? "0x1a86",
    "externalMaster.vendorId"
  );
  config.externalMaster.baudRate = integer(
    config.externalMaster.baudRate ?? 115200,
    "externalMaster.baudRate",
    1,
    4_000_000
  );
  config.externalMaster.scanSeconds = Number(config.externalMaster.scanSeconds ?? 5);
  if (!Number.isFinite(config.externalMaster.scanSeconds) || config.externalMaster.scanSeconds < 1) {
    fail("externalMaster.scanSeconds must be at least 1");
  }
  config.openDmx ??= {};
  config.openDmx.enabled ??= false;
  if (typeof config.openDmx.enabled !== "boolean") fail("openDmx.enabled must be true or false");
  if (config.openDmx.path !== undefined && typeof config.openDmx.path !== "string") {
    fail("openDmx.path must be a string");
  }
  if (config.openDmx.serialNumber !== undefined && typeof config.openDmx.serialNumber !== "string") {
    fail("openDmx.serialNumber must be a string");
  }
  config.music = validateMusicConfig(config.music);

  const occupied = new Map();
  const requiredNames = ["red", "green", "blue"];
  for (const [typeName, type] of Object.entries(config.fixtureTypes)) {
    integer(type.channelCount, `fixtureTypes.${typeName}.channelCount`, 1, DMX_CHANNELS);
    if (!type.channels || typeof type.channels !== "object") fail(`fixtureTypes.${typeName}.channels is required`);
    for (const name of requiredNames) {
      if (!(name in type.channels)) fail(`fixtureTypes.${typeName}.channels.${name} is required`);
    }
    for (const [name, offset] of Object.entries(type.channels)) {
      if (![...requiredNames, "brightness"].includes(name)) fail(`Unknown channel role ${typeName}.${name}`);
      integer(offset, `fixtureTypes.${typeName}.channels.${name}`, 1, type.channelCount);
    }
    type.fixedChannels ??= {};
    if (typeof type.fixedChannels !== "object" || Array.isArray(type.fixedChannels)) {
      fail(`fixtureTypes.${typeName}.fixedChannels must be an object`);
    }
    const mappedOffsets = new Set(Object.values(type.channels));
    for (const [offsetText, value] of Object.entries(type.fixedChannels)) {
      const offset = Number(offsetText);
      integer(offset, `fixtureTypes.${typeName}.fixedChannels offset`, 1, type.channelCount);
      integer(value, `fixtureTypes.${typeName}.fixedChannels.${offsetText}`, 0, 255);
      if (mappedOffsets.has(offset)) fail(`fixtureTypes.${typeName} channel ${offset} is both mapped and fixed`);
    }
  }

  const fixtureIds = new Set();
  const fixtures = config.fixtures.map((fixture, index) => {
    const address = integer(fixture.address, `fixtures[${index}].address`, 1, DMX_CHANNELS);
    const type = config.fixtureTypes[fixture.type];
    if (!type) fail(`fixtures[${index}] refers to unknown type ${JSON.stringify(fixture.type)}`);
    if (address + type.channelCount - 1 > DMX_CHANNELS) fail(`Fixture at address ${address} extends beyond channel 512`);
    for (let offset = 0; offset < type.channelCount; offset += 1) {
      const channel = address + offset;
      if (occupied.has(channel)) fail(`Fixtures at addresses ${occupied.get(channel)} and ${address} overlap on channel ${channel}`);
      occupied.set(channel, address);
    }
    const id = fixture.id ?? `fixture-${index + 1}`;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) fail(`fixtures[${index}].id must contain only letters, numbers, _ or -`);
    if (fixtureIds.has(id)) fail(`Duplicate fixture id ${JSON.stringify(id)}`);
    fixtureIds.add(id);
    const name = fixture.name ?? `Light ${index + 1}`;
    if (typeof name !== "string" || !name.trim()) fail(`fixtures[${index}].name must be a non-empty string`);
    const lightsUpColour = fixture.lightsUpColour ?? { red: 255, green: 255, blue: 255 };
    if (!lightsUpColour || typeof lightsUpColour !== "object" || Array.isArray(lightsUpColour)) {
      fail(`fixtures[${index}].lightsUpColour must be an RGB object`);
    }
    for (const channel of ["red", "green", "blue"]) {
      lightsUpColour[channel] = integer(
        lightsUpColour[channel],
        `fixtures[${index}].lightsUpColour.${channel}`,
        0,
        255
      );
    }
    return { ...fixture, id, name: name.trim(), address, type, lightsUpColour };
  });

  return {
    ...config,
    fixtures,
    universeLength: Math.max(...fixtures.map(fixture => fixture.address + fixture.type.channelCount - 1)),
    usb: {
      vendorId: parseUsbId(config.usb?.vendorId ?? "0x16c0", "usb.vendorId"),
      productId: parseUsbId(config.usb?.productId ?? "0x05dc", "usb.productId")
    },
    openDmx: {
      enabled: config.openDmx?.enabled ?? false,
      path: config.openDmx?.path,
      serialNumber: config.openDmx?.serialNumber
    }
  };
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randomInteger(min, max) {
  return Math.floor(randomBetween(min, max + 1));
}

function circularHueDistance(first, second) {
  const difference = Math.abs((((second - first) % 360) + 360) % 360);
  return Math.min(difference, 360 - difference);
}

function randomTargetHue(fromHue, minimumDistance = 20) {
  let targetHue;
  do {
    targetHue = Math.random() * 360;
  } while (circularHueDistance(fromHue, targetHue) < minimumDistance);
  return targetHue;
}

function hueToRgb(hue) {
  const h = ((hue % 360) + 360) % 360 / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const sector = Math.floor(h);
  const values = [
    [1, x, 0], [x, 1, 0], [0, 1, x],
    [0, x, 1], [x, 0, 1], [1, 0, x]
  ][sector];
  return values.map(value => Math.round(value * 255));
}

function hsvToRgb(hue, saturation, value) {
  const [red, green, blue] = hueToRgb(hue);
  const minimum = 255 * value * (1 - saturation);
  return [red, green, blue].map(channel => Math.round(minimum + channel * value * saturation));
}

function hueMix(from, to, amount) {
  const distance = ((to - from + 540) % 360) - 180;
  return (from + distance * amount + 360) % 360;
}

function transitionTo(fromHue, toHue, durationSeconds, now) {
  const normalizedFromHue = ((fromHue % 360) + 360) % 360;
  const normalizedToHue = ((toHue % 360) + 360) % 360;
  // Take the shortest route around the wheel while remaining fully saturated.
  const hueDistance = ((normalizedToHue - normalizedFromHue + 540) % 360) - 180;
  return {
    fromHue: normalizedFromHue,
    toHue: normalizedFromHue + hueDistance,
    startedAt: now,
    durationMs: durationSeconds * 1000
  };
}

function newIndividualTransition(config, fromHue, now) {
  return transitionTo(
    fromHue,
    randomTargetHue(fromHue, config.music?.enabled && config.music.influencePercent > 0 ? 48 : 20),
    randomBetween(config.transitionSeconds.min, config.transitionSeconds.max),
    now
  );
}

function transitionProgress(transition, now) {
  return Math.min(1, Math.max(0, (now - transition.startedAt) / transition.durationMs));
}

function transitionHue(transition, now) {
  const rawProgress = transitionProgress(transition, now);
  const progress = transition.easing === "smoothstep"
    ? rawProgress * rawProgress * (3 - 2 * rawProgress)
    : rawProgress;
  return transition.fromHue + (transition.toHue - transition.fromHue) * progress;
}

function announceTransition(mode, state, now) {
  mode.broadcastTransition?.({
    id: state.fixture.id,
    automaticMode: mode.name,
    hue: ((transitionHue(state.transition, now) % 360) + 360) % 360,
    targetHue: ((state.transition.toHue % 360) + 360) % 360,
    durationMs: Math.max(0, (1 - transitionProgress(state.transition, now)) * state.transition.durationMs)
  });
}

function isPairFollower(state) {
  return state.pairLeaderId !== null && state.pairLeaderId !== state.fixture.id;
}

function pairLeader(states, state) {
  if (state.pairLeaderId === null) return state;
  return states.find(candidate => candidate.fixture.id === state.pairLeaderId) ?? state;
}

function pairMembers(states, leader) {
  return leader.pairLeaderId === null
    ? [leader]
    : states.filter(state => state.pairLeaderId === leader.fixture.id);
}

function selectPairLeaders(states, fixtureIds) {
  const selected = selectStates(states, fixtureIds);
  return [...new Set(selected.map(state => pairLeader(states, state)))];
}

function copyCurrentBehaviour(config, mode, source, target, now) {
  const hue = source.staticHue ?? transitionHue(source.transition, now);
  target.staticHue = source.staticHue;
  if (source.staticHue !== null) return;
  if (mode.name === "master") {
    const remaining = Math.max(
      0.1,
      (1 - transitionProgress(mode.masterTransition, now)) * mode.masterTransition.durationMs / 1000
    );
    target.transition = transitionTo(hue, mode.masterTransition.toHue, remaining, now);
  } else {
    target.transition = newIndividualTransition(config, hue, now);
  }
  announceTransition(mode, target, now);
}

function createFixtureState(config, fixture, now) {
  const initialHue = Math.random() * 360;
  return {
    fixture,
    transition: newIndividualTransition(config, initialHue, now),
    staticHue: null,
    pairLeaderId: null
  };
}

function createModeState(config, now) {
  const initialMasterHue = Math.random() * 360;
  return {
    name: "individual",
    masterTransition: newMasterTransition(config, initialMasterHue, now),
    masterTransitionsRemaining: 0,
    individualUntil: newIndividualModeDeadline(config, now),
    externalConnected: false,
    externalControlled: false,
    externalHasMessage: false,
    externalPort: null,
    lightsUp: false,
    lightsUpTransition: { from: 0, to: 0, startedAt: now, durationMs: 0 }
  };
}

function lightsUpLevel(mode, now) {
  const transition = mode.lightsUpTransition;
  if (transition.durationMs === 0) return transition.to;
  const progress = Math.min(1, Math.max(0, (now - transition.startedAt) / transition.durationMs));
  return transition.from + (transition.to - transition.from) * progress;
}

function setLightsUp(config, mode, up, now = performance.now()) {
  const next = Boolean(up);
  if (mode.lightsUp === next) return false;
  const durationSeconds = next ? config.lightsUp.fadeUpSeconds : config.lightsUp.fadeDownSeconds;
  mode.lightsUpTransition = {
    from: lightsUpLevel(mode, now),
    to: Number(next),
    startedAt: now,
    durationMs: durationSeconds * 1000
  };
  mode.lightsUp = next;
  mode.broadcastLightsUp?.({ up: next, durationMs: mode.lightsUpTransition.durationMs });
  console.log(`Lights ${next ? "up" : "down"}; fading over ${durationSeconds.toFixed(1)} seconds.`);
  return true;
}

function newIndividualModeDeadline(config, now) {
  return now + randomBetween(
    config.masterMode.individualModeSeconds.min,
    config.masterMode.individualModeSeconds.max
  ) * 1000;
}

function newMasterTransition(config, fromHue, now) {
  const targetHue = randomTargetHue(fromHue);
  const duration = randomBetween(
    config.masterMode.transitionSeconds.min,
    config.masterMode.transitionSeconds.max
  );
  return transitionTo(fromHue, targetHue, duration, now);
}

function applyMasterTransition(states, mode, masterTransition, now) {
  const duration = masterTransition.durationMs / 1000;
  for (const state of states) {
    if (isPairFollower(state)) continue;
    if (state.staticHue !== null) continue;
    state.transition = transitionTo(
      transitionHue(state.transition, now),
      masterTransition.toHue,
      duration,
      now
    );
    announceTransition(mode, state, now);
  }
}

function updateMode(config, states, mode, now) {
  if (mode.name === "individual") {
    for (const state of states) {
      if (isPairFollower(state)) continue;
      if (state.staticHue !== null) continue;
      if (transitionProgress(state.transition, now) >= 1) {
        state.transition = newIndividualTransition(config, state.transition.toHue, now);
        announceTransition(mode, state, now);
      }
    }
  }

  // A connected bridge owns the master/wander decision, but individual
  // wandering above must continue to generate targets while it says "false".
  if (mode.externalControlled) return;

  if (mode.name === "individual") {
    if (!config.masterMode.enabled || now < mode.individualUntil) return;
    const currentMasterHue = transitionHue(mode.masterTransition, now);
    mode.name = "master";
    mode.masterTransitionsRemaining = randomInteger(
      config.masterMode.transitionCount.min,
      config.masterMode.transitionCount.max
    );
    mode.masterTransition = newMasterTransition(config, currentMasterHue, now);
    applyMasterTransition(states, mode, mode.masterTransition, now);
    console.log(`Entering master mode for ${mode.masterTransitionsRemaining} transitions.`);
    return;
  }

  if (!config.masterMode.enabled || transitionProgress(mode.masterTransition, now) < 1) return;

  const completedMasterHue = mode.masterTransition.toHue;

  mode.masterTransitionsRemaining -= 1;
  if (mode.masterTransitionsRemaining <= 0) {
    setIndividualMode(config, states, mode, now);
    mode.individualUntil = newIndividualModeDeadline(config, now);
    mode.masterTransition = newMasterTransition(config, completedMasterHue, now);
    console.log(
      `Master session complete; returned to individual wandering mode for ` +
      `${((mode.individualUntil - now) / 1000).toFixed(1)} seconds.`
    );
    return;
  }

  mode.masterTransition = newMasterTransition(config, completedMasterHue, now);
  applyMasterTransition(states, mode, mode.masterTransition, now);
  const target = ((mode.masterTransition.toHue % 360) + 360) % 360;
  const duration = mode.masterTransition.durationMs / 1000;
  console.log(
    `Master target reached; ${mode.masterTransitionsRemaining} transitions remain. ` +
    `Next master target ${target.toFixed(1)} degrees over ${duration.toFixed(1)} seconds.`
  );
}

function applyMusicRate(states, mode, now, degreesPerSecond) {
  if (!Number.isFinite(degreesPerSecond) || degreesPerSecond <= 0) return;
  const leaders = states.filter(state => !isPairFollower(state) && state.staticHue === null);
  if (mode.name === "master" && leaders.length) {
    const target = mode.masterTransition.toHue;
    const firstApplication = leaders.some(state => !state.transition.musicDriven);
    if (firstApplication) {
      const snapshots = leaders.map(state => ({ state, hue: transitionHue(state.transition, now) }));
      const maximumDistance = Math.max(...snapshots.map(({ hue }) => circularHueDistance(hue, target)), 1);
      const duration = Math.max(.1, maximumDistance / degreesPerSecond);
      for (const { state, hue } of snapshots) state.transition = {
        ...transitionTo(hue, target, duration, now), easing: "smoothstep", musicDriven: true
      };
      mode.masterTransition = { ...leaders[0].transition };
      return;
    }
    const progress = transitionProgress(mode.masterTransition, now);
    const maximumDistance = Math.max(...leaders.map(state => Math.abs(state.transition.toHue - state.transition.fromHue)), 1);
    const durationMs = Math.max(100, maximumDistance / degreesPerSecond * 1000);
    const startedAt = now - progress * durationMs;
    mode.masterTransition = { ...mode.masterTransition, durationMs, startedAt, easing: "smoothstep", musicDriven: true };
    for (const state of leaders) state.transition = { ...state.transition, durationMs, startedAt, easing: "smoothstep", musicDriven: true };
    return;
  }
  for (const state of leaders) {
    if (!state.transition.musicDriven) {
      const current = transitionHue(state.transition, now);
      const distance = circularHueDistance(current, state.transition.toHue);
      state.transition = { ...transitionTo(current, state.transition.toHue, Math.max(.1, distance / degreesPerSecond), now),
        easing: "smoothstep", musicDriven: true };
      continue;
    }
    const progress = transitionProgress(state.transition, now);
    const distance = Math.max(1, Math.abs(state.transition.toHue - state.transition.fromHue));
    const durationMs = Math.max(100, distance / degreesPerSecond * 1000);
    state.transition.durationMs = durationMs;
    state.transition.startedAt = now - progress * durationMs;
  }
}

function releaseMusicTransitions(config, states, mode, now) {
  const leaders = states.filter(state => !isPairFollower(state) && state.staticHue === null && state.transition.musicDriven);
  if (!leaders.length) return;
  if (mode.name === "master") {
    const current = leaders.map(state => transitionHue(state.transition, now));
    const duration = randomBetween(config.masterMode.transitionSeconds.min, config.masterMode.transitionSeconds.max);
    leaders.forEach((state, index) => { state.transition = transitionTo(current[index], mode.masterTransition.toHue, duration, now); });
    mode.masterTransition = transitionTo(current[0], mode.masterTransition.toHue, duration, now);
  } else {
    for (const state of leaders) {
      const current = transitionHue(state.transition, now);
      state.transition = transitionTo(current, state.transition.toHue,
        randomBetween(config.transitionSeconds.min, config.transitionSeconds.max), now);
    }
  }
  for (const state of leaders) announceTransition(mode, state, now);
}

function freezeAutomaticTransitions(states, mode, elapsedMs) {
  for (const state of states) if (state.staticHue === null) state.transition.startedAt += elapsedMs;
  mode.masterTransition.startedAt += elapsedMs;
}

function musicCanDriveHue(config, mode, playbackStatus, releaseAmount = 0) {
  return config.music.enabled && config.music.influencePercent > 0 && !mode.externalControlled &&
    (playbackStatus === "READY" || releaseAmount > 0);
}

function setIndividualMode(config, states, mode, now) {
  mode.name = "individual";
  for (const state of states) {
    if (isPairFollower(state)) continue;
    if (state.staticHue !== null) continue;
    state.transition = newIndividualTransition(config, transitionHue(state.transition, now), now);
    announceTransition(mode, state, now);
  }
}

function applyExternalMasterMessage(config, states, mode, message, now) {
  mode.externalControlled = true;
  mode.externalHasMessage = true;
  if (!message.syncMode) {
    if (mode.name !== "individual") setIndividualMode(config, states, mode, now);
    return;
  }

  mode.name = "master";
  mode.masterTransition = transitionTo(message.hue, message.hue, message.durationMs / 1000, now);
  for (const state of states) {
    if (isPairFollower(state)) continue;
    if (state.staticHue !== null) continue;
    state.transition = transitionTo(
      transitionHue(state.transition, now),
      message.hue,
      message.durationMs / 1000,
      now
    );
    announceTransition(mode, state, now);
  }
}

function releaseExternalMaster(config, states, mode, now) {
  if (!mode.externalControlled) return;
  mode.externalControlled = false;
  mode.externalHasMessage = false;
  mode.masterTransitionsRemaining = 0;
  setIndividualMode(config, states, mode, now);
  mode.individualUntil = newIndividualModeDeadline(config, now);
  mode.masterTransition = newMasterTransition(config, transitionHue(mode.masterTransition, now), now);
  console.log("External lighting master unavailable; resumed local colour wandering.");
}

function parseExternalMasterMessage(line) {
  const match = /^UDP:\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*(true|false)\s*$/i.exec(line);
  if (!match) return null;
  const hue = Number(match[1]);
  const durationMs = Number(match[2]);
  const brightness = Number(match[3]);
  const syncMode = match[4].toLowerCase() === "true";
  if (
    !Number.isFinite(hue) ||
    !Number.isFinite(durationMs) ||
    (syncMode && durationMs <= 0) ||
    !Number.isFinite(brightness)
  ) {
    return null;
  }
  return {
    hue: ((hue % 360) + 360) % 360,
    durationMs,
    brightness,
    syncMode
  };
}

function createExternalMasterMonitor(config, states, mode) {
  if (!config.externalMaster.enabled) return { close: async () => {}, sendLightsUp: async () => false };

  let tableState = null;
  let lastFollowAt = -Infinity;
  let lastFollowHue = null;
  let stopped = false;
  let port = null;
  let scanTimer = null;
  const wantedVendorId = config.externalMaster.vendorId.toString(16).padStart(4, "0");

  const scheduleScan = () => {
    if (!stopped && !scanTimer) {
      scanTimer = setTimeout(() => {
        scanTimer = null;
        void scan();
      }, config.externalMaster.scanSeconds * 1000);
    }
  };

  const scan = async () => {
    if (stopped || port) return;
    try {
      const ports = await SerialPort.list();
      const match = ports.find(candidate => candidate.vendorId?.toLowerCase() === wantedVendorId);
      if (!match) {
        scheduleScan();
        return;
      }

      const candidate = new SerialPort({
        path: match.path,
        baudRate: config.externalMaster.baudRate,
        autoOpen: false
      });
      port = candidate;
      const parser = candidate.pipe(new ReadlineParser({ delimiter: "\n" }));
      parser.on("data", data => {
        const line = data.toString().trim();
        if (line.startsWith("TABLE: ")) {
          try {
            const report = JSON.parse(line.slice(7));
            if (typeof report.static === "boolean" && Number.isFinite(report.hue) && report.hue >= 0 && report.hue < 360) {
              tableState = report;
              if (!report.static) lastFollowHue = null;
            }
          } catch { /* Ignore incomplete or malformed reports. */ }
          return;
        }
        const normalized = line.toLowerCase().replace(/[\s_-]+/g, "");
        if (["1", "up", "lightsup"].includes(normalized)) {
          setLightsUp(config, mode, true);
          return;
        }
        if (["0", "down", "lightsdown"].includes(normalized)) {
          setLightsUp(config, mode, false);
          return;
        }
        const message = parseExternalMasterMessage(line);
        if (!message) {
          if (line.startsWith("UDP:")) console.warn(`Ignored malformed external master message: ${line}`);
          return;
        }
        applyExternalMasterMessage(config, states, mode, message, performance.now());
        console.log(
          message.syncMode
            ? `External master: hue ${message.hue.toFixed(1)} over ${(message.durationMs / 1000).toFixed(1)} seconds.`
            : "External master selected individual wandering mode."
        );
      });
      candidate.once("close", () => {
        if (port === candidate) port = null;
        tableState = null;
        lastFollowHue = null;
        mode.externalConnected = false;
        mode.externalHasMessage = false;
        mode.externalPort = null;
        releaseExternalMaster(config, states, mode, performance.now());
        scheduleScan();
      });
      candidate.on("error", error => console.error(`External master serial error: ${error.message}`));
      candidate.open(error => {
        if (error) {
          console.error(`Could not open external master ${match.path}: ${error.message}`);
          if (port === candidate) port = null;
          mode.externalConnected = false;
          mode.externalHasMessage = false;
          mode.externalPort = null;
          scheduleScan();
          return;
        }
        mode.externalConnected = true;
        mode.externalControlled = true;
        mode.externalHasMessage = false;
        mode.externalPort = match.path;
        mode.masterTransitionsRemaining = 0;
        if (mode.name !== "individual") {
          setIndividualMode(config, states, mode, performance.now());
        }
        candidate.write("BRIDGE?\n", error => {
          if (error) console.warn(`Bridge handshake failed: ${error.message}`);
        });
        console.log(`Listening for the external lighting master on ${match.path} at ${config.externalMaster.baudRate} baud.`);
      });
    } catch (error) {
      console.error(`Could not scan for the external lighting master: ${error.message}`);
      scheduleScan();
    }
  };

  const tableLeader = () => {
    const anchor = states.find(state => state.fixture.id === mode.tablePairLeaderId);
    return anchor ? pairLeader(states, anchor) : null;
  };
  const setTableColour = async hue => {
    const connection = port;
    if (!connection?.isOpen || !tableState) fail("Table lights bridge is unavailable or needs updated firmware");
    await serialAction(done => connection.write(hue === null ? "WANDER\n" : `STATIC ${hue}\n`, done));
    if (port === connection && tableState) tableState = { static: hue !== null, hue: hue ?? tableState.hue };
  };
  const syncTablePair = async (now = performance.now(), force = false) => {
    const leader = tableLeader();
    if (!leader || !port?.isOpen || !tableState || (!force && now - lastFollowAt < 50)) return;
    const current = leader.staticHue ?? transitionHue(leader.transition, now);
    const hue = ((Math.round(current * 100) / 100) % 360 + 360) % 360;
    lastFollowAt = now;
    if (!force && hue === lastFollowHue) return;
    await setTableColour(hue);
    lastFollowHue = hue;
  };
  void scan();
  return {
    tableLeader,
    syncTablePair,
    pairTable: async leader => {
      if (!port?.isOpen || !tableState) fail("Table lights bridge is unavailable");
      const previous = mode.tablePairLeaderId;
      mode.tablePairLeaderId = leader.fixture.id;
      try { await syncTablePair(performance.now(), true); }
      catch (error) { mode.tablePairLeaderId = previous; throw error; }
    },
    unpairTable: async () => {
      if (port?.isOpen && tableState) await setTableColour(null);
      mode.tablePairLeaderId = null;
      lastFollowHue = null;
    },
    tableFixture: () => {
      if (!port?.isOpen || !tableState) return [];
      const leader = tableLeader();
      const now = performance.now();
      const current = leader ? leader.staticHue ?? transitionHue(leader.transition, now) : tableState.hue;
      return [{
        id: TABLE_LIGHTS_ID, name: "Table lights", kind: "bridge",
        mode: leader ? leader.staticHue === null ? "wander" : "static" : tableState.static ? "static" : "wander",
        automaticMode: leader ? mode.name : "individual",
        pairLeaderId: leader?.fixture.id ?? null, pairLeaderName: leader?.fixture.name ?? null,
        hue: ((current % 360) + 360) % 360,
        targetHue: leader ? leader.staticHue ?? ((leader.transition.toHue % 360) + 360) % 360 : null,
        durationMs: leader && leader.staticHue === null
          ? Math.max(0, (1 - transitionProgress(leader.transition, now)) * leader.transition.durationMs) : 0,
        lightsUpColour: { red: 255, green: 255, blue: 255 }
      }];
    },
    setTableColour,
    sendLightsUp: async up => {
      if (!port?.isOpen) return false;
      await serialAction(done => port.write(`${up ? "1" : "0"}\n`, done));
      return true;
    },
    close: async () => {
      stopped = true;
      clearTimeout(scanTimer);
      if (mode.tablePairLeaderId && port?.isOpen && tableState) {
        await setTableColour(null).catch(error => console.warn(`Could not release table lights: ${error.message}`));
      }
      if (port?.isOpen) await new Promise(resolve => port.close(() => resolve()));
      port = null;
    }
  };
}

function renderUniverse(config, states, now, controls) {
  // Buffer.alloc fills every channel with zero before mapped values are applied.
  const universe = Buffer.alloc(config.universeLength, 0);
  for (const state of states) {
    const controllingState = pairLeader(states, state);
    let hue = controllingState.staticHue ?? transitionHue(controllingState.transition, now);
    const music = controllingState.staticHue === null ? controls.musicIntent : null;
    if (music?.accent) {
      const fixtureIndex = states.indexOf(state);
      const accentHue = (music.accent.hue + [-16, -5, 7, 20][fixtureIndex % 4] + 360) % 360;
      hue = hueMix(hue, accentHue, music.accent.shape * music.influence);
    }
    const musicValue = music ? music.brightness : 1;
    const hasDimmer = "brightness" in state.fixture.type.channels;
    let [red, green, blue] = hsvToRgb(hue, music ? music.saturation : 1, hasDimmer ? 1 : musicValue);
    const upLevel = lightsUpLevel(controls.mode, now);
    red = Math.round(red + (state.fixture.lightsUpColour.red - red) * upLevel);
    green = Math.round(green + (state.fixture.lightsUpColour.green - green) * upLevel);
    blue = Math.round(blue + (state.fixture.lightsUpColour.blue - blue) * upLevel);
    if (!hasDimmer) {
      const scale = controls.masterBrightness / 255;
      red = Math.round(red * scale);
      green = Math.round(green * scale);
      blue = Math.round(blue * scale);
    }
    const outputValue = musicValue + (1 - musicValue) * upLevel;
    const values = { red, green, blue, brightness: Math.round(controls.masterBrightness * outputValue) };
    for (const [role, offset] of Object.entries(state.fixture.type.channels)) {
      universe[state.fixture.address + offset - 2] = values[role];
    }
    for (const [offset, value] of Object.entries(state.fixture.type.fixedChannels)) {
      universe[state.fixture.address + Number(offset) - 2] = value;
    }
  }
  return universe;
}

function sendUdmxUniverse(device, universe) {
  return new Promise((resolve, reject) => {
    device.controlTransfer(
      USB_VENDOR_DEVICE_OUT,
      UDMX_SET_CHANNEL_RANGE,
      universe.length,
      0,
      universe,
      error => error ? reject(error) : resolve()
    );
  });
}

async function sendUdmxUniverseWithRetries(device, universe, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await sendUdmxUniverse(device, universe);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(2);
    }
  }
  throw lastError;
}

function serialAction(action) {
  return new Promise((resolve, reject) => action(error => error ? reject(error) : resolve()));
}

async function sendOpenDmxUniverse(port, universe) {
  const frame = Buffer.alloc(universe.length + 1, 0);
  universe.copy(frame, 1);
  await serialAction(done => port.set({ brk: true }, done));
  await wait(1);
  await serialAction(done => port.set({ brk: false }, done));
  await wait(1);
  await serialAction(done => port.write(frame, done));
  await serialAction(done => port.drain(done));
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function createUdmxTransport(config) {
  const udmxDevice = usb.findByIds(config.usb.vendorId, config.usb.productId);
  if (!udmxDevice) return null;
  udmxDevice.open();
  return {
    name: `uDMX ${config.usb.vendorId.toString(16).padStart(4, "0")}:${config.usb.productId.toString(16).padStart(4, "0")}`,
    send: universe => sendUdmxUniverseWithRetries(udmxDevice, universe),
    close: async () => udmxDevice.close()
  };
}

async function createOpenDmxTransport(config) {
  if (!config.openDmx.enabled) return null;
  const ports = await SerialPort.list();
  const match = ports.find(candidate =>
    config.openDmx.path
      ? candidate.path === config.openDmx.path
      : config.openDmx.serialNumber
        ? candidate.serialNumber === config.openDmx.serialNumber
        : candidate.manufacturer?.toLowerCase().includes("ftdi")
  );
  if (!match) return null;
  const port = new SerialPort({
    path: match.path,
    baudRate: 250000,
    dataBits: 8,
    stopBits: 2,
    parity: "none",
    autoOpen: false
  });
  let portError = null;
  port.on("error", error => { portError = error; });
  try {
    await serialAction(done => port.open(done));
  } catch (error) {
    if (port.isOpen) await serialAction(done => port.close(done)).catch(() => {});
    throw error;
  }
  return {
    name: `Open DMX ${match.path}`,
    send: universe => {
      if (portError) throw portError;
      if (!port.isOpen) throw new Error("Serial port disconnected");
      return sendOpenDmxUniverse(port, universe);
    },
    close: async () => {
      if (port.isOpen) await serialAction(done => port.close(done));
    }
  };
}

async function createTransport(config) {
  return createDmxOutputs([
    () => createUdmxTransport(config),
    ...(config.openDmx.enabled ? [() => createOpenDmxTransport(config)] : [])
  ]);
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16_384) fail("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function persistLightsUpColours(updates) {
  const source = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const byId = new Map(updates.map(update => [update.id, update.colour]));
  source.fixtures = source.fixtures.map((fixture, index) => {
    const id = fixture.id ?? `fixture-${index + 1}`;
    const colour = byId.get(id);
    return colour ? { ...fixture, lightsUpColour: colour } : fixture;
  });
  await writeFile(CONFIG_PATH, `${JSON.stringify(source, null, 2)}\n`, "utf8");
}

async function persistMusicConfig(music) {
  const source = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  source.music = music;
  await writeFile(CONFIG_PATH, `${JSON.stringify(source, null, 2)}\n`, "utf8");
}

function createWebServer(config, states, mode, controls, externalMaster, transport, playback = {
  snapshot: { status: "NO_TRACK", title: null, error: null }, position: () => 0,
  receive: () => false
}) {
  const tableLeader = () => externalMaster.tableLeader?.();
  const splitSelection = ids => {
    const hasTable = Array.isArray(ids) && ids.includes(TABLE_LIGHTS_ID);
    if (hasTable && !externalMaster.tableFixture?.().length) fail("Table lights bridge is unavailable");
    const dmxIds = hasTable ? ids.filter(id => id !== TABLE_LIGHTS_ID) : ids;
    const selected = hasTable && dmxIds.length === 0 ? [] : selectStates(states, dmxIds);
    return { hasTable, selected };
  };
  const controlSelection = ids => {
    const {hasTable, selected} = splitSelection(ids);
    if (hasTable && tableLeader()) selected.push(tableLeader());
    return {hasTable, matching: [...new Set(selected.map(state => pairLeader(states, state)))]};
  };
  const includeTable = updated => {
    if (tableLeader() && updated.includes(tableLeader().fixture.id) && !updated.includes(TABLE_LIGHTS_ID)) updated.push(TABLE_LIGHTS_ID);
    return updated;
  };
  const eventClients = new Set();
  mode.broadcastTransition = payload => {
    const event = `event: transition\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of eventClients) client.write(event);
  };
  mode.broadcastLightsUp = payload => {
    const event = `event: lights-up\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of eventClients) client.write(event);
  };
  const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]]
  ]);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.setHeader("access-control-allow-private-network", "true");
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        response.write(": connected\n\n");
        eventClients.add(response);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
        request.once("close", () => {
          clearInterval(heartbeat);
          eventClients.delete(response);
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        const now = performance.now();
        json(response, 200, {
          dmx: transport?.status ?? { connected: false, outputs: [] },
          masterBrightness: controls.masterBrightness,
          lightsUp: mode.lightsUp,
          music: {
            config: config.music,
            status: playback.snapshot.status,
            kind: playback.snapshot.event?.kind ?? null,
            title: playback.snapshot.title,
            error: playback.snapshot.error,
            analysisMs: playback.snapshot.analysisMs ?? null,
            positionSeconds: playback.position(performance.now(), config.music.avDelayMs),
            durationSeconds: playback.snapshot.event?.durationSeconds ?? null,
            intent: controls.musicIntent ? {
              feature: controls.musicIntent.feature,
              brightness: controls.musicIntent.brightness,
              hueRate: controls.musicIntent.hueRate,
              saturation: controls.musicIntent.saturation,
              accent: controls.musicIntent.accent
            } : null
          },
          externalMaster: {
            connected: mode.externalConnected,
            mode: !mode.externalConnected
              ? "disconnected"
              : !mode.externalHasMessage
                ? "awaiting"
                : mode.name === "master" ? "master" : "wander",
            port: mode.externalPort
          },
          fixtures: states.map(state => {
            const controllingState = pairLeader(states, state);
            const hue = ((controllingState.staticHue ?? transitionHue(controllingState.transition, now)) % 360 + 360) % 360;
            return {
              id: state.fixture.id,
              name: state.fixture.name,
              address: state.fixture.address,
              lightsUpColour: state.fixture.lightsUpColour,
              mode: controllingState.staticHue === null ? "wander" : "static",
              automaticMode: mode.name,
              pairLeaderId: state.pairLeaderId,
              pairLeaderName: state.pairLeaderId === null ? null : controllingState.fixture.name,
              hue,
              targetHue: controllingState.staticHue === null
                ? ((controllingState.transition.toHue % 360) + 360) % 360
                : hue,
              durationMs: controllingState.staticHue === null
                ? Math.max(0, (1 - transitionProgress(controllingState.transition, now)) * controllingState.transition.durationMs)
                : 0
            };
          }).concat(externalMaster.tableFixture?.() ?? [])
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/lights") {
        const body = await readJson(request);
        if (typeof body.up !== "boolean") fail("up must be true or false");
        setLightsUp(config, mode, body.up);
        const forwarded = await externalMaster.sendLightsUp(body.up).catch(error => {
          console.warn(`Could not forward lights state to ESP: ${error.message}`);
          return false;
        });
        json(response, 200, { up: mode.lightsUp, forwarded });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/playback") {
        const address = request.socket.remoteAddress;
        if (address && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) fail("Playback events are loopback-only");
        const accepted = playback.receive(await readJson(request));
        json(response, 200, { accepted, status: playback.snapshot.status });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/music") {
        const body = await readJson(request);
        config.music = validateMusicConfig({ ...config.music, ...body });
        await persistMusicConfig(config.music);
        json(response, 200, { music: config.music });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/brightness") {
        const body = await readJson(request);
        controls.masterBrightness = integer(Number(body.brightness), "brightness", 0, 255);
        json(response, 200, { masterBrightness: controls.masterBrightness });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/lights-up-colour") {
        const body = await readJson(request);
        const matching = selectStates(states, body.fixtureIds);
        const colour = {};
        for (const channel of ["red", "green", "blue"]) {
          colour[channel] = integer(Number(body.colour?.[channel]), `colour.${channel}`, 0, 255);
        }
        for (const state of matching) state.fixture.lightsUpColour = { ...colour };
        await persistLightsUpColours(matching.map(state => ({ id: state.fixture.id, colour })));
        json(response, 200, { updated: matching.map(state => state.fixture.id), colour });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/pair") {
        const body = await readJson(request);
        const {hasTable, selected} = splitSelection(body.fixtureIds);
        if (hasTable && tableLeader() && !selected.includes(tableLeader())) selected.push(tableLeader());
        if (selected.length + (hasTable ? 1 : 0) < 2) fail("Select at least two lights to pair or extend a pair");
        const existingLeader = selected.map(state => pairLeader(states, state)).find(
          leader => leader.pairLeaderId !== null
        );
        const leader = existingLeader ?? selected[0];
        const members = new Set();
        for (const state of selected) {
          for (const member of pairMembers(states, pairLeader(states, state))) members.add(member);
        }
        if (hasTable) await externalMaster.pairTable(leader);
        for (const member of members) member.pairLeaderId = leader.fixture.id;
        json(response, 200, {
          leaderId: leader.fixture.id,
          updated: includeTable([...members].map(state => state.fixture.id))
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/unpair") {
        const body = await readJson(request);
        const {hasTable, selected} = splitSelection(body.fixtureIds);
        const oldTableLeader = tableLeader();
        const oldTableMembers = oldTableLeader ? pairMembers(states, oldTableLeader) : [];
        if (oldTableLeader) mode.tablePairLeaderId = oldTableLeader.fixture.id;
        if (hasTable) await externalMaster.unpairTable();
        const selectedSet = new Set(selected);
        const groupIds = new Set(selected.map(state => state.pairLeaderId).filter(Boolean));
        const now = performance.now();
        const updated = new Set();
        for (const groupId of groupIds) {
          const members = states.filter(state => state.pairLeaderId === groupId);
          const source = states.find(state => state.fixture.id === groupId) ?? members[0];
          const sourceSnapshot = {
            staticHue: source.staticHue,
            transition: { ...source.transition }
          };
          const detached = members.filter(state => selectedSet.has(state));
          const remaining = members.filter(state => !selectedSet.has(state));
          for (const state of detached) {
            state.pairLeaderId = null;
            copyCurrentBehaviour(config, mode, sourceSnapshot, state, now);
            updated.add(state.fixture.id);
          }
          if (remaining.length === 1) {
            remaining[0].pairLeaderId = null;
            copyCurrentBehaviour(config, mode, sourceSnapshot, remaining[0], now);
            updated.add(remaining[0].fixture.id);
          } else if (remaining.length > 1) {
            const nextLeader = remaining.includes(source) ? source : remaining[0];
            if (nextLeader !== source) copyCurrentBehaviour(config, mode, sourceSnapshot, nextLeader, now);
            for (const state of remaining) {
              state.pairLeaderId = nextLeader.fixture.id;
              updated.add(state.fixture.id);
            }
          }
        }
        if (hasTable) updated.add(TABLE_LIGHTS_ID);
        else if (oldTableLeader && selectedSet.has(oldTableLeader)) {
          const remaining = oldTableMembers.filter(state => !selectedSet.has(state));
          if (remaining.length) mode.tablePairLeaderId = pairLeader(states, remaining[0]).fixture.id;
          else await externalMaster.unpairTable();
          updated.add(TABLE_LIGHTS_ID);
        }
        // A DMX leader with only the table group left is still a pair leader.
        if (tableLeader()) tableLeader().pairLeaderId = tableLeader().fixture.id;
        // Remove a self-only DMX pair after detaching the table group.
        if (hasTable && oldTableLeader && pairMembers(states, oldTableLeader).length <= 1) oldTableLeader.pairLeaderId = null;
        json(response, 200, { updated: [...updated] });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/static") {
        const body = await readJson(request);
        const {hasTable, matching} = controlSelection(body.fixtureIds);
        const hue = Number(body.hue);
        if (!Number.isFinite(hue)) fail("hue must be a number");
        const normalizedHue = ((hue % 360) + 360) % 360;
        if (hasTable && !tableLeader()) await externalMaster.setTableColour(normalizedHue);
        for (const state of matching) state.staticHue = normalizedHue;
        const updated = matching.flatMap(state => pairMembers(states, state)).map(state => state.fixture.id);
        if (hasTable) updated.push(TABLE_LIGHTS_ID);
        includeTable(updated);
        await externalMaster.syncTablePair?.(performance.now(), true);
        json(response, 200, { updated, hue: normalizedHue });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/wander") {
        const body = await readJson(request);
        const {hasTable, matching} = controlSelection(body.fixtureIds);
        if (hasTable && !tableLeader()) await externalMaster.setTableColour(null);
        const now = performance.now();
        for (const state of matching) {
          const fromHue = state.staticHue ?? transitionHue(state.transition, now);
          state.staticHue = null;
          const remaining = Math.max(0.1, (1 - transitionProgress(mode.masterTransition, now)) * mode.masterTransition.durationMs / 1000);
          state.transition = mode.name === "master"
            ? transitionTo(fromHue, mode.masterTransition.toHue, remaining, now)
            : newIndividualTransition(config, fromHue, now);
          announceTransition(mode, state, now);
        }
        const updated = matching.flatMap(state => pairMembers(states, state)).map(state => state.fixture.id);
        if (hasTable) updated.push(TABLE_LIGHTS_ID);
        includeTable(updated);
        await externalMaster.syncTablePair?.(performance.now(), true);
        json(response, 200, { updated });
        return;
      }
      const asset = assets.get(url.pathname);
      if (request.method === "GET" && asset) {
        const [file, contentType] = asset;
        response.writeHead(200, { "content-type": contentType });
        response.end(await readFile(new URL(`./public/${file}`, import.meta.url)));
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
  });
  server.once("close", () => {
    for (const client of eventClients) client.end();
    eventClients.clear();
  });
  return server;
}

function selectStates(states, fixtureIds) {
  if (!Array.isArray(fixtureIds) || fixtureIds.length === 0) fail("fixtureIds must select at least one light");
  const selected = new Set(fixtureIds);
  const matching = states.filter(state => selected.has(state.fixture.id));
  if (matching.length !== selected.size) fail("One or more fixtureIds are unknown");
  return matching;
}

async function runDiagnostics(config, transport) {
  if (config.fixtures.length !== 1) {
    fail("Diagnostic mode currently requires exactly one configured fixture");
  }
  const fixture = config.fixtures[0];
  const tests = [
    ["BLACKOUT", [0, 0, 0], 0],
    ["RED only", [255, 0, 0], config.masterBrightness],
    ["GREEN only", [0, 255, 0], config.masterBrightness],
    ["BLUE only", [0, 0, 255], config.masterBrightness],
    ["BLACKOUT", [0, 0, 0], 0]
  ];

  console.log("Diagnostic mode: each test is held for 4 seconds.");
  for (const [name, [red, green, blue], brightness] of tests) {
    const universe = Buffer.alloc(config.universeLength, 0);
    const values = { red, green, blue, brightness };
    for (const [role, offset] of Object.entries(fixture.type.channels)) {
      universe[fixture.address + offset - 2] = values[role];
    }
    for (const [offset, value] of Object.entries(fixture.type.fixedChannels)) {
      universe[fixture.address + Number(offset) - 2] = value;
    }
    const fixtureValues = [...universe.subarray(
      fixture.address - 1,
      fixture.address - 1 + fixture.type.channelCount
    )];
    console.log(`${name.padEnd(10)} DMX ${fixture.address}-${fixture.address + fixture.type.channelCount - 1}: [${fixtureValues.join(", ")}]`);
    const endAt = performance.now() + 4000;
    while (performance.now() < endAt) {
      if (!await transport.send(universe)) fail("Diagnostic stopped: no DMX output connected");
      await wait(1000 / config.fps);
    }
  }
}

async function main() {
  const config = validateConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
  const transport = await createTransport(config);
  console.log(
    `Lighting controller ready; ${config.fixtures.length} fixtures at ${config.fps} FPS.`
  );

  if (diagnosticMode) {
    try {
      if (!transport.status.connected) fail("Diagnostics require a connected DMX output");
      await runDiagnostics(config, transport);
    } finally {
      await transport.send(Buffer.alloc(config.universeLength, 0));
      await transport.close();
    }
    return;
  }

  let stopped = false;
  let timer;
  let webServer;
  let externalMaster;
  const analyseAudio = createAudioAnalyser();
  const playback = new PlaybackCoordinator({ analyse: analyseAudio });
  const stop = async signal => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    webServer?.close();
    webServer?.closeAllConnections?.();
    await externalMaster?.close();
    playback.cancel();
    await analyseAudio.close();
    try {
      const sent = await transport.send(Buffer.alloc(config.universeLength, 0));
      console.log(`\n${signal}: ${sent ? "sent blackout and stopped" : "stopped (no DMX output connected)"}.`);
    } catch (error) {
      console.error(`\n${signal}: could not send blackout: ${error.message}`);
    } finally {
      await transport.close();
    }
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  const states = config.fixtures.map(fixture => createFixtureState(config, fixture, performance.now()));
  const mode = createModeState(config, performance.now());
  const controls = { masterBrightness: config.masterBrightness, mode, musicIntent: null };
  const musicState = createMusicIntentState();
  externalMaster = createExternalMasterMonitor(config, states, mode);
  webServer = createWebServer(config, states, mode, controls, externalMaster, transport, playback);
  webServer.listen(config.webPort, "0.0.0.0", () => {
    console.log(`Lighting controls: http://localhost:${config.webPort}`);
  });
  const frameMs = 1000 / config.fps;
  let nextFrame = performance.now();
  let previousFrame = nextFrame;
  let musicWasDriving = false;
  const tick = async () => {
    if (stopped) return;
    const now = performance.now();
    try {
      const musicCanDrive = config.music.enabled && config.music.influencePercent > 0;
      if (musicCanDrive && playback.snapshot.status === "PAUSED") {
        freezeAutomaticTransitions(states, mode, Math.max(0, now - previousFrame));
      }
      updateMode(config, states, mode, now);
      const musicRelease = playback.snapshot.status === "NO_TRACK"
        ? playback.release(now, config.music.activationBlendSeconds) : 0;
      if (musicCanDrive && playback.snapshot.profile && (["READY", "PAUSED"].includes(playback.snapshot.status) || musicRelease > 0)) {
        const nextIntent = computeMusicIntent(
          playback.snapshot.profile,
          playback.position(now, config.music.avDelayMs),
          config.music,
          musicState,
          now / 1000,
          playback.snapshot.status === "NO_TRACK" ? musicRelease : playback.activation(now, config.music.activationBlendSeconds)
        );
        if (nextIntent) {
          Object.assign(musicState, nextIntent);
          controls.musicIntent = nextIntent;
          const canDriveHue = musicCanDriveHue(config, mode, playback.snapshot.status, musicRelease);
          if (!canDriveHue && musicWasDriving) releaseMusicTransitions(config, states, mode, now);
          if (canDriveHue) applyMusicRate(states, mode, now, nextIntent.hueRate);
          musicWasDriving = canDriveHue;
        }
      } else if (playback.snapshot.status !== "ANALYSING") {
        if (musicWasDriving) releaseMusicTransitions(config, states, mode, now);
        musicWasDriving = false;
        controls.musicIntent = null;
        musicState.lastAt = null;
      }
      await externalMaster.syncTablePair?.(now).catch(error => {
        console.warn(`Could not update paired table lights: ${error.message}`);
      });
      await transport.send(renderUniverse(config, states, now, controls));
    } catch (error) {
      console.error(`DMX write failed: ${error.message}`);
      await stop("DMX error");
      process.exitCode = 1;
      return;
    }
    nextFrame += frameMs;
    previousFrame = now;
    if (nextFrame < performance.now() - frameMs) nextFrame = performance.now();
    timer = setTimeout(tick, Math.max(0, nextFrame - performance.now()));
  };
  await tick();
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
