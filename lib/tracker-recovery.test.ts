import { createMemoryField, depositObservedMemory } from './memory-engine.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AnonymousTrackManager, MotionFrameAnalyzer, selectObservedTracks } from './motion-tracker.ts';

const body = (x: number) => ({ x, y: 0.5, width: 0.5, height: 0.5, energy: 0.8 });

void test('coalescing an observed fragment into an older body preserves the observation', () => {
  const manager = new AnonymousTrackManager();
  manager.update([body(0.4)], 1000);
  const original = manager.update([body(0.4)], 1100).active[0].id;
  manager.update([], 1200);
  // Outside centroid association gate, but inside the body's merge gate.
  const result = manager.update([body(0.62)], 1300);
  const visible = selectObservedTracks(result.active);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, original);
  assert.equal(visible[0].position.x, 0.62);
  assert.equal(visible[0].lastSeen, 1300);
  assert.ok(visible[0].path.some((point) => point.t === 1300));
});

void test('reacquisition does not retroactively count occlusion as dwell or stillness', () => {
  const manager = new AnonymousTrackManager();
  manager.update([body(0.4)], 1000);
  const seen = manager.update([body(0.4)], 1100).active[0];
  const dwell = seen.dwellSeconds;
  manager.update([], 1200);
  manager.update([], 2000);
  const recovered = manager.update([body(0.4)], 2100).active[0];
  assert.equal(recovered.dwellSeconds, dwell);
  assert.equal(recovered.stillFor, 0);
});

void test('distant fresh bodies do not refresh hidden tracks', () => {
  const manager = new AnonymousTrackManager();
  const small = (x: number) => ({ ...body(x), width: 0.08, height: 0.2 });
  manager.update([small(0.1)], 1000);
  manager.update([small(0.1)], 1100);
  manager.update([], 1200);
  const result = manager.update([small(0.9)], 1300);
  assert.equal(selectObservedTracks(result.active).length, 0);
  assert.equal(result.active.filter((track) => track.occluded).length, 1);
});

/**
 * Two people standing close — within one body-width, inside the too-close
 * collapse radius, but never actually overlapping in the frame — is the
 * scenario the greedy-claim and blanket too-close-collapse mechanisms had no
 * measured protection against: `assignTracks` (see `track-assignment.test.ts`'s
 * starvation case, cross-checked against a brute-force optimum) fixes the
 * matching half; the `bothFreshlyDistinct` guard on the `tooClose` check in
 * the collapse loop fixes the other half, while leaving `inside`/`fragment`
 * running unconditionally so genuinely overlapping fragments of one body
 * still collapse (see 'a track coalesced away is not then used to coalesce
 * another', above, which pins exactly that).
 *
 * The gap chosen (0.07 at width 0.08) is inside `MIN_PERSON_SEPARATION`
 * (0.08, so the pre-fix code always collapsed it) but produces zero box
 * overlap, so `inside` and `fragment` do not independently explain the two
 * tracks surviving here — only the guard does.
 */
void test('two people standing closer than one body-width apart both survive', () => {
  const manager = new AnonymousTrackManager();
  const close = (x: number) => ({ x, y: 0.5, width: 0.08, height: 0.2, energy: 0.8 });
  let now = 0;
  const step = (blobs: ReturnType<typeof close>[]) => {
    now += 100;
    return manager.update(blobs, now);
  };

  // Confirm both tracks while they are far apart.
  step([close(0.2), close(0.8)]);
  step([close(0.2), close(0.8)]);

  // Approach, one gated step at a time, down to a 0.07 gap — inside the
  // too-close radius the whole way — and hold there across several frames.
  for (const [left, right] of [
    [0.3, 0.7], [0.38, 0.62], [0.44, 0.56], [0.465, 0.535], [0.465, 0.535], [0.465, 0.535],
  ] as const) {
    const result = step([close(left), close(right)]);
    assert.equal(selectObservedTracks(result.active).length, 2,
      `at ${left}/${right}: two distinct blobs must stay two tracks`);
  }

  // Separate again, and confirm no phantom third track was left behind.
  for (const [left, right] of [[0.44, 0.56], [0.38, 0.62], [0.2, 0.8]] as const) {
    const result = step([close(left), close(right)]);
    assert.equal(result.active.length, 2, `separating at ${left}/${right}: still exactly two tracks`);
  }
});

void test('a track older than the occlusion limit cannot be resurrected by a late frame', () => {
  const manager = new AnonymousTrackManager();
  manager.update([body(0.4)], 1000);
  const original = manager.update([body(0.4)], 1100).active[0].id;
  const result = manager.update([body(0.4)], 10000);
  assert.ok(result.ended.some((track) => track.id === original));
  assert.equal(selectObservedTracks(result.active).length, 0);
  assert.notEqual(result.active[0].id, original);
});


void test('unconfirmed and hidden tracks cannot deposit memory; observed tracks use projection', () => {
  const manager = new AnonymousTrackManager();
  const field = createMemoryField();
  const project = () => ({ x: 0.9, y: 0.9 });
  depositObservedMemory(field, manager.update([body(0.1)], 1000).active, project);
  assert.ok(field.every((value) => value === 0));
  const confirmed = manager.update([body(0.1)], 1100).active;
  depositObservedMemory(field, confirmed, project);
  assert.ok(field.some((value) => value > 0));
  assert.equal(field[0], 0);
  const before = field.slice();
  depositObservedMemory(field, manager.update([], 1200).active, project);
  assert.deepEqual(field, before);
});

void test('a briefly fragmented observed body keeps one identity', () => {
  const manager = new AnonymousTrackManager();
  const whole = { x: 0.5, y: 0.5, width: 0.5, height: 0.6, energy: 1 };
  manager.update([whole], 1000);
  const id = manager.update([whole], 1100).active[0].id;
  const fragments = [
    { x: 0.32, y: 0.5, width: 0.12, height: 0.5, energy: 0.4 },
    { x: 0.68, y: 0.5, width: 0.12, height: 0.5, energy: 0.4 },
  ];
  for (let now = 1150; now <= 1600; now += 50) {
    const visible = selectObservedTracks(manager.update(fragments, now).active);
    assert.equal(visible.length, 1, 'a split inside the recent outline invented a person');
    assert.equal(visible[0].id, id);
  }
  assert.ok(manager.getFragmentRecoveries() > 0);
  manager.clear();
  assert.equal(manager.getFragmentRecoveries(), 0);
});

void test('fragment continuity expires rather than permanently merging two emerging people', () => {
  const manager = new AnonymousTrackManager();
  const whole = { x: 0.5, y: 0.5, width: 0.5, height: 0.6, energy: 1 };
  manager.update([whole], 1000);
  manager.update([whole], 1100);
  const separated = [
    { x: 0.32, y: 0.5, width: 0.12, height: 0.5, energy: 0.4 },
    { x: 0.68, y: 0.5, width: 0.12, height: 0.5, energy: 0.4 },
  ];
  let visible = [];
  for (let now = 1150; now <= 3000; now += 50) visible = selectObservedTracks(manager.update(separated, now).active);
  assert.equal(visible.length, 2, 'inferred fragments must not renew their own continuity evidence');
});


void test('a second person outside the previous outline is not absorbed by continuity', () => {
  const manager = new AnonymousTrackManager();
  const first = { x: 0.3, y: 0.5, width: 0.2, height: 0.5, energy: 0.7 };
  const second = { ...first, x: 0.7 };
  manager.update([first], 1000);
  manager.update([first], 1100);
  manager.update([first, second], 1150);
  assert.equal(selectObservedTracks(manager.update([first, second], 1200).active).length, 2);
  assert.equal(manager.getFragmentRecoveries(), 0);
});

void test('a scrap of movement inside an old outline is not enough to hold a body together', () => {
  // Fragment continuity exists because a whole observed body can split into
  // regions inside its own previous outline. It must not fire on a hand and a
  // cuff: two tiny pieces are evidence that something moved, not that a person
  // is still standing there, and treating them as a body keeps a track alive
  // across an absence the tracker cannot see.
  const manager = new AnonymousTrackManager();
  const outline = { x: 0.5, y: 0.5, width: 0.4, height: 0.6, energy: 0.8 };
  manager.update([outline], 1000);
  manager.update([outline], 1100);
  assert.equal(manager.getFragmentRecoveries(), 0);

  // Two pieces well inside the outline, together covering a twentieth of it.
  const scraps = [
    { x: 0.45, y: 0.4, width: 0.05, height: 0.05, energy: 0.4 },
    { x: 0.55, y: 0.45, width: 0.05, height: 0.05, energy: 0.4 },
  ];
  manager.update(scraps, 1200);
  assert.equal(manager.getFragmentRecoveries(), 0, 'two scraps were treated as a whole body');

  // The same two tracks, but each piece now half the outline: that is a body
  // that split, and continuity is exactly what it is for.
  const halves = [
    { x: 0.42, y: 0.5, width: 0.18, height: 0.55, energy: 0.5 },
    { x: 0.58, y: 0.5, width: 0.18, height: 0.55, energy: 0.5 },
  ];
  const whole = new AnonymousTrackManager();
  whole.update([outline], 1000);
  whole.update([outline], 1100);
  whole.update(halves, 1200);
  assert.equal(whole.getFragmentRecoveries(), 1, 'a body that split into halves was read as two people');
});

void test('a region too faint or too small to be anybody is not a blob', () => {
  // Connected components joins whatever touches, so a single flickering cell
  // and a faint smear both arrive here. A body is at least three cells and
  // carries real energy; without both bounds the tracker mints a person out of
  // sensor noise and then grants it four seconds of occlusion prediction.
  const analyzer = new MotionFrameAnalyzer();
  const still = new Float32Array(160 * 90).fill(40);
  for (let frame = 0; frame < 40; frame += 1) analyzer.analyze(still, 20, 0.85, 1000 + frame * 50);

  const speck = new Float32Array(160 * 90).fill(40);
  // One cell is 4x4 pixels; light two of them, side by side, brightly.
  for (let y = 40; y < 44; y += 1) for (let x = 80; x < 88; x += 1) speck[y * 160 + x] = 230;
  let blobs: ReturnType<MotionFrameAnalyzer['analyze']> = [];
  for (let frame = 0; frame < 4; frame += 1) blobs = analyzer.analyze(speck, 20, 0.85, 4000 + frame * 50);
  assert.deepEqual(blobs, [], 'two bright cells are not a person');
  assert.ok(analyzer.getDiagnostics().activeCells > 0, 'but the cells were accepted, so the bound is the blob test');

  // A region large enough to be a body does become one.
  const person = new Float32Array(160 * 90).fill(40);
  for (let y = 36; y < 52; y += 1) for (let x = 76; x < 92; x += 1) person[y * 160 + x] = 230;
  for (let frame = 0; frame < 4; frame += 1) blobs = analyzer.analyze(person, 20, 0.85, 6000 + frame * 50);
  assert.equal(blobs.length, 1, 'a body-sized region must be a blob');
});

void test('a track coalesced away is not then used to coalesce another', () => {
  // Three tracks standing inside one body's width: the newest survivor takes
  // the oldest, and the one already taken must not go on to absorb a third.
  // Consuming a deleted identity is how a coalesce loop produces a track that
  // no longer exists in the map it is iterating.
  const manager = new AnonymousTrackManager();
  const at = (x: number) => ({ x, y: 0.5, width: 0.12, height: 0.3, energy: 0.7 });
  manager.update([at(0.3)], 1000);
  manager.update([at(0.3)], 1100);
  manager.update([at(0.3), at(0.34)], 1200);
  manager.update([at(0.3), at(0.34), at(0.38)], 1300);
  const result = manager.update([at(0.3), at(0.34), at(0.38)], 1400);
  assert.equal(result.active.length, 1, `three overlapping detections became ${result.active.length} people`);
  assert.ok(result.active.every((track) => Number.isFinite(track.position.x)));
});
