import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASSUMED_STEP_SECONDS,
  FramePacer,
  MAX_RETINA_STEP_SECONDS,
  MAX_SWARM_STEP_SECONDS,
  MEMORY_REPAINT_MS,
  paintGround,
  paintOverlays,
  paintTraceFrame,
  resetContext,
  step,
  type TraceLayers,
} from './room-frame.ts';
import { PERSONALITY_RENDER, paletteFor, type PersonalityRender } from './palette.ts';
import { createMemoryField, depositMemory } from './memory-engine.ts';
import { recordingContext } from './test-doubles/canvas-2d.ts';
import { DEFAULT_CONFIG, type ActiveGhost, type Ghost } from './room-types.ts';
import { ghost, track } from './test-doubles/room.ts';

const NOW = 50_000;
const WALL = 1_700_000_000_000;

function layers(): TraceLayers & { context: ReturnType<typeof recordingContext> } {
  const context = recordingContext();
  return {
    context,
    retina: recordingContext(),
    retinaCanvas: { width: 640, height: 360 } as TraceLayers['retinaCanvas'],
    memory: recordingContext(),
    memoryCanvas: {} as TraceLayers['memoryCanvas'],
    grain: {} as TraceLayers['grain'],
  };
}

const field = () => {
  const values = createMemoryField();
  depositMemory(values, { x: 0.5, y: 0.5 }, 0.4, 5);
  return values;
};

const frame = (overrides: Partial<Parameters<typeof paintTraceFrame>[1]> = {}) => ({
  width: 1280,
  height: 720,
  now: NOW,
  wall: WALL,
  config: DEFAULT_CONFIG,
  palette: paletteFor('room'),
  personality: PERSONALITY_RENDER.curious,
  field: field(),
  tracks: [track()],
  ghosts: [ghost({ createdAt: WALL - 10_000 })],
  active: { current: [] as ActiveGhost[] },
  retinaDeltaSeconds: 1 / 60,
  repaintMemory: true,
  closingElapsed: 0,
  day: 1,
  ...overrides,
});

void test('a frame actually puts light on the wall', () => {
  // The failure this whole module exists to catch: a draw path that quietly
  // does nothing is indistinguishable from an empty gallery.
  const surfaces = layers();
  paintTraceFrame(surfaces, frame());
  assert.ok(surfaces.context.markCount > 0, 'nothing was drawn');
  assert.ok((surfaces.retina as ReturnType<typeof recordingContext>).markCount > 0, 'the retina took no light');
});

void test('every layer is balanced, so no blend mode leaks into the next frame', () => {
  // A `save` without its `restore` leaves a composite operation and a blur set
  // on a context that the next frame then paints the room's ground with.
  const surfaces = layers();
  paintTraceFrame(surfaces, frame());
  assert.equal(
    surfaces.context.countOf('save'),
    surfaces.context.countOf('restore'),
  );
  assert.ok(surfaces.context.countOf('save') >= 5, 'the composite is layered, not flat');
});

void test('the accumulated light is faded before anything is added to it', () => {
  // Forgetting is applied to the light rather than to the data. Drawing first
  // and fading afterwards erases the frame that was just drawn.
  const surfaces = layers();
  const retina = surfaces.retina as ReturnType<typeof recordingContext>;
  paintTraceFrame(surfaces, frame());
  const fadeAt = retina.calls.findIndex((call) => call.method === 'fillRect');
  const drawAt = retina.calls.findIndex((call) => call.method !== 'fillRect' && call.method !== 'setTransform');
  assert.ok(fadeAt >= 0, 'the retina was never faded');
  assert.ok(fadeAt < retina.calls.length - 1);
  assert.ok(drawAt === -1 || fadeAt < drawAt);
  assert.ok(retina.valuesOf('globalCompositeOperation').includes('destination-out'));
});

void test('a slower frame fades more light than a fast one', () => {
  // Forgetting is per second, not per frame: a CHEAP machine at 20 fps has to
  // forget at the same rate as a FULL one at 60, or the piece is a different
  // piece on each.
  const alpha = (deltaSeconds: number) => {
    const surfaces = layers();
    paintTraceFrame(surfaces, frame({ retinaDeltaSeconds: deltaSeconds }));
    const fill = (surfaces.retina as ReturnType<typeof recordingContext>)
      .valuesOf('fillStyle')
      .find((value) => String(value).startsWith('rgba'));
    return Number(/([\d.]+)\)$/.exec(String(fill))![1]);
  };
  assert.ok(alpha(1 / 20) > alpha(1 / 60));
});

void test('the memory field is only re-rasterised when it is due', () => {
  const painted = layers();
  paintTraceFrame(painted, frame({ repaintMemory: true }));
  assert.ok((painted.memory as ReturnType<typeof recordingContext>).calls.length > 0);
  const skipped = layers();
  paintTraceFrame(skipped, frame({ repaintMemory: false }));
  assert.equal((skipped.memory as ReturnType<typeof recordingContext>).calls.length, 0);
  // It is still composited either way: the wash is on the wall between repaints.
  assert.equal(skipped.context.countOf('drawImage'), painted.context.countOf('drawImage'));
});

void test('the closing montage is drawn only during the closing ritual', () => {
  const ordinary = layers();
  paintTraceFrame(ordinary, frame({ closingElapsed: 0 }));
  const closing = layers();
  paintTraceFrame(closing, frame({ closingElapsed: 4_000 }));
  assert.ok(closing.context.markCount > ordinary.context.markCount);
});

void test('the ground is filled for traces and cleared under the particle field', () => {
  // Filling it under the swarm would hide the GPU surface entirely; clearing it
  // for traces would leave the room black.
  const filled = recordingContext();
  paintGround(filled, { width: 100, height: 100, palette: paletteFor('room'), blackout: false, overlayOnly: false });
  assert.equal(filled.countOf('fillRect'), 1);
  assert.equal(filled.countOf('clearRect'), 0);
  const overlay = recordingContext();
  paintGround(overlay, { width: 100, height: 100, palette: paletteFor('room'), blackout: false, overlayOnly: true });
  assert.equal(overlay.countOf('clearRect'), 1);
  assert.equal(overlay.countOf('fillRect'), 0);
});

void test('blackout is black, not the palette dimmed', () => {
  const context = recordingContext();
  paintGround(context, { width: 10, height: 10, palette: paletteFor('room'), blackout: true, overlayOnly: false });
  assert.deepEqual(context.valuesOf('fillStyle'), ['#000000']);
});

void test('operator marks are never blurred or blended', () => {
  // They are the only part of the frame addressed to a person rather than to
  // the room.
  const context = recordingContext();
  paintOverlays(context, {
    width: 800, height: 600, now: NOW, config: DEFAULT_CONFIG, palette: paletteFor('room'),
    tracks: [track()], trackingOverlay: true, calibrationStep: 1,
  });
  assert.equal(context.valuesOf('filter')[0], 'none');
  assert.equal(context.valuesOf('globalCompositeOperation')[0], 'source-over');
  assert.ok(context.markCount > 0);
});

void test('overlays that are off draw nothing at all', () => {
  const context = recordingContext();
  paintOverlays(context, {
    width: 800, height: 600, now: NOW, config: DEFAULT_CONFIG, palette: paletteFor('room'),
    tracks: [track()], trackingOverlay: false, calibrationStep: null,
  });
  assert.equal(context.markCount, 0);
});

void test('calibration step zero is a step, not an absent one', () => {
  // `if (!step)` here means the first marker is never drawn and the operator
  // aligns the room against a corner that is not on the wall.
  const context = recordingContext();
  paintOverlays(context, {
    width: 800, height: 600, now: NOW, config: DEFAULT_CONFIG, palette: paletteFor('room'),
    tracks: [], trackingOverlay: false, calibrationStep: 0,
  });
  assert.ok(context.markCount > 0);
});

void test('a context is handed back in a known state', () => {
  const context = recordingContext();
  resetContext(context);
  assert.deepEqual(context.valuesOf('globalAlpha'), [1]);
  assert.deepEqual(context.valuesOf('filter'), ['none']);
  assert.deepEqual(context.valuesOf('globalCompositeOperation'), ['source-over']);
  assert.equal(context.countOf('setTransform'), 1);
});

void test('a backgrounded tab does not return and erase the room', () => {
  // Uncapped, a sixty second step integrates every visitor off the wall and
  // fades the retina to black in one frame. A stall must look like a slow frame.
  assert.equal(step(0, 60_000, MAX_SWARM_STEP_SECONDS), MAX_SWARM_STEP_SECONDS);
  assert.equal(step(0, 60_000, MAX_RETINA_STEP_SECONDS), MAX_RETINA_STEP_SECONDS);
  assert.equal(step(null, 60_000, MAX_RETINA_STEP_SECONDS), ASSUMED_STEP_SECONDS);
  assert.ok(Math.abs(step(1_000, 1_016, MAX_SWARM_STEP_SECONDS) - 0.016) < 1e-9);
});

void test('the pacer notices a resize once, and only once', () => {
  const pacer = new FramePacer();
  assert.equal(pacer.resized('1280x720'), true, 'the first frame must size its buffers');
  assert.equal(pacer.resized('1280x720'), false);
  assert.equal(pacer.resized('1920x1080'), true);
});

void test('a resize discards the clocks of the buffers it reallocated', () => {
  // The elapsed time since the last frame describes light that no longer
  // exists, so integrating over it fades a buffer that was just created.
  const pacer = new FramePacer();
  pacer.resized('a');
  pacer.retinaDelta(1_000);
  pacer.swarmDelta(1_000);
  pacer.resized('b');
  assert.equal(pacer.retinaDelta(9_000), ASSUMED_STEP_SECONDS);
  assert.equal(pacer.swarmDelta(9_000), ASSUMED_STEP_SECONDS);
});

void test('the memory field paints on the first frame and then at its own pace', () => {
  // Starting from zero made this a warmup as well as a rate: for the first
  // seven-tenths of a second of a session the field could not be painted, and a
  // rAF clock starts at zero.
  const pacer = new FramePacer();
  assert.equal(pacer.memoryDue(0), true);
  assert.equal(pacer.memoryDue(MEMORY_REPAINT_MS), false);
  assert.equal(pacer.memoryDue(MEMORY_REPAINT_MS + 1), true);
});

/** Blur radius in pixels from a `filter` value, or 0 for `none`. */
function blurOf(filter: unknown): number {
  const match = /blur\(([\d.]+)px\)/.exec(String(filter));
  return match ? Number(match[1]) : 0;
}

void test('each layer lands under its own blend mode from the palette', () => {
  // The composite is the artwork. A layer drawn under the wrong blend reads as
  // a different piece, and nothing about the data model would have changed.
  const surfaces = layers();
  const palette = paletteFor('room');
  paintTraceFrame(surfaces, frame({ palette }));
  const modes = surfaces.context.valuesOf('globalCompositeOperation');
  assert.ok(modes.includes(palette.marks.memoryField.composite));
  assert.ok(modes.includes(palette.marks.presentPath.composite));
  assert.ok(modes.includes(palette.marks.recentTrail.composite));
  assert.ok(modes.includes(palette.marks.ghostRecall.composite));
});

void test('the memory field is washed over the wall wider than the wall', () => {
  // A blurred field clipped to the frame shows its own edges as a rectangle of
  // light, which is the one shape that never appears in this room.
  const surfaces = layers();
  paintTraceFrame(surfaces, frame({ width: 1000, height: 800 }));
  const wash = surfaces.context.callsTo('drawImage')[0];
  const [, x, y, w, h] = wash.args as number[];
  assert.ok(x < 0 && y < 0, 'the wash must start outside the frame');
  assert.ok(w > 1000 && h > 800, 'and finish outside it');
});

void test('the accumulated light is drawn to the frame exactly, twice', () => {
  // Once sharp and once as bloom. Offsetting or rescaling either one puts the
  // glow somewhere the mark is not.
  const surfaces = layers();
  paintTraceFrame(surfaces, frame({ width: 1000, height: 800 }));
  const retinaDraws = surfaces.context.callsTo('drawImage')
    .filter((call) => call.args[0] === surfaces.retinaCanvas);
  assert.equal(retinaDraws.length, 2);
  for (const draw of retinaDraws) assert.deepEqual(draw.args.slice(1), [0, 0, 1000, 800]);
});

void test('the bloom is wider and fainter than the light it blooms', () => {
  const surfaces = layers();
  paintTraceFrame(surfaces, frame({ width: 1200 }));
  const blurs = surfaces.context.valuesOf('filter').map(blurOf).filter((value) => value > 0);
  const alphas = surfaces.context.valuesOf('globalAlpha').map(Number);
  assert.ok(Math.max(...blurs) >= 10, 'nothing in this frame is drawn hard-edged');
  // A bloom at full alpha is a second copy of the image, not a glow.
  assert.ok(alphas.some((alpha) => alpha > 0 && alpha < 0.5));
});

void test('every blur scales with the surface, so a 4K wall is not a sharper piece', () => {
  const blurs = (width: number) => {
    const surfaces = layers();
    paintTraceFrame(surfaces, frame({ width, height: Math.round(width * 0.5625) }));
    return surfaces.context.valuesOf('filter').map(blurOf).filter((value) => value > 0);
  };
  const small = blurs(1280);
  const large = blurs(3840);
  assert.equal(small.length, large.length);
  assert.ok(large.some((value, index) => value > small[index]), 'no blur followed the surface');
  for (const [index, value] of large.entries()) assert.ok(value >= small[index]);
});

void test('the memory wash follows the room\'s drift and the bloom its presence', () => {
  // Both are personality, and swapping them makes a dormant room glow and a
  // crowded one go flat.
  const alphas = (personality: PersonalityRender) => {
    const surfaces = layers();
    paintTraceFrame(surfaces, frame({ personality }));
    return surfaces.context.valuesOf('globalAlpha').map(Number);
  };
  const calm = PERSONALITY_RENDER.dormant;
  const busy = PERSONALITY_RENDER.overwhelmed;
  assert.notDeepEqual(alphas(calm), alphas(busy));
  const dimmed = alphas({ ...PERSONALITY_RENDER.curious, drift: 0, presence: 0 });
  assert.ok(dimmed.includes(0), 'a room with no drift still washed its memory field over the wall');
});

void test('intensity reaches every layer of the room\'s own light', () => {
  // The operator's one brightness control. A layer that ignores it stays lit
  // when the room is turned down for a dark gallery.
  //
  // The grain is deliberately outside this: it is a property of the projection
  // surface rather than of the room, so it holds its alpha while the light in
  // front of it dims. It is the last thing drawn, hence `slice(0, -1)`.
  const alphas = (visualIntensity: number) => {
    const surfaces = layers();
    paintTraceFrame(surfaces, frame({ config: { ...DEFAULT_CONFIG, visualIntensity } }));
    return surfaces.context.valuesOf('globalAlpha').map(Number).filter((value) => value < 1).slice(0, -1);
  };
  const bright = alphas(1);
  const dim = alphas(0.2);
  assert.ok(bright.length >= 2);
  assert.equal(bright.length, dim.length);
  for (const [index, value] of dim.entries()) assert.ok(value < bright[index], `layer ${index}`);
});

void test('the grain is added in a dark room and multiplied on paper', () => {
  // Light on a wall adds; ink on paper takes light away. The same grain in the
  // wrong mode is a grey veil over a white sheet.
  const modeOf = (mode: 'room' | 'paper') => {
    const surfaces = layers();
    paintTraceFrame(surfaces, frame({ palette: paletteFor(mode) }));
    return {
      composite: surfaces.context.valuesOf('globalCompositeOperation').at(-1),
      alpha: Number(surfaces.context.valuesOf('globalAlpha').at(-1)),
    };
  };
  const room = modeOf('room');
  const paper = modeOf('paper');
  assert.equal(room.composite, 'lighter');
  assert.equal(paper.composite, 'multiply');
  assert.ok(room.alpha > paper.alpha, 'a projector needs more grain than a sheet of paper');
});

void test('the closing montage shows today, not the whole archive', () => {
  const today = ghost({ id: 'today', day: 3, createdAt: WALL - 1_000 });
  const older = ghost({ id: 'older', day: 1, createdAt: WALL - 90_000_000 });
  const withBoth = layers();
  paintTraceFrame(withBoth, frame({ ghosts: [today, older], day: 3, closingElapsed: 4_000 }));
  const onlyOld = layers();
  paintTraceFrame(onlyOld, frame({ ghosts: [older], day: 3, closingElapsed: 4_000 }));
  assert.ok(
    withBoth.context.markCount > onlyOld.context.markCount,
    'the montage drew the same thing with and without a memory from today',
  );
});

void test('the tracking overlay is what the tracking overlay draws', () => {
  // Checked on its own rather than alongside calibration: the two are drawn by
  // the same call and a test that turns both on cannot tell which one painted.
  const on = recordingContext();
  paintOverlays(on, {
    width: 800, height: 600, now: NOW, config: DEFAULT_CONFIG, palette: paletteFor('room'),
    tracks: [track()], trackingOverlay: true, calibrationStep: null,
  });
  assert.ok(on.markCount > 0);
  const off = recordingContext();
  paintOverlays(off, {
    width: 800, height: 600, now: NOW, config: DEFAULT_CONFIG, palette: paletteFor('room'),
    tracks: [track()], trackingOverlay: false, calibrationStep: null,
  });
  assert.equal(off.markCount, 0);
});

void test('an empty room still paints its field, trails and ambience', () => {
  // The piece with nobody in it is the piece: a frame that only draws when
  // somebody is present is a dark wall for most of a gallery day.
  const surfaces = layers();
  paintTraceFrame(surfaces, frame({ tracks: [] }));
  assert.ok(surfaces.context.markCount >= 5);
});

void test('the retina is faded across its whole surface, at its own size', () => {
  // Fading the frame's dimensions into a half-resolution buffer leaves three
  // quarters of the accumulated light never forgotten.
  const surfaces = layers();
  paintTraceFrame(surfaces, frame({ width: 1280, height: 720 }));
  const retina = surfaces.retina as ReturnType<typeof recordingContext>;
  const fade = retina.callsTo('fillRect')[0];
  assert.deepEqual(fade.args, [0, 0, surfaces.retinaCanvas.width, surfaces.retinaCanvas.height]);
});

void test('a frame with no retina delta still deposits something', () => {
  // The first frame of a session has no previous frame to measure against.
  const surfaces = layers();
  paintTraceFrame(surfaces, frame({ retinaDeltaSeconds: ASSUMED_STEP_SECONDS }));
  const retina = surfaces.retina as ReturnType<typeof recordingContext>;
  const fill = retina.valuesOf('fillStyle').find((value) => String(value).startsWith('rgba'));
  const alpha = Number(/([\d.]+)\)$/.exec(String(fill))![1]);
  assert.ok(alpha > 0 && alpha < 1);
});

void test('the whole composite, measured, at a known surface size', () => {
  // The one test that pins the geometry rather than describing it. Every
  // number here is a decision about how the room looks from across a gallery,
  // and each was previously only checkable by projecting it onto a wall.
  const surfaces = layers();
  const personality = PERSONALITY_RENDER.curious;
  const config = { ...DEFAULT_CONFIG, visualIntensity: 0.85 };
  paintTraceFrame(surfaces, frame({ width: 1000, height: 800, personality, config }));

  // Five blurred layers, in order: the memory wash, the accumulated light, its
  // bloom, recent trails, and recalls. Each has a floor so the layer stays soft
  // on a small surface and a width term so it stays soft on a large one.
  assert.deepEqual(surfaces.context.valuesOf('filter'), [
    `blur(${Math.max(16, 1000 * 0.012)}px)`,
    `blur(${Math.max(1, 1000 * 0.0016)}px)`,
    `blur(${Math.max(10, 1000 * 0.011)}px)`,
    `blur(${Math.max(1, 1000 * 0.0014)}px)`,
    `blur(${Math.max(1, 1000 * 0.0022)}px)`,
  ]);

  // Three layers carry an alpha: the wash follows the room's drift, the bloom
  // its presence, and the grain is fixed because it belongs to the surface.
  assert.deepEqual(surfaces.context.valuesOf('globalAlpha'), [
    0.5 * config.visualIntensity * personality.drift,
    0.32 * config.visualIntensity * personality.presence,
    0.05,
  ]);

  // The wash over-scans; everything else lands on the frame exactly.
  assert.deepEqual(surfaces.context.callsTo('drawImage').map((call) => call.args), [
    [surfaces.memoryCanvas, -1000 * 0.015, -800 * 0.015, 1000 * 1.03, 800 * 1.03],
    [surfaces.retinaCanvas, 0, 0, 1000, 800],
    [surfaces.retinaCanvas, 0, 0, 1000, 800],
    [surfaces.grain, 0, 0, 1000, 800],
  ]);
});

void test('the retina is handed back to a known state before it is faded', () => {
  // It is the one surface that survives between frames. A composite operation
  // left set on it from last frame is applied to every mark of this one.
  const surfaces = layers();
  paintTraceFrame(surfaces, frame());
  const retina = surfaces.retina as ReturnType<typeof recordingContext>;
  assert.equal(retina.valuesOf('filter')[0], 'none');
  assert.equal(retina.valuesOf('globalAlpha')[0], 1);
  assert.equal(retina.calls[0].method, 'setTransform');
});

void test('a frame that deposits more light draws its bodies brighter', () => {
  // The deposit is what this frame lost, so a slower frame lays down more. An
  // inverted relationship makes a stuttering room the brightest one.
  // Track marks carry their intensity in the stroke colour, not in a context
  // alpha, so that is where the deposit shows up.
  const trackAlpha = (retinaDeltaSeconds: number) => {
    const surfaces = layers();
    paintTraceFrame(surfaces, frame({ retinaDeltaSeconds }));
    const retina = surfaces.retina as ReturnType<typeof recordingContext>;
    const alphas = retina.valuesOf('strokeStyle')
      .map((value) => Number(/([\d.]+)\)$/.exec(String(value))?.[1] ?? 0));
    return Math.max(...alphas);
  };
  const slow = trackAlpha(1 / 20);
  assert.ok(slow > 0, 'the bodies in the room were not drawn into the retina at all');
  assert.ok(slow > trackAlpha(1 / 60));
});

void test('every layer that can draw does draw', () => {
  // Each of these is a whole category of the piece, and a removed call leaves
  // a frame that still looks like a frame.
  const bare = layers();
  paintTraceFrame(bare, frame({ tracks: [], ghosts: [], active: { current: [] } }));
  // Four composited images plus whatever ambience contributes.
  assert.ok(bare.context.markCount > 4, 'the ambient layer drew nothing');

  const withGhosts = layers();
  paintTraceFrame(withGhosts, frame({ tracks: [], active: { current: [] } }));
  assert.ok(withGhosts.context.markCount > bare.context.markCount, 'recent trails drew nothing');

  const withRecall = layers();
  paintTraceFrame(withRecall, frame({
    tracks: [],
    ghosts: [],
    active: { current: [{ ghost: ghost({ createdAt: WALL - 1_000 }), startedAt: NOW - 500, kind: 'ghost' }] },
  }));
  assert.ok(withRecall.context.markCount > bare.context.markCount, 'the recall drew nothing');
});

void test('the montage belongs to the closing ritual and to today', () => {
  const today = ghost({ id: 'today', day: 3, createdAt: WALL - 1_000 });
  const older = ghost({ id: 'older', day: 1, createdAt: WALL - 90_000_000 });
  const marks = (ghosts: Ghost[], closingElapsed: number) => {
    const surfaces = layers();
    paintTraceFrame(surfaces, frame({ ghosts, day: 3, closingElapsed }));
    return surfaces.context.markCount;
  };
  // Not outside the ritual, however much of today the room is holding.
  assert.ok(marks([today], 4_000) > marks([today], 0));
  // And not for a day that is already over.
  assert.equal(marks([older], 4_000), marks([older], 0));
});

void test('the assumed first step is a frame, not a minute', () => {
  assert.ok(ASSUMED_STEP_SECONDS > 0 && ASSUMED_STEP_SECONDS < 0.05);
});
