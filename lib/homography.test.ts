import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type Coordinate,
  applyHomography,
  mapCalibratedPoint,
  solveHomography,
} from './homography.ts';

/**
 * Camera space to room space.
 *
 * The operator stands on four projected markers and the room solves the
 * projective transform between what the camera saw and where the projector
 * painted. Everything downstream — where a trace is drawn, where a line of text
 * lands, which side a voice comes from — is in the space this produces, so an
 * error here is invisible in the arithmetic and obvious on the wall.
 */

const UNIT: Coordinate[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

function close(actual: number, expected: number, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  );
}

void test('the identity mapping leaves every point where it was', () => {
  const matrix = solveHomography(UNIT, UNIT);
  for (const point of [{ x: 0.2, y: 0.7 }, { x: 0.5, y: 0.5 }, { x: 0.93, y: 0.04 }]) {
    const mapped = applyHomography(point, matrix);
    close(mapped.x, point.x);
    close(mapped.y, point.y);
  }
});

void test('the four calibration points land exactly on their markers', () => {
  // The one property the operator can actually verify by standing on them.
  const target: Coordinate[] = [
    { x: 0.1, y: 0.2 },
    { x: 0.9, y: 0.08 },
    { x: 0.96, y: 0.88 },
    { x: 0.04, y: 0.8 },
  ];
  const matrix = solveHomography(UNIT, target);
  for (let index = 0; index < 4; index += 1) {
    const mapped = applyHomography(UNIT[index], matrix);
    close(mapped.x, target[index].x, 1e-9);
    close(mapped.y, target[index].y, 1e-9);
  }
});

void test('a keystoned projection is a projective transform, not an affine one', () => {
  // A projector aimed off-axis makes one edge of the image wider than the
  // other, which is exactly what an affine fit cannot express. Here the narrow
  // edge is at y=0, so it is the far one: equal steps across the room compress
  // toward it, and the centre of the room must land nearer to it than halfway.
  // An affine transform would put it at exactly 0.5, which is the failure this
  // catches.
  const keystoned: Coordinate[] = [
    { x: 0.2, y: 0 },
    { x: 0.8, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const matrix = solveHomography(UNIT, keystoned);
  const middle = applyHomography({ x: 0.5, y: 0.5 }, matrix);
  close(middle.x, 0.5, 1e-9);
  assert.ok(middle.y < 0.5, `the centre must be drawn toward the far edge, got ${middle.y}`);
  // And the compression is real rather than a rounding wobble.
  assert.ok(0.5 - middle.y > 0.05, `too little foreshortening to be a perspective map: ${middle.y}`);
});

void test('extra fields on a point survive the mapping', () => {
  // Tracks and path points carry ids and timestamps through this.
  const matrix = solveHomography(UNIT, UNIT);
  const mapped = applyHomography({ x: 0.3, y: 0.4, t: 1234, id: 'track-7' }, matrix);
  assert.equal(mapped.t, 1234);
  assert.equal(mapped.id, 'track-7');
});

void test('an uncalibrated room passes points straight through', () => {
  // Four identical markers cannot define a transform. The failure must be the
  // room behaving as though it were never calibrated, not a throw inside the
  // sensing loop that takes the installation down.
  const degenerate: Coordinate[] = [
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.5 },
  ];
  assert.throws(() => solveHomography(degenerate, UNIT), /degenerate/);
  const point = { x: 0.31, y: 0.62 };
  assert.deepEqual(mapCalibratedPoint(point, degenerate, UNIT), point);
});

void test('three markers are refused rather than half-solved', () => {
  assert.throws(() => solveHomography(UNIT.slice(0, 3), UNIT), /exactly four/);
  const point = { x: 0.4, y: 0.4 };
  assert.deepEqual(mapCalibratedPoint(point, UNIT.slice(0, 3), UNIT), point);
});

void test('a point on the horizon is returned unchanged rather than as infinity', () => {
  // Where the denominator vanishes the projective map has no finite answer.
  // Returning the point is wrong by a known amount; returning Infinity would
  // put a body at the edge of the room and poison the memory field.
  const horizon = applyHomography({ x: 1, y: 0 }, [1, 0, 0, 0, 1, 0, -1, 0, 1]);
  assert.equal(horizon.x, 1);
  assert.equal(horizon.y, 0);
  assert.ok(Number.isFinite(horizon.x) && Number.isFinite(horizon.y));
});

void test('calibration survives a marker order that needs pivoting', () => {
  // Gaussian elimination picks its pivot by magnitude. A marker set whose first
  // row starts at zero exercises the swap, and a silently wrong solve here
  // would misplace every trace in the room.
  const source: Coordinate[] = [
    { x: 0, y: 0 },
    { x: 0.9, y: 0.1 },
    { x: 0.85, y: 0.95 },
    { x: 0.05, y: 0.9 },
  ];
  const target: Coordinate[] = [
    { x: 0.02, y: 0.03 },
    { x: 0.97, y: 0.01 },
    { x: 0.99, y: 0.99 },
    { x: 0.01, y: 0.98 },
  ];
  const matrix = solveHomography(source, target);
  for (let index = 0; index < 4; index += 1) {
    const mapped = applyHomography(source[index], matrix);
    close(mapped.x, target[index].x, 1e-8);
    close(mapped.y, target[index].y, 1e-8);
  }
});
