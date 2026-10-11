import type { SwarmFrame } from './swarm-frame.ts';

/**
 * One interface, three ways of drawing the room.
 *
 * The engine says *this memory exists here, with this intensity*; a renderer
 * says *this is how that looks*. Everything below the interface is about how,
 * and nothing below it decides who the room is interested in, which memory is
 * recalled or whether a track is a person. That separation is what lets the
 * same session be drawn by a compute pipeline on a capable machine and by a
 * fragment shader on the one in the gallery, and be the same artwork.
 *
 * `traces` is the Canvas 2D line renderer. It is not a `RoomRenderer` — it
 * draws into the shared 2D surface the console and calibration markers live on
 * rather than owning a canvas — and it stays the last fallback, because a room
 * drawing something is worth more than a room waiting for a GPU.
 */
export type RendererBackend = 'webgpu' | 'webgl' | 'traces';

export interface RoomRenderer {
  readonly backend: RendererBackend;
  /** Particles actually simulated, which is not always what was asked for. */
  readonly particleCount: number;
  /**
   * False once the underlying device or context has gone. A dead renderer
   * accepts every call and draws nothing, so the caller can decide when to
   * rebuild instead of having an exception thrown at it mid-frame.
   */
  readonly alive: boolean;
  resize(width: number, height: number): void;
  /** 0..1 densities from the memory field. Never pixels. */
  setMemoryField(field: Float32Array, width: number, height: number): void;
  /** The ephemeral coarse motion grid: 0 quiet, 1 candidate, 2 accepted. */
  setPresenceMask(mask: ArrayLike<number>, width: number, height: number): void;
  render(frame: SwarmFrame): void;
  destroy(): void;
}

/** What the room knows about this machine when it picks a backend. */
export type RendererCapability = {
  /** WebGPU was probed and can carry the field, with the count it would run. */
  webgpu: { available: boolean; reason: string; particleCount?: number };
  /** WebGL2 with float render targets. */
  webgl2: boolean;
  /**
   * The GPU has lost too many contexts this session and the swarm has been
   * abandoned. See `renderer-health.ts`; this outranks everything else.
   */
  abandoned: boolean;
};

/**
 * What the operator asked for, which is not always what they can have.
 *
 * `traces` is deliberately not one of the options. Choosing the line renderer
 * over the particle field is what `VisualEngine` is for, and two settings that
 * do the same thing is how an operator ends up with one of them set the way they
 * want and the other one winning. This preference picks the GPU API; `traces` is
 * only ever an outcome, when there is no usable GPU or this one has been given
 * up on.
 */
export type RendererPreference = 'auto' | 'webgl' | 'webgpu';

export type RendererChoice = {
  backend: RendererBackend;
  /**
   * One sentence for the operator console, naming what was chosen and why.
   * Diagnostics have to answer "what is broken" and "what should I do", and a
   * backend silently falling back is exactly the failure that looks like the
   * artwork working.
   */
  why: string;
};

/**
 * Pick a backend.
 *
 * The rule is deliberately conservative, and it is the rule rather than a
 * preference: **WebGPU is never chosen by `auto`.** It becomes the default when
 * it has passed visual, recovery and burn-in parity against WebGL on the
 * hardware the gallery actually runs, and that is a decision with evidence
 * behind it, not a capability check. Until then an operator can select it
 * explicitly and see what it does.
 *
 * Asking for a backend this machine cannot provide is answered with the best
 * one it can, and the console is told which and why. Silently doing something
 * other than what was asked is how an operator ends up debugging the wrong
 * layer for an afternoon.
 */
export function chooseRendererBackend(
  preference: RendererPreference,
  capability: RendererCapability,
): RendererChoice {
  if (capability.abandoned) {
    return {
      backend: 'traces',
      why: 'this GPU lost its context repeatedly; the line renderer owns the room for the rest of the session',
    };
  }
  if (preference === 'webgpu') {
    if (capability.webgpu.available) {
      const count = capability.webgpu.particleCount;
      return {
        backend: 'webgpu',
        why: `WebGPU was selected in the console${count ? ` and will run ${Math.round(count / 1000)}k particles` : ''}`,
      };
    }
    if (capability.webgl2) {
      return {
        backend: 'webgl',
        why: `WebGPU was selected but is unavailable — ${capability.webgpu.reason}; running WebGL2 instead`,
      };
    }
    return {
      backend: 'traces',
      why: `neither WebGPU nor WebGL2 is available — ${capability.webgpu.reason}`,
    };
  }
  if (capability.webgl2) {
    return {
      backend: 'webgl',
      // Named so that "why am I not on WebGPU" has an answer in the console
      // rather than in this file.
      why: preference === 'webgl'
        ? 'WebGL2 was selected in the console'
        : 'WebGL2 is the exhibition default until WebGPU passes its parity gates',
    };
  }
  return {
    backend: 'traces',
    why: 'WebGL2 float render targets are unavailable on this machine; running the line renderer',
  };
}
