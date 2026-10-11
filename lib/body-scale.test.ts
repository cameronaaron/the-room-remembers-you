import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_BODY_CELLS,
  MIN_SCALE_SAMPLES,
  SCALE_WINDOW_MS,
  BodyScale,
} from './body-scale.ts';

function feed(scale: BodyScale, cells: number, times: number, now = 0, step = 42) {
  for (let index = 0; index < times; index += 1) {
    scale.observe([cells], now + index * step);
  }
}

void test('nothing is claimed about body size before there is evidence for it', () => {
  const scale = new BodyScale();
  assert.equal(scale.cellsPerBody(), null);
  feed(scale, 7, MIN_SCALE_SAMPLES - 1);
  assert.equal(scale.cellsPerBody(), null, 'still short of the evidence bar');
  feed(scale, 7, 1, MIN_SCALE_SAMPLES * 42);
  assert.equal(scale.calibrated, true);
});

void test('the scale follows the camera rather than a constant', () => {
  // The same code, two installations. A gallery camera looking across a room
  // and a webcam at desk range disagree about body size by a factor of eight,
  // which is exactly what a hardcoded figure cannot express.
  const gallery = new BodyScale();
  feed(gallery, 7, 40);
  assert.equal(gallery.cellsPerBody(), 7);

  const desk = new BodyScale();
  feed(desk, 300, 40);
  assert.equal(desk.cellsPerBody(), 300);
});

void test('a body that briefly fragments cannot drag the estimate down', () => {
  // The case the median is here for. A visitor splits into scraps for a moment;
  // if those scraps set the scale, the bound would then permit the over-count
  // it exists to prevent.
  const scale = new BodyScale();
  feed(scale, 40, 100);
  for (let index = 0; index < 12; index += 1) scale.observe([3, 3, 4], 100 * 42 + index * 42);
  assert.equal(scale.cellsPerBody(), 40, 'a minority of samples must not move a median');
});

void test('two visitors who touch cannot drag the estimate up', () => {
  // The opposite minority, with the opposite consequence: a scale that is too
  // large tightens the bound and starts deleting people.
  const scale = new BodyScale();
  feed(scale, 8, 100);
  for (let index = 0; index < 10; index += 1) scale.observe([19], 100 * 42 + index * 42);
  assert.equal(scale.cellsPerBody(), 8);
});

void test('the estimate follows a camera that is re-aimed mid-exhibition', () => {
  const scale = new BodyScale();
  feed(scale, 300, 60);
  assert.equal(scale.cellsPerBody(), 300);
  // The camera is moved back. Everything older than the window stops counting.
  feed(scale, 7, 60, SCALE_WINDOW_MS + 1000);
  assert.equal(scale.cellsPerBody(), 7);
});

void test('an estimate below the detector\'s own minimum region is measuring noise', () => {
  const scale = new BodyScale();
  feed(scale, 1, 60);
  assert.equal(scale.cellsPerBody(), null, 'samples under the floor are not observations');
  const mixed = new BodyScale();
  feed(mixed, MIN_BODY_CELLS, 60);
  assert.ok((mixed.cellsPerBody() ?? 0) >= MIN_BODY_CELLS);
});

void test('retention is bounded however long the installation runs', () => {
  const scale = new BodyScale();
  for (let index = 0; index < 5000; index += 1) scale.observe([7, 8, 9], index * 42);
  assert.ok(scale.sampleCount <= 600, `held ${scale.sampleCount} samples`);
});

void test('a reset leaves the room with no assumption about body size', () => {
  const scale = new BodyScale();
  feed(scale, 7, 60);
  scale.reset();
  assert.equal(scale.cellsPerBody(), null);
});
