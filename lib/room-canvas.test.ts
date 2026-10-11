import assert from 'node:assert/strict';
import test from 'node:test';
import { paintMemory, unrestOffset } from './room-canvas.ts';
import { recordingContext } from './test-doubles/canvas-2d.ts';
import { createMemoryField, FIELD_HEIGHT, FIELD_WIDTH } from './memory-engine.ts';
import { paletteFor } from './palette.ts';
import { DEFAULT_CONFIG } from './room-types.ts';

const palette = paletteFor(DEFAULT_CONFIG.projectionMode);
const alphaAt = (image: { data: Uint8ClampedArray }, cell: number) => image.data[cell * 4 + 3];

/** Run paintMemory and hand back the image buffer it actually put down. */
function painted(field: Float32Array, intensity: number) {
  const context = recordingContext();
  paintMemory(context, field, intensity, palette);
  const put = context.callsTo('putImageData');
  assert.equal(put.length, 1, 'the field was not put on the surface');
  return { context, image: put[0].args[0] as { data: Uint8ClampedArray } };
}

void test('an empty field is cleared and drawn as fully transparent', () => {
  // Drawn, not skipped: the memory canvas has to be cleared even when there is
  // nothing in it, or the last frame with memory in it stays on the wall.
  const { context, image } = painted(createMemoryField(), 1);
  assert.equal(context.countOf('clearRect'), 1);
  for (let cell = 0; cell < FIELD_WIDTH * FIELD_HEIGHT; cell += 1) {
    assert.equal(alphaAt(image, cell), 0, `cell ${cell} was not transparent`);
  }
});

void test('memory becomes opacity, and colour comes from the palette', () => {
  const field = createMemoryField();
  field[0] = 0.5;
  const { image } = painted(field, 1);
  const mark = palette.marks.memoryField;
  assert.equal(image.data[0], mark.rgb[0]);
  assert.equal(image.data[1], mark.rgb[1]);
  assert.equal(image.data[2], mark.rgb[2]);
  assert.ok(alphaAt(image, 0) > 0, 'a remembered cell was invisible');
  assert.equal(alphaAt(image, 1), 0, 'an untouched cell was painted');
});

void test('more memory is never less visible', () => {
  // Monotonic, which is the property; the exact curve is a matter of taste.
  let previous = -1;
  for (const value of [0, 0.1, 0.25, 0.4, 0.45, 0.8, 1]) {
    const field = createMemoryField();
    field[0] = value;
    const alpha = alphaAt(painted(field, 1).image, 0);
    assert.ok(alpha >= previous, `memory ${value} was fainter than the step below it`);
    previous = alpha;
  }
});

void test('the field saturates rather than overflowing its alpha byte', () => {
  // `field * 2.2` passes 1 at about 0.46, and an alpha byte that wrapped past
  // 255 would render the brightest memory as the faintest.
  const mark = palette.marks.memoryField;
  const ceiling = Math.round(mark.alpha * 255);
  for (const value of [0.46, 0.8, 1, 4, 1_000]) {
    const field = createMemoryField();
    field[0] = value;
    const alpha = alphaAt(painted(field, 1).image, 0);
    assert.equal(alpha, ceiling, `memory ${value} did not clamp`);
    assert.ok(alpha <= 255);
  }
});

void test('intensity scales the whole field and zero makes it invisible', () => {
  const field = createMemoryField();
  field[0] = 0.3;
  const full = alphaAt(painted(field, 1).image, 0);
  const half = alphaAt(painted(field, 0.5).image, 0);
  const none = alphaAt(painted(field, 0).image, 0);
  assert.ok(half < full && half > 0, `half intensity gave ${half} against ${full}`);
  assert.equal(none, 0, 'the room was told to show nothing and showed something');
});

void test('every cell of the field reaches the surface', () => {
  // A loop bounded by the wrong dimension leaves a band of the room unpainted,
  // which reads as a dead zone no visitor can deposit memory into.
  const field = createMemoryField();
  field.fill(1);
  const { image } = painted(field, 1);
  assert.equal(image.data.length, FIELD_WIDTH * FIELD_HEIGHT * 4);
  for (let cell = 0; cell < FIELD_WIDTH * FIELD_HEIGHT; cell += 1) {
    assert.ok(alphaAt(image, cell) > 0, `cell ${cell} never received the field`);
  }
});

void test('a settled room does not shimmer at all', () => {
  assert.deepEqual(unrestOffset(1, 5_000, 0), { x: 0, y: 0 });
  assert.deepEqual(unrestOffset(1, 5_000, -1), { x: 0, y: 0 });
});

void test('jitter is deterministic, so a still point does not vibrate', () => {
  // The whole reason this is a hash of seed and time rather than Math.random:
  // the same point at the same instant must land in the same place, or every
  // redraw of a stationary body moves it.
  assert.deepEqual(unrestOffset(3, 5_000, 0.4), unrestOffset(3, 5_000, 0.4));
});

void test('different points shimmer differently at the same instant', () => {
  const a = unrestOffset(1, 5_000, 0.4);
  const b = unrestOffset(2, 5_000, 0.4);
  assert.notDeepEqual(a, b);
});

void test('the same point shimmers over time', () => {
  assert.notDeepEqual(unrestOffset(1, 5_000, 0.4), unrestOffset(1, 9_000, 0.4));
});

void test('jitter stays inside the amount it was given', () => {
  // Sine and cosine bound this, but the bound is what callers rely on to keep
  // an unsettled body from leaving its own outline.
  for (let seed = 0; seed < 40; seed += 1) {
    for (let now = 0; now < 40_000; now += 997) {
      const { x, y } = unrestOffset(seed, now, 0.4);
      assert.ok(Math.abs(x) <= 0.4 + 1e-12, `x ${x} escaped`);
      assert.ok(Math.abs(y) <= 0.4 + 1e-12, `y ${y} escaped`);
    }
  }
});

void test('jitter scales with the unrest it is given', () => {
  const small = unrestOffset(7, 5_000, 0.1);
  const large = unrestOffset(7, 5_000, 0.4);
  assert.ok(Math.abs(large.x) > Math.abs(small.x));
  assert.ok(Math.abs(large.x - small.x * 4) < 1e-12, 'the scaling is not linear in amount');
});
