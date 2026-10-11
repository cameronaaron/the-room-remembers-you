import type { RendererBackend, RendererPreference, RoomRenderer } from './room-renderer.ts';
import type { RenderSurface } from './gpu-surface.ts';
import { chooseRendererBackend } from './room-renderer.ts';
import { SwarmRenderer } from './swarm-renderer.ts';
import { WebGpuRoomRenderer } from './webgpu-renderer.ts';

/**
 * Getting a renderer, with every way it can go wrong handled somewhere a test
 * can reach.
 *
 * This is the seam between "which backend should the room use" — a policy, in
 * `room-renderer.ts` — and "build it", which needs a canvas, an adapter and a
 * GPU. The component gets one call and one answer. Everything it used to decide
 * inside a `try` block in an effect is here instead, which is the same move that
 * put `assessLiveness` in `liveness.ts`.
 *
 * Two things matter here and are not obvious:
 *
 * * **Every construction gets a canvas that has never held a context.** A canvas
 *   is consumed by the first graphics API it is asked for, permanently and in
 *   both directions — see `gpu-surface.ts`, where that is measured rather than
 *   assumed. So this takes a `RenderSurface` rather than an element, and takes a
 *   `fresh()` one immediately before each attempt. `WebGpuRoomRenderer.create`
 *   still refuses as much as it can before touching the canvas, because a
 *   refusal that costs nothing is better than one that costs an element; but it
 *   is no longer load-bearing, and the paths it cannot cover — `configure`
 *   failing, or a refusal reached after `getContext` — are covered here.
 * * **A refusal is not an error.** Every path returns a backend and a sentence.
 *   The room draws something in all of them, including the one where there is no
 *   GPU at all.
 */

export type RendererStartupOptions = {
  /** What the operator selected. `auto` is the shipped default. */
  preference: RendererPreference;
  /** Particles asked for, from the hardware profile. */
  budget: number;
  /** Whether this GPU has already lost too many contexts. */
  abandoned: boolean;
  /** Told when a WebGPU device is lost. WebGL reports this through an event. */
  onDeviceLost?: (reason: string) => void;
  /** Told when the driver reports an error nothing else caught. */
  onDeviceError?: (message: string) => void;
};

export type RendererStartup = {
  /** Null when the answer is the line renderer, which owns no canvas. */
  renderer: RoomRenderer | null;
  backend: RendererBackend;
  /**
   * The operator console's renderer line.
   *
   * It carries the reason when this is not what was asked for, rather than
   * leaving it to the rolling "last event" field, which the next thing the room
   * notices overwrites within a second. A console that reports the backend it
   * settled for and not why is a console that answers the easy half of the
   * question.
   */
  label: string;
  /** Why this backend and not another. */
  why: string;
  /** Whether this is a fallback rather than what was selected. */
  degraded: boolean;
};

/**
 * How the renderer is built. Injected so the decision can be tested without a
 * GPU, a canvas or a browser — the same reason `EmergenceRoom` takes its clock.
 */
export type RendererFactories = {
  hasWebGpu: () => boolean;
  createWebGpu: (
    canvas: HTMLCanvasElement,
    budget: number,
    onDeviceLost?: (reason: string) => void,
    onDeviceError?: (message: string) => void,
  ) => Promise<RoomRenderer>;
  createWebGl: (canvas: HTMLCanvasElement, budget: number) => RoomRenderer;
};

/** How many particles, phrased the way the console has always phrased it. */
function thousands(count: number): string {
  return `${(count / 1000).toFixed(0)}k`;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : 'unknown');

export async function startRoomRenderer(
  surface: RenderSurface,
  options: RendererStartupOptions,
  factories: RendererFactories,
): Promise<RendererStartup> {
  const capability = {
    // A cheap synchronous probe. Whether this adapter can actually carry the
    // field is decided by `assessWebGpu` inside `create`, against real limits,
    // and a refusal there falls through to WebGL below.
    webgpu: { available: factories.hasWebGpu(), reason: 'this browser has no WebGPU implementation' },
    webgl2: true,
    abandoned: options.abandoned,
  };
  const choice = chooseRendererBackend(options.preference, capability);
  // `auto` cannot be disappointed; an explicit selection can. Anything else is
  // a fallback and has to say so on the renderer line, not only in the rolling
  // event field.
  const degraded = options.preference !== 'auto' && choice.backend !== options.preference;

  if (choice.backend === 'traces') {
    // The line renderer owns no canvas, and leaving a spent one mounted would
    // hold a projection-sized drawing buffer for nothing.
    surface.release();
    return {
      renderer: null,
      backend: 'traces',
      label: `Canvas 2D traces · ${choice.why}`,
      why: choice.why,
      degraded: true,
    };
  }

  if (choice.backend === 'webgpu') {
    try {
      const renderer = await factories.createWebGpu(
        surface.fresh(),
        options.budget,
        options.onDeviceLost,
        options.onDeviceError,
      );
      return {
        renderer,
        backend: 'webgpu',
        label: `WebGPU swarm · ${thousands(renderer.particleCount)}`,
        why: choice.why,
        degraded: false,
      };
    } catch (error) {
      // WebGL is still on the table because the *next* attempt gets its own
      // element, whether or not the refused one reached the canvas. Fall
      // through rather than returning: what the operator asked for is
      // unavailable, and the room's job is to draw something and say what
      // happened.
      const fallback = chooseRendererBackend(options.preference, {
        ...capability,
        webgpu: { available: false, reason: reasonOf(error) },
      });
      return withWebGl(surface, options, factories, fallback.why, true);
    }
  }

  return withWebGl(surface, options, factories, choice.why, degraded);
}

function withWebGl(
  surface: RenderSurface,
  options: RendererStartupOptions,
  factories: RendererFactories,
  why: string,
  degraded: boolean,
): RendererStartup {
  try {
    const renderer = factories.createWebGl(surface.fresh(), options.budget);
    const running = `WebGL2 swarm · ${thousands(renderer.particleCount)}`;
    return {
      renderer,
      backend: 'webgl',
      label: degraded ? `${running} · ${why}` : running,
      why,
      degraded,
    };
  } catch (error) {
    const reason = `particle field unavailable — ${reasonOf(error)}`;
    surface.release();
    return {
      renderer: null,
      backend: 'traces',
      label: `Canvas 2D traces · ${reason}`,
      why: reason,
      degraded: true,
    };
  }
}

/**
 * The real backends.
 *
 * The one place the two concrete renderers are named, so everything above is
 * about the decision and everything below is about a GPU. A component imports
 * this; a test imports its own.
 */
export const browserRenderers: RendererFactories = {
  hasWebGpu: () => typeof navigator !== 'undefined' && 'gpu' in navigator,
  createWebGpu: (canvas, budget, onDeviceLost, onError) =>
    WebGpuRoomRenderer.create(canvas, { budget, onDeviceLost, onError }),
  createWebGl: (canvas, budget) => new SwarmRenderer(canvas, budget),
};
