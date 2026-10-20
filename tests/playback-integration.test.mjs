import test from "node:test";
import assert from "node:assert/strict";
import { PlaybackCoordinator } from "../playback-integration.js";

const event = (overrides = {}) => ({ schemaVersion: 1, event: "playback", sessionId: "one", sequence: 0,
  kind: "tango", state: "playing", path: "/music/test.mp3", positionSeconds: 5, durationSeconds: 100,
  playbackRate: 1, sentAtUnixMs: 1, ...overrides });

test("one analysis runs per session and stale/out-of-order messages are ignored", async () => {
  let now = 1000, calls = 0, resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const coordinator = new PlaybackCoordinator({ now: () => now, analyse: async () => { calls += 1; return first; } });
  assert.equal(coordinator.receive(event()), true);
  assert.equal(coordinator.receive(event()), false);
  assert.equal(coordinator.receive(event({ sequence: 1, positionSeconds: 6 })), true);
  assert.equal(calls, 1);
  resolveFirst({ duration: 100, steps: [] }); await first; await new Promise(resolve => setImmediate(resolve));
  assert.equal(coordinator.snapshot.status, "READY");
  now = 2000; assert.equal(coordinator.position(now), 7);
});

test("pause freezes the clock and a new session rejects a stale profile", async () => {
  let now = 1000, resolvers = [];
  const coordinator = new PlaybackCoordinator({ now: () => now, analyse: () => new Promise(resolve => resolvers.push(resolve)) });
  coordinator.receive(event()); coordinator.receive(event({ sessionId: "two", sequence: 0, positionSeconds: 20 }));
  resolvers[0]({ duration: 100, steps: [{ time: 0 }] }); await Promise.resolve();
  assert.equal(coordinator.snapshot.profile, null);
  coordinator.receive(event({ sessionId: "two", sequence: 1, state: "paused", positionSeconds: 22 }));
  now = 5000; assert.equal(coordinator.position(now), 22);
});
