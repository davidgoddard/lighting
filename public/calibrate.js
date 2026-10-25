const LEAD_SECONDS = 0.15;
const INTERVAL_SECONDS = 5;
const delay = document.querySelector("#delay");
const delayValue = document.querySelector("#delay-value");
const delayDirection = document.querySelector("#delay-direction");
const toggle = document.querySelector("#toggle");
const status = document.querySelector("#status");

let audioContext;
let running = false;
let scheduler;
let nextClickAt = 0;
let saveTimer;
const scheduledOscillators = new Set();

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}

function showDelay() {
  const milliseconds = Number(delay.value);
  delayValue.value = `${(milliseconds / 1000).toFixed(2)} s`;
  delayDirection.textContent = milliseconds === 0 ? "No added delay" : "Lights later";
}

function saveDelay() {
  showDelay();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await post("/api/music", { avDelayMs: Number(delay.value) });
      status.textContent = running ? "Click track running · delay saved" : "Delay saved";
    } catch (error) {
      status.textContent = error.message;
    }
  }, 100);
}

function scheduleClick(at) {
  const oscillator = new OscillatorNode(audioContext, { type: "sine", frequency: 880 });
  const gain = new GainNode(audioContext, { gain: 0.0001 });
  oscillator.connect(gain).connect(audioContext.destination);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.12, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.065);
  oscillator.start(at);
  oscillator.stop(at + 0.07);
  scheduledOscillators.add(oscillator);
  oscillator.addEventListener("ended", () => scheduledOscillators.delete(oscillator), { once: true });
}

async function queueClick() {
  if (!running) return;
  const now = audioContext.currentTime;
  while (nextClickAt < now + LEAD_SECONDS + 0.1) {
    const secondsUntilClick = Math.max(0, nextClickAt - now);
    scheduleClick(nextClickAt);
    void post("/api/calibration/pulse", {
      leadMs: secondsUntilClick * 1000,
      delayMs: Number(delay.value)
    }).catch(error => {
      status.textContent = error.message;
    });
    nextClickAt += INTERVAL_SECONDS;
  }
}

async function start() {
  audioContext ??= new AudioContext({ latencyHint: "playback" });
  await audioContext.resume();
  await post("/api/calibration", { active: true });
  running = true;
  nextClickAt = audioContext.currentTime + LEAD_SECONDS;
  await queueClick();
  scheduler = setInterval(queueClick, 250);
  toggle.textContent = "Stop click track";
  toggle.dataset.running = "true";
  status.textContent = "Click track running";
}

async function stop() {
  running = false;
  clearInterval(scheduler);
  for (const oscillator of scheduledOscillators) {
    try { oscillator.stop(); } catch { /* It may already have ended. */ }
  }
  scheduledOscillators.clear();
  await post("/api/calibration", { active: false });
  toggle.textContent = "Start click track";
  delete toggle.dataset.running;
  status.textContent = "Stopped";
}

toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  try { if (running) await stop(); else await start(); }
  catch (error) { status.textContent = error.message; }
  finally { toggle.disabled = false; }
});
delay.addEventListener("input", saveDelay);
window.addEventListener("pagehide", () => {
  if (running) navigator.sendBeacon("/api/calibration", new Blob([JSON.stringify({ active: false })], { type: "application/json" }));
});

try {
  const response = await fetch("/api/state");
  const state = await response.json();
  delay.value = String(state.music.config.avDelayMs);
  showDelay();
} catch (error) {
  status.textContent = error.message;
}
