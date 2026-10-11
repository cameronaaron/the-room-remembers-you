import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CROSSING_COOLDOWN_MS,
  MEMORY_REST_MS,
  MEMORY_RIPENS_MS,
  MemoryCollisions,
  disturbanceFrame,
  memoryLoss,
} from './memory-disturbance.ts';
import type { Ghost, VisitorTrack } from './room-types.ts';

const point = (x: number, y: number) => ({ x, y, t: 0 });
const ghost = { id: 'old', createdAt: 0, fidelity: 1, path: [point(0.5, 0.2), point(0.5, 0.8)] } as Ghost;
const track = { previous: point(0.4, 0.5), position: point(0.6, 0.5), sightings: 3, occluded: false } as VisitorTrack;
const project = (p: { x: number; y: number }) => p;

void test('a crossing awakens history with global and per-memory cooldowns', () => {
  const first = MEMORY_RIPENS_MS + 5000;
  const collisions = new MemoryCollisions();
  assert.equal(collisions.find([track], [ghost], first, project)?.ghost.id, 'old');
  assert.equal(collisions.find([track], [ghost], first + 1000, project), null);
  assert.equal(collisions.find([track], [ghost], first + CROSSING_COOLDOWN_MS - 1, project), null);
  // The global wait has passed, but this particular path is still resting, so
  // the only memory on offer stays silent.
  assert.equal(collisions.find([track], [ghost], first + CROSSING_COOLDOWN_MS, project), null);
  assert.ok(collisions.find([track], [ghost], first + MEMORY_REST_MS, project));
});

void test('one memory rests longer than the room waits, or its rest never binds', () => {
  // Below the global wait this gate is unreachable and the same path could be
  // shown to a visitor over and over.
  assert.ok(MEMORY_REST_MS > CROSSING_COOLDOWN_MS);
  const collisions = new MemoryCollisions();
  const other = { ...ghost, id: 'other' } as Ghost;
  const first = MEMORY_RIPENS_MS + 5000;
  assert.equal(collisions.find([track], [ghost, other], first, project)?.ghost.id, 'old');
  // A second path is available once the room's own wait expires.
  assert.equal(
    collisions.find([track], [ghost, other], first + CROSSING_COOLDOWN_MS, project)?.ghost.id,
    'other',
  );
});

void test('stationary, distant, unconfirmed and recent paths do not cause recalls', () => {
  for (const subject of [
    { ...track, previous: track.position },
    { ...track, previous: point(0.1, 0.1), position: point(0.2, 0.1) },
    { ...track, sightings: 1 },
    { ...track, occluded: true },
  ]) assert.equal(new MemoryCollisions().find([subject], [ghost], 30000, project), null);
  assert.equal(new MemoryCollisions().find([track], [{ ...ghost, createdAt: 1 }], MEMORY_RIPENS_MS, project), null);
});

void test('crossings use projected coordinates and reset forgets cooldowns', () => {
  const collisions = new MemoryCollisions();
  assert.equal(collisions.find([track], [ghost], 30000, p => ({ x: p.x * 0.2, y: p.y })), null);
  assert.ok(collisions.find([track], [ghost], 30000, project));
  collisions.clear();
  assert.ok(collisions.find([track], [ghost], 30001, project));
});

void test('fresh memories remain faithful; old ones veer and end before completion', () => {
  const original = structuredClone(ghost.path);
  const fresh = memoryLoss(10000, 1, 20000);
  assert.equal(fresh, 0);
  assert.deepEqual(disturbanceFrame(ghost.path, 0.6, fresh).path, original);
  const loss = memoryLoss(0, 1, 7 * 3600000);
  assert.equal(loss, 1);
  assert.deepEqual(disturbanceFrame(ghost.path, 0.1, loss).path, original);
  const wrong = disturbanceFrame(ghost.path, 0.45, loss);
  assert.notDeepEqual(wrong.path, original);
  assert.ok(wrong.end < 0.7);
  assert.equal(disturbanceFrame(ghost.path, 0.7, loss).fade, 0);
  assert.deepEqual(ghost.path, original);
  assert.ok(wrong.path.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
});

void test('cooldowns are discarded with the memories they belong to', () => {
  const collisions = new MemoryCollisions();
  const archive: Ghost[] = [];
  let recalls = 0;
  // A gallery day forgets its oldest paths continuously. Cooldowns keyed by
  // memory leak unless they are dropped with the memory itself.
  // Step by the room's own wait so the sweep keeps exercising recall whatever
  // the cooldown is tuned to, rather than silently degrading into a few hits.
  let clock = MEMORY_RIPENS_MS;
  for (let day = 0; day < 500; day++) {
    clock += CROSSING_COOLDOWN_MS;
    archive.push({ ...ghost, id: `path-${day}`, createdAt: clock - MEMORY_RIPENS_MS } as Ghost);
    if (archive.length > 20) archive.shift();
    if (collisions.find([track], archive, clock, project)) recalls++;
    assert.ok(collisions.tracked <= archive.length, 'cooldowns outlived the archive');
  }
  assert.ok(recalls > 20, `the sweep never exercised recall (${recalls})`);
  collisions.find([track], [], clock + MEMORY_REST_MS, project);
  assert.equal(collisions.tracked, 0, 'an emptied archive must leave no cooldowns');
});

void test('age loss is gradual, starts after five minutes and respects the creation epoch', () => {
  const createdAt = 9_000_000;
  assert.equal(memoryLoss(createdAt, 1, createdAt + 300000), 0);
  assert.equal(memoryLoss(createdAt, 1, createdAt + 300000 + 3 * 3600000), 0.5);
  assert.equal(memoryLoss(createdAt, 0.25, createdAt), 0.75);
  assert.equal(memoryLoss(createdAt, 2, createdAt - 1), 0);
});
void test('dissolution holds its grace period, fades continuously and drifts in both axes', () => {
  const path = [point(0.5, 0.5), point(0.5, 0.5), point(0.5, 0.5)];
  assert.equal(disturbanceFrame(path, 0.5, 0.2).end, 1);
  const halfwayFade = disturbanceFrame(path, 0.925, 0);
  assert.ok(Math.abs(halfwayFade.fade - 0.5) < 1e-12);
  const early = disturbanceFrame(path, 0.4, 0.5);
  const later = disturbanceFrame(path, 0.6, 0.5);
  assert.ok(Math.abs(early.end - 0.76) < 1e-12);
  assert.ok(later.path[1].x > early.path[1].x);
  assert.ok(later.path[1].y > early.path[1].y);
  assert.ok(later.path[0].y > early.path[0].y);
  assert.ok(Math.abs(later.path[0].y - 0.55) < 1e-12);
  assert.ok(later.path[2].x > later.path[1].x);
  assert.ok(later.path[2].y < later.path[1].y);
});
void test('global cooldown also blocks a different ripe memory', () => {
  const collisions = new MemoryCollisions();
  const other = { ...ghost, id: 'other' };
  const now = 30000;
  assert.ok(collisions.find([track], [ghost, other], now, project));
  assert.equal(collisions.find([track], [ghost, other], now + 1, project), null);
  assert.equal(collisions.find([track], [ghost, other], now + CROSSING_COOLDOWN_MS - 1, project), null);
  assert.equal(collisions.find([track], [ghost, other], now + CROSSING_COOLDOWN_MS, project)?.ghost.id, 'other');
});
