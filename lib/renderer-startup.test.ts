import assert from 'node:assert/strict';
import test from 'node:test';
import { startRoomRenderer, type RendererFactories } from './renderer-startup.ts';
import type { RenderSurface } from './gpu-surface.ts';
import type { RoomRenderer } from './room-renderer.ts';

/**
 * A surface that hands out a distinct element every time it is asked, and
 * remembers what it has spent.
 *
 * Distinct objects rather than one stand-in, because the property under test is
 * that no two constructions share an element: a canvas is consumed by the first
 * graphics API it is asked for, permanently and in both directions, and
 * `gpu-surface.ts` records the measurement. A single `{}` would make every
 * assertion about that pass by accident.
 */
function surfaces() {
  const handed: HTMLCanvasElement[] = [];
  let mounted: HTMLCanvasElement | null = null;
  let released = 0;
  const surface: RenderSurface = {
    fresh() {
      mounted = { id: handed.length } as unknown as HTMLCanvasElement;
      handed.push(mounted);
      return mounted;
    },
    current: () => mounted,
    release() { released += 1; mounted = null; },
  };
  return {
    surface,
    handed,
    get released() { return released; },
  };
}

function fakeRenderer(backend: RoomRenderer['backend'], particleCount: number): RoomRenderer {
  return {
    backend,
    particleCount,
    alive: true,
    resize() {},
    setMemoryField() {},
    setPresenceMask() {},
    render() {},
    destroy() {},
  };
}

function factories(overrides: Partial<RendererFactories> = {}): RendererFactories {
  return {
    hasWebGpu: () => true,
    createWebGpu: async () => fakeRenderer('webgpu', 359_936),
    createWebGl: () => fakeRenderer('webgl', 147_456),
    ...overrides,
  };
}

const settings = {
  preference: 'auto' as const,
  budget: 147_456,
  abandoned: false,
};

void test('the shipped default is WebGL2, and it reports what it is running', async () => {
  const started = await startRoomRenderer(surfaces().surface, settings, factories());
  assert.equal(started.backend, 'webgl');
  assert.equal(started.label, 'WebGL2 swarm · 147k', 'nothing went wrong, so nothing is explained');
  assert.equal(started.degraded, false);
  assert.ok(started.renderer);
});

void test('an operator who selects WebGPU gets it', async () => {
  const started = await startRoomRenderer(surfaces().surface, { ...settings, preference: 'webgpu' }, factories());
  assert.equal(started.backend, 'webgpu');
  assert.equal(started.label, 'WebGPU swarm · 360k');
});

/**
 * The property this whole module exists to protect, and it is no longer the one
 * that used to be asserted here.
 *
 * This test read `webglCanvas === canvas` — "the same canvas must still be
 * usable" — which was the design when `WebGpuRoomRenderer.create` was trusted to
 * refuse before touching the element. Measured in Chrome, that is false in the
 * case that matters: calling `getContext('webgpu')` consumes the canvas whether
 * or not it is ever configured, and neither `unconfigure()` nor destroying the
 * device gives it back. A WebGPU attempt that got as far as the canvas and then
 * refused left the fallback building on an element that could never hold WebGL2,
 * so a machine that cannot run WebGPU lost the renderer it *can* run.
 *
 * The claim is now the stronger one: each construction is handed an element
 * nothing has asked for a context. Ordering inside `create` is still worth
 * having — a refusal that costs nothing beats one that costs an element — but
 * nothing depends on it being perfect.
 */
void test('a WebGPU attempt that fails still leaves the room with a particle field', async () => {
  let webglCanvas: HTMLCanvasElement | null = null;
  const surface = surfaces();
  const started = await startRoomRenderer(surface.surface, { ...settings, preference: 'webgpu' }, factories({
    createWebGpu: async () => { throw new Error('no WebGPU adapter is available on this machine'); },
    createWebGl: (target) => { webglCanvas = target; return fakeRenderer('webgl', 147_456); },
  }));
  assert.equal(started.backend, 'webgl');
  assert.equal(surface.handed.length, 2, 'the refused attempt spent an element of its own');
  assert.equal(webglCanvas, surface.handed[1], 'WebGL2 built on the fresh one');
  assert.notEqual(webglCanvas, surface.handed[0], 'never on the one WebGPU was offered');
  assert.match(started.why, /no WebGPU adapter/);
  assert.match(started.why, /WebGL2 instead/);
  assert.equal(started.degraded, true);
  // The reason rides on the renderer line itself. `lastEvent` is a rolling
  // field the next thing the room notices overwrites within a second, and an
  // operator asking "why is this not what I selected" is asking an hour later.
  assert.match(started.label, /WebGL2 swarm · 147k · .*no WebGPU adapter/);
});

void test('with both GPU backends gone the room still draws lines, and says why', async () => {
  const started = await startRoomRenderer(surfaces().surface, { ...settings, preference: 'webgpu' }, factories({
    hasWebGpu: () => false,
    createWebGl: () => { throw new Error('EXT_color_buffer_float is unavailable'); },
  }));
  assert.equal(started.backend, 'traces');
  assert.equal(started.renderer, null, 'the line renderer owns no canvas');
  assert.match(started.why, /EXT_color_buffer_float/);
  assert.match(started.label, /EXT_color_buffer_float/, 'the console keeps the reason');
});

void test('a browser with no WebGPU is not asked for one', async () => {
  let asked = false;
  const started = await startRoomRenderer(surfaces().surface, { ...settings, preference: 'webgpu' }, factories({
    hasWebGpu: () => false,
    createWebGpu: async () => { asked = true; throw new Error('unreachable'); },
  }));
  assert.equal(asked, false);
  assert.equal(started.backend, 'webgl');
  assert.match(started.why, /no WebGPU implementation/);
});

/**
 * `renderer-health.ts` gives up on the swarm after repeated context losses.
 * Asking this GPU for another context would only reseed the field again, so the
 * verdict outranks the operator's selection.
 */
void test('a GPU that has been abandoned is not asked for another context', async () => {
  let built = 0;
  for (const preference of ['auto', 'webgl', 'webgpu'] as const) {
    const started = await startRoomRenderer(surfaces().surface, { ...settings, preference, abandoned: true }, factories({
      createWebGpu: async () => { built += 1; return fakeRenderer('webgpu', 1); },
      createWebGl: () => { built += 1; return fakeRenderer('webgl', 1); },
    }));
    assert.equal(started.backend, 'traces');
  }
  assert.equal(built, 0);
});

void test('a lost WebGPU device is reported to the caller that asked for it', async () => {
  const told: string[] = [];
  let announce: ((reason: string) => void) | undefined;
  await startRoomRenderer(
    surfaces().surface,
    { ...settings, preference: 'webgpu', onDeviceLost: (reason) => told.push(reason) },
    factories({
      createWebGpu: async (_canvas, _budget, onDeviceLost) => {
        announce = onDeviceLost;
        return fakeRenderer('webgpu', 1024);
      },
    }),
  );
  assert.ok(announce, 'the renderer must be handed somewhere to report a loss');
  announce?.('the GPU device was lost');
  assert.deepEqual(told, ['the GPU device was lost']);
});

/**
 * The surface is a resource, not a piece of markup, and the line renderer does
 * not use it. A spent canvas left mounted holds a projection-sized drawing
 * buffer for a backend that draws nothing on it.
 */
void test('a room that falls back to lines is not left holding a GPU surface', async () => {
  for (const [name, overrides] of [
    ['no GPU at all', { hasWebGpu: () => false, createWebGl: () => { throw new Error('no float targets'); } }],
    ['this GPU already abandoned', {}],
  ] as const) {
    const surface = surfaces();
    const abandoned = name === 'this GPU already abandoned';
    const started = await startRoomRenderer(
      surface.surface,
      { ...settings, preference: 'webgpu', abandoned },
      factories(overrides),
    );
    assert.equal(started.backend, 'traces', name);
    assert.equal(surface.surface.current(), null, `${name}: nothing is left mounted`);
    assert.ok(surface.released > 0, `${name}: the surface was released rather than abandoned`);
  }
});

void test('a start that succeeds first time spends exactly one element', async () => {
  for (const preference of ['auto', 'webgl', 'webgpu'] as const) {
    const surface = surfaces();
    await startRoomRenderer(surface.surface, { ...settings, preference }, factories());
    assert.equal(surface.handed.length, 1, preference);
  }
});
