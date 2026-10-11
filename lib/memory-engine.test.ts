import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  choosePersonality,
  createFalseMemory,
  createMemoryField,
  depositObservedMemory,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  decayMemory,
  depositMemory,
  findConvergentGhost,
  memoryDensity,
  normalizePath,
  pathExtent,
  RETURN_MIN_EXTENT,
  rememberGhost,
  decayStrength,
  reinforceStrength,
  rememberWhisper,
  simplifyPath,
  trajectoryDistance,
  eventChance,
  RECALL_RATE_PER_SECOND,
  trimExpired,
  idHash,
  LINEAGE_MAX,
  MEMORY_ID_MAX,
} from './memory-engine.ts';
import { mapCalibratedPoint, solveHomography } from './homography.ts';
import { AnonymousTrackManager, BODY_MERGE_GAP, boxOverlapRatio, isFragmentOf, maxPlausibleBodies, medianDifference, mergeAdjacentBlobs, MotionFrameAnalyzer, selectObservedTracks } from './motion-tracker.ts';
import { GallerySimulation } from './simulation.ts';
import { ghost } from './test-doubles/room.ts';
import type { Ghost, Point, VisitorTrack } from './room-types.ts';

const point = (x: number, y: number, t = 0): Point => ({ x, y, t });

void test('memory deposits locally and clamps without touching distant cells', () => {
  const field = createMemoryField();
  depositMemory(field, point(0.5, 0.5), 2, 1);
  assert.equal(Math.max(...field), 1);
  assert.equal(field[0], 0);
  assert.ok(memoryDensity(field) > 0);
});

void test('memory decay follows the configured half-life', () => {
  const field = createMemoryField();
  field[0] = 1;
  decayMemory(field, 600, 10);
  assert.ok(Math.abs(field[0] - 0.5) < 0.0001);
});

void test('path normalization preserves endpoints and direction-independent distance', () => {
  const path = [point(0, 0), point(0.5, 0.5), point(1, 1)];
  const normalized = normalizePath(path, 7);
  assert.deepEqual(normalized[0], path[0]);
  assert.deepEqual(normalized.at(-1), path.at(-1));
  assert.ok(trajectoryDistance(path, [...path].reverse()) < 0.0001);
});

void test('convergence returns only a genuinely similar historic path', () => {
  const base = [point(0.1, 0.1), point(0.5, 0.5), point(0.9, 0.8)];
  const ghost: Ghost = {
    id: 'old', createdAt: 1, lastReplayedAt: 0, path: base, dwellSeconds: 2,
    intensity: 0.3, strength: 0.4, fidelity: 1, recallCount: 0,
    lineage: ['old'], falseMemory: false, day: 1,
  };
  assert.equal(findConvergentGhost(base.map((p) => point(p.x + 0.01, p.y)), [ghost])?.id, 'old');
  assert.equal(findConvergentGhost([point(0.1, 0.9), point(0.5, 0.9), point(0.9, 0.9)], [ghost]), null);
});

void test('personality responds to crowding, stillness, loneliness, and forgetting', () => {
  const track = (overrides: Partial<VisitorTrack> = {}): VisitorTrack => ({
    id: 'visitor', bornAt: 0, lastSeen: 0, position: point(0, 0), previous: point(0, 0),
    velocity: { x: 0, y: 0 }, speed: 0.01, stillFor: 0, dwellSeconds: 2, path: [], active: true,
    occluded: false, confidence: 1, sightings: 4, extent: { width: 0.08, height: 0.25 }, ...overrides,
  });
  assert.equal(choosePersonality(Array.from({ length: 8 }, (_, id) => track({ id: String(id) })), 0, 0, 'attentive'), 'overwhelmed');
  assert.equal(choosePersonality([track({ stillFor: 16 })], 0, 0, 'attentive'), 'remembering');
  assert.equal(choosePersonality([], 121, 0.02, 'attentive'), 'lonely');
  assert.equal(choosePersonality([], 1201, 0.02, 'lonely'), 'forgetting');
});

void test('automatic expiration retains only records inside the requested boundary', () => {
  const now = 10 * 86_400_000;
  const items = [{ createdAt: now - 86_400_000 }, { createdAt: now - 3 * 86_400_000 }];
  assert.equal(trimExpired(items, now, 2).length, 1);
});

void test('anonymous tracks are stable while nearby and expire without retaining identity', () => {
  const manager = new AnonymousTrackManager();
  const first = manager.update([{ x: 0.2, y: 0.3, width: 0.1, height: 0.2, energy: 1 }], 1000).active[0];
  const second = manager.update([{ x: 0.22, y: 0.31, width: 0.1, height: 0.2, energy: 1 }], 1100).active[0];
  assert.equal(second.id, first.id);
  const hidden = manager.update([], 3001);
  assert.equal(hidden.active[0].id, first.id);
  assert.equal(hidden.active[0].occluded, true);
  assert.equal(selectObservedTracks(hidden.active).length, 0);
  const reacquired = manager.update([{ x: 0.24, y: 0.32, width: 0.1, height: 0.2, energy: 1 }], 3200);
  assert.equal(reacquired.active[0].id, first.id);
  assert.equal(reacquired.active[0].occluded, false);
  const result = manager.update([], 7301);
  assert.equal(result.active.length, 0);
  assert.equal(result.ended[0].id, first.id);
});

const motionFrame = (value: number) => new Float32Array(160 * 90).fill(value);

void test('motion analysis rejects uniform lighting changes and room-wide scene changes', () => {
  const analyzer = new MotionFrameAnalyzer();
  for (let frame = 0; frame < 9; frame += 1) analyzer.analyze(motionFrame(80), 24);

  assert.equal(analyzer.analyze(motionFrame(125), 24).length, 0);
  assert.ok(Math.abs(analyzer.getDiagnostics().meanLightShift - 45) < 0.01);

  const sceneChange = motionFrame(80);
  for (let index = 0; index < sceneChange.length; index += 2) sceneChange[index] = 180;
  assert.equal(analyzer.analyze(sceneChange, 24).length, 0);
  assert.equal(analyzer.getDiagnostics().state, 'scene-change');
});

void test('motion analysis requires persistent local movement instead of one noisy frame', () => {
  const analyzer = new MotionFrameAnalyzer();
  for (let frame = 0; frame < 9; frame += 1) analyzer.analyze(motionFrame(80), 24);
  const localMotion = motionFrame(80);
  for (let y = 24; y < 68; y += 1) {
    for (let x = 52; x < 92; x += 1) localMotion[y * 160 + x] = 175;
  }
  assert.equal(analyzer.analyze(localMotion, 24).length, 0);
  assert.ok(analyzer.analyze(localMotion, 24).length > 0);
  assert.ok(analyzer.getDiagnostics().activeCells > 0);
});

void test('four-point homography maps camera space into projector space', () => {
  const source = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const target = [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.1 }, { x: 0.8, y: 0.9 }, { x: 0.2, y: 0.8 }];
  const matrix = solveHomography(source, target);
  source.forEach((item, index) => {
    const mapped = mapCalibratedPoint(item, source, target);
    assert.ok(Math.abs(mapped.x - target[index].x) < 1e-8);
    assert.ok(Math.abs(mapped.y - target[index].y) < 1e-8);
  });
  assert.equal(matrix.length, 9);
});

void test('every recall mutates fidelity and geometry while reinforcing strength', () => {
  const ghost: Ghost = {
    id: 'memory', createdAt: 1, lastReplayedAt: 0,
    path: [point(0.1, 0.2), point(0.42, 0.73), point(0.9, 0.3)],
    dwellSeconds: 4, intensity: 0.4, strength: 0.3, fidelity: 1,
    recallCount: 0, lineage: ['memory'], falseMemory: false, day: 1,
  };
  const recalled = rememberGhost(ghost, () => 0.75);
  assert.equal(recalled.recallCount, 1);
  assert.ok(recalled.fidelity < ghost.fidelity);
  assert.ok(recalled.strength > ghost.strength);
  assert.notDeepEqual(recalled.path, ghost.path);
  assert.ok(reinforceStrength(0.4, 0.2) > 0.4);
});

void test('false memories preserve provenance while combining two real paths', () => {
  const makeGhost = (id: string, path: Point[]): Ghost => ({
    id, path, createdAt: 1, lastReplayedAt: 0, dwellSeconds: 2,
    intensity: 0.3, strength: 0.4, fidelity: 0.8, recallCount: 0,
    lineage: [id], falseMemory: false, day: 2,
  });
  const first = makeGhost('first', [point(0, 0), point(0.5, 0.5), point(1, 1)]);
  const second = makeGhost('second', [point(1, 0), point(0.5, 0.5), point(0, 1)]);
  const combined = createFalseMemory(first, second, 99, { id: 'whisper', envelope: [0.1, 0.8, 0.3] });
  assert.equal(combined.falseMemory, true);
  assert.deepEqual(combined.lineage.sort(), ['first', 'second', 'whisper']);
  assert.ok(combined.fidelity < first.fidelity);
  assert.ok(combined.path.length > first.path.length);
});

void test('accelerated gallery simulation is deterministic and respects hardware capacity', () => {
  const first = new GallerySimulation(42);
  const second = new GallerySimulation(42);
  first.reset(1000);
  second.reset(1000);
  assert.deepEqual(first.sample(60_000, 720, 'CHEAP'), second.sample(60_000, 720, 'CHEAP'));
  assert.ok(first.sample(600_000, 720, 'CHEAP').length <= 4);
  assert.ok(first.sample(600_000, 720, 'FULL').length <= 12);
});

void test('rare events fire at the same rate whatever the analysis frame rate', () => {
  // The room used to roll once per analysis tick, so a FULL profile at 24 Hz
  // remembered things 2.4x more often than a CHEAP one at 10 Hz.
  const rate = RECALL_RATE_PER_SECOND;
  const overOneSecond = (hz: number) => 1 - (1 - eventChance(rate, 1 / hz)) ** hz;
  const slow = overOneSecond(10);
  const fast = overOneSecond(24);
  assert.ok(Math.abs(slow - fast) < 1e-9, `${slow} vs ${fast}`);
  assert.ok(Math.abs(slow - eventChance(rate, 1)) < 1e-9);
});

void test('recall pacing lands inside a gallery visit', () => {
  // Mean interval between recalls at the default frequency.
  const meanSeconds = 1 / (RECALL_RATE_PER_SECOND * 0.45);
  assert.ok(meanSeconds < 120, `a visitor waits ${meanSeconds.toFixed(0)}s on average`);
  assert.ok(meanSeconds > 20, 'recalls should stay rare enough to feel like events');
});

void test('event chance is bounded and monotonic', () => {
  assert.equal(eventChance(0.05, 0), 0);
  assert.ok(eventChance(0.05, 10) > eventChance(0.05, 1));
  assert.ok(eventChance(0.05, 1e6) <= 1);
  assert.equal(eventChance(-5, 10), 0);
});

void test('one body arriving in pieces is counted as one person', () => {
  // Connected components only join cells that touch orthogonally, so a visitor
  // whose clothing matches the background in places arrives as a head, a torso
  // and legs. Before merging, that was three people.
  const head = { x: 0.5, y: 0.2, width: 0.06, height: 0.08, energy: 0.3 };
  const torso = { x: 0.5, y: 0.33, width: 0.09, height: 0.12, energy: 0.5 };
  const legs = { x: 0.51, y: 0.5, width: 0.07, height: 0.14, energy: 0.4 };
  const merged = mergeAdjacentBlobs([head, torso, legs]);
  assert.equal(merged.length, 1, 'a fragmented body should merge into one');
  // The merged box must actually span the whole body.
  assert.ok(merged[0].height >= 0.4, `merged height was ${merged[0].height}`);
  assert.ok(merged[0].y > 0.2 && merged[0].y < 0.5);
});

void test('two people standing apart stay two people', () => {
  const left = { x: 0.3, y: 0.5, width: 0.08, height: 0.3, energy: 0.5 };
  const right = { x: 0.7, y: 0.5, width: 0.08, height: 0.3, energy: 0.5 };
  assert.equal(mergeAdjacentBlobs([left, right]).length, 2);
});

void test('merging is transitive but does not swallow the room', () => {
  // A chain of fragments collapses; something genuinely distant does not join.
  const chain = [
    { x: 0.20, y: 0.5, width: 0.06, height: 0.1, energy: 0.2 },
    { x: 0.27, y: 0.5, width: 0.06, height: 0.1, energy: 0.2 },
    { x: 0.34, y: 0.5, width: 0.06, height: 0.1, energy: 0.2 },
    { x: 0.90, y: 0.5, width: 0.06, height: 0.1, energy: 0.2 },
  ];
  const merged = mergeAdjacentBlobs(chain);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((blob) => blob.x > 0.85), 'the distant body should survive');
});

void test('merging an empty or single detection is a no-op', () => {
  assert.deepEqual(mergeAdjacentBlobs([]), []);
  const only = { x: 0.4, y: 0.4, width: 0.1, height: 0.2, energy: 0.6 };
  assert.deepEqual(mergeAdjacentBlobs([only]), [only]);
});

void test('a one-frame detection never becomes a person', () => {
  // The phantom-crowd bug: a fragment appeared for a single frame, minted a
  // track, and that track then lingered for four seconds of occlusion
  // prediction. One visitor read as a crowd that took seconds to drain.
  const manager = new AnonymousTrackManager();
  const blip = { x: 0.5, y: 0.5, width: 0.08, height: 0.2, energy: 0.6 };

  const first = manager.update([blip], 1000);
  assert.equal(selectObservedTracks(first.active).length, 0, 'a candidate is not yet a person');

  // It vanishes. It must be gone immediately, not held as occluded.
  const second = manager.update([], 1100);
  assert.equal(selectObservedTracks(second.active).length, 0);
  assert.equal(second.active.length, 0, 'an unconfirmed candidate must not linger');
});

void test('a real person is confirmed and then held through a brief occlusion', () => {
  const manager = new AnonymousTrackManager();
  const person = (x: number) => ({ x, y: 0.5, width: 0.08, height: 0.25, energy: 0.7 });

  manager.update([person(0.5)], 1000);
  const confirmed = manager.update([person(0.51)], 1100);
  assert.equal(selectObservedTracks(confirmed.active).length, 1, 'two sightings should confirm');

  // Now they are briefly hidden. A confirmed person is predicted through it.
  const hidden = manager.update([], 1200);
  assert.equal(hidden.active.length, 1, 'a confirmed person survives occlusion');
  assert.equal(selectObservedTracks(hidden.active).length, 0, 'but is not shown while hidden');
  assert.ok(hidden.active[0].occluded);
});

void test('a steady person keeps one identity rather than churning', () => {
  const manager = new AnonymousTrackManager();
  const ids = new Set<string>();
  for (let frame = 0; frame < 20; frame += 1) {
    const { active } = manager.update(
      [{ x: 0.3 + frame * 0.01, y: 0.5, width: 0.08, height: 0.25, energy: 0.7 }],
      1000 + frame * 100,
    );
    for (const track of selectObservedTracks(active)) ids.add(track.id);
  }
  assert.equal(ids.size, 1, `one person walking produced ${ids.size} identities`);
});

void test('a person filling the frame is movement, not a scene change', () => {
  // Taken from a real desk-range session: a single visitor changed 29% of the
  // pixels while lighting 34% of the grid, and the old pixel-fraction guard
  // discarded 21% of those frames. Coverage separates the two cases; a pixel
  // count cannot.
  const analyzer = new MotionFrameAnalyzer();
  const width = 160;
  const height = 90;
  const empty = new Float32Array(width * height).fill(80);
  for (let frame = 0; frame < 12; frame += 1) analyzer.analyze(empty, 24);

  // A large contiguous body occupying about a third of the frame.
  const withPerson = new Float32Array(empty);
  for (let y = 20; y < height; y += 1) {
    for (let x = 45; x < 115; x += 1) withPerson[y * width + x] = 200;
  }
  analyzer.analyze(withPerson, 24);
  analyzer.analyze(withPerson, 24);
  const diagnostics = analyzer.getDiagnostics();

  assert.notEqual(diagnostics.state, 'scene-change', 'a close visitor must not read as a scene change');
  assert.ok(diagnostics.changedPercent > 25, `only ${diagnostics.changedPercent.toFixed(0)}% of pixels changed`);
  assert.ok(diagnostics.coveragePercent < 85, `coverage was ${diagnostics.coveragePercent.toFixed(0)}%`);
  assert.ok(diagnostics.blobCount >= 1, 'the visitor should still be detected');
});

void test('the lights coming on is still rejected', () => {
  const analyzer = new MotionFrameAnalyzer();
  const width = 160;
  const height = 90;
  const dark = new Float32Array(width * height);
  // Textured, so a uniform shift is not cancelled by the mean-light correction.
  for (let index = 0; index < dark.length; index += 1) dark[index] = 40 + (index % 37) * 3;
  for (let frame = 0; frame < 12; frame += 1) analyzer.analyze(dark, 24);

  // Every part of the room gets brighter, and unevenly.
  const lit = dark.map((value, index) => value * (2.1 + (index % 11) * 0.05));
  analyzer.analyze(Float32Array.from(lit), 24);
  const diagnostics = analyzer.getDiagnostics();
  assert.equal(diagnostics.state, 'scene-change', 'a room-wide change must still be rejected');
  assert.equal(diagnostics.blobCount, 0);
});

void test('fragments of a large close body merge, distant people do not', () => {
  // A visitor close to the camera arrives as big fragments with big gaps
  // between them; a fixed allowance only ever suited small, distant bodies.
  const upper = { x: 0.5, y: 0.28, width: 0.26, height: 0.24, energy: 0.6 };
  const lower = { x: 0.52, y: 0.60, width: 0.24, height: 0.28, energy: 0.6 };
  assert.equal(mergeAdjacentBlobs([upper, lower]).length, 1, 'one close visitor split in two');

  // Two people at gallery distance, well apart, must survive as two.
  const a = { x: 0.25, y: 0.5, width: 0.07, height: 0.22, energy: 0.5 };
  const b = { x: 0.72, y: 0.5, width: 0.07, height: 0.22, energy: 0.5 };
  assert.equal(mergeAdjacentBlobs([a, b]).length, 2);
});

void test('the light-shift estimate survives a large object in frame', () => {
  // The arithmetic mean does not: a third of the frame shifting by 120 levels
  // drags it to ~41, enough to push every untouched background pixel over the
  // threshold and make the whole image look like it moved.
  const size = 160 * 90;
  const background = new Float32Array(size).fill(80);
  const withPerson = new Float32Array(background);
  for (let index = 0; index < Math.floor(size * 0.34); index += 1) withPerson[index] = 200;

  const mean = withPerson.reduce((sum, value, index) => sum + value - background[index], 0) / size;
  assert.ok(mean > 35, `the mean shift is ${mean.toFixed(1)}, which is the bug`);
  assert.equal(medianDifference(withPerson, background), 0, 'the median must ignore the object');
});

void test('the light-shift estimate still tracks a genuine global change', () => {
  const size = 160 * 90;
  const before = new Float32Array(size).fill(60);
  const after = new Float32Array(size).fill(95);
  assert.equal(medianDifference(after, before), 35);
});

void test('one body split vertically is one person, side by side is two', () => {
  // From a real session: 51 samples reported two people when there was one,
  // every one of them two genuinely separate regions. A person is a vertical
  // column, so their pieces stack and share a horizontal band; two people stand
  // beside each other and share almost none. The merge rule has to be
  // asymmetric to tell those apart.
  const torso = { x: 0.5, y: 0.34, width: 0.13, height: 0.2, energy: 0.6 };
  const legs = { x: 0.52, y: 0.68, width: 0.11, height: 0.22, energy: 0.5 };
  // Vertical gap of about 0.11, far wider than a symmetric allowance permits.
  assert.equal(mergeAdjacentBlobs([torso, legs]).length, 1, 'a column should merge');

  const left = { x: 0.34, y: 0.5, width: 0.11, height: 0.34, energy: 0.6 };
  const right = { x: 0.6, y: 0.5, width: 0.11, height: 0.34, energy: 0.6 };
  assert.equal(mergeAdjacentBlobs([left, right]).length, 2, 'neighbours are two people');
});

void test('the long vertical reach does not stretch sideways', () => {
  // Two people shoulder to shoulder are still two, even at the vertical
  // distance a single column is allowed to span.
  const a = { x: 0.4, y: 0.5, width: 0.1, height: 0.3, energy: 0.5 };
  const b = { x: 0.56, y: 0.5, width: 0.1, height: 0.3, energy: 0.5 };
  assert.equal(mergeAdjacentBlobs([a, b]).length, 2);
});

void test('barely overlapping columns are not merged across a long gap', () => {
  // A sliver of shared horizontal extent is not a body; it needs a real column.
  const high = { x: 0.42, y: 0.2, width: 0.12, height: 0.12, energy: 0.4 };
  const low = { x: 0.55, y: 0.62, width: 0.12, height: 0.12, energy: 0.4 };
  assert.equal(mergeAdjacentBlobs([high, low]).length, 2);
});

void test('two people close to the camera are still two people', () => {
  // Every other side-by-side case here is a pair at gallery distance, 0.07 to
  // 0.13 wide. At desk range a visitor fills a quarter of the frame, and while
  // the size-scaled allowance applied sideways these two had to stand 40% of
  // the frame apart to be counted separately: the scale factor multiplies the
  // smaller dimension, which for a standing person is their width, so the
  // sideways reach grew in the one direction that tells neighbours apart.
  const left = { x: 0.33, y: 0.5, width: 0.28, height: 0.85, energy: 0.7 };
  const right = { x: 0.67, y: 0.5, width: 0.28, height: 0.85, energy: 0.7 };
  assert.equal(mergeAdjacentBlobs([left, right]).length, 2, 'two close visitors became one body');
});

void test('the sideways allowance does not grow with how close a body is', () => {
  // The same edge gap, at two distances. A rule whose horizontal reach scales
  // with body size answers these differently, which is the defect: the pair
  // that is easiest to see as two is the one it merges.
  const edgeGap = 0.08;
  const pairAt = (width: number) => [
    { x: 0.5 - (width + edgeGap) / 2, y: 0.5, width, height: width * 3, energy: 0.6 },
    { x: 0.5 + (width + edgeGap) / 2, y: 0.5, width, height: width * 3, energy: 0.6 },
  ];
  assert.equal(mergeAdjacentBlobs(pairAt(0.08)).length, 2, 'distant pair');
  assert.equal(mergeAdjacentBlobs(pairAt(0.28)).length, 2, 'near pair, same gap');
});

void test('a close body split head-to-legs still merges vertically', () => {
  // The other half of the asymmetry, pinned so the fix above cannot be taken
  // too far: the scaled reach still has to close a vertical gap that the fixed
  // allowance never could, or one near visitor becomes a stack of people.
  const upper = { x: 0.5, y: 0.26, width: 0.26, height: 0.22, energy: 0.6 };
  const lower = { x: 0.52, y: 0.62, width: 0.24, height: 0.26, energy: 0.6 };
  const gapY = (lower.y - upper.y) - (upper.height + lower.height) / 2;
  assert.ok(gapY > BODY_MERGE_GAP, 'a fixed allowance would not reach this far');
  assert.equal(mergeAdjacentBlobs([upper, lower]).length, 1, 'one close visitor split in two');
});

void test('occlusion recovery behaves the same at any analysis rate', () => {
  // These were per-frame constants, so the same occlusion left 17% of a
  // person's confidence at 10 Hz and 3% at 24 Hz. How long the room holds on to
  // someone who stepped behind someone else must not depend on how fast the
  // machine happens to be analysing.
  const holdFor = (hz: number) => {
    const manager = new AnonymousTrackManager();
    const step = 1000 / hz;
    let now = 1000;
    for (let frame = 0; frame < 4; frame += 1, now += step) {
      manager.update([{ x: 0.5, y: 0.5, width: 0.09, height: 0.26, energy: 0.7 }], now);
    }
    let heldFrames = 0;
    while (heldFrames < hz * 10) {
      const { active } = manager.update([], now);
      if (!active.length) break;
      heldFrames += 1;
      now += step;
    }
    return (heldFrames * step) / 1000;
  };

  const slow = holdFor(10);
  const fast = holdFor(24);
  assert.ok(Math.abs(slow - fast) < 0.35, `held ${slow.toFixed(2)}s at 10 Hz but ${fast.toFixed(2)}s at 24 Hz`);
  assert.ok(slow > 2 && slow < 5, `an occluded person was held for ${slow.toFixed(2)}s`);
});

void test('a prediction is dropped once its confidence has collapsed', () => {
  const manager = new AnonymousTrackManager();
  for (let frame = 0; frame < 4; frame += 1) {
    manager.update([{ x: 0.5, y: 0.5, width: 0.09, height: 0.26, energy: 0.7 }], 1000 + frame * 50);
  }
  let now = 1200;
  let last = manager.update([], now).active;
  while (last.length && now < 1200 + 20_000) {
    now += 50;
    last = manager.update([], now).active;
  }
  assert.equal(last.length, 0, 'an occluded track must not be held indefinitely');
  assert.ok(now - 1200 < 6_000, 'and it should go well inside the occlusion window');
});

void test('sensing reports settling until the background stops moving', () => {
  // After warmup, anything already standing in the room is learned in
  // gradually, so the changed area starts around twice its eventual size. On a
  // real session coverage ran 42, 50, 45, 42, 38, 33, 28, 23 and only then held
  // at 22 — and two phantom tracks were born inside that transient.
  const analyzer = new MotionFrameAnalyzer();
  const width = 160;
  const height = 90;
  const empty = new Float32Array(width * height).fill(80);
  let now = 0;
  const step = 50; // 20 Hz
  for (let frame = 0; frame < 12; frame += 1, now += step) analyzer.analyze(empty, 24, 0.85, now);

  // Someone is standing there, and the model begins absorbing them.
  const shrinking = (fraction: number) => {
    const frame = new Float32Array(empty);
    const rows = Math.floor(height * fraction);
    for (let y = height - rows; y < height; y += 1) {
      for (let x = 55; x < 105; x += 1) frame[y * width + x] = 210;
    }
    return frame;
  };
  for (const fraction of [0.9, 0.75, 0.6, 0.45, 0.35]) {
    analyzer.analyze(shrinking(fraction), 24, 0.85, now);
    now += step;
  }
  assert.equal(analyzer.getDiagnostics().state, 'settling', 'a moving background is not settled');

  // Now it holds steady.
  const steady = shrinking(0.35);
  for (let frame = 0; frame < 60; frame += 1, now += step) analyzer.analyze(steady, 24, 0.85, now);
  assert.equal(analyzer.getDiagnostics().state, 'tracking', 'a steady room should settle');
});

void test('settling cannot stall forever in a busy room', () => {
  const analyzer = new MotionFrameAnalyzer();
  const width = 160;
  const height = 90;
  const base = new Float32Array(width * height).fill(80);
  let now = 0;
  for (let frame = 0; frame < 12; frame += 1, now += 50) analyzer.analyze(base, 24, 0.85, now);
  // Constantly changing coverage, so the stability test never passes on merit.
  for (let frame = 0; frame < 400; frame += 1, now += 50) {
    const noisy = new Float32Array(base);
    const rows = 20 + (frame % 40);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 20; x < 140; x += 1) noisy[y * width + x] = 200;
    }
    analyzer.analyze(noisy, 24, 0.85, now);
  }
  assert.notEqual(analyzer.getDiagnostics().state, 'settling', 'the timeout must release it');
});

void test('standing still is not walking a path twice', () => {
  // A stationary visitor accumulates path points at one spot roughly twice a
  // second, so after about eleven seconds the first half of their "path"
  // matches the second half perfectly. The room told people who had simply sat
  // down that they had walked this before.
  const still: Point[] = Array.from({ length: 30 }, (_, index) => point(0.5 + (index % 3) * 0.002, 0.5, index * 500));
  assert.ok(trajectoryDistance(still.slice(0, 15), still.slice(15)) < 0.055, 'halves do match');
  assert.ok(pathExtent(still) < RETURN_MIN_EXTENT, 'but the path went nowhere');
});

void test('an actual there-and-back has the extent to count', () => {
  const out: Point[] = Array.from({ length: 15 }, (_, index) => point(0.2 + index * 0.03, 0.5, index * 400));
  const back: Point[] = Array.from({ length: 15 }, (_, index) => point(0.2 + index * 0.03, 0.52, 6000 + index * 400));
  const walked = [...out, ...back];
  assert.ok(pathExtent(walked) >= RETURN_MIN_EXTENT, `extent was only ${pathExtent(walked).toFixed(2)}`);
  assert.ok(trajectoryDistance(out, back) < 0.055, 'and the two halves match');
});

void test('path extent is the diagonal reach, and safe on short paths', () => {
  assert.equal(pathExtent([]), 0);
  assert.equal(pathExtent([point(0.5, 0.5)]), 0);
  assert.ok(Math.abs(pathExtent([point(0, 0), point(0.3, 0.4)]) - 0.5) < 1e-9);
});

void test('scraps of one barely-moving person do not become two people', () => {
  // Blob merging works on what a single frame detected. It cannot help when a
  // nearly-still visitor registers as disconnected scraps that never touch. On
  // a real session 44 of 307 samples reported two or more people at a median
  // coverage of 8% — one person, barely moving.
  const manager = new AnonymousTrackManager();
  const body = { x: 0.5, y: 0.45, width: 0.16, height: 0.3, energy: 0.7 };
  for (let frame = 0; frame < 4; frame += 1) manager.update([body], 1000 + frame * 50);

  // A second scrap appears well inside the same body.
  const scrap = { x: 0.55, y: 0.6, width: 0.05, height: 0.06, energy: 0.3 };
  let active = manager.update([body, scrap], 1250).active;
  active = manager.update([body, scrap], 1300).active;
  assert.equal(selectObservedTracks(active).length, 1, 'one person, however they fragment');
});

void test('two people standing a body apart remain two people', () => {
  const manager = new AnonymousTrackManager();
  const left = { x: 0.3, y: 0.5, width: 0.1, height: 0.3, energy: 0.6 };
  const right = { x: 0.62, y: 0.5, width: 0.1, height: 0.3, energy: 0.6 };
  let active: ReturnType<AnonymousTrackManager['update']>['active'] = [];
  for (let frame = 0; frame < 4; frame += 1) {
    active = manager.update([left, right], 1000 + frame * 50).active;
  }
  assert.equal(selectObservedTracks(active).length, 2);
});

void test('the surviving identity is the one that has been there longer', () => {
  const manager = new AnonymousTrackManager();
  const body = { x: 0.5, y: 0.5, width: 0.14, height: 0.3, energy: 0.7 };
  for (let frame = 0; frame < 4; frame += 1) manager.update([body], 1000 + frame * 50);
  const [original] = selectObservedTracks(manager.update([body], 1250).active);

  manager.update([body, { x: 0.53, y: 0.53, width: 0.05, height: 0.05, energy: 0.3 }], 1300);
  const after = selectObservedTracks(manager.update([body], 1350).active);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, original.id, 'the established person should not be replaced');
});

void test('a detection lying inside another is part of the same body', () => {
  // A moving hand can sit well away from a body's centre while lying entirely
  // within its outline. Centroid distance alone cannot see that.
  const body = { x: 0.5, y: 0.45, width: 0.16, height: 0.3 };
  const hand = { x: 0.55, y: 0.58, width: 0.05, height: 0.06 };
  assert.ok(boxOverlapRatio(body, hand) >= 0.3, `overlap was only ${boxOverlapRatio(body, hand).toFixed(2)}`);

  const other = { x: 0.85, y: 0.45, width: 0.16, height: 0.3 };
  assert.equal(boxOverlapRatio(body, other), 0, 'separate people do not overlap');
});

void test('a small detection near a large one is a piece of it', () => {
  // Overlap alone misses this: a hand or shoulder can register just outside a
  // torso's box while obviously belonging to the same body. On a real session a
  // single visitor at 13% coverage still produced three separate tracks.
  const torso = { x: 0.5, y: 0.45, width: 0.16, height: 0.3 };
  const hand = { x: 0.55, y: 0.6, width: 0.05, height: 0.06 };
  assert.ok(isFragmentOf(hand, torso), 'a hand belongs to the body beside it');
  assert.ok(!isFragmentOf(torso, hand), 'and not the other way round');
});

void test('a person is never a fragment of another person', () => {
  const one = { x: 0.4, y: 0.5, width: 0.12, height: 0.3 };
  const two = { x: 0.56, y: 0.5, width: 0.12, height: 0.3 };
  assert.ok(!isFragmentOf(one, two), 'comparable sizes are two people');
  assert.ok(!isFragmentOf(two, one));

  // Nor is a distant scrap, however small.
  const farScrap = { x: 0.95, y: 0.9, width: 0.04, height: 0.04 };
  assert.ok(!isFragmentOf(farScrap, one), 'a scrap across the room is its own thing');
});

void test('three scraps of one visitor collapse to one person', () => {
  const manager = new AnonymousTrackManager();
  const torso = { x: 0.5, y: 0.45, width: 0.16, height: 0.3, energy: 0.7 };
  for (let frame = 0; frame < 4; frame += 1) manager.update([torso], 1000 + frame * 50);

  const hand = { x: 0.58, y: 0.6, width: 0.05, height: 0.06, energy: 0.3 };
  const shoulder = { x: 0.44, y: 0.3, width: 0.05, height: 0.05, energy: 0.3 };
  manager.update([torso, hand, shoulder], 1250);
  const active = manager.update([torso, hand, shoulder], 1300).active;
  assert.equal(selectObservedTracks(active).length, 1, 'one visitor, three scraps');
});

void test('three bodies cannot move less than one', () => {
  // Over a real desk-range session a single visitor ranged 39–546 active cells,
  // and every sample claiming three people sat at 75 cells or fewer. The count
  // of people is bounded by how much of the room is actually moving.
  const desk = 55;
  assert.equal(maxPlausibleBodies(35, desk), 1);
  assert.equal(maxPlausibleBodies(75, desk), 1);
  assert.equal(maxPlausibleBodies(546, desk), 10, 'a busy room is not constrained');
  assert.equal(maxPlausibleBodies(0, desk), 1, 'the bound never reaches zero');
});

void test('the bound only bites when the frame is nearly still', () => {
  // It must not interfere once there is enough movement to judge shape by.
  const desk = 55;
  assert.ok(maxPlausibleBodies(200, desk) >= 3);
  assert.ok(maxPlausibleBodies(400, desk) >= 7);
});

void test('the same movement means different counts at different camera distances', () => {
  // The arithmetic was never wrong; the constant was. A body covers about 55
  // cells at desk range and about 7 across a gallery, so the identical 199
  // active cells are at most three people in one room and twenty-eight in the
  // other. Reading the gallery with the desk figure is what silently turned an
  // opening-night crowd into three visitors.
  assert.equal(maxPlausibleBodies(199, 55), 4);
  assert.equal(maxPlausibleBodies(199, 7), 28);
  // And eight people across a gallery, at 83 cells, were bounded to two.
  assert.equal(maxPlausibleBodies(83, 55), 2);
  assert.ok(maxPlausibleBodies(83, 7) >= 8);
});

void test('a long path is thinned to a fixed budget without losing its ends', () => {
  // Paths are archived for the rest of the gallery week, so an unbounded one is
  // an unbounded store. The shape has to survive: a memory that no longer goes
  // where the visitor went is a different memory.
  const path = Array.from({ length: 500 }, (_, index) => point(index / 499, Math.sin(index / 40) * 0.4 + 0.5, index));
  const thinned = simplifyPath(path, 72);
  assert.equal(thinned.length, 72);
  assert.deepEqual(thinned[0], path[0], 'the start is where they came in');
  assert.deepEqual(thinned.at(-1), path.at(-1), 'the end is where they left');
  assert.ok(trajectoryDistance(thinned, path) < 0.02, 'the route is preserved');
});

void test('a path already inside the budget is copied, never aliased', () => {
  // The archive must not hold a reference into a live track's array; the
  // tracker keeps appending to it.
  const path = [point(0.1, 0.1, 0), point(0.2, 0.2, 1)];
  const copied = simplifyPath(path, 72);
  assert.deepEqual(copied, path);
  assert.notEqual(copied[0], path[0], 'a shared point would be mutated later');
});

void test('an empty path normalizes to nothing rather than to a point at the origin', () => {
  // A ghost at (0,0) is a body in the corner of the room that nobody produced.
  assert.deepEqual(normalizePath([]), []);
});

void test('a visitor who never moved normalizes to a stack at one place', () => {
  const still = normalizePath([point(0.42, 0.61, 0)], 8);
  assert.equal(still.length, 8);
  for (const sample of still) {
    assert.equal(sample.x, 0.42);
    assert.equal(sample.y, 0.61);
  }
});

void test('strength halves on its half-life and never escapes its bounds', () => {
  const halfLifeHours = 4;
  assert.ok(Math.abs(decayStrength(1, halfLifeHours * 3600, halfLifeHours) - 0.5) < 1e-12);
  assert.ok(Math.abs(decayStrength(1, halfLifeHours * 7200, halfLifeHours) - 0.25) < 1e-12);
  assert.equal(decayStrength(1, 0, halfLifeHours), 1, 'no time, no forgetting');
  assert.ok(decayStrength(1, 1e9, halfLifeHours) >= 0);
  // A zero or negative half-life would divide by nothing; the floor keeps the
  // burn-in's twelve hours of decay finite.
  assert.ok(Number.isFinite(decayStrength(1, 3600, 0)));
});

void test('reinforcement approaches certainty without ever reaching it', () => {
  let strength = 0.2;
  for (let recall = 0; recall < 200; recall += 1) strength = reinforceStrength(strength, 0.08);
  assert.ok(strength > 0.9 && strength < 1, `a memory became certain: ${strength}`);
  assert.equal(reinforceStrength(0.5, 0), 0.5, 'no reinforcement, no change');
  assert.equal(reinforceStrength(0.5, 5), 1, 'an out-of-range amount is clamped, not extrapolated');
});

void test('remembering a whisper costs it fidelity and detail, and reinforces it', () => {
  // The rule the whole piece rests on: recall strengthens a memory while making
  // it less true.
  const whisper = {
    envelope: Array.from({ length: 40 }, (_, index) => Math.sin(index / 4) * 0.5 + 0.5),
    fidelity: 1,
    strength: 0.3,
    recallCount: 0,
    lastReplayedAt: 0,
  };
  const recalled = rememberWhisper(whisper, () => 0.5);
  assert.ok(recalled.fidelity < whisper.fidelity, 'recall costs fidelity');
  assert.ok(recalled.strength > whisper.strength, 'and reinforces strength');
  assert.equal(recalled.recallCount, 1);
  assert.ok(recalled.lastReplayedAt > 0);
  for (const value of recalled.envelope) assert.ok(value >= 0 && value <= 1);
});

void test('a whisper recalled to nothing keeps enough of itself to still be a sound', () => {
  // Repeated recall shortens the envelope. An envelope of one or zero samples
  // is not a quieter memory, it is silence with a record that says otherwise.
  let whisper = {
    envelope: [0.2, 0.5, 0.8, 0.4, 0.1],
    fidelity: 1,
    strength: 0.3,
    recallCount: 0,
    lastReplayedAt: 0,
  };
  for (let recall = 0; recall < 60; recall += 1) whisper = rememberWhisper(whisper, () => 0.5);
  assert.ok(whisper.envelope.length >= 3, `a whisper decayed to ${whisper.envelope.length} samples`);
  assert.ok(whisper.fidelity >= 0.03, 'fidelity has a floor');
});

void test('the room reads its own state from who is in it', () => {
  const walking = (speed: number, stillFor = 0) => ({ speed, stillFor } as VisitorTrack);
  assert.equal(choosePersonality([], 0, 0, 'dormant'), 'dormant', 'empty and unmarked');
  assert.equal(choosePersonality([], 0, 0.5, 'dormant'), 'remembering', 'empty but well trodden');
  assert.equal(choosePersonality([], 3 * 60, 0.5, 'dormant'), 'lonely');
  assert.equal(choosePersonality([], 21 * 60, 0.5, 'lonely'), 'forgetting');

  assert.equal(choosePersonality([walking(0, 20)], 0, 0.2, 'curious'), 'remembering', 'everybody still');
  assert.equal(choosePersonality([walking(0.4)], 0, 0.2, 'curious'), 'attentive', 'somebody moving quickly');
  assert.equal(choosePersonality([walking(0.02)], 0, 0.2, 'dormant'), 'curious', 'a dormant room waking');
  assert.equal(choosePersonality([walking(0.02)], 0, 0.2, 'attentive'), 'attentive', 'an awake room stays awake');

  const crowd = (count: number) => Array.from({ length: count }, () => walking(0.1));
  assert.equal(choosePersonality(crowd(4), 0, 0.2, 'attentive'), 'crowded');
  assert.equal(choosePersonality(crowd(8), 0, 0.2, 'crowded'), 'overwhelmed');
});

void test('an empty frame reports no light shift rather than the darkest possible one', () => {
  // The histogram scan satisfies `seen >= 0` on its first bin, so without a
  // guard a zero-length frame returned -255: the far end of the range, which
  // downstream is a room that has just gone black.
  assert.equal(medianDifference(new Float32Array(0), new Float32Array(0)), 0);
});

void test('the light shift is the median, not the mean, of what changed', () => {
  // A visitor covering a third of the frame and 120 levels brighter than the
  // wall drags a mean to ~41, after which every untouched background pixel
  // reads as changed and the whole image looks like a lighting change.
  const background = new Float32Array(300).fill(80);
  const current = Float32Array.from(background);
  for (let index = 0; index < 100; index += 1) current[index] = 200;
  assert.equal(medianDifference(current, background), 0, 'a minority of the frame moves nothing');

  // A genuine lighting change moves every pixel, and must be reported.
  const brighter = Float32Array.from(background, (value) => value + 30);
  assert.equal(medianDifference(brighter, background), 30);
});

void test('a false memory with no whisper behind it carries no whisper in its lineage', () => {
  const makeGhost = (id: string, path: Point[]): Ghost => ({
    id, path, createdAt: 1, lastReplayedAt: 0, dwellSeconds: 2,
    intensity: 0.3, strength: 0.4, fidelity: 0.8, recallCount: 0,
    lineage: [id], falseMemory: false, day: 2,
  });
  const first = makeGhost('first', [point(0, 0), point(0.5, 0.5), point(1, 1)]);
  const second = makeGhost('second', [point(1, 0), point(0.5, 0.5), point(0, 1)]);
  const silent = createFalseMemory(first, second, 99);
  assert.deepEqual(silent.lineage.sort(), ['first', 'second']);
  assert.equal(silent.falseMemory, true);
  // Provenance is what makes a composite auditable. A whisper that did not go
  // into one must not be findable in it, and one that did must be.
  const heard = createFalseMemory(first, second, 99, { id: 'whisper', envelope: [0.1, 0.8, 0.3] });
  assert.ok(heard.lineage.includes('whisper'));
  assert.notDeepEqual(silent.path, heard.path, 'the whisper bends the joined path');

  // A whisper held with no envelope left — every point filtered away by
  // successive recalls — cannot bend anything, and must not be claimed to.
  const empty = createFalseMemory(first, second, 99, { id: 'mute', envelope: [] });
  assert.deepEqual(empty.path, silent.path);
  assert.ok(empty.lineage.includes('mute'), 'it was still a source');
});

void test('a walking visitor leaves a broader, fainter trace than a standing one', () => {
  const project = (p: Point) => ({ x: p.x, y: p.y });
  const walker: VisitorTrack[] = [{
    id: 'w', bornAt: 0, lastSeen: 1000, position: point(0.5, 0.5), previous: point(0.4, 0.5),
    velocity: { x: 0.1, y: 0 }, speed: 0.2, stillFor: 0, dwellSeconds: 2, path: [],
    active: true, occluded: false, confidence: 1, sightings: 5, extent: { width: 0.1, height: 0.26 },
  }];
  const stander: VisitorTrack[] = [{ ...walker[0], speed: 0, velocity: { x: 0, y: 0 }, stillFor: 4000 }];

  const walked = createMemoryField();
  depositObservedMemory(walked, walker, project);
  const stood = createMemoryField();
  depositObservedMemory(stood, stander, project);

  const peak = (field: Float32Array) => Math.max(...field);
  const spread = (field: Float32Array) => field.reduce((count, v) => count + (v > peak(field) * 0.1 ? 1 : 0), 0);
  assert.ok(peak(stood) > peak(walked), 'standing still is the heavier mark');
  assert.ok(spread(walked) < spread(stood), 'and the wider one');
  assert.ok(peak(walked) > 0, 'but walking still leaves something');

  // Interest scales what is deposited; refusing to be interested cannot erase it.
  const attended = createMemoryField();
  depositObservedMemory(attended, walker, project, () => 3);
  assert.ok(peak(attended) > peak(walked));
  const negative = createMemoryField();
  depositObservedMemory(negative, walker, project, () => -5);
  assert.equal(peak(negative), 0, 'a negative weight deposits nothing, never subtracts');
});

void test('a memory field is restored from whatever was saved, however much that was', () => {
  const empty = createMemoryField();
  assert.equal(empty.length, FIELD_WIDTH * FIELD_HEIGHT);
  assert.equal(memoryDensity(empty), 0);
  assert.equal(memoryDensity(new Float32Array(0)), 0, 'an empty field is empty, not a division by zero');

  const partial = createMemoryField([0.5, 0.25]);
  assert.equal(partial.length, empty.length, 'a short save is padded, never truncating the room');
  assert.deepEqual([partial[0], partial[1], partial[2]], [0.5, 0.25, 0]);

  // A field saved by a build with a larger grid must not overrun this one.
  const oversized = createMemoryField(Array.from({ length: empty.length + 500 }, () => 0.75));
  assert.equal(oversized.length, empty.length);
  assert.ok([...oversized].every((value) => value === 0.75));
});

void test('a trajectory needs two points on both sides before it can be compared', () => {
  const walk = [point(0, 0), point(0.5, 0.5), point(1, 1)];
  assert.equal(trajectoryDistance([], walk), Number.POSITIVE_INFINITY);
  assert.equal(trajectoryDistance(walk, []), Number.POSITIVE_INFINITY);
  assert.equal(trajectoryDistance([point(0, 0)], walk), Number.POSITIVE_INFINITY);
  assert.equal(trajectoryDistance(walk, [point(0, 0)]), Number.POSITIVE_INFINITY);
  // Infinity rather than 0: an unknown separation must never read as "the same
  // path", which is what tells a visitor they have walked this before.
  assert.ok(trajectoryDistance(walk, walk) < 0.001);
});

void test('a region with no area overlaps nothing, rather than dividing by its own emptiness', () => {
  // A blob one cell wide can reduce to zero height at the edge of the grid.
  // Dividing by its area gives Infinity, and Infinity clears every overlap
  // threshold there is — one degenerate region would be coalesced into
  // whichever body it happened to be nearest.
  const body = { x: 0.5, y: 0.5, width: 0.12, height: 0.3 };
  const flat = { x: 0.5, y: 0.5, width: 0.12, height: 0 };
  const thin = { x: 0.5, y: 0.5, width: 0, height: 0.3 };
  assert.equal(boxOverlapRatio(body, flat), 0);
  assert.equal(boxOverlapRatio(flat, body), 0);
  assert.equal(boxOverlapRatio(body, thin), 0);
  assert.equal(boxOverlapRatio(flat, flat), 0);
  assert.ok(Number.isFinite(boxOverlapRatio(body, flat)));
});

void test('the analyzer refuses a frame that is not the size it models the room at', () => {
  // The background model is a per-cell array. A frame of another size would
  // read past its end as zeros — a whole-room change on every frame, which
  // reads as a scene change and rejects everything, silently and forever.
  const analyzer = new MotionFrameAnalyzer();
  assert.throws(() => analyzer.analyze(new Float32Array(160 * 90 - 1), 20), /Unexpected motion frame size/);
  assert.throws(() => analyzer.analyze(new Float32Array(0), 20), /Unexpected motion frame size/);
  assert.doesNotThrow(() => analyzer.analyze(new Float32Array(160 * 90), 20));
});

void test('the rejected-frame share is a real fraction from the first judged frame onward', () => {
  const analyzer = new MotionFrameAnalyzer();
  // Before any frame has been judged the analyzer is still learning the room,
  // and says so. A zero here would be indistinguishable from a camera whose
  // every frame is being accepted, which is the opposite diagnosis.
  assert.equal(analyzer.getDiagnostics().state, 'idle', 'nothing has been looked at yet');
  assert.equal(analyzer.getDiagnostics().rejectedFraction, 0);

  const still = new Float32Array(160 * 90).fill(40);
  for (let frame = 0; frame < 40; frame += 1) analyzer.analyze(still, 20, 0.85, 1000 + frame * 50);
  assert.equal(analyzer.getDiagnostics().rejectedFraction, 0, 'a still room rejects nothing');

  // A whole-frame brightening is a light being switched on, and medianDifference
  // already removes it. What the coverage guard is for is a frame rearranged
  // beyond anything a body could do: here five pixels of every sixteen change,
  // so the median holds at nothing changed while 96% of cells are candidates.
  const rearranged = new Float32Array(160 * 90);
  for (let y = 0; y < 90; y += 1) {
    for (let x = 0; x < 160; x += 1) {
      const moved = (x % 4 < 2 && y % 4 < 2) || (x % 4 === 2 && y % 4 === 2);
      rearranged[y * 160 + x] = moved ? 220 : 40;
    }
  }
  analyzer.analyze(rearranged, 20, 0.85, 4000);
  const after = analyzer.getDiagnostics();
  assert.equal(after.state, 'scene-change');
  assert.ok(after.coveragePercent > 85, `coverage was ${after.coveragePercent}`);
  assert.ok(after.rejectedFraction > 0 && after.rejectedFraction <= 1, `fraction was ${after.rejectedFraction}`);

  analyzer.reset();
  assert.equal(analyzer.getDiagnostics().rejectedFraction, 0, 'relearning the room forgets the rejections too');
  assert.equal(analyzer.getDiagnostics().state, 'idle');
});


void test('a shortfall of half a body is not a reason to delete somebody', () => {
  // Measured on synthetic gallery frames driven through the whole installation:
  // two visitors at the geometry the work prescribes produced 19 accepted cells
  // against a learned scale of 11 — 1.73 bodies — and the bound reported one
  // person. That is the silent under-count this file's notes describe, arriving
  // through the mechanism built to prevent an over-count.
  assert.equal(maxPlausibleBodies(19, 11), 2, 'two visitors were rounded away');
  assert.equal(maxPlausibleBodies(20, 11), 2);
  assert.equal(maxPlausibleBodies(22, 11), 2);

  // The cases the bound exists for are untouched: the real session that claimed
  // three people at 75 cells against a 55-cell scale is 1.36, and still one.
  assert.equal(maxPlausibleBodies(75, 55), 1);
  assert.equal(maxPlausibleBodies(39, 55), 1, 'one visitor barely moving stays one');
  assert.equal(maxPlausibleBodies(5, 11), 1, 'and a nearly-still frame never reaches zero');

  // The bias is deliberate and one-directional: the bound may permit an
  // over-count, which coalescing and fragment continuity are there to catch,
  // and may never invent an absence, which nothing catches.
  for (let cells = 0; cells <= 400; cells += 1) {
    for (const scale of [7, 11, 55]) {
      const bound = maxPlausibleBodies(cells, scale);
      assert.ok(bound >= Math.floor(cells / scale), `${cells}/${scale} bounded below the floor`);
      assert.ok(bound >= 1);
    }
  }
});

/**
 * §12, found by the Rust port rather than by a test.
 *
 * A composite id embedded both of its parents' ids, and a false memory made
 * from two false memories embedded *theirs*. Measured, not feared: the length
 * roughly 2.6x'd per generation and reached 38,312 characters by the eighth,
 * every one of which was written to disk on every save. `room_protocol` caps a
 * memory id at 64 characters, so the Rust could not represent what the
 * TypeScript was producing — which is how it was found.
 *
 * Provenance belongs in `lineage`, which the standards already require and
 * which is now bounded too.
 */
void test('compositing false memories cannot grow an id or a lineage without limit', () => {
  const base = (id: string): Ghost => ({
    ...ghost(), id, lineage: [], falseMemory: false,
  });
  let first = base('g-1a2b3c');
  let second = base('g-4d5e6f');
  // Each generation composites the previous with itself, which is what
  // `chooseRareGhost` does whenever two false memories are the rarest pair.
  for (let generation = 1; generation <= 24; generation += 1) {
    const made = createFalseMemory(first, second, 1_700_000_000_000 + generation);
    assert.ok(
      made.id.length <= MEMORY_ID_MAX,
      `generation ${generation} minted a ${made.id.length}-character id`,
    );
    assert.ok(/^[a-z0-9-]+$/.test(made.id), `${made.id} is not an id the engine accepts`);
    assert.ok(
      made.lineage.length <= LINEAGE_MAX,
      `generation ${generation} carried ${made.lineage.length} sources`,
    );
    first = made;
    second = createFalseMemory(second, made, 1_700_000_000_000 + generation + 1_000);
  }
  // And the provenance that survives is the useful end: the immediate parents.
  const last = createFalseMemory(first, second, 1_700_000_000_001);
  assert.ok(last.lineage.includes(first.id), 'the immediate parents must survive the cut');
  assert.ok(last.lineage.includes(second.id));
});

/** A composite is named after its parents, so the same pair names the same memory. */
void test('a composite is named deterministically from what it was made of', () => {
  const one = ghost({ id: 'g-aaa' });
  const two = ghost({ id: 'g-bbb' });
  assert.equal(createFalseMemory(one, two, 99).id, createFalseMemory(one, two, 99).id);
  assert.notEqual(
    createFalseMemory(one, two, 99).id,
    createFalseMemory(two, one, 99).id,
    'which memory led is part of what was made',
  );
  // A separator inside the hash, so a shift of characters between the two
  // parents does not name the same composite.
  assert.notEqual(idHash('ab', 'c'), idHash('a', 'bc'));
});

/**
 * The two halves of a boundary no type system spans. `room-protocol` declares
 * these caps and this file mirrors them; reading the Rust here is what turns
 * "keep them in step" into a check.
 */
void test('the caps this engine holds are the caps the protocol declares', () => {
  const bounded = readFileSync(
    fileURLToPath(new URL('../crates/room-protocol/src/bounded.rs', import.meta.url)),
    'utf8',
  );
  const ids = readFileSync(
    fileURLToPath(new URL('../crates/room-protocol/src/ids.rs', import.meta.url)),
    'utf8',
  );
  const declared = (source: string, name: string) => {
    const match = new RegExp(`pub const ${name}: usize = (\\d+);`).exec(source);
    assert.ok(match, `${name} is not declared where this test looks for it`);
    return Number(match[1]);
  };
  assert.equal(declared(ids, 'MEMORY_ID_MAX'), MEMORY_ID_MAX);
  assert.equal(declared(bounded, 'LINEAGE_MAX'), LINEAGE_MAX);
});
