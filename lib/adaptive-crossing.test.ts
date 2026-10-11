import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCollisions, projectedBodyRadius, distanceToSegment } from './memory-disturbance.ts';
import type { Ghost, VisitorTrack, Point } from './room-types.ts';
const p = (x: number, y: number): Point => ({ x, y, t: 0 });
const identity = (point: Point) => point;
const visitor = (width: number): VisitorTrack => ({ id: 'a', previous: p(0.3, 0.5), position: p(0.49, 0.5), extent: { width, height: width * 2 }, sightings: 2, occluded: false } as VisitorTrack);
const ghost = { id: 'old', createdAt: 0, path: [p(0.5, 0.1), p(0.5, 0.9)] } as Ghost;
void test('body tolerance follows measured size and both projected axes', () => {
  for (const width of [0.01, 0.04, 0.1, 0.4]) {
    assert.ok(Math.abs(projectedBodyRadius(visitor(width), identity) - width / 2) < 1e-12);
    assert.ok(Math.abs(projectedBodyRadius(visitor(width), point => ({ x: point.x * 3, y: point.y / 4 })) - width / 4) < 1e-12);
  }
  assert.equal(projectedBodyRadius({ ...visitor(1), extent: undefined } as unknown as VisitorTrack, identity), 0);
  for (const width of [0, -1, Infinity, NaN]) assert.equal(projectedBodyRadius(visitor(width), identity), 0);
  for (const height of [0, -1, Infinity, NaN]) assert.equal(projectedBodyRadius({ ...visitor(1), extent: { width: 1, height } }, identity), 0);
  assert.equal(projectedBodyRadius(visitor(1), () => ({ x: NaN, y: 0 })), 0);
});
void test('the same scaled walk crosses at every camera scale and sample rate', () => {
  for (const scale of [0.2, 1, 3]) for (const hz of [10, 15, 24, 60, 240]) {
    const collision = new MemoryCollisions();
    const project = (point: Point) => ({ x: point.x * scale, y: point.y * scale });
    const history = { ...ghost, path: ghost.path.map(point => ({ ...point, ...project(point) })) };
    let hit = false;
    for (let frame = 1; frame <= hz * 2; frame++) {
      const track = { ...visitor(0.08), previous: p(0.3 + (frame - 1) / (hz * 10), 0.5), position: p(0.3 + frame / (hz * 10), 0.5) };
      hit ||= collision.find([track], [history], 30000 + frame * 1000 / hz, project) !== null;
    }
    assert.ok(hit, `scale ${scale}, hz ${hz}`);
  }
});
void test('jitter does not awaken a path and anchors retire after occlusion or reset', () => {
  const collision = new MemoryCollisions();
  const track = { ...visitor(0.08), previous: p(0.4599, 0.5), position: p(0.4601, 0.5) };
  for (let i = 0; i < 100; i++) assert.equal(collision.find([track], [ghost], 30000 + i, identity), null);
  collision.find([{ ...track, occluded: true }], [ghost], 31000, identity);
  assert.ok(collision.find([{ ...visitor(0.08), previous: p(0.4, 0.5) }], [ghost], 32000, identity));
  collision.clear();
  assert.ok(collision.find([visitor(0.08)], [ghost], 32001, identity));
});
void test('near misses depend on body size, not a fixed fraction of the wall', () => {
  assert.equal(new MemoryCollisions().find([visitor(0.01)], [ghost], 30000, identity), null);
  assert.ok(new MemoryCollisions().find([visitor(0.08)], [ghost], 30000, identity));
  assert.equal(distanceToSegment({ x: 2, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 1);
  assert.equal(distanceToSegment({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 1);
});
void test('segment distance handles rotations, translations and endpoints', () => {
  for (const offset of [-2, 0, 3]) {
    assert.equal(distanceToSegment(p(offset + 2, 4), p(offset + 1, 2), p(offset + 1, 6)), 1);
    assert.ok(Math.abs(distanceToSegment(p(offset + 1, 0), p(offset, 0), p(offset + 1, 1)) - Math.SQRT1_2) < 1e-12);
    assert.equal(distanceToSegment(p(offset - 1, 0), p(offset, 0), p(offset + 1, 0)), 1);
  }
});
void test('crossing an infinite extension or moving away is not entering history', () => {
  const subjects = [
    { ...visitor(0.001), previous: p(0.4, 0.95), position: p(0.6, 0.95) },
    { ...visitor(0.08), previous: p(0.48, 0.5), position: p(0.47, 0.5) },
    { ...visitor(0.001), previous: p(0.2, 0.2), position: p(0.3, 0.3) },
  ];
  for (const subject of subjects) assert.equal(new MemoryCollisions().find([subject], [ghost], 30000, identity), null);
  const result = new MemoryCollisions().find([visitor(0.08)], [ghost], 25000, identity);
  assert.equal(result?.index, 0);
  assert.equal(result?.trackId, 'a');
  assert.deepEqual(result?.at, p(0.49, 0.5));
});
void test('proximity includes its outer boundary but requires starting outside it', () => {
  const history = { ...ghost, path: [p(0.5, 0), p(0.5, 1)] };
  const subject = { ...visitor(0.25), previous: p(0.25, 0.5), position: p(0.375, 0.5) };
  assert.ok(new MemoryCollisions().find([subject], [history], 30000, identity));
  assert.equal(new MemoryCollisions().find([{ ...subject, previous: p(0.375, 0.5), position: p(0.4, 0.5) }], [history], 30000, identity), null);
});
void test('projected radius conservatively follows the nearer edge under perspective', () => {
  const subject = visitor(0.4);
  const transform = (point: Point) => ({ x: point.x, y: point.y * point.y / 10 });
  const radius = projectedBodyRadius(subject, transform);
  assert.ok(Math.abs(radius - 0.024) < 1e-12);
});
void test('pending movement is forgotten on reset, disappearance and occlusion', () => {
  for (const cleanup of ['reset', 'gone', 'occluded'] as const) {
    const collisions = new MemoryCollisions();
    const track = { ...visitor(0.25), previous: p(0.37, 0.5), position: p(0.374, 0.5) };
    assert.equal(collisions.find([track], [ghost], 30000, identity), null);
    if (cleanup === 'reset') collisions.clear();
    if (cleanup === 'gone') collisions.find([], [ghost], 30001, identity);
    if (cleanup === 'occluded') collisions.find([{ ...track, occluded: true }], [ghost], 30001, identity);
    assert.equal(collisions.find([{ ...track, previous: p(0.374, 0.5), position: p(0.378, 0.5) }], [ghost], 30002, identity), null, cleanup);
  }
});
void test('leaving history without a measured footprint does not count as crossing it', () => {
  const subject = { ...visitor(0), previous: p(0.5, 0.5), position: p(0.6, 0.5) };
  assert.equal(new MemoryCollisions().find([subject], [ghost], 30000, identity), null);
});
void test('negative perspective slope picks the opposite projected edge', () => {
  const subject = visitor(0.4);
  const transform = (point: Point) => ({ x: point.x, y: (1 - point.y) ** 2 / 10 });
  assert.ok(Math.abs(projectedBodyRadius(subject, transform) - 0.024) < 1e-12);
});
void test('diagonal segments keep their geometry away from the origin', () => {
  assert.ok(Math.abs(distanceToSegment(p(2, 1), p(1, 1), p(2, 2)) - Math.SQRT1_2) < 1e-12);
  const history = { ...ghost, path: [p(0.2, 0.2), p(0.8, 0.8)] };
  const subject = { ...visitor(0), previous: p(0.4, 0.6), position: p(0.6, 0.4) };
  assert.ok(new MemoryCollisions().find([subject], [history], 30000, identity));
  assert.equal(projectedBodyRadius({ ...visitor(0.1), extent: { width: -0.1, height: 0.2 } }, identity), 0);
});
