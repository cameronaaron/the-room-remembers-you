import assert from 'node:assert/strict';
import test from 'node:test';
import {
  drawAmbient,
  drawCalibration,
  drawClosingMontage,
  drawRecall,
  drawRecalls,
  drawRecentTrails,
  drawTrackingOverlay,
  drawTracks,
  GHOST_KIND_MARK,
  type Holder,
} from './room-drawing.ts';
import { recordingContext } from './test-doubles/canvas-2d.ts';
import { paletteFor, PERSONALITY_RENDER } from './palette.ts';
import { RECALL_PRESENTATION, type RecallKind } from './swarm.ts';
import { TRACK_CONFIRM_SIGHTINGS } from './motion-tracker.ts';
import { DEFAULT_CONFIG, type ActiveGhost, type Ghost, type RoomConfig, type VisitorTrack } from './room-types.ts';

/**
 * The trace renderer is the fallback surface: the engine a machine without
 * WebGL2 float targets falls back to. Its failure mode is not a wrong pixel but
 * a draw path that quietly does nothing, which on a wall is indistinguishable
 * from an empty gallery. These ask whether anything was drawn at all; how it
 * looks is judged against the captures in `docs/`.
 */

const W = 1_280;
const H = 720;
const NOW = 100_000;
const palette = paletteFor(DEFAULT_CONFIG.projectionMode);
const personality = PERSONALITY_RENDER.attentive;
const config: RoomConfig = { ...DEFAULT_CONFIG };

const track = (overrides: Partial<VisitorTrack> = {}): VisitorTrack => ({
  id: 'visitor', bornAt: NOW - 8_000, lastSeen: NOW,
  position: { x: 0.5, y: 0.5, t: NOW }, previous: { x: 0.48, y: 0.5, t: NOW - 100 },
  velocity: { x: 0.2, y: 0 }, speed: 0.2, stillFor: 0, dwellSeconds: 8,
  path: [{ x: 0.2, y: 0.5, t: NOW - 4_000 }, { x: 0.35, y: 0.5, t: NOW - 2_000 }, { x: 0.5, y: 0.5, t: NOW }],
  active: true, occluded: false, confidence: 1, sightings: TRACK_CONFIRM_SIGHTINGS + 2,
  extent: { width: 0.09, height: 0.3 }, ...overrides,
});

const ghost = (overrides: Partial<Ghost> = {}): Ghost => ({
  id: 'ghost', createdAt: NOW - 60_000, lastReplayedAt: 0,
  path: [{ x: 0.15, y: 0.3, t: 0 }, { x: 0.5, y: 0.55, t: 1_000 }, { x: 0.85, y: 0.35, t: 2_000 }],
  dwellSeconds: 6, intensity: 0.5, strength: 0.5, fidelity: 1, recallCount: 0,
  lineage: ['ghost'], falseMemory: false, day: 1, ...overrides,
});

const holder = (items: ActiveGhost[]): Holder<ActiveGhost[]> => ({ current: items });

void test('a room with people in it draws them', () => {
  const context = recordingContext();
  drawTracks(context, [track()], W, H, NOW, 1, personality, config, palette);
  assert.ok(context.markCount > 0, 'a visitor standing in the room was not drawn');
});

void test('a room with nobody in it draws no bodies', () => {
  const context = recordingContext();
  drawTracks(context, [], W, H, NOW, 1, personality, config, palette);
  assert.equal(context.markCount, 0);
});

void test('two visitors are drawn more than one', () => {
  // Guards the loop: a draw that paints the first track and returns looks
  // perfectly healthy in a gallery with one person in it.
  const one = recordingContext();
  drawTracks(one, [track({ id: 'a' })], W, H, NOW, 1, personality, config, palette);
  const two = recordingContext();
  drawTracks(two, [track({ id: 'a' }), track({ id: 'b', position: { x: 0.2, y: 0.4, t: NOW } })], W, H, NOW, 1, personality, config, palette);
  assert.ok(two.markCount > one.markCount, `two visitors drew ${two.markCount} against ${one.markCount}`);
});

void test('an unconfirmed detection is not drawn as a person', () => {
  // `selectObservedTracks` is the single gate between sensing and the artwork.
  const context = recordingContext();
  drawTracks(context, [track({ sightings: 1, confidence: 0.2 })], W, H, NOW, 1, personality, config, palette);
  assert.equal(context.markCount, 0, 'a candidate was painted as a visitor');
});

void test('a track predicted through an occlusion is not drawn either', () => {
  const context = recordingContext();
  drawTracks(context, [track({ occluded: true })], W, H, NOW, 1, personality, config, palette);
  assert.equal(context.markCount, 0, 'a predicted body reached the wall');
});

void test('recent trails are drawn, and an empty history draws nothing', () => {
  const drawn = recordingContext();
  drawRecentTrails(drawn, [ghost()], W, H, NOW, 1, palette);
  assert.ok(drawn.markCount > 0);
  const empty = recordingContext();
  drawRecentTrails(empty, [], W, H, NOW, 1, palette);
  assert.equal(empty.markCount, 0);
});

void test('every kind of recall has a mark and draws something', () => {
  // A kind added to the swarm but missed here picks up `undefined` as its mark
  // and renders as nothing — a recall the room believes it is showing.
  for (const kind of Object.keys(RECALL_PRESENTATION) as RecallKind[]) {
    assert.ok(GHOST_KIND_MARK[kind], `${kind} has no mark`);
    assert.ok(palette.marks[GHOST_KIND_MARK[kind]], `${kind} maps to a mark the palette lacks`);
    const context = recordingContext();
    drawRecall(context, { ghost: ghost(), startedAt: NOW, kind }, 0.5, W, H, NOW, 1, palette, personality);
    assert.ok(context.markCount > 0, `a ${kind} recall drew nothing`);
  }
});

void test('a running recall is drawn and kept', () => {
  const active = holder([{ ghost: ghost(), startedAt: NOW, kind: 'ghost' }]);
  const context = recordingContext();
  drawRecalls(context, active, W, H, NOW + 1_000, 1, palette, personality);
  assert.ok(context.markCount > 0);
  assert.equal(active.current.length, 1, 'a running recall was dropped');
});

void test('a finished recall is retired rather than drawn forever', () => {
  // Nothing else prunes this list; a recall that never expires accumulates
  // until the fallback surface is drawing every memory the room ever had.
  const active = holder([{ ghost: ghost(), startedAt: NOW, kind: 'ghost' }]);
  const context = recordingContext();
  const past = NOW + RECALL_PRESENTATION.ghost.durationMs + 1;
  drawRecalls(context, active, W, H, past, 1, palette, personality);
  assert.equal(active.current.length, 0, 'a finished recall stayed on the list');
  assert.equal(context.markCount, 0);
});

void test('a recall scheduled for later is kept but not yet drawn', () => {
  const active = holder([{ ghost: ghost(), startedAt: NOW + 5_000, kind: 'ghost' }]);
  const context = recordingContext();
  drawRecalls(context, active, W, H, NOW, 1, palette, personality);
  assert.equal(active.current.length, 1, 'a scheduled recall was discarded');
  assert.equal(context.markCount, 0, 'a recall was drawn before it began');
});

void test('recalls are drawn independently of each other', () => {
  const active = holder([
    { ghost: ghost({ id: 'a' }), startedAt: NOW, kind: 'ghost' },
    { ghost: ghost({ id: 'b' }), startedAt: NOW + RECALL_PRESENTATION.ghost.durationMs + 1, kind: 'ghost' },
    { ghost: ghost({ id: 'c' }), startedAt: NOW, kind: 'convergence' },
  ]);
  drawRecalls(recordingContext(), active, W, H, NOW + 1_000, 1, palette, personality);
  assert.deepEqual(active.current.map((item) => item.ghost.id), ['a', 'b', 'c'], 'a live recall was lost');
});

void test('a recall being forgotten as it is shown still draws', () => {
  const context = recordingContext();
  const active = holder([{
    ghost: ghost(), startedAt: NOW, kind: 'ghost',
    disturbance: { loss: 0.4, at: { x: 0.5, y: 0.5 }, voicePlayed: false, admitted: false },
  }]);
  drawRecalls(context, active, W, H, NOW + 1_000, 1, palette, personality);
  assert.ok(context.markCount > 0, 'a disturbed recall vanished entirely');
});

void test('ambient drift is memory made visible, so an unremembering room has none', () => {
  // Deliberately nothing at zero: the drift represents what the room is
  // holding, not that it is running. An empty field draws an empty wall.
  const context = recordingContext();
  drawAmbient(context, W, H, NOW, 0, personality, palette, 1);
  assert.equal(context.markCount, 0);
});

void test('a room holding memory drifts, and more memory drifts more', () => {
  const faint = recordingContext();
  drawAmbient(faint, W, H, NOW, 0.005, personality, palette, 1);
  const dense = recordingContext();
  drawAmbient(dense, W, H, NOW, 0.015, personality, palette, 1);
  assert.ok(faint.markCount > 0, 'a remembering room drew nothing');
  assert.ok(dense.markCount > faint.markCount, `${dense.markCount} was not more than ${faint.markCount}`);
});

void test('drift is capped, so a saturated room does not draw forever', () => {
  // `min(18, floor(density * 900))` — without the cap a full memory field asks
  // for 900 bezier strokes every frame on the machine least able to afford it,
  // which is the machine this renderer exists for.
  for (const density of [0.02, 0.5, 1]) {
    const context = recordingContext();
    drawAmbient(context, W, H, NOW, density, personality, palette, 1);
    assert.equal(context.countOf('stroke'), 18, `density ${density} escaped the cap`);
  }
});

void test('the closing montage draws what the day held, and nothing when it held nothing', () => {
  const drawn = recordingContext();
  drawClosingMontage(drawn, [ghost({ id: 'a' }), ghost({ id: 'b' })], W, H, 2_000, palette);
  assert.ok(drawn.markCount > 0);
  const empty = recordingContext();
  drawClosingMontage(empty, [], W, H, 2_000, palette);
  assert.equal(empty.markCount, 0);
});

void test('the tracking overlay writes the words an operator reads off the wall', () => {
  // The overlay exists to be read while standing in front of the projection,
  // so text is the one thing it cannot be allowed to stop drawing.
  const context = recordingContext();
  drawTrackingOverlay(context, [track()], W, H, NOW, config);
  assert.ok(context.countOf('fillText') + context.countOf('strokeText') > 0, 'the overlay said nothing');
});

/** What the overlay actually wrote, joined. */
const wordsOf = (context: ReturnType<typeof recordingContext>) =>
  context.callsTo('fillText').map((call) => String(call.args[0])).join(' | ');

void test('the overlay says outright when the room is tracking nobody', () => {
  // The reason this overlay exists. Sensing failure is silent by construction:
  // a camera that sees nothing renders exactly what an empty gallery renders,
  // and this is the one surface that answers the question from the wall, where
  // a visitor is actually standing. Counting marks cannot check that — a header
  // bar is marks — so the words themselves are the assertion.
  const blind = recordingContext();
  drawTrackingOverlay(blind, [], W, H, NOW, config);
  assert.match(wordsOf(blind), /NOT TRACKING ANYONE/);
  assert.match(wordsOf(blind), /press D/, 'the overlay reports a fault without saying what to do');
});

void test('an unconfirmed or predicted track does not count as someone tracked', () => {
  // The overlay still marks them — it is the debug view, and a candidate that
  // never confirms is exactly what an operator needs to see — but the headline
  // count is `selectObservedTracks`, the same gate the artwork is behind.
  const context = recordingContext();
  drawTrackingOverlay(context, [track({ sightings: 1, confidence: 0.2 }), track({ id: 'hidden', occluded: true })], W, H, NOW, config);
  assert.match(wordsOf(context), /NOT TRACKING ANYONE/, 'candidates were counted as people');
});

void test('the overlay counts the people the artwork can actually see', () => {
  const context = recordingContext();
  drawTrackingOverlay(context, [track({ id: 'a' }), track({ id: 'b' })], W, H, NOW, config);
  assert.match(wordsOf(context), /TRACKING 2/);
});

void test('calibration draws a mark for every corner at every step', () => {
  for (let step = 0; step < 4; step += 1) {
    const context = recordingContext();
    drawCalibration(context, W, H, step, palette);
    assert.ok(context.markCount > 0, `step ${step} drew nothing to stand on`);
  }
});

void test('every draw leaves the context balanced', () => {
  // An unmatched save() leaks a clip or a transform into whatever is drawn
  // next, which shows up as a later layer mysteriously cropped or offset.
  const cases: Array<[string, (context: ReturnType<typeof recordingContext>) => void]> = [
    ['drawTracks', (c) => drawTracks(c, [track()], W, H, NOW, 1, personality, config, palette)],
    ['drawRecentTrails', (c) => drawRecentTrails(c, [ghost()], W, H, NOW, 1, palette)],
    ['drawRecall', (c) => drawRecall(c, { ghost: ghost(), startedAt: NOW, kind: 'ghost' }, 0.5, W, H, NOW, 1, palette, personality)],
    ['drawAmbient', (c) => drawAmbient(c, W, H, NOW, 0.3, personality, palette, 1)],
    ['drawClosingMontage', (c) => drawClosingMontage(c, [ghost()], W, H, 2_000, palette)],
    ['drawTrackingOverlay', (c) => drawTrackingOverlay(c, [track()], W, H, NOW, config)],
    ['drawCalibration', (c) => drawCalibration(c, W, H, 1, palette)],
  ];
  for (const [name, draw] of cases) {
    const context = recordingContext();
    draw(context);
    assert.equal(context.countOf('save'), context.countOf('restore'), `${name} left the context unbalanced`);
  }
});
