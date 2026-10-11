import './test-doubles/dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuSurface, SURFACE_CLASS } from './gpu-surface.ts';

function host(): HTMLElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

/**
 * The whole point, stated as a property rather than as a count: no element is
 * ever handed out twice, because a canvas is consumed by the first graphics API
 * it is asked for and nothing gives it back.
 */
void test('no two constructions are offered the same element', () => {
  const surface = new GpuSurface(host());
  const seen = new Set<HTMLCanvasElement>();
  for (let attempt = 0; attempt < 12; attempt += 1) seen.add(surface.fresh());
  assert.equal(seen.size, 12);
  assert.equal(surface.spent, 12, 'and it says how many it has cost');
});

void test('a fresh element replaces the one before it rather than stacking', () => {
  const parent = host();
  const surface = new GpuSurface(parent);
  const first = surface.fresh();
  const second = surface.fresh();
  assert.equal(parent.childNodes.length, 1, 'one surface is mounted at a time');
  assert.equal(surface.current(), second);
  // Detached, so the drawing buffer behind it can be collected. On a machine
  // losing its GPU repeatedly these would otherwise accumulate for the session.
  assert.equal(first.parentNode, null, 'the spent one is detached');
  assert.equal(second.parentNode, parent);
});

void test('release leaves the host empty and says there is no surface', () => {
  const parent = host();
  const surface = new GpuSurface(parent);
  const canvas = surface.fresh();
  surface.release();
  assert.equal(surface.current(), null);
  assert.equal(canvas.parentNode, null);
  assert.equal(parent.childNodes.length, 0);
  // Releasing twice is what an unmount racing a fallback does, and it must not
  // throw its way out of a React cleanup.
  surface.release();
  assert.equal(surface.current(), null);
});

/**
 * The field is not content. A screen reader announcing a canvas of particles
 * would be reading the room's memory out as an image description, and the class
 * is what `globals.css` positions it by — a canvas that arrives unstyled is
 * mounted at its default 300x150 in the corner of the projection.
 */
void test('every surface carries the class and is hidden from assistive tech', () => {
  const surface = new GpuSurface(host());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const canvas = surface.fresh();
    assert.equal(canvas.className, SURFACE_CLASS);
    assert.equal(canvas.getAttribute('aria-hidden'), 'true');
  }
});

void test('the element is made by whatever the caller injected', () => {
  const made: string[] = [];
  const surface = new GpuSurface(host(), () => {
    made.push('made');
    return document.createElement('canvas');
  });
  surface.fresh();
  surface.fresh();
  assert.deepEqual(made, ['made', 'made']);
});
