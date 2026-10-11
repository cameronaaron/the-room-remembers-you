/**
 * One frame on the wall: what is painted, in what order, over what.
 *
 * The composite is the artwork. Six layers land on the projection surface in a
 * fixed sequence — accumulated light, the memory field under it, a bloom pass
 * of the same light, recent trails, recalls, ambient and grain — and each one
 * carries its own blend mode and blur from the palette. Reordering two of them
 * or leaking a `globalAlpha` across a `save` boundary produces a frame that is
 * wrong in a way no numeric test of the data model can see.
 *
 * It is here so that `test-doubles/canvas-2d.ts` can be handed the same
 * sequence a projector gets and asked what was drawn, and how much. That
 * answers "did this paint at all", which is the failure that matters: a drawing
 * function that quietly draws nothing is indistinguishable from an empty
 * gallery.
 */
import { depositPerFrame, retentionPerFrame, rgbCss, type Palette, type PersonalityRender } from './palette.ts';
import { paintMemory } from './room-canvas.ts';
import {
  drawAmbient,
  drawCalibration,
  drawClosingMontage,
  drawRecalls,
  drawRecentTrails,
  drawTracks,
  drawTrackingOverlay,
} from './room-drawing.ts';
import { memoryDensity } from './memory-engine.ts';
import type { ActiveGhost, Ghost, RoomConfig, VisitorTrack } from './room-types.ts';

/**
 * How often the memory field is re-rasterised. It is a slow, blurred wash;
 * repainting it every frame costs a full field traversal for a difference
 * nobody standing in the room can see.
 */
export const MEMORY_REPAINT_MS = 700;

/** Largest step the particle simulation will integrate over. */
export const MAX_SWARM_STEP_SECONDS = 0.05;
/** Largest step the retina will fade over, so one stall cannot wipe it. */
export const MAX_RETINA_STEP_SECONDS = 0.5;
/** The step assumed before there is a previous frame to measure against. */
export const ASSUMED_STEP_SECONDS = 1 / 60;

/** Something with a mutable `current`, which is what `drawRecalls` prunes through. */
type Holder<T> = { current: T };

/**
 * The per-frame timing and resize state the draw loop carries between frames.
 *
 * Held as an object rather than as closure variables so a test can drive a
 * stall, a resize or a run of even frames without a window to resize.
 */
export class FramePacer {
  private lastKey = '';
  /** null rather than 0: zero is a clock reading, not the absence of one. */
  private lastSwarmAt: number | null = null;
  private lastRetinaAt: number | null = null;
  private lastMemoryAt: number | null = null;

  /**
   * Whether the surface changed shape. A resize discards both accumulation
   * clocks: the buffers behind them have just been reallocated, so the elapsed
   * time since the last frame describes light that no longer exists.
   */
  resized(key: string): boolean {
    if (key === this.lastKey) return false;
    this.lastKey = key;
    this.lastSwarmAt = null;
    this.lastRetinaAt = null;
    return true;
  }

  swarmDelta(now: number): number {
    const delta = step(this.lastSwarmAt, now, MAX_SWARM_STEP_SECONDS);
    this.lastSwarmAt = now;
    return delta;
  }

  retinaDelta(now: number): number {
    const delta = step(this.lastRetinaAt, now, MAX_RETINA_STEP_SECONDS);
    this.lastRetinaAt = now;
    return delta;
  }

  /** True at most once per `MEMORY_REPAINT_MS`, and always on the first frame. */
  memoryDue(now: number): boolean {
    if (this.lastMemoryAt !== null && now - this.lastMemoryAt <= MEMORY_REPAINT_MS) return false;
    this.lastMemoryAt = now;
    return true;
  }
}

/**
 * Seconds since the previous frame, capped.
 *
 * Uncapped, a tab that was backgrounded for a minute returns with a sixty
 * second step: the particle field integrates every visitor straight off the
 * wall and the retina fades to black in one frame. The cap makes a stall look
 * like a slow frame, which is what it should look like.
 */
export function step(lastAt: number | null, now: number, maxSeconds: number): number {
  if (lastAt === null) return ASSUMED_STEP_SECONDS;
  return Math.min(maxSeconds, (now - lastAt) / 1000);
}

/** Every frame starts from a known context state; blend modes do not carry over. */
export function resetContext(context: CanvasRenderingContext2D) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = 1;
  context.filter = 'none';
}

/**
 * The ground the frame is built on. Under the particle field the 2D layer is a
 * transparent overlay for operator marks only, so it is cleared rather than
 * filled — filling it would hide the GPU surface underneath entirely.
 */
export function paintGround(
  context: CanvasRenderingContext2D,
  options: { width: number; height: number; palette: Palette; blackout: boolean; overlayOnly: boolean },
) {
  if (options.overlayOnly) {
    context.clearRect(0, 0, options.width, options.height);
    return;
  }
  context.fillStyle = options.blackout ? '#000000' : rgbCss(options.palette.ground);
  context.fillRect(0, 0, options.width, options.height);
}

/** The surfaces a trace frame composites through. */
export type TraceLayers = {
  /** The projection surface itself. */
  context: CanvasRenderingContext2D;
  /** The accumulation buffer: light the room has already emitted. */
  retina: CanvasRenderingContext2D;
  retinaCanvas: CanvasImageSource & { width: number; height: number };
  /** The memory field, rasterised at field resolution. */
  memory: CanvasRenderingContext2D;
  memoryCanvas: CanvasImageSource;
  grain: CanvasImageSource;
};

export type TraceFrame = {
  width: number;
  height: number;
  /** Animation clock, for anything being presented. */
  now: number;
  /** Wall clock, for anything a memory records about itself. */
  wall: number;
  config: RoomConfig;
  palette: Palette;
  personality: PersonalityRender;
  field: Float32Array;
  tracks: readonly VisitorTrack[];
  ghosts: Ghost[];
  /** Pruned in place by `drawRecalls` as presentations finish. */
  active: Holder<ActiveGhost[]>;
  retinaDeltaSeconds: number;
  repaintMemory: boolean;
  /** Milliseconds into the closing ritual, or 0 when the room is not closing. */
  closingElapsed: number;
  day: number;
};

export function paintTraceFrame(layers: TraceLayers, frame: TraceFrame) {
  const { context, retina } = layers;
  const { width, height, palette, personality, config } = frame;
  const retention = retentionPerFrame(personality.retention, frame.retinaDeltaSeconds);
  // Lay down only what this frame lost, so continuously drawn marks settle on
  // their declared alpha instead of integrating to white.
  const deposit = depositPerFrame(retention);

  // Forgetting, applied to the light rather than to the data.
  resetContext(retina);
  retina.globalCompositeOperation = 'destination-out';
  retina.fillStyle = `rgba(0, 0, 0, ${deposit})`;
  retina.fillRect(0, 0, layers.retinaCanvas.width, layers.retinaCanvas.height);

  // The retina holds the present only: bodies in the room now, and the
  // afterimage they leave as they move. Everything older is already recorded in
  // the light this buffer is still holding, so re-drawing stored history into
  // it would deposit the same minutes over and over until every channel clipped
  // and the palette's hues went white.
  retina.globalCompositeOperation = palette.marks.presentPath.composite;
  drawTracks(
    retina,
    frame.tracks,
    layers.retinaCanvas.width,
    layers.retinaCanvas.height,
    frame.now,
    config.visualIntensity * deposit,
    personality,
    config,
    palette,
  );

  if (frame.repaintMemory) paintMemory(layers.memory, frame.field, config.visualIntensity, palette);

  context.save();
  context.globalCompositeOperation = palette.marks.memoryField.composite;
  context.globalAlpha = 0.5 * config.visualIntensity * personality.drift;
  context.filter = `blur(${Math.max(16, width * 0.012)}px)`;
  context.drawImage(layers.memoryCanvas, -width * 0.015, -height * 0.015, width * 1.03, height * 1.03);
  context.restore();

  context.save();
  context.globalCompositeOperation = palette.marks.presentPath.composite;
  context.filter = `blur(${Math.max(1, width * 0.0016)}px)`;
  context.drawImage(layers.retinaCanvas, 0, 0, width, height);
  context.restore();

  // Bloom: the same light again, wide and soft, so a mark reads as glow on the
  // wall rather than as a drawn line.
  context.save();
  context.globalCompositeOperation = palette.marks.presentPath.composite;
  context.globalAlpha = 0.32 * config.visualIntensity * personality.presence;
  context.filter = `blur(${Math.max(10, width * 0.011)}px)`;
  context.drawImage(layers.retinaCanvas, 0, 0, width, height);
  context.restore();

  // Everything below is a performance rather than a presence: each carries its
  // own fade envelope and is painted straight to the wall, so none of it
  // integrates and none of it can clip the accumulated image.
  context.save();
  context.globalCompositeOperation = palette.marks.recentTrail.composite;
  context.filter = `blur(${Math.max(1, width * 0.0014)}px)`;
  drawRecentTrails(context, frame.ghosts, width, height, frame.wall, config.visualIntensity, palette);
  context.restore();

  context.save();
  context.globalCompositeOperation = palette.marks.ghostRecall.composite;
  context.filter = `blur(${Math.max(1, width * 0.0022)}px)`;
  drawRecalls(context, frame.active, width, height, frame.now, config.visualIntensity, palette, personality);
  if (frame.closingElapsed) {
    drawClosingMontage(
      context,
      frame.ghosts.filter((ghost) => ghost.day === frame.day),
      width,
      height,
      frame.closingElapsed,
      palette,
    );
  }
  context.restore();

  drawAmbient(
    context,
    width,
    height,
    frame.now,
    memoryDensity(frame.field),
    personality,
    palette,
    config.visualIntensity,
  );

  context.save();
  context.globalAlpha = palette.mode === 'room' ? 0.05 : 0.035;
  context.globalCompositeOperation = palette.mode === 'room' ? 'lighter' : 'multiply';
  context.drawImage(layers.grain, 0, 0, width, height);
  context.restore();
}

/**
 * Operator marks, drawn last and over everything.
 *
 * They are the only part of the frame addressed to a person rather than to the
 * room, so they are never blurred, never blended and never affected by the
 * projection palette's composite modes.
 */
export function paintOverlays(
  context: CanvasRenderingContext2D,
  options: {
    width: number;
    height: number;
    now: number;
    config: RoomConfig;
    palette: Palette;
    tracks: readonly VisitorTrack[];
    trackingOverlay: boolean;
    calibrationStep: number | null;
  },
) {
  resetContext(context);
  if (options.trackingOverlay) {
    drawTrackingOverlay(context, options.tracks, options.width, options.height, options.now, options.config);
  }
  if (options.calibrationStep !== null) {
    drawCalibration(context, options.width, options.height, options.calibrationStep, options.palette);
  }
}
