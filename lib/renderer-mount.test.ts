import './test-doubles/dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mountRoomRenderer } from './renderer-mount.ts';
import { RendererHealth } from './renderer-health.ts';
import { GpuSurface } from './gpu-surface.ts';
import type { RendererFactories } from './renderer-startup.ts';
import type { RendererPreference, RoomRenderer } from './room-renderer.ts';

/**
 * `alive` is readonly on `RoomRenderer` — a renderer reports its own state and
 * nothing outside it may rewrite that. A test double is the one place that has
 * to, because a device dying is exactly what it exists to simulate.
 */
type Built = Omit<RoomRenderer, 'alive'> & { alive: boolean; destroyed: number };

function fakeRenderer(backend: RoomRenderer['backend']): Built {
  return {
    backend,
    particleCount: 147_456,
    alive: true,
    resize() {},
    setMemoryField() {},
    setPresenceMask() {},
    render() {},
    destroyed: 0,
    destroy() { this.destroyed += 1; },
  };
}

/**
 * One rig for every case here. It records what was built on what, hands back
 * the `onDeviceLost` callback a WebGPU renderer would have been given, and
 * counts rebuild requests — the escalation this module owns, none of which is
 * reachable without losing a real GPU context in a real browser.
 */
function rig(options: {
  preference?: RendererPreference;
  webgpu?: boolean | 'refuses';
  webgl?: boolean;
  health?: RendererHealth;
  /** Reuse a host across mounts, the way the render tree does. */
  host?: HTMLElement;
} = {}) {
  const built: Array<{ backend: string; canvas: HTMLCanvasElement }> = [];
  const renderers: Built[] = [];
  const statuses: Array<[string, string]> = [];
  const published: Array<RoomRenderer | null> = [];
  let rebuilds = 0;
  let announceLoss: ((reason: string) => void) | undefined;
  let clock = 0;

  const make = (backend: RoomRenderer['backend'], canvas: HTMLCanvasElement) => {
    built.push({ backend, canvas });
    const renderer = fakeRenderer(backend);
    renderers.push(renderer);
    return renderer;
  };
  const factories: RendererFactories = {
    hasWebGpu: () => options.webgpu !== false,
    createWebGpu: async (canvas, _budget, onDeviceLost) => {
      if (options.webgpu === 'refuses') throw new Error('no WebGPU adapter is available on this machine');
      announceLoss = onDeviceLost;
      return make('webgpu', canvas);
    },
    createWebGl: (canvas) => {
      if (options.webgl === false) throw new Error('EXT_color_buffer_float is unavailable');
      return make('webgl', canvas);
    },
  };

  const parent = options.host ?? document.createElement('div');
  if (!options.host) document.body.appendChild(parent);
  const surface = new GpuSurface(parent);
  const health = options.health ?? new RendererHealth();
  const stop = mountRoomRenderer(parent, {
    preference: options.preference ?? 'auto',
    budget: 147_456,
    health,
    now: () => clock,
    onRenderer: (renderer) => published.push(renderer),
    onStatus: (renderer, lastEvent) => statuses.push([renderer, lastEvent]),
    onRebuild: () => { rebuilds += 1; },
  }, { factories, makeSurface: () => surface });

  return {
    built, renderers, statuses, published, surface, health, stop, host: parent,
    get rebuilds() { return rebuilds; },
    get canvas() { return surface.current(); },
    loseDevice: (reason = 'the GPU device was lost') => announceLoss?.(reason),
    advance: (ms: number) => { clock += ms; },
    settle: () => new Promise((resolve) => { setTimeout(resolve, 0); }),
  };
}

void test('the renderer it builds is the one the room is given to draw with', async () => {
  const room = rig();
  await room.settle();
  assert.equal(room.built.length, 1);
  assert.equal(room.built[0]?.backend, 'webgl', 'auto is WebGL2, as the gates require');
  assert.equal(room.published.at(-1), room.renderers[0]);
  assert.match(room.statuses.at(-1)?.[0] ?? '', /WebGL2 swarm/);
  room.stop();
});

/**
 * The defect this module was extracted to fix.
 *
 * A canvas is consumed by the first graphics API it is asked for, permanently —
 * measured in `gpu-surface.ts`. So a WebGPU device that does not come back can
 * only fall back to WebGL2 on an element that has never held WebGPU. Before
 * this, the rebuild reused the one canvas in the render tree and the room
 * dropped to Canvas 2D traces for the rest of the gallery day, on hardware that
 * could have run the particle field.
 */
void test('a rebuild after a device loss draws on an element WebGPU never touched', async () => {
  // One host across both mounts, because that is what the render tree does:
  // the positioned wrapper stays put and only what is drawn on is replaced.
  const host = document.createElement('div');
  document.body.appendChild(host);
  const health = new RendererHealth();
  const first = rig({ preference: 'webgpu', health, host });
  await first.settle();
  assert.equal(first.built[0]?.backend, 'webgpu');
  const spent = first.built[0]?.canvas;
  assert.ok(spent);

  first.loseDevice();
  assert.equal(first.published.at(-1), null, 'the room falls through to traces meanwhile');
  assert.equal(first.renderers[0]?.destroyed, 1, 'the dead renderer released its resources');
  assert.equal(first.rebuilds, 1, 'and the caller was asked to mount again');
  first.stop();
  assert.equal(spent.parentNode, null, 'the spent element left the tree with it');

  // The adapter did not come back. This is the mount the caller makes in
  // response, and WebGL2 is all that is left.
  const second = rig({ preference: 'webgpu', webgpu: 'refuses', health, host });
  await second.settle();
  const rebuilt = second.built.at(-1);
  assert.equal(rebuilt?.backend, 'webgl', 'the particle field survives the loss');
  assert.notEqual(rebuilt?.canvas, spent, 'on a canvas WebGPU never had');
  assert.equal(host.childNodes.length, 1, 'and exactly one surface is mounted, not two');
  assert.equal(rebuilt?.canvas.parentNode, host);
  second.stop();
});

void test('a WebGL context loss holds, and a restore rebuilds', async () => {
  const room = rig();
  await room.settle();
  const canvas = room.canvas;
  assert.ok(canvas);

  const lost = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(lost);
  assert.equal(lost.defaultPrevented, true, 'a restore is only offered for a cancelled loss');
  assert.equal(room.published.at(-1), null);
  assert.equal(room.rebuilds, 0, 'nothing is rebuilt until the browser grants a context');
  assert.match(room.statuses.at(-1)?.[0] ?? '', /GPU context lost/);

  canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(room.rebuilds, 1);
  room.stop();
});

/**
 * `RendererHealth` abandons the swarm after repeated losses rather than
 * recovering forever: each rebuild reseeds the particles, so recovering several
 * times a minute is strobing, and strobing reads as a fault rather than as the
 * work.
 */
void test('a GPU that keeps losing its context is eventually left alone', async () => {
  const health = new RendererHealth();
  let abandoned = false;
  for (let attempt = 0; attempt < 12 && !abandoned; attempt += 1) {
    const room = rig({ health });
    await room.settle();
    const canvas = room.canvas;
    if (!canvas) {
      // Once health has given up, the mount refuses to ask for a context at all.
      assert.equal(room.built.length, 0, 'no further contexts were requested');
      abandoned = true;
      break;
    }
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    room.stop();
  }
  assert.ok(abandoned, 'the room must stop chasing a GPU that keeps dropping it');
  assert.equal(health.state.abandoned, true);
});

void test('an unmount releases the renderer, the surface and the listeners', async () => {
  const room = rig();
  await room.settle();
  const canvas = room.canvas;
  assert.ok(canvas);
  room.stop();

  assert.equal(room.renderers[0]?.destroyed, 1, 'the GPU device is not left held');
  assert.equal(room.published.at(-1), null, 'and the draw loop is told there is nothing');
  assert.equal(room.surface.current(), null, 'no spent canvas is left in the tree');

  const before = room.rebuilds;
  canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(room.rebuilds, before, 'a retired mount does not ask for a rebuild');
});

/**
 * The effect can be torn down while an adapter is being acquired, and a
 * renderer nobody is holding is a leaked GPU device on a machine that runs for
 * weeks.
 */
void test('a renderer that arrives after the unmount is destroyed, not installed', async () => {
  const room = rig({ preference: 'webgpu' });
  room.stop();
  await room.settle();
  assert.equal(room.renderers[0]?.destroyed, 1);
  assert.equal(room.published.at(-1), null);
  assert.equal(room.surface.current(), null);
});

void test('a GPU error the driver reports reaches the operator', async () => {
  const room = rig({ preference: 'webgpu' });
  await room.settle();
  // WebGPU does not throw from `submit`; a command buffer that fails validation
  // is dropped and the wall keeps whatever it had, which in a room lit only by
  // the field is indistinguishable from a quiet gallery.
  room.loseDevice('the GPU device was lost');
  assert.match(room.statuses.at(-1)?.[1] ?? '', /the GPU device was lost/);
  room.stop();
});

/**
 * The operator console's **Graphics backend** selector, which could not work.
 *
 * The room runs WebGL2 by default, so the one canvas in the render tree had
 * already been asked for a WebGL2 context by the time anyone opened the
 * console. Selecting WebGPU re-ran the effect against that same element, which
 * can never hold a WebGPU context — so the operator got a fallback and a
 * truthful sentence about a canvas, forever, and the setting appeared to take
 * effect only after a page reload.
 */
void test('changing the backend mid-session actually changes the backend', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const health = new RendererHealth();

  const webgl = rig({ preference: 'webgl', health, host });
  await webgl.settle();
  assert.equal(webgl.built.at(-1)?.backend, 'webgl');
  const first = webgl.built.at(-1)?.canvas;
  webgl.stop();

  const webgpu = rig({ preference: 'webgpu', health, host });
  await webgpu.settle();
  assert.equal(webgpu.built.at(-1)?.backend, 'webgpu', 'the operator got what they selected');
  assert.notEqual(webgpu.built.at(-1)?.canvas, first, 'because it is not the WebGL2 element');
  assert.match(webgpu.statuses.at(-1)?.[0] ?? '', /WebGPU swarm/);
  webgpu.stop();
});

/**
 * A device can be lost between construction and installation.
 *
 * `WebGpuRoomRenderer` registers `device.lost` inside its own constructor, so
 * the loss arrives through `onDeviceLost` while `startRoomRenderer` is still
 * resolving. Handling it against a renderer nobody holds yet and then
 * installing the dead one on top is the worst available outcome: a dead WebGPU
 * renderer does not throw, `submit` drops the command buffer, and the wall
 * keeps its last frame — which in a room lit only by the field is
 * indistinguishable from a quiet gallery.
 */
void test('a device lost before the renderer is installed is never installed', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const room = rig({ preference: 'webgpu', host });
  // Resolve the factory, then lose the device before the mount's `.then` runs.
  await Promise.resolve();
  room.loseDevice('the GPU device was lost during startup');
  await room.settle();

  assert.equal(room.published.at(-1), null, 'the room was never handed a dead renderer');
  assert.equal(room.renderers[0]?.destroyed, 1, 'and it was released rather than leaked');
  assert.equal(room.surface.current(), null, 'with nothing left mounted');
  assert.equal(room.rebuilds, 1, 'the rebuild still goes ahead');
  room.stop();
});

void test('a renderer that arrives already dead is reported, not installed', async () => {
  const room = rig({ preference: 'webgpu' });
  await Promise.resolve();
  // Whatever killed it did not report through `onDeviceLost`; `alive` is the
  // renderer's own answer and is asserted rather than assumed.
  const built = room.renderers[0];
  if (built) built.alive = false;
  await room.settle();

  assert.equal(room.published.at(-1), null, 'the room is told it has no field');
  assert.equal(built?.destroyed, 1, 'and the dead one is released');
  // Silence is the failure this whole module is about. A dead renderer that
  // nobody mentions leaves the console reporting the backend it thought it got.
  assert.match(room.statuses.at(-1)?.[0] ?? '', /Canvas 2D traces/);
  assert.match(room.statuses.at(-1)?.[1] ?? '', /not alive/);
  assert.equal(room.rebuilds, 1, 'and it is retried like any other lost device');
  room.stop();
});
