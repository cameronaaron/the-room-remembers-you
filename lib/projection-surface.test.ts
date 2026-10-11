import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG } from './room-types.ts';
import {
  MAX_PIXEL_RATIO,
  projectionStyle,
  surfaceSize,
} from './projection-surface.ts';

void test('a high-density display does not multiply the cost of every frame', () => {
  // A 3x panel triples fill cost for a blurred light field nobody can resolve
  // from across a gallery. The cap is what keeps the CHEAP profile affordable.
  const capped = surfaceSize(1920, 1080, 3);
  assert.equal(capped.width, 1920 * MAX_PIXEL_RATIO);
  assert.equal(capped.height, 1080 * MAX_PIXEL_RATIO);
});

void test('a ratio the browser cannot state is treated as one', () => {
  // `devicePixelRatio` is 0 or undefined in more environments than it should
  // be; a surface scaled by zero is a canvas that throws rather than draws.
  for (const ratio of [0, Number.NaN]) {
    const surface = surfaceSize(800, 600, ratio);
    assert.equal(surface.width, 800);
    assert.equal(surface.height, 600);
  }
});

void test('the retina is half the projection and never zero', () => {
  const surface = surfaceSize(1000, 800, 1);
  assert.equal(surface.retinaWidth, 500);
  assert.equal(surface.retinaHeight, 400);
  const sliver = surfaceSize(1, 1, 1);
  assert.ok(sliver.retinaWidth >= 1 && sliver.retinaHeight >= 1, 'a zero-sized buffer throws on drawImage');
});

void test('the key changes exactly when the surface does', () => {
  // The draw loop reallocates its buffers on this comparison. A key that
  // changes when nothing did reallocates every frame; one that does not change
  // when the window did leaves the room drawing at the old size forever.
  assert.equal(surfaceSize(1280, 720, 1).key, surfaceSize(1280, 720, 1).key);
  assert.notEqual(surfaceSize(1280, 720, 1).key, surfaceSize(1280, 721, 1).key);
  // Same pixels by two routes is the same surface.
  assert.equal(surfaceSize(640, 360, 2).key, surfaceSize(1280, 720, 1).key);
});

void test('cropping scales the image back up rather than shrinking it', () => {
  // Otherwise every keystone adjustment also shrinks the projection and the
  // operator chases the two settings against each other on a ladder.
  const square = projectionStyle({ ...DEFAULT_CONFIG, crop: 0 });
  assert.match(square.transform, /scale\(1\)/);
  const cropped = projectionStyle({ ...DEFAULT_CONFIG, crop: 9 });
  assert.match(cropped.clipPath, /inset\(9%\)/);
  const scale = Number(/scale\(([\d.]+)\)/.exec(cropped.transform)![1]);
  assert.ok(scale > 1, 'a cropped projection must grow back to fill the wall');
  // Cropping to the full 45% doubles what is left, which is the geometry the
  // operator's two controls are calibrated against.
  assert.match(projectionStyle({ ...DEFAULT_CONFIG, crop: 45 }).transform, /scale\(2\)/);
});

void test('keystone axes are not interchangeable', () => {
  // X keystone is a rotation about Y and vice versa. Swapping them produces a
  // projection that looks adjustable and corrects the wrong edge.
  const x = projectionStyle({ ...DEFAULT_CONFIG, keystoneX: 5 });
  const y = projectionStyle({ ...DEFAULT_CONFIG, keystoneY: 5 });
  assert.match(x.transform, /rotateY\(5deg\)/);
  assert.match(y.transform, /rotateX\(5deg\)/);
  assert.notEqual(x.transform, y.transform);
});
