import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceCalibration, CALIBRATION_MARKERS, isUsableQuad } from './calibration-flow.ts';
import { CALIBRATION_TARGETS } from './room-projection.ts';

void test('there is one step per marker on the wall', () => {
  // The flow and the quad it fills have to agree. A fifth target with a
  // four-step walk silently pairs the corners against the wrong points.
  assert.equal(CALIBRATION_MARKERS, CALIBRATION_TARGETS.length);
  assert.equal(CALIBRATION_MARKERS, 4);
});

void test('nothing happens when no calibration is running', () => {
  assert.equal(advanceCalibration(null, true), null);
  assert.equal(advanceCalibration(null, false), null);
});

void test('step zero is a real step, not an absent one', () => {
  // The bug the null check exists to avoid: `if (!step)` treats the first
  // marker as "not calibrating" and the walk can never begin.
  const action = advanceCalibration(0, true);
  assert.equal(action?.kind, 'advance');
});

void test('an empty marker does not advance the walk', () => {
  // Advancing here leaves the quad a corner short while the operator believes
  // they captured it, and the homography is then fitted to three real points
  // and one that belongs to a different marker.
  for (let step = 0; step < CALIBRATION_MARKERS; step += 1) {
    const action = advanceCalibration(step, false);
    assert.equal(action?.kind, 'needs-body', `step ${step} advanced with nobody on the marker`);
    assert.match(action!.message, /visible body/);
  }
});

void test('the walk visits every marker before it completes', () => {
  // Finishing early is the quiet failure: a partial quad still solves, and the
  // result is a mapping that is wrong everywhere by a little.
  const visited: number[] = [];
  let step = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const action = advanceCalibration(step, true);
    assert.ok(action);
    if (action.kind === 'complete') break;
    assert.equal(action.kind, 'advance');
    step = (action as { step: number }).step;
    visited.push(step);
  }
  assert.deepEqual(visited, [1, 2, 3], 'the walk skipped or repeated a marker');
});

void test('the last marker completes rather than advancing past the quad', () => {
  const action = advanceCalibration(CALIBRATION_MARKERS - 1, true);
  assert.equal(action?.kind, 'complete');
  assert.match(action!.message, /aligned/);
});

void test('markers are counted from one, the way they are described out loud', () => {
  // Off by one here sends somebody to stand on the wrong spot, and the mapping
  // that results is wrong without ever looking broken.
  assert.match(advanceCalibration(0, true)!.message, /marker 2/);
  assert.match(advanceCalibration(1, true)!.message, /marker 3/);
  assert.match(advanceCalibration(2, true)!.message, /marker 4/);
});

const quad = (...points: Array<[number, number]>) => points.map(([x, y]) => ({ x, y }));

void test('four distinct corners are usable', () => {
  assert.equal(isUsableQuad(quad([0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9])), true);
  assert.equal(isUsableQuad(CALIBRATION_TARGETS), true);
});

void test('a quad of the wrong size is refused', () => {
  assert.equal(isUsableQuad([]), false);
  assert.equal(isUsableQuad(quad([0.1, 0.1], [0.9, 0.1], [0.9, 0.9])), false);
  assert.equal(isUsableQuad(quad([0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5])), false);
});

void test('an operator who never moved is refused', () => {
  // Four captures from one spot is a degenerate quad, and the solver answers
  // with a mapping rather than an error.
  assert.equal(isUsableQuad(quad([0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5])), false);
  assert.equal(isUsableQuad(quad([0.1, 0.1], [0.9, 0.1], [0.1, 0.1], [0.1, 0.9])), false);
});

void test('a corner that is not a finite point is refused', () => {
  assert.equal(isUsableQuad(quad([Number.NaN, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9])), false);
  assert.equal(isUsableQuad(quad([0.1, Number.POSITIVE_INFINITY], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9])), false);
});
