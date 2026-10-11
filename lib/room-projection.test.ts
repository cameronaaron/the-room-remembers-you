import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCameraPoint, mapRoomPoint } from './room-projection.ts';
import { DEFAULT_CONFIG, type RoomConfig } from './room-types.ts';

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`);

void test('an unrotated camera leaves a point where it found it', () => {
  const point = { x: 0.2, y: 0.7 };
  assert.deepEqual(mapCameraPoint(point, 0), point);
});

void test('every quarter turn is the rotation it claims to be', () => {
  // A corner, which is the only point that distinguishes a rotation from a
  // flip: mirroring the frame maps the centre to itself just as a turn does.
  const topLeft = { x: 0, y: 0 };
  assert.deepEqual(mapCameraPoint(topLeft, 90), { x: 1, y: 0 });
  assert.deepEqual(mapCameraPoint(topLeft, 180), { x: 1, y: 1 });
  assert.deepEqual(mapCameraPoint(topLeft, 270), { x: 0, y: 1 });
});

void test('four quarter turns return a point to itself', () => {
  // The property, rather than four remembered pairs: a rotation that is
  // secretly a reflection passes the corner test above in isolation and fails
  // here, because reflecting twice is the identity and would come back early.
  for (const start of [{ x: 0.13, y: 0.42 }, { x: 0.9, y: 0.05 }, { x: 0.5, y: 0.5 }]) {
    let point = start;
    for (let turn = 0; turn < 4; turn += 1) point = mapCameraPoint(point, 90);
    near(point.x, start.x, 'x after four turns');
    near(point.y, start.y, 'y after four turns');
  }
});

void test('a quarter turn is not its own inverse', () => {
  const point = { x: 0.13, y: 0.42 };
  const once = mapCameraPoint(point, 90);
  assert.notDeepEqual(mapCameraPoint(once, 90), point);
  // But two quarter turns are a half turn.
  assert.deepEqual(mapCameraPoint(once, 90), mapCameraPoint(point, 180));
});

void test('rotation carries a point\'s other fields with it', () => {
  // Path points carry a timestamp. A rotation that rebuilt the point from x and
  // y alone would silently drop it, and a path with no time is not a path.
  const traced = { x: 0.2, y: 0.4, t: 1_234 };
  assert.equal(mapCameraPoint(traced, 90).t, 1_234);
  assert.equal(mapCameraPoint(traced, 0).t, 1_234);
});

void test('rotation copies rather than moves the point it was given', () => {
  const point = { x: 0.2, y: 0.4 };
  const turned = mapCameraPoint(point, 270);
  assert.notEqual(turned, point, 'the same object came back');
  assert.deepEqual(point, { x: 0.2, y: 0.4 }, 'the original was mutated');
});

const upright: RoomConfig = { ...DEFAULT_CONFIG, cameraRotation: 0 };

void test('an uncalibrated upright room is a straight pass-through', () => {
  // The default calibration is the identity quad, so nothing should move at
  // all: a room nobody has calibrated must still answer where people are.
  for (const point of [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.5 }, { x: 0.87, y: 0.2 }]) {
    const mapped = mapRoomPoint(point, upright);
    near(mapped.x, point.x, 'x through an identity calibration');
    near(mapped.y, point.y, 'y through an identity calibration');
  }
});

void test('the room mapping rotates before it calibrates, not after', () => {
  // Not commutative, and the order is not arbitrary: the calibration quad is
  // captured in upright camera space, so calibrating first would push every
  // point through a homography fitted to a frame that no longer exists. A
  // deliberately lopsided target makes the two orders disagree.
  const config: RoomConfig = {
    ...DEFAULT_CONFIG,
    cameraRotation: 90,
    spatialCalibration: {
      ...DEFAULT_CONFIG.spatialCalibration,
      source: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      target: [{ x: 0.1, y: 0.05 }, { x: 0.95, y: 0.2 }, { x: 0.8, y: 0.9 }, { x: 0.2, y: 0.75 }],
      calibratedAt: 1,
    },
  };
  const point = { x: 0.3, y: 0.8 };
  const rotatedFirst = mapRoomPoint(point, config);
  // Rotating a point that has already been calibrated — the wrong order.
  const calibratedFirst = mapCameraPoint(mapRoomPoint(point, { ...config, cameraRotation: 0 }), 90);
  assert.notDeepEqual(rotatedFirst, calibratedFirst);
  // And the right order agrees with doing the two steps by hand.
  const byHand = mapRoomPoint(mapCameraPoint(point, 90), { ...config, cameraRotation: 0 });
  near(rotatedFirst.x, byHand.x, 'x');
  near(rotatedFirst.y, byHand.y, 'y');
});

void test('a calibrated room sends the source quad onto the target quad', () => {
  const target = [{ x: 0.12, y: 0.08 }, { x: 0.88, y: 0.14 }, { x: 0.82, y: 0.93 }, { x: 0.18, y: 0.86 }];
  const source = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const config: RoomConfig = {
    ...DEFAULT_CONFIG,
    cameraRotation: 0,
    spatialCalibration: { ...DEFAULT_CONFIG.spatialCalibration, source, target, calibratedAt: 1 },
  };
  source.forEach((corner, index) => {
    const mapped = mapRoomPoint(corner, config);
    near(mapped.x, target[index].x, `corner ${index} x`);
    near(mapped.y, target[index].y, `corner ${index} y`);
  });
});
