/**
 * Keeping a renderer, across the losses a gallery machine actually produces.
 *
 * `renderer-startup.ts` answers "which backend, and build it". This answers the
 * longer question: what happens at 3am when the projector renegotiates, the
 * driver resets, or the display sleeps and the GPU takes the particle field
 * with it. It is the same shape as `mountTracking` and `mountAttention` — one
 * call, one cleanup — and it is a module for the same reason they are: a
 * recovery path reachable only by losing a real GPU context in a real browser
 * is a recovery path nothing checks.
 *
 * ## Two ways a context goes, and they report differently
 *
 * WebGL dispatches `webglcontextlost` on the canvas and *may* follow it with
 * `webglcontextrestored` — but only if the loss was cancelled, and a driver
 * that has given up sends nothing at all, which is why `RendererHealth.poll`
 * exists a layer up. WebGPU resolves a promise and never offers a restore, so
 * the decision the `webglcontextrestored` listener makes is made immediately.
 *
 * Both end in the same place: destroy the renderer, hand the room back to the
 * trace engine so something is still on the wall, and ask `RendererHealth`
 * whether another rebuild is worth it. Rebuilding is the honest recovery
 * because both backends hold every GPU resource in fields built by their
 * factory — there is no half-dead object to repair — and it is bounded because
 * each rebuild reseeds the particles, so recovering several times a minute is
 * strobing, and strobing reads as a fault rather than as the work.
 *
 * ## Every rebuild is a new element
 *
 * The rebuild goes through `GpuSurface`, so the renderer that comes back is
 * free to be a different backend from the one that died. That is the whole
 * point: a WebGPU device that does not come back must be able to fall back to
 * WebGL2, and on the element that just held WebGPU it cannot. See
 * `gpu-surface.ts`, where the exclusivity is measured.
 */
import type { RendererPreference, RoomRenderer } from './room-renderer.ts';
import type { RendererHealth } from './renderer-health.ts';
import { type RenderSurface, GpuSurface } from './gpu-surface.ts';
import { type RendererFactories, browserRenderers, startRoomRenderer } from './renderer-startup.ts';

export type RendererMountOptions = {
  /** What the operator selected. `auto` is the shipped default. */
  preference: RendererPreference;
  /** Particles asked for, from the hardware profile. */
  budget: number;
  /** Loss policy, owned by the caller so it survives every rebuild. */
  health: RendererHealth;
  /** Monotonic, because the loss window is a duration. */
  now: () => number;
  /** Where the live renderer is published, and `null` while there is none. */
  onRenderer: (renderer: RoomRenderer | null) => void;
  /** The console's renderer line, and the rolling event field beside it. */
  onStatus: (renderer: string, lastEvent: string) => void;
  /** Ask the caller to mount again. The caller decides when; this never loops. */
  onRebuild: () => void;
};

/** Injected whole so a test needs no GPU, no canvas and no browser. */
export type RendererMountDeps = {
  factories?: RendererFactories;
  makeSurface?: (host: HTMLElement) => RenderSurface;
};

/** What the room shows while it has no particle field. */
const TRACES = 'Canvas 2D traces';

export function mountRoomRenderer(
  host: HTMLElement,
  options: RendererMountOptions,
  deps: RendererMountDeps = {},
): () => void {
  // The trace engine owns the room for the rest of the session; asking this
  // GPU for another context would only reseed the field again.
  if (options.health.state.abandoned) return () => {};

  const surface = (deps.makeSurface ?? ((element) => new GpuSurface(element)))(host);
  const factories = deps.factories ?? browserRenderers;
  let renderer: RoomRenderer | null = null;
  let listening: HTMLCanvasElement | null = null;
  let retired = false;
  /**
   * Whether this mount has already given its context up.
   *
   * A device can be lost between the renderer being constructed and this mount
   * being handed it: `WebGpuRoomRenderer` registers `device.lost` inside its own
   * constructor, so the loss is reported through `onDeviceLost` while
   * `startRoomRenderer` is still resolving. Without this the loss is handled
   * against a renderer nobody holds yet, and then the dead one is installed on
   * top — and a dead WebGPU renderer does not throw. `submit` drops the command
   * buffer, the wall keeps its last frame, and in a room lit only by the field
   * that is indistinguishable from a quiet gallery. `RendererHealth.poll` cannot
   * catch it either, because this path resolves the loss immediately and clears
   * the timestamp poll watches.
   */
  let surrendered = false;

  /** Shared by both loss paths: the field is gone, the room keeps drawing. */
  const surrender = () => {
    surrendered = true;
    options.health.contextLost(options.now());
    renderer?.destroy();
    renderer = null;
    options.onRenderer(null);
  };

  const onDeviceLost = (reason: string) => {
    if (retired) return;
    surrender();
    // WebGPU never offers a restore, so the decision the listener below makes
    // on `webglcontextrestored` is made here, immediately.
    const action = options.health.contextRestored(options.now());
    options.onStatus(TRACES, `${reason} — ${options.health.describe()}`);
    if (action === 'rebuild') options.onRebuild();
  };

  const onLost = (event: Event) => {
    if (retired) return;
    // A restore is only ever offered for a loss that was cancelled.
    event.preventDefault();
    surrender();
    options.onStatus(`${TRACES} · GPU context lost`, options.health.describe());
  };

  const onRestored = () => {
    if (retired) return;
    const action = options.health.contextRestored(options.now());
    if (action === 'fallback') {
      options.onStatus(TRACES, options.health.describe());
      return;
    }
    options.onRebuild();
  };

  void startRoomRenderer(surface, {
    preference: options.preference,
    budget: options.budget,
    abandoned: options.health.state.abandoned,
    onDeviceLost,
    onDeviceError: (message) => {
      if (!retired) options.onStatus(TRACES, `GPU driver reported: ${message}`);
    },
  }, factories).then((started) => {
    // The mount may have been torn down while an adapter was being acquired,
    // and a renderer nobody is holding is a leaked GPU device on a machine that
    // runs for weeks. It may also have lost its device before anyone was handed
    // it, in which case the loss has already been dealt with and this is the
    // corpse arriving afterwards.
    if (retired || surrendered) {
      started.renderer?.destroy();
      surface.release();
      return;
    }
    // Or it arrived dead without having said so. `alive` is asserted rather
    // than assumed because installing it is the quietest failure available: a
    // dead WebGPU renderer does not throw, and the wall keeps its last frame.
    // It is a lost device like any other, and is reported as one.
    if (started.renderer && !started.renderer.alive) {
      started.renderer.destroy();
      onDeviceLost('the renderer was not alive when it was handed over');
      return;
    }
    renderer = started.renderer;
    options.onRenderer(renderer);
    // Attached here rather than before the attempt because the element does not
    // exist until a renderer has been built on it. The gap is one microtask of
    // a context that has just been created successfully; a loss inside it would
    // arrive as a dead renderer on the next frame, which `RendererHealth.poll`
    // is what covers.
    listening = surface.current();
    listening?.addEventListener('webglcontextlost', onLost);
    listening?.addEventListener('webglcontextrestored', onRestored);
    options.onStatus(started.label, started.why);
  });

  return () => {
    retired = true;
    listening?.removeEventListener('webglcontextlost', onLost);
    listening?.removeEventListener('webglcontextrestored', onRestored);
    listening = null;
    renderer?.destroy();
    renderer = null;
    options.onRenderer(null);
    surface.release();
  };
}
