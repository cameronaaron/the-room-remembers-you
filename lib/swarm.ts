/**
 * The swarm: the maximalist renderer's pure core.
 *
 * The line-drawing renderer could only ever put a few dozen marks on screen,
 * which caps how dense and how alive the image can feel. This module holds
 * everything about the particle field that can be reasoned about and tested
 * without a GPU: how many particles a machine should run, how they are packed
 * into textures, and the colour they carry.
 *
 * The GPU code in `swarm-renderer.ts` builds its gradient lookup texture from
 * `SWARM_GRADIENT` here, so the shader and the tests cannot disagree about what
 * the piece looks like.
 */

import { cielab, type Rgb } from './palette.ts';
import type { HardwareProfile } from './room-types';

/**
 * Particles per profile. A particle is four floats of state and four of
 * metadata, simulated in a fragment shader, so the cost is dominated by
 * texture size and fill rate rather than by count alone.
 */
export const SWARM_BUDGET: Readonly<Record<HardwareProfile, number>> = {
  CHEAP: 65_536,
  STANDARD: 147_456,
  // Measured on Apple silicon through ANGLE's Metal backend: 360k holds 60 fps
  // at both 1080p and 3840x2017. Raised from 262k on that measurement rather
  // than on taste. At 4K the field is noticeably grainier — the same count
  // spread over four times the pixels — which is the real cost of the increase.
  FULL: 360_000,
};

/** Hard ceiling regardless of profile, so a bad config cannot wedge the room. */
export const SWARM_MAX = 409_600;

/**
 * Particle state lives in square float textures addressed by `gl_VertexID`.
 * Returns the side length that holds `count` particles.
 *
 * WebGL2 takes non-power-of-two textures without restriction, and rounding up
 * to a power of two here would quietly quadruple a profile: 147,456 particles
 * would have been packed into a 512x512 texture and simulated as 262,144, so
 * STANDARD would have cost exactly what FULL costs.
 */
export function swarmTextureSide(count: number): number {
  const clamped = Math.max(1, Math.min(SWARM_MAX, Math.floor(count)));
  return Math.ceil(Math.sqrt(clamped));
}

/** Particles actually simulated for a requested count, once packed into a square. */
export function swarmParticleCount(count: number): number {
  const side = swarmTextureSide(count);
  return side * side;
}

/**
 * Colour by how alive a place is: 0 is ground the room barely remembers, 1 is a
 * body standing there right now. Cold and deep at the bottom, running up
 * through turquoise, blue, violet and pink to a hot core.
 *
 * The direction matters more than it looks. An empty room sits at 0, which is
 * the colour the piece wears most of the time — so 0 must be a colour and not a
 * near-white, or the work quietly reverts to the grey it started as. The first
 * version of this gradient ran the other way and rendered an empty gallery in
 * flat white static.
 *
 * There is deliberately no cyan stop. Cyan carries very little chroma in
 * CIELAB while being extremely luminous, so every version that included one
 * either failed the chroma floor or put a bright spike early in the ramp, which
 * made barely-remembered ground glow brighter than a body. Indigo through gold
 * climbs in brightness the whole way, which is what makes presence read as heat.
 *
 * The sweep is deliberately full-gamut, and `swarm.test.ts` fails if the chroma
 * ever drains back out of it.
 */
export const SWARM_GRADIENT: ReadonlyArray<{ at: number; rgb: Rgb }> = [
  { at: 0, rgb: [16, 46, 104] },
  { at: 0.2, rgb: [88, 52, 230] },
  { at: 0.4, rgb: [40, 120, 255] },
  { at: 0.58, rgb: [176, 100, 255] },
  { at: 0.74, rgb: [255, 64, 150] },
  { at: 0.89, rgb: [255, 196, 64] },
  { at: 1, rgb: [255, 246, 220] },
];

/**
 * Sample the gradient. `t` is clamped, so callers need not bound it.
 *
 * `stops` exists so the degenerate-table guard below is reachable from a test:
 * with the committed table no two adjacent stops share an `at`, so a zero span
 * is a claim about a table nobody has written yet rather than about this one.
 */
export function sampleSwarmGradient(t: number, stops: ReadonlyArray<{ at: number; rgb: Rgb }> = SWARM_GRADIENT): Rgb {
  const position = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  let low = stops[0];
  let high = stops[stops.length - 1];
  for (let index = 0; index < stops.length - 1; index += 1) {
    if (position >= stops[index].at && position <= stops[index + 1].at) {
      low = stops[index];
      high = stops[index + 1];
      break;
    }
  }
  const span = high.at - low.at;
  const mix = span <= 0 ? 0 : (position - low.at) / span;
  return [
    low.rgb[0] + (high.rgb[0] - low.rgb[0]) * mix,
    low.rgb[1] + (high.rgb[1] - low.rgb[1]) * mix,
    low.rgb[2] + (high.rgb[2] - low.rgb[2]) * mix,
  ];
}

/** Width of the gradient lookup texture handed to the shader. */
export const SWARM_LUT_WIDTH = 256;

/**
 * RGBA bytes for the shader's gradient lookup, built from `SWARM_GRADIENT`.
 *
 * The buffer type is named because WebGPU's `writeTexture` refuses a view that
 * might sit on a `SharedArrayBuffer`, and the inferred `Uint8Array` is exactly
 * that "might".
 */
export function buildSwarmGradientLut(): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(SWARM_LUT_WIDTH * 4);
  for (let index = 0; index < SWARM_LUT_WIDTH; index += 1) {
    const rgb = sampleSwarmGradient(index / (SWARM_LUT_WIDTH - 1));
    data[index * 4] = Math.round(rgb[0]);
    data[index * 4 + 1] = Math.round(rgb[1]);
    data[index * 4 + 2] = Math.round(rgb[2]);
    data[index * 4 + 3] = 255;
  }
  return data;
}

/** CIELAB chroma. The numerical form of "this colour has not gone grey". */
export function chroma(rgb: Rgb): number {
  const [, a, b] = cielab(rgb);
  return Math.hypot(a, b);
}

/**
 * How hard the swarm answers the room. These are the numbers that decide
 * whether a visitor knows within a second that they are causing something,
 * which is the difference between an installation and a screensaver.
 */
export type SwarmDynamics = {
  /** Radius, in room units, over which a body displaces particles. */
  readonly bodyRadius: number;
  /** Outward push from a body. Large on purpose: the response must be obvious. */
  readonly bodyPush: number;
  /**
   * Tangential drag. Larger than it looks it should be: a body has to read as
   * a vortex the field gathers around, not as a hole it flees from.
   */
  readonly bodySwirl: number;
  /** How strongly accumulated memory steers the flow. */
  readonly memoryFlow: number;
  /**
   * Ambient curl so the field is never still, even in an empty room. Also what
   * keeps particles spread across the whole wall: with memory flow dominant the
   * swarm collapses onto its ridges and a visitor standing anywhere else gets
   * no answer at all.
   */
  readonly ambientCurl: number;
  /** Per-second velocity retention. */
  readonly damping: number;
  /** Seconds a particle lives before it is respawned into the memory field. */
  readonly life: number;
  /**
   * Attraction toward occupied motion cells, which gathers particles onto the
   * outline of whoever is actually standing there.
   *
   * This is the leg the piece was missing. A visitor could see that the field
   * answered *something*, but never that it answered *them*. Seeing your own
   * shape is what collapses the attribution — it is the same move a live
   * camera feed makes in a queue-line gag, done here from a 40x23 occupancy
   * grid so no image of anyone is ever handled.
   */
  readonly silhouettePull: number;
};

export const SWARM_DYNAMICS: SwarmDynamics = {
  bodyRadius: 0.14,
  bodyPush: 7.5,
  bodySwirl: 5.2,
  memoryFlow: 0.5,
  ambientCurl: 1.3,
  damping: 0.055,
  life: 6,
  silhouettePull: 0.9,
};

/**
 * Time for a body's push to travel one particle-visible distance, used by the
 * tests as a stand-in for "can a visitor tell they did that". A body moving at
 * a walking pace must displace particles faster than the eye's roughly 100 ms
 * change-detection window.
 */
export function bodyResponseSeconds(dynamics: SwarmDynamics = SWARM_DYNAMICS): number {
  // Distance covered under constant acceleration `bodyPush` to clear a
  // noticeable fraction (10%) of the body's own radius.
  const distance = dynamics.bodyRadius * 0.1;
  return Math.sqrt((2 * distance) / dynamics.bodyPush);
}

// ---------------------------------------------------------------------------
// Recalled memories, walking the room as bodies.
// ---------------------------------------------------------------------------

/** The six ways the room can bring something back. */
export type RecallKind = 'ghost' | 'stillness' | 'empty' | 'return' | 'convergence' | 'false';

/**
 * How long a recall takes to cross the room, and how warm it runs.
 *
 * A recall is rendered as a body: the same vortex, the same gathering shell,
 * the same heat as a living visitor. That is the point of the piece — alone in
 * the room, you cannot tell what the room is remembering from who is actually
 * there.
 *
 * The exception is `false`. A composite memory walks a route nobody ever walked,
 * and it runs cold: present and moving, but never warm. Nothing labels it. A
 * visitor is simply left with the sense that something over there is not alive.
 */
export type RecallPresentation = {
  readonly durationMs: number;
  /** Scales the body's contribution to colour temperature. 1 is a living body. */
  readonly heat: number;
};

export const RECALL_PRESENTATION = {
  ghost: { durationMs: 11_000, heat: 0.85 },
  stillness: { durationMs: 16_000, heat: 0.72 },
  empty: { durationMs: 15_000, heat: 0.66 },
  return: { durationMs: 9_000, heat: 0.95 },
  convergence: { durationMs: 18_000, heat: 1 },
  false: { durationMs: 13_000, heat: 0.34 },
} as const satisfies Record<RecallKind, RecallPresentation>;

/** A recalled memory expressed as something the swarm can respond to. */
export type RecallBody = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Envelope so a recall swells and subsides rather than appearing outright. */
  strength: number;
  heat: number;
};

/** How far ahead of linear progress the travelling head runs. */
const HEAD_LEAD = 1.35;

/**
 * The position, heading and weight of a recall part-way through its crossing.
 * Returns null once it is finished, or if the path is too short to walk.
 */
export function recallBody(
  path: ReadonlyArray<{ x: number; y: number }>,
  kind: RecallKind,
  elapsedMs: number,
  ghostStrength: number,
): RecallBody | null {
  const presentation = RECALL_PRESENTATION[kind];
  if (!presentation || path.length < 2) return null;
  const progress = elapsedMs / presentation.durationMs;
  if (!Number.isFinite(progress) || progress < 0 || progress >= 1) return null;

  const lastIndex = path.length - 1;
  const head = Math.min(1, progress * HEAD_LEAD);
  const index = Math.min(lastIndex, Math.max(1, Math.round(lastIndex * head)));
  const here = path[index];
  const behind = path[index - 1];

  // Index advance per second, so the body's velocity matches how fast the room
  // is actually re-walking the path rather than being an arbitrary constant.
  const indicesPerSecond = (lastIndex * HEAD_LEAD) / (presentation.durationMs / 1000);

  return {
    x: here.x,
    y: here.y,
    vx: (here.x - behind.x) * indicesPerSecond,
    vy: (here.y - behind.y) * indicesPerSecond,
    strength: Math.sin(Math.min(1, progress) * Math.PI) * Math.max(0, Math.min(1, ghostStrength)),
    heat: presentation.heat,
  };
}
