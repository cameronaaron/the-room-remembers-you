import assert from 'node:assert/strict';
import test from 'node:test';
import { composeRoomBodies } from './room-bodies.ts';
import { MAX_BODIES } from './swarm-frame.ts';
import { captureGhost } from './room-capture.ts';
import { createRuntimeStatus } from './room-status.ts';
import {
  SENSING_LOG_LIMIT,
  SENSING_SAMPLE_INTERVAL_MS,
  SensingLog,
  sensingSample,
} from './room-telemetry.ts';
import { DEFAULT_CONFIG, type ActiveGhost } from './room-types.ts';
import { track, ghost } from './test-doubles/room.ts';

void test('status instances and resets own separate masks and audio state', () => {
  const first = createRuntimeStatus();
  first.motion.mask[0] = 1;
  first.audio.captured = 9;
  const second = createRuntimeStatus();
  assert.equal(second.motion.mask[0], 0);
  assert.equal(second.audio.captured, 0);
  assert.equal(
    second.motion.mask.length,
    second.motion.width * second.motion.height,
  );
});

void test('body composition excludes occlusion and candidates and projects observed visitors', () => {
  const live = track({
    position: { x: 0.2, y: 0.3, t: 0 },
    stillFor: 30,
    confidence: 0.1,
  });
  const before = structuredClone(live);
  const result = composeRoomBodies(
    [track({ occluded: true }), track({ sightings: 1 }), live],
    [],
    { ...DEFAULT_CONFIG, cameraRotation: 90 },
    1000,
  );
  assert.equal(result.bodies.length, 1);
  assert.ok(Math.abs(result.bodies[0].x - 0.7) < 1e-8);
  assert.ok(Math.abs(result.bodies[0].y - 0.2) < 1e-8);
  assert.equal(result.bodies[0].stillness, 1);
  assert.equal(result.bodies[0].strength, 0.35);
  assert.deepEqual(live, before);
});

void test('recalls wait for their start, expire, and cannot displace reserved living slots', () => {
  const running: ActiveGhost = { ghost: ghost(), kind: 'ghost', startedAt: 0 };
  const future = { ...running, startedAt: 5000 };
  const expired = { ...running, startedAt: -100_000 };
  const result = composeRoomBodies(
    Array.from({ length: 20 }, () => track()),
    [future, expired, ...Array(10).fill(running)],
    DEFAULT_CONFIG,
    1000,
  );
  assert.equal(result.bodies.length, 12);
  assert.equal(result.bodies.filter((body) => body.heat === 1).length, 9);
  assert.equal(result.recalls.length, 11);
  assert.equal(result.recalls[0], future);
  assert.ok(!result.recalls.includes(expired));
});

void test('capture rejects brief tracks and records a projected copy using supplied time', () => {
  assert.equal(captureGhost(track(), [], DEFAULT_CONFIG, 2, 123), null);
  const path = Array.from({ length: 5 }, (_, i) => ({
    x: i / 5,
    y: 0.3,
    t: i * 1000,
  }));
  assert.equal(
    captureGhost(
      track({ path, dwellSeconds: 0.99 }),
      [],
      DEFAULT_CONFIG,
      2,
      123,
    ),
    null,
  );
  const visitor = track({ path });
  const before = structuredClone(visitor);
  const result = captureGhost(
    visitor,
    [],
    { ...DEFAULT_CONFIG, cameraRotation: 90 },
    2,
    123,
  )!;
  assert.equal(result.ghost.createdAt, 123);
  assert.equal(result.ghost.day, 2);
  assert.deepEqual(result.ghost.lineage, [visitor.id]);
  assert.ok(result.ghost.path.every((point) => Math.abs(point.x - 0.7) < 1e-8));
  assert.equal(result.ghost.strength, 0.48);
  assert.deepEqual(visitor, before);
  const converged = captureGhost(
    visitor,
    [result.ghost],
    { ...DEFAULT_CONFIG, cameraRotation: 90 },
    3,
    456,
  )!;
  assert.equal(converged.convergence, result.ghost);
  assert.equal(converged.ghost.strength, 0.72);
});

void test('telemetry reports counts with an explicit privacy allowlist', () => {
  const status = createRuntimeStatus();
  const sample = sensingSample(
    500.7,
    23.456,
    status.motion,
    status.audio,
    [track(), track({ occluded: true }), track({ sightings: 1 })],
    7,
    8,
    'camera',
  );
  assert.equal(sample.t, 501);
  assert.equal(sample.hz, 23.5);
  assert.equal(sample.live, 1);
  assert.equal(sample.hidden, 1);
  assert.equal(sample.candidates, 1);
  assert.equal(sample.fragmentRecoveries, 7);
  assert.equal(sample.whispersHeld, 8);
  assert.deepEqual(
    Object.keys(sample).sort(),
    [
      't',
      'hz',
      'changedPercent',
      'coveragePercent',
      'rejectedFraction',
      'candidateCells',
      'activeCells',
      'blobs',
      'live',
      'hidden',
      'fragmentRecoveries',
      'cellsPerBody',
      'candidates',
      'micLevel',
      'micThreshold',
      'whispersHeld',
      'whispersCaptured',
      'whispersReplayed',
      'audioContext',
      'state',
      'source',
    ].sort(),
  );
});

void test('the sensing log samples on its own cadence, not the sensing loop\'s', () => {
  // FULL senses twenty-four times a second. Logging every tick fills the ring
  // in two and a half minutes and describes the room no better.
  const log = new SensingLog();
  let taken = 0;
  for (let tick = 0; tick < 24 * 10; tick += 1) {
    const now = tick * (1000 / 24);
    if (log.due(now)) {
      log.mark(now);
      taken += 1;
    }
  }
  assert.equal(taken, Math.round((10 * 1000) / SENSING_SAMPLE_INTERVAL_MS));
});

void test('a fresh log holds nothing', () => {
  // Exported before anything was recorded, an initialised-with-something log
  // ships a sample describing a session that never happened.
  const log = new SensingLog();
  assert.equal(log.size, 0);
  assert.deepEqual(log.all, []);
});

void test('the first sample is due immediately, whatever the clock reads', () => {
  // A rAF-derived clock starts at zero, and an unset "last sampled at" of zero
  // cannot be told from having just sampled.
  assert.equal(new SensingLog().due(0), true);
});

void test('log timestamps are elapsed time, not page time', () => {
  // The exported file is read by `analyze-session`, which has no idea how long
  // the page had been open before recording started.
  const log = new SensingLog();
  assert.equal(log.mark(812_345), 0);
  assert.equal(log.mark(812_345 + SENSING_SAMPLE_INTERVAL_MS), SENSING_SAMPLE_INTERVAL_MS);
});

void test('the log is bounded, and keeps the end of the session', () => {
  // Half an hour at two samples a second. What an operator wants after a fault
  // is the part just before it.
  const log = new SensingLog();
  for (let index = 0; index < SENSING_LOG_LIMIT + 50; index += 1) {
    log.push(sensingSample(
      index, 24, createRuntimeStatus().motion, createRuntimeStatus().audio, [], 0, 0, 'synthetic',
    ));
  }
  assert.equal(log.size, SENSING_LOG_LIMIT);
  assert.equal(log.all[0].t, 50);
});

void test('the field is never asked to hold more bodies than it has slots for', () => {
  // `composeRoomBodies` packs living visitors and recalls into one fixed-size
  // array that the GPU reads as a uniform. Overflowing it does not throw; the
  // extra bodies are silently the ones that do not appear.
  const crowd = Array.from({ length: MAX_BODIES * 3 }, (_unused, index) =>
    track({ id: `visitor-${index}`, position: { x: index / (MAX_BODIES * 3), y: 0.5, t: 0 } }));
  const recalls: ActiveGhost[] = Array.from({ length: MAX_BODIES }, (_unused, index) => ({
    ghost: ghost({ id: `recall-${index}` }), startedAt: 0, kind: 'ghost',
  }));
  const composed = composeRoomBodies(crowd, recalls, DEFAULT_CONFIG, 1_000);
  assert.ok(composed.bodies.length <= MAX_BODIES, `${composed.bodies.length} bodies for ${MAX_BODIES} slots`);
});
