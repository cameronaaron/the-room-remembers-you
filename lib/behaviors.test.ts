import assert from 'node:assert/strict';
import test from 'node:test';
import { BehaviorWatcher, type BehaviorKind } from './behaviors.ts';
import type { Point, VisitorTrack } from './room-types.ts';

function track(id: string, x: number, y: number, width = 0.09, path: Point[] = []): VisitorTrack {
  return {
    id,
    bornAt: 0,
    lastSeen: 0,
    position: { x, y, t: 0 },
    previous: { x, y, t: 0 },
    velocity: { x: 0, y: 0 },
    speed: 0,
    stillFor: 0,
    dwellSeconds: 5,
    path,
    active: true,
    occluded: false,
    confidence: 1,
    sightings: 5,
    extent: { width, height: 0.26 },
  };
}

/** Advance a watcher with a scripted sequence of frames. */
function play(
  watcher: BehaviorWatcher,
  frames: Array<{ at: number; tracks: VisitorTrack[] }>,
): BehaviorKind[] {
  const seen: BehaviorKind[] = [];
  for (const frame of frames) {
    for (const event of watcher.update(frame.tracks, frame.at)) seen.push(event.kind);
  }
  return seen;
}

void test('a stationary body with a moving outline reads as a wave', () => {
  const watcher = new BehaviorWatcher();
  const frames = Array.from({ length: 14 }, (_, index) => ({
    at: 1000 + index * 120,
    // Standing still; the detected region widens and narrows as an arm moves.
    tracks: [track('a', 0.5, 0.5, 0.09 + (index % 4 < 2 ? 0.05 : 0))],
  }));
  assert.ok(play(watcher, frames).includes('wave'));
});

void test('standing still without moving is not a wave', () => {
  const watcher = new BehaviorWatcher();
  const frames = Array.from({ length: 14 }, (_, index) => ({
    at: 1000 + index * 120,
    tracks: [track('a', 0.5, 0.5, 0.09)],
  }));
  assert.ok(!play(watcher, frames).includes('wave'));
});

void test('walking across the room is not a wave', () => {
  const watcher = new BehaviorWatcher();
  const frames = Array.from({ length: 14 }, (_, index) => ({
    at: 1000 + index * 120,
    // Moving, and the outline varies as bodies do.
    tracks: [track('a', 0.2 + index * 0.03, 0.5, 0.09 + (index % 4 < 2 ? 0.05 : 0))],
  }));
  assert.ok(!play(watcher, frames).includes('wave'), 'drift must disqualify a wave');
});

void test('two people closing the distance read as an approach', () => {
  const watcher = new BehaviorWatcher();
  const frames = Array.from({ length: 12 }, (_, index) => ({
    at: 1000 + index * 200,
    tracks: [
      track('a', 0.2 + index * 0.02, 0.5),
      track('b', 0.8 - index * 0.02, 0.5),
    ],
  }));
  assert.ok(play(watcher, frames).includes('approach'));
});

void test('two people already together do not read as approaching', () => {
  const watcher = new BehaviorWatcher();
  const frames = Array.from({ length: 12 }, (_, index) => ({
    at: 1000 + index * 200,
    tracks: [track('a', 0.48, 0.5), track('b', 0.54, 0.5)],
  }));
  assert.ok(!play(watcher, frames).includes('approach'));
});

void test('walking someone else\'s path a moment later reads as following', () => {
  const watcher = new BehaviorWatcher();
  const frames: Array<{ at: number; tracks: VisitorTrack[] }> = [];
  for (let index = 0; index < 24; index += 1) {
    const at = 1000 + index * 200;
    const leaderX = 0.15 + index * 0.03;
    // The follower is where the leader was 1.6 s (eight frames) ago.
    const followerX = 0.15 + Math.max(0, index - 8) * 0.03;
    frames.push({ at, tracks: [track('lead', leaderX, 0.5), track('follow', followerX, 0.5)] });
  }
  assert.ok(play(watcher, frames).includes('follow'));
});

void test('two people walking side by side are not following each other', () => {
  const watcher = new BehaviorWatcher();
  const frames = Array.from({ length: 24 }, (_, index) => ({
    at: 1000 + index * 200,
    // Same heading, same time, well apart across the direction of travel.
    tracks: [
      track('a', 0.15 + index * 0.03, 0.35),
      track('b', 0.15 + index * 0.03, 0.75),
    ],
  }));
  assert.ok(!play(watcher, frames).includes('follow'));
});

void test('walking in together, from the edge, reads as arriving together', () => {
  const watcher = new BehaviorWatcher();
  const seen = play(watcher, [
    { at: 1000, tracks: [track('a', 0.08, 0.5), track('b', 0.12, 0.55)] },
    { at: 1200, tracks: [track('a', 0.14, 0.5), track('b', 0.18, 0.55)] },
  ]);
  assert.ok(seen.includes('together'));
});

void test('two tracks appearing mid-room at once is not an arrival', () => {
  // The failure this exists for, from a real session: sensing starts, every
  // track in the room is born in the same instant, and the room told a single
  // visitor "two of you, at once" within three seconds. A track being born is
  // not the same event as a person arriving — someone who genuinely walked in
  // was at the edge a moment earlier.
  const watcher = new BehaviorWatcher();
  const seen = play(watcher, [
    { at: 1000, tracks: [track('a', 0.45, 0.5), track('b', 0.55, 0.52)] },
    { at: 1200, tracks: [track('a', 0.45, 0.5), track('b', 0.55, 0.52)] },
  ]);
  assert.ok(!seen.includes('together'));
});

void test('nothing is reported until sensing has settled', () => {
  // For several seconds after the background model warms up, anything already
  // standing in the room is still being learned in and the changed area is
  // about twice its eventual size. Detections there are good enough to react
  // to and not solid enough to make claims about.
  const watcher = new BehaviorWatcher();
  const frames = [
    { at: 1000, tracks: [track('a', 0.08, 0.5), track('b', 0.12, 0.55)] },
    { at: 1200, tracks: [track('a', 0.14, 0.5), track('b', 0.18, 0.55)] },
  ];
  const seen: string[] = [];
  for (const frame of frames) {
    for (const event of watcher.update(frame.tracks, frame.at, false)) seen.push(event.kind);
  }
  assert.deepEqual(seen, [], 'an unsettled room must stay quiet');
});

void test('someone joining later did not arrive together', () => {
  const watcher = new BehaviorWatcher();
  const seen = play(watcher, [
    { at: 1000, tracks: [track('a', 0.3, 0.5)] },
    { at: 9000, tracks: [track('a', 0.3, 0.5), track('b', 0.4, 0.5)] },
    { at: 9200, tracks: [track('a', 0.3, 0.5), track('b', 0.4, 0.5)] },
  ]);
  assert.ok(!seen.includes('together'));
});

void test('returning to a spot after going away reads as a revisit', () => {
  const watcher = new BehaviorWatcher();
  const path: Point[] = [{ x: 0.3, y: 0.5, t: 0 }];
  for (let index = 1; index <= 14; index += 1) path.push({ x: 0.3 + index * 0.05, y: 0.5, t: index * 2000 });
  path.push({ x: 0.3, y: 0.5, t: 40_000 });
  const seen = play(watcher, [{ at: 40_000, tracks: [track('a', 0.3, 0.5, 0.09, path)] }]);
  assert.ok(seen.includes('revisit'));
});

void test('never leaving a spot is not a revisit', () => {
  const watcher = new BehaviorWatcher();
  const path: Point[] = Array.from({ length: 16 }, (_, index) => ({ x: 0.3, y: 0.5, t: index * 2000 }));
  const seen = play(watcher, [{ at: 40_000, tracks: [track('a', 0.3, 0.5, 0.09, path)] }]);
  assert.ok(!seen.includes('revisit'), 'an excursion is required');
});

void test('people apart moving in step read as mirroring', () => {
  const watcher = new BehaviorWatcher();
  const frames = Array.from({ length: 14 }, (_, index) => {
    const a = track('a', 0.2 + index * 0.02, 0.3);
    const b = track('b', 0.7 + index * 0.02, 0.8);
    for (const person of [a, b]) {
      person.velocity = { x: 0.12, y: 0 };
      person.speed = 0.12;
    }
    return { at: 1000 + index * 180, tracks: [a, b] };
  });
  assert.ok(play(watcher, frames).includes('mirror'));
});

void test('people moving in opposite directions are not mirroring', () => {
  const watcher = new BehaviorWatcher();
  const frames = Array.from({ length: 14 }, (_, index) => {
    const a = track('a', 0.2 + index * 0.02, 0.3);
    const b = track('b', 0.8 - index * 0.02, 0.8);
    a.velocity = { x: 0.12, y: 0 };
    a.speed = 0.12;
    b.velocity = { x: -0.12, y: 0 };
    b.speed = 0.12;
    return { at: 1000 + index * 180, tracks: [a, b] };
  });
  assert.ok(!play(watcher, frames).includes('mirror'));
});

void test('a behaviour is not reported twice in quick succession', () => {
  const watcher = new BehaviorWatcher();
  const wave = (at: number, index: number) => ({
    at,
    tracks: [track('a', 0.5, 0.5, 0.09 + (index % 4 < 2 ? 0.05 : 0))],
  });
  const first = play(watcher, Array.from({ length: 14 }, (_, i) => wave(1000 + i * 120, i)));
  const second = play(watcher, Array.from({ length: 14 }, (_, i) => wave(3000 + i * 120, i)));
  assert.equal(first.filter((kind) => kind === 'wave').length, 1);
  assert.equal(second.filter((kind) => kind === 'wave').length, 0, 'cooldown should suppress');
});

void test('tracks that leave stop being remembered', () => {
  const watcher = new BehaviorWatcher();
  watcher.update([track('a', 0.5, 0.5)], 1000);
  watcher.update([], 1200);
  // A new track reusing the position must not inherit the departed history.
  const seen = watcher.update([track('a', 0.5, 0.5)], 1400);
  assert.deepEqual(seen, []);
});

void test('a reset leaves the watcher with no history of anybody', () => {
  // Alt+Shift+R erases room memory. A watcher still holding where people stood
  // would report a revisit against a room that has forgotten the first visit.
  const watcher = new BehaviorWatcher();
  for (let step = 0; step < 60; step += 1) {
    watcher.update([track('a', 0.2 + step * 0.01, 0.5)], step * 200, true);
  }
  watcher.reset();
  // After a reset the same track is a stranger: nothing it does can be compared
  // against what it did before, so its first frame back reports nothing.
  assert.deepEqual(watcher.update([track('a', 0.2, 0.5)], 0, true), []);
});

void test('a sparse follower is compared only against leader positions near the right moment', () => {
  // The follower reports at 3 Hz while the leader reports at 12. Every lag
  // still finds a nearest leader sample, but most of them are the wrong moment
  // by half a second or more, and matching those would call a walk down the
  // same corridor a minute apart "following". Only samples within 400 ms of
  // the lagged time may count, and dropping enough of them leaves too few to
  // decide on at all.
  const watcher = new BehaviorWatcher(12_000);
  const frames: Array<{ at: number; tracks: VisitorTrack[] }> = [];
  for (let step = 0; step < 60; step += 1) {
    const at = 1000 + step * 100;
    const leader = track('leader', 0.1 + step * 0.012, 0.5);
    // One follower sample per second, landing between the leader's.
    const tracks = step % 10 === 0
      ? [leader, track('follower', 0.1 + (step - 10) * 0.012, 0.5)]
      : [leader];
    frames.push({ at, tracks });
  }
  const sparse = play(watcher, frames);
  assert.ok(!sparse.includes('follow'), 'six coincidences at one lag are not a claim about a person');

  // The same two paths, reported at the same rate, are following.
  const dense = new BehaviorWatcher(12_000);
  const denseFrames = Array.from({ length: 60 }, (_, step) => ({
    at: 1000 + step * 100,
    tracks: [
      track('leader', 0.1 + step * 0.012, 0.5),
      track('follower', 0.1 + Math.max(0, step - 10) * 0.012, 0.52),
    ],
  }));
  assert.ok(play(dense, denseFrames).includes('follow'));
});

void test('a path that comes back to a different place is not a revisit', () => {
  const watcher = new BehaviorWatcher();
  // A long walk whose old points are all old enough, but none of which is
  // within REVISIT_RADIUS of where the visitor now stands.
  const path = Array.from({ length: 40 }, (_, index) => ({
    x: 0.05 + index * 0.02,
    y: 0.2,
    t: 1000 + index * 400,
  }));
  const now = 1000 + 40 * 400 + 30_000;
  assert.deepEqual(
    play(watcher, [{ at: now, tracks: [track('a', 0.9, 0.9, 0.09, path)] }]),
    [],
    'standing somewhere new is not standing somewhere again',
  );

  const returned = new BehaviorWatcher();
  assert.ok(
    play(returned, [{ at: now, tracks: [track('a', 0.06, 0.2, 0.09, path)] }]).includes('revisit'),
    'the same walk, ending where it began, is one',
  );
});

void test('a track reporting speed with no direction cannot align with anything', () => {
  // The tracker supplies speed and velocity separately, so a smoothed speed
  // above the floor alongside a zero velocity vector is a shape the detector is
  // handed, not one it computes. Normalising by a zero length divides to NaN,
  // and NaN fails every comparison — so a room of motionless people would read
  // as unaligned rather than as an error, and nobody would ever find out.
  const watcher = new BehaviorWatcher();
  const still = (id: string, x: number) => ({
    ...track(id, x, 0.5),
    speed: 0.4,
    velocity: { x: 0, y: 0 },
  });
  const frames = Array.from({ length: 12 }, (_, index) => ({
    at: 1000 + index * 150,
    // Well inside the frame, so neither is an arrival and `together` stays out
    // of the way; 0.4 apart, comfortably past MIRROR_MIN_SEPARATION.
    tracks: [still('a', 0.3), still('b', 0.7)],
  }));
  assert.deepEqual(play(watcher, frames), [], 'no direction, no mirroring');
});

void test('a leader whose history starts long after the follower cannot be matched to them', () => {
  // The follower has been in the room for a while and the leader has just
  // arrived, so at the longer lags the nearest leader sample is seconds away
  // from the moment being compared. Matching those would say "following" about
  // two people who were not in the room at the same time.
  const watcher = new BehaviorWatcher(20_000);
  const frames: Array<{ at: number; tracks: VisitorTrack[] }> = [];
  for (let step = 0; step < 40; step += 1) {
    frames.push({ at: 1000 + step * 100, tracks: [track('follower', 0.1 + step * 0.02, 0.5)] });
  }
  // The leader appears for one burst, far later, on the same route.
  for (let step = 0; step < 12; step += 1) {
    const at = 6000 + step * 100;
    frames.push({ at, tracks: [track('follower', 0.9, 0.5), track('leader', 0.1 + step * 0.03, 0.52)] });
  }
  assert.ok(!play(watcher, frames).includes('follow'), 'two people who overlapped for a second are not following');
});

/**
 * §12: the sample window bounds this in practice, but "in practice" is not a
 * bound. A caller stepping its clock in fractions of a millisecond — a replay
 * running flat out, a simulation with no wall clock — would otherwise grow one
 * track's history without limit over an unattended run.
 *
 * The ceiling is `SAMPLES_MAX`, and `room_engine::behavior` holds the same
 * figure so the two implementations agree by construction in a regime neither
 * will ever reach rather than approximately.
 */
void test('a clock stepping faster than any sensing pipeline cannot grow one track without limit', () => {
  const watcher = new BehaviorWatcher(Number.POSITIVE_INFINITY);
  for (let step = 0; step < 4_000; step += 1) {
    watcher.update([track('one', 0.5, 0.5)], step * 1e-6);
  }
  // Read through the only door the watcher opens: `mirror` compares the newest
  // samples of two windows, and the held count is what bounds that work.
  const held = (watcher as unknown as {
    watched: Map<string, { samples: unknown[] }>;
  }).watched.get('one');
  assert.ok(held, 'the track is still present');
  assert.equal(held.samples.length, 1_024);
});
