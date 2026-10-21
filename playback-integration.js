import { isAbsolute, basename } from "node:path";

const STATES = new Set(["playing", "paused", "stopped", "ended"]);

export function validatePlaybackEvent(body) {
  if (!body || body.schemaVersion !== 1 || body.event !== "playback") throw new Error("Unsupported playback event");
  if (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 160) throw new Error("Invalid sessionId");
  if (!Number.isSafeInteger(body.sequence) || body.sequence < 0) throw new Error("Invalid sequence");
  if (!STATES.has(body.state)) throw new Error("Invalid playback state");
  if (!['tango', 'cortina'].includes(body.kind)) throw new Error("Invalid playback kind");
  if (typeof body.path !== "string" || !isAbsolute(body.path) || body.path.includes("\0")) throw new Error("path must be an absolute local path");
  for (const field of ["positionSeconds", "durationSeconds", "playbackRate", "sentAtUnixMs"]) {
    if (!Number.isFinite(body[field]) || body[field] < 0) throw new Error(`Invalid ${field}`);
  }
  if (body.playbackRate > 4) throw new Error("Invalid playbackRate");
  return { ...body, title: basename(body.path) };
}

export class PlaybackCoordinator {
  constructor({ analyse, now = () => performance.now() }) {
    this.analyse = analyse; this.now = now; this.generation = 0;
    this.snapshot = { status: "NO_TRACK", sessionId: null, sequence: -1, profile: null, error: null, title: null };
  }
  receive(raw) {
    const event = validatePlaybackEvent(raw);
    if (event.sessionId === this.snapshot.sessionId && event.sequence <= this.snapshot.sequence) return false;
    const newSession = event.sessionId !== this.snapshot.sessionId;
    if (newSession) {
      this.generation += 1;
      this.snapshot = { status: event.kind === "tango" ? "ANALYSING" : "UNAVAILABLE", sessionId: event.sessionId,
        sequence: event.sequence, profile: null, error: null, title: event.title, event, receivedAt: this.now(), readyAt: null, generation: this.generation };
      if (event.kind === "tango" && event.state !== "stopped" && event.state !== "ended") this.#startAnalysis(event, this.generation);
    } else {
      this.snapshot.event = event; this.snapshot.sequence = event.sequence; this.snapshot.receivedAt = this.now();
    }
    if (event.state === "paused") this.snapshot.status = this.snapshot.profile ? "PAUSED" : this.snapshot.status;
    if (event.state === "stopped" || event.state === "ended") { this.snapshot.status = "NO_TRACK"; this.snapshot.stoppedAt = this.now(); }
    if (event.state === "playing" && this.snapshot.profile) this.snapshot.status = "READY";
    return true;
  }
  async #startAnalysis(event, generation) {
    const started = this.now();
    try {
      const profile = await this.analyse(event.path, generation);
      if (generation !== this.generation || this.snapshot.sessionId !== event.sessionId) return;
      this.snapshot.profile = Object.freeze(profile); this.snapshot.status = this.snapshot.event.state === "paused" ? "PAUSED" : "READY";
      this.snapshot.readyAt = this.now(); this.snapshot.analysisMs = this.now() - started;
      console.log(`Music analysis ready: analysisMs=${Math.round(this.snapshot.analysisMs)} duration=${profile.duration}s ` +
        `events=${profile.events?.length ?? 0} strong=${profile.strong?.length ?? 0} edges=${profile.edges?.length ?? 0}`);
    } catch (error) {
      if (generation !== this.generation) return;
      this.snapshot.status = "UNAVAILABLE"; this.snapshot.error = error instanceof Error ? error.message : String(error);
      this.snapshot.analysisMs = this.now() - started;
      console.warn(`Music analysis unavailable after ${Math.round(this.snapshot.analysisMs)}ms: ${this.snapshot.error}`);
    }
  }
  position(now = this.now(), delayMs = 0) {
    const { event, receivedAt } = this.snapshot;
    if (!event) return 0;
    const elapsed = event.state === "playing" ? Math.max(0, now - receivedAt) / 1000 * event.playbackRate : 0;
    return Math.max(0, Math.min(event.durationSeconds, event.positionSeconds + elapsed - delayMs / 1000));
  }
  activation(now = this.now(), seconds = 3) {
    if (this.snapshot.readyAt === null || this.snapshot.readyAt === undefined) return 0;
    return Math.min(1, Math.max(0, (now - this.snapshot.readyAt) / (seconds * 1000)));
  }
  release(now = this.now(), seconds = 3) {
    if (this.snapshot.stoppedAt === undefined) return 0;
    return Math.min(1, Math.max(0, 1 - (now - this.snapshot.stoppedAt) / (seconds * 1000)));
  }
  cancel() { this.generation += 1; }
}
