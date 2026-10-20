const lightsElement = document.querySelector("#lights");
const wheel = document.querySelector("#wheel");
const pointer = document.querySelector("#pointer");
const targetPointer = document.querySelector("#target-pointer");
const hueValue = document.querySelector("#hue-value");
const summary = document.querySelector("#selection-summary");
const status = document.querySelector("#status");
const wanderButton = document.querySelector("#wander");
const pairButton = document.querySelector("#pair");
const unpairButton = document.querySelector("#unpair");
const selectAllButton = document.querySelector("#select-all");
const espStatus = document.querySelector("#esp-status");
const espStatusText = document.querySelector("#esp-status-text");
const brightnessSlider = document.querySelector("#brightness");
const brightnessValue = document.querySelector("#brightness-value");
const lightsUpButton = document.querySelector("#lights-up");
const lightsUpLabel = document.querySelector("#lights-up-label");
const cortinaColourInput = document.querySelector("#cortina-colour");
const applyCortinaColourButton = document.querySelector("#apply-cortina-colour");
const musicInputs = {
  enabled: document.querySelector("#music-enabled"), influencePercent: document.querySelector("#music-influence"),
  transitionSpeedPercent: document.querySelector("#music-speed"), minimumBrightnessPercent: document.querySelector("#music-min"),
  maximumBrightnessPercent: document.querySelector("#music-max"), gamma: document.querySelector("#music-gamma"),
  avDelayMs: document.querySelector("#music-delay"), dramaticPausesEnabled: document.querySelector("#music-pauses")
};
const musicDefaults = { enabled: false, influencePercent: 100, transitionSpeedPercent: 220,
  minimumBrightnessPercent: 25, maximumBrightnessPercent: 100, gamma: 1.05, avDelayMs: 0, dramaticPausesEnabled: true };
let fixtures = [];
let hue = 0;
let dragging = false;
let sendTimer;
let staticUpdateRunning = false;
let staticUpdatePending = false;
let brightnessTimer;
let lightsUp = false;
let musicSaveTimer;

function renderMusic(music, visibleFixtures = fixtures) {
  if (!music) return;
  const labels = { NO_TRACK: "No track", ANALYSING: "Analysing — current lighting held", READY: "Music profile ready", PAUSED: "Playback paused", UNAVAILABLE: "Music analysis unavailable" };
  const statusLabel = music.kind === "cortina"
    ? "Cortina override — music response suspended"
    : labels[music.status] ?? music.status;
  document.querySelector("#music-status").textContent = `${music.title ?? ""}${music.title ? " · " : ""}${statusLabel}${music.error ? ` · ${music.error}` : ""}`;
  for (const [name, input] of Object.entries(musicInputs)) {
    const value = music.config[name]; if (input.type === "checkbox") input.checked = Boolean(value); else input.value = String(value);
    const output = input.parentElement?.querySelector("output");
    if (output) output.textContent = name === "gamma" ? Number(value).toFixed(2) : name === "avDelayMs" ? `${value} ms` : `${value}%`;
  }
  const feature = music.intent?.feature;
  document.querySelector("#music-features").textContent = feature
    ? `Intensity ${Math.round(feature.intensity * 100)}% · fast energy ${Math.round(feature.fastEnergy * 100)}% · activity ${Math.round(feature.fastActivity * 100)}% · drive ${Math.round(feature.drive * 100)}% · ${feature.trend.toLowerCase()}` : "Waiting for analysis";
  const timing = Number.isFinite(music.positionSeconds) && Number.isFinite(music.durationSeconds)
    ? ` · ${Math.floor(music.positionSeconds / 60)}:${String(Math.floor(music.positionSeconds % 60)).padStart(2, "0")} / ${Math.floor(music.durationSeconds / 60)}:${String(Math.floor(music.durationSeconds % 60)).padStart(2, "0")}` : "";
  const analysis = Number.isFinite(music.analysisMs) ? ` · analysed in ${(music.analysisMs / 1000).toFixed(1)}s` : "";
  document.querySelector("#music-output").textContent = music.intent
    ? `Value ${Math.round(music.intent.brightness * 100)}% · ${music.intent.hueRate.toFixed(1)}°/s${music.intent.accent ? ` · ${music.intent.accent.phase} accent (${Math.round(music.intent.accent.score * 100)}%)` : ""}${timing}${analysis}`
    : `Legacy lighting output${timing}${analysis}`;
  const musicValue = music.intent?.brightness ?? 1;
  for (const fixture of visibleFixtures) {
    const card = document.querySelector(`.light[data-id="${CSS.escape(fixture.id)}"]`);
    const value = fixture.kind !== "bridge" && fixture.mode === "wander" ? musicValue : 1;
    card?.style.setProperty("--light-value", String(value));
  }
}

function scheduleMusicSave() {
  for (const [name, input] of Object.entries(musicInputs)) {
    const output = input.parentElement?.querySelector("output");
    if (output) output.textContent = name === "gamma" ? Number(input.value).toFixed(2) : name === "avDelayMs" ? `${input.value} ms` : `${input.value}%`;
  }
  clearTimeout(musicSaveTimer);
  musicSaveTimer = setTimeout(async () => {
    const body = Object.fromEntries(Object.entries(musicInputs).map(([name, input]) => [name, input.type === "checkbox" ? input.checked : Number(input.value)]));
    if (body.minimumBrightnessPercent > body.maximumBrightnessPercent) body.maximumBrightnessPercent = body.minimumBrightnessPercent;
    try { const result = await post("/api/music", body); renderMusic({ config: result.music, status: "NO_TRACK" }); }
    catch (error) { document.querySelector("#music-status").textContent = error.message; }
  }, 120);
}
for (const input of Object.values(musicInputs)) input.addEventListener("input", scheduleMusicSave);
document.querySelector("#music-reset").addEventListener("click", () => {
  for (const [name, value] of Object.entries(musicDefaults)) { const input = musicInputs[name]; if (input.type === "checkbox") input.checked = value; else input.value = value; }
  scheduleMusicSave();
});

function displayLightsUp(up) {
  lightsUp = Boolean(up);
  lightsUpButton.setAttribute("aria-checked", String(lightsUp));
  lightsUpLabel.textContent = lightsUp ? "Lights up" : "Lights down";
}

function displayBrightness(value) {
  const brightness = Math.max(0, Math.min(255, Number(value)));
  brightnessSlider.value = String(brightness);
  brightnessValue.value = `${Math.round(brightness / 255 * 100)}%`;
}

function scheduleBrightnessUpdate() {
  displayBrightness(brightnessSlider.value);
  if (brightnessTimer) return;
  brightnessTimer = setTimeout(async () => {
    brightnessTimer = undefined;
    try {
      await post("/api/brightness", { brightness: Number(brightnessSlider.value) });
      status.textContent = "Brightness applied";
    } catch (error) {
      status.textContent = error.message;
    }
  }, 25);
}
const lightTransitions = new Map();
let animationFrame;

function shortestHueDistance(fromHue, toHue) {
  return ((toHue - fromHue + 540) % 360) - 180;
}

function trackedFixture() {
  const selected = fixtures.filter(fixture => selectedIds().includes(fixture.id));
  const controllingIds = new Set(selected.map(fixture => fixture.pairLeaderId ?? fixture.id));
  if (controllingIds.size !== 1) return null;
  const [id] = controllingIds;
  return fixtures.find(fixture => fixture.id === id) ?? null;
}

function animateLightTargets(now) {
  for (const [id, transition] of lightTransitions) {
    const progress = transition.durationMs === 0
      ? 1
      : Math.min(1, (now - transition.startedAt) / transition.durationMs);
    const currentHue = (transition.fromHue + transition.distance * progress + 360) % 360;
    const fixture = fixtures.find(item => item.id === id);
    if (fixture) fixture.hue = currentHue;
    const card = document.querySelector(`.light[data-id="${CSS.escape(id)}"]`);
    card?.style.setProperty("--light-colour", `hsl(${currentHue} 100% 50%)`);
    const tracked = trackedFixture();
    if (
      !dragging && tracked?.id === id && fixture?.mode === "wander"
    ) {
      setHue(currentHue);
    }
    if (progress >= 1) lightTransitions.delete(id);
  }
  animationFrame = lightTransitions.size ? requestAnimationFrame(animateLightTargets) : undefined;
}

function startLightTransition({ id, automaticMode, hue: fromHue, targetHue, durationMs }) {
  const normalizedFrom = normalizedHue(fromHue);
  const normalizedTarget = normalizedHue(targetHue);
  const affected = fixtures.filter(item => item.id === id || item.pairLeaderId === id);
  for (const fixture of affected) {
    if (fixture.mode === "static" || (fixture.kind === "bridge" && !fixture.pairLeaderId)) continue;
    if (automaticMode) fixture.automaticMode = automaticMode;
    fixture.targetHue = normalizedTarget;
    const modeLabel = document.querySelector(`.light[data-id="${CSS.escape(fixture.id)}"] .mode-label`);
    if (modeLabel) modeLabel.textContent = fixture.automaticMode === "master" ? "Master" : "Individual";
    lightTransitions.set(fixture.id, {
      fromHue: normalizedFrom,
      distance: shortestHueDistance(normalizedFrom, normalizedTarget),
      durationMs: Math.max(0, Number(durationMs)),
      startedAt: performance.now()
    });
  }
  const tracked = trackedFixture();
  if (tracked && affected.includes(tracked)) showTarget(tracked);
  if (!animationFrame) animationFrame = requestAnimationFrame(animateLightTargets);
}

function normalizedHue(value) {
  return (Number(value) % 360 + 360) % 360;
}

function showTarget(fixture) {
  const show = fixture?.kind !== "bridge" && fixture?.mode === "wander" && Number.isFinite(Number(fixture.targetHue));
  targetPointer.classList.toggle("visible", show);
  if (!show) return;
  const targetHue = normalizedHue(fixture.targetHue);
  targetPointer.style.transform = `rotate(${targetHue - 90}deg)`;
  document.documentElement.style.setProperty("--target-accent", `hsl(${targetHue} 100% 50%)`);
}

function syncWheelToSelection(initial = false) {
  const fixture = trackedFixture();
  showTarget(fixture);
  if (!fixture || dragging) return;
  if (initial || fixture.mode === "wander") {
    setHue(fixture.hue);
  }
}

function renderDmxStatus(dmx) {
  document.querySelector("#dmx-status").textContent = dmx?.connected
    ? `DMX connected · ${dmx.outputs.join(" + ")}`
    : "DMX disconnected · reconnecting automatically. Table lights remain available.";
}

function renderEspStatus(externalMaster) {
  const connected = Boolean(externalMaster?.connected);
  espStatus.dataset.connected = String(connected);
  const labels = {
    disconnected: "ESP not detected",
    awaiting: "ESP connected · awaiting data",
    master: "ESP connected · master mode",
    wander: "ESP connected · wandering mode"
  };
  espStatusText.textContent = labels[externalMaster?.mode] ?? labels.disconnected;
  espStatus.title = connected && externalMaster.port ? `Serial port: ${externalMaster.port}` : "";
}

async function refreshEspStatus() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) return;
    const latestState = await response.json();
    const { externalMaster, dmx, fixtures: latest } = latestState;
    renderMusic(latestState.music, latest);
    renderEspStatus(externalMaster);
    renderDmxStatus(dmx);
    if (!staticUpdateRunning && !staticUpdatePending && !dragging) {
      for (const current of latest.filter(fixture => fixture.kind !== "bridge" && fixture.mode === "wander")) {
        const local = fixtures.find(fixture => fixture.id === current.id);
        if (local) Object.assign(local, current);
        startLightTransition(current);
      }
    }
    if (!staticUpdateRunning && !staticUpdatePending && !dragging) {
      const previous = fixtures.find(fixture => fixture.kind === "bridge");
      const bridge = latest.find(fixture => fixture.kind === "bridge");
      if (JSON.stringify(previous) !== JSON.stringify(bridge)) {
        const selection = selectedIds();
        fixtures = fixtures.filter(fixture => fixture.kind !== "bridge");
        if (bridge) fixtures.push(bridge);
        renderLightsPreservingSelection(selection);
      }
    }
  } catch {
    renderEspStatus(null);
  }
}

const selectedIds = () => [...document.querySelectorAll(".light input:checked")].map(input => input.value);

function colourToHex({ red, green, blue }) {
  return `#${[red, green, blue].map(value => Number(value).toString(16).padStart(2, "0")).join("")}`;
}

function hexToColour(hex) {
  return {
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16)
  };
}

function syncCortinaColourToSelection() {
  const selected = fixtures.filter(fixture => selectedIds().includes(fixture.id));
  applyCortinaColourButton.disabled = selected.length === 0 || selected.some(fixture => fixture.kind === "bridge");
  if (selected.length) cortinaColourInput.value = colourToHex(selected[0].lightsUpColour);
}

function setHue(nextHue, send = false) {
  hue = (Math.round(nextHue) + 360) % 360;
  document.documentElement.style.setProperty("--accent", `hsl(${hue} 100% 50%)`);
  pointer.style.transform = `rotate(${hue - 90}deg)`;
  hueValue.value = `${hue}°`;
  wheel.setAttribute("aria-valuenow", hue);
  if (send && selectedIds().length) scheduleStaticUpdate();
}

function updateSelectionSummary() {
  const count = selectedIds().length;
  summary.textContent = count ? `${count} light${count === 1 ? "" : "s"} selected` : "Select a light to begin";
  wanderButton.disabled = count === 0;
  pairButton.disabled = count < 2;
  unpairButton.disabled = !fixtures.some(fixture => selectedIds().includes(fixture.id) && fixture.pairLeaderId !== null);
  selectAllButton.textContent = count === fixtures.length ? "Clear selection" : "Select all";
  syncCortinaColourToSelection();
  if (!trackedFixture()) targetPointer.classList.remove("visible");
}

function renderLights() {
  const cards = fixtures.map(fixture => {
    const label = document.createElement("label");
    label.className = "light";
    label.dataset.id = fixture.id;
    label.dataset.mode = fixture.mode;
    label.style.setProperty("--light-colour", `hsl(${fixture.hue} 100% 50%)`);
    label.style.setProperty("--light-value", "1");
    const modeText = fixture.mode === "static"
      ? "Static"
      : fixture.kind === "bridge" ? "Automatic" : fixture.automaticMode === "master" ? "Master" : "Individual";
    const pairText = fixture.pairLeaderId === null
      ? ""
      : fixture.pairLeaderId === fixture.id ? " · Pair leader" : ` · Paired to ${fixture.pairLeaderName}`;
    label.innerHTML = `<input type="checkbox" value="${fixture.id}"><span class="light-card"><span class="selection-check" aria-hidden="true">✓</span><span class="light-copy"><span class="light-name"></span><span class="light-meta"><span class="mode-label">${modeText}</span> · ${fixture.kind === "bridge" ? "All table lights" : `DMX ${fixture.address}`}<span class="pair-label"></span></span></span><i class="mode-dot" aria-label="Current colour"></i></span>`;
    label.querySelector(".light-name").textContent = fixture.name;
    label.querySelector(".pair-label").textContent = pairText;
    label.querySelector("input").addEventListener("change", () => {
      updateSelectionSummary();
      syncWheelToSelection(true);
    });
    return label;
  });
  lightsElement.replaceChildren(...cards.filter((card, index) => fixtures[index].kind !== "bridge"));
  const bridgePanel = document.querySelector("#bridge-panel");
  const bridgeCards = cards.filter((card, index) => fixtures[index].kind === "bridge");
  bridgePanel.hidden = bridgeCards.length === 0;
  document.querySelector("#bridge-lights").replaceChildren(...bridgeCards);
  updateSelectionSummary();
}

function hueFromPointer(event) {
  const bounds = wheel.getBoundingClientRect();
  const x = event.clientX - (bounds.left + bounds.width / 2);
  const y = event.clientY - (bounds.top + bounds.height / 2);
  return Math.atan2(y, x) * 180 / Math.PI + 90;
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}

async function refreshFixtures(preserveSelection = selectedIds()) {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error("Could not refresh lights");
  const latestState = await response.json();
  fixtures = latestState.fixtures;
  renderLightsPreservingSelection(preserveSelection);
  for (const fixture of fixtures) {
    if (fixture.mode === "wander") startLightTransition(fixture);
  }
  syncWheelToSelection(true);
}

function scheduleStaticUpdate() {
  staticUpdatePending = true;
  status.textContent = "Applying…";
  if (sendTimer || staticUpdateRunning) return;
  sendTimer = setTimeout(async () => {
    sendTimer = undefined;
    staticUpdateRunning = true;
    staticUpdatePending = false;
    const ids = selectedIds();
    if (!ids.length) {
      staticUpdateRunning = false;
      staticUpdatePending = false;
      return;
    }
    const requestedHue = hue;
    try {
      const result = await post("/api/static", { fixtureIds: ids, hue: requestedHue });
      for (const fixture of fixtures) {
        if (!result.updated.includes(fixture.id)) continue;
        Object.assign(fixture, { hue: requestedHue, mode: "static" });
        lightTransitions.delete(fixture.id);
      }
      syncWheelToSelection();
      renderLightsPreservingSelection(ids);
      status.textContent = "Colour held";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      staticUpdateRunning = false;
      if (staticUpdatePending) scheduleStaticUpdate();
    }
  }, 25);
}

function renderLightsPreservingSelection(ids) {
  renderLights();
  for (const input of document.querySelectorAll(".light input")) input.checked = ids.includes(input.value);
  updateSelectionSummary();
  syncWheelToSelection();
}

wheel.addEventListener("pointerdown", event => {
  dragging = true;
  wheel.setPointerCapture(event.pointerId);
  setHue(hueFromPointer(event), true);
});
wheel.addEventListener("pointermove", event => {
  if (dragging) setHue(hueFromPointer(event), true);
});
wheel.addEventListener("pointerup", () => { dragging = false; });
wheel.addEventListener("pointercancel", () => { dragging = false; });
wheel.addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
  setHue(hue + direction * (event.shiftKey ? 10 : 1), true);
});

selectAllButton.addEventListener("click", () => {
  const inputs = [...document.querySelectorAll(".light input")];
  const select = !inputs.every(input => input.checked);
  for (const input of inputs) input.checked = select;
  updateSelectionSummary();
  syncWheelToSelection(true);
});

brightnessSlider.addEventListener("input", scheduleBrightnessUpdate);

applyCortinaColourButton.addEventListener("click", async () => {
  const ids = selectedIds();
  if (!ids.length) return;
  applyCortinaColourButton.disabled = true;
  try {
    const result = await post("/api/lights-up-colour", {
      fixtureIds: ids,
      colour: hexToColour(cortinaColourInput.value)
    });
    for (const fixture of fixtures) {
      if (result.updated.includes(fixture.id)) fixture.lightsUpColour = result.colour;
    }
    status.textContent = `Cortina colour saved for ${result.updated.length} light${result.updated.length === 1 ? "" : "s"}`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    syncCortinaColourToSelection();
  }
});

lightsUpButton.addEventListener("click", async () => {
  const requested = !lightsUp;
  lightsUpButton.disabled = true;
  try {
    const result = await post("/api/lights", { up: requested });
    displayLightsUp(result.up);
    status.textContent = result.up ? "Lights raised" : "Normal colours resumed";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    lightsUpButton.disabled = false;
  }
});

pairButton.addEventListener("click", async () => {
  const ids = selectedIds();
  try {
    status.textContent = "Pairing…";
    await post("/api/pair", { fixtureIds: ids });
    await refreshFixtures(ids);
    status.textContent = "Lights paired";
  } catch (error) {
    status.textContent = error.message;
  }
});

unpairButton.addEventListener("click", async () => {
  const ids = selectedIds();
  try {
    status.textContent = "Unpairing…";
    await post("/api/unpair", { fixtureIds: ids });
    await refreshFixtures(ids);
    status.textContent = "Selected lights unpaired";
  } catch (error) {
    status.textContent = error.message;
  }
});

wanderButton.addEventListener("click", async () => {
  const ids = selectedIds();
  try {
    status.textContent = "Resuming…";
    const result = await post("/api/wander", { fixtureIds: ids });
    for (const fixture of fixtures) if (ids.includes(fixture.id)) fixture.mode = "wander";
    const stateResponse = await fetch("/api/state");
    if (stateResponse.ok) {
      const latestState = await stateResponse.json();
      for (const latest of latestState.fixtures.filter(fixture => result.updated.includes(fixture.id))) {
        const fixture = fixtures.find(item => item.id === latest.id);
        Object.assign(fixture, latest);
        startLightTransition(latest);
      }
    }
    renderLightsPreservingSelection(ids);
    syncWheelToSelection(true);
    status.textContent = "Wandering resumed";
  } catch (error) {
    status.textContent = error.message;
  }
});

try {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error("Could not load lights");
  const initialState = await response.json();
  ({ fixtures } = initialState);
  displayBrightness(initialState.masterBrightness);
  displayLightsUp(initialState.lightsUp);
  renderEspStatus(initialState.externalMaster);
  renderDmxStatus(initialState.dmx);
  renderLights();
  renderMusic(initialState.music, initialState.fixtures);
  for (const fixture of fixtures) {
    if (fixture.mode === "wander") startLightTransition({
      id: fixture.id,
      hue: fixture.hue,
      targetHue: fixture.targetHue,
      durationMs: fixture.durationMs
    });
  }
  const events = new EventSource("/api/events");
  events.addEventListener("transition", event => startLightTransition(JSON.parse(event.data)));
  events.addEventListener("lights-up", event => displayLightsUp(JSON.parse(event.data).up));
  setHue(fixtures[0]?.hue ?? 0);
  setInterval(refreshEspStatus, 1000);
} catch (error) {
  lightsElement.textContent = error.message;
  status.textContent = "Controller unavailable";
}
