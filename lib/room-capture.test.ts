import assert from 'node:assert/strict';
import test from 'node:test';
import { rememberDeparture, rememberDepartures, type DepartureRoom } from './room-capture.ts';
import { MAX_ACTIVE_RECALLS } from './room-emergence.ts';
import { GHOSTS_MAX } from './room-upkeep.ts';
import { RoomRng } from './room-rng.ts';
import { DEFAULT_CONFIG, type ActiveGhost, type Ghost } from './room-types.ts';
import { track } from './test-doubles/room.ts';

const NOW = 100_000;
const WALL = 1_700_000_000_000;

/** A room nobody has left yet. */
function room(overrides: Partial<DepartureRoom> = {}): DepartureRoom {
  return {
    ghosts: [],
    active: [],
    config: DEFAULT_CONFIG,
    day: 1,
    wall: WALL,
    now: NOW,
    random: new RoomRng(1).draw,
    ...overrides,
  };
}

/** A walk long enough and slow enough to be worth remembering. */
function walk(x: number, y = 0.5, points = 12) {
  return Array.from({ length: points }, (_, step) => ({
    x: x + step * 0.05,
    y,
    t: NOW - (points - step) * 400,
  }));
}

void test('a visitor who walked becomes a memory the room holds', () => {
  const held = room();
  const merged = rememberDeparture(track({ path: walk(0.1), dwellSeconds: 6 }), held);
  assert.equal(held.ghosts.length, 1, 'the walk was kept');
  assert.equal(merged, null, 'nothing was converged with, so there is nothing to say');
  assert.equal(held.active.length, 0);
});

void test('a visitor who barely appeared leaves nothing behind', () => {
  const held = room();
  // Under the path length and the dwell floor `captureGhost` holds: a person
  // clipping the edge of frame is not a walk the room should keep.
  assert.equal(rememberDeparture(track({ path: walk(0.1, 0.5, 3) }), held), null);
  assert.equal(rememberDeparture(track({ path: walk(0.1), dwellSeconds: 0.5 }), held), null);
  assert.equal(held.ghosts.length, 0);
});

/**
 * The one thing this decision says out loud. Walking a route the room already
 * holds merges the two, and that merge is the only departure the room speaks
 * about — which is why it was worth taking out of the render component, where
 * it could only be reached by waiting for somebody to leave.
 */
void test('walking a route the room already holds merges the two and says so', () => {
  const held = room();
  const route = walk(0.1);
  rememberDeparture(track({ id: 'first', path: route, dwellSeconds: 6 }), held);
  assert.equal(held.ghosts.length, 1);

  const merged = rememberDeparture(track({ id: 'second', path: route, dwellSeconds: 6 }), held);
  assert.ok(merged, 'the same route twice is a convergence');
  assert.equal(merged.event, 'convergence — repeated paths merged');
  assert.equal(held.active.length, 1, 'and the merged memory surfaces');
  assert.equal(held.active[0].kind, 'convergence');
  // Addressed along the shared route, not at the edge of the room where the
  // track happened to end.
  assert.ok(merged.at.x > 0.1 && merged.at.x < 0.9, `addressed at ${merged.at.x}`);
});

/**
 * A convergence may find no slot — living visitors keep reserved bodies — and
 * the room still merged the paths. The line is the point, not the recall; a
 * caller that skipped the line when the slots were full would make the room
 * silent exactly when it is busiest.
 */
void test('a full room still says what it merged, even with no slot to show it in', () => {
  const full: ActiveGhost[] = Array.from({ length: MAX_ACTIVE_RECALLS + 3 }, (_, index) => ({
    ghost: { id: `busy-${index}` } as Ghost,
    startedAt: NOW,
    kind: 'ghost' as const,
  }));
  const held = room({ active: full });
  const route = walk(0.1);
  rememberDeparture(track({ id: 'first', path: route, dwellSeconds: 6 }), held);
  const merged = rememberDeparture(track({ id: 'second', path: route, dwellSeconds: 6 }), held);
  assert.ok(merged, 'the merge happened whether or not it could be shown');
  assert.equal(held.active.length, full.length, 'and nothing was forced into a full room');
});

void test('the whole frame of departures is answered in order', () => {
  const held = room();
  const route = walk(0.2);
  rememberDeparture(track({ id: 'earlier', path: route, dwellSeconds: 6 }), held);

  const said = rememberDepartures([
    track({ id: 'brief', path: walk(0.1, 0.5, 3) }),
    track({ id: 'retracing', path: route, dwellSeconds: 6 }),
    track({ id: 'elsewhere', path: walk(0.05, 0.92), dwellSeconds: 6 }),
  ], held);
  assert.equal(said.length, 1, 'only the retrace is worth a line');
  assert.equal(said[0].event, 'convergence — repeated paths merged');
  // The brief one was dropped; the other two were kept alongside the first.
  assert.equal(held.ghosts.length, 3);
});

/**
 * §12: a gallery day is thousands of departures, and every one of them adds a
 * memory. The cap belongs to the collection, not to the caller remembering it.
 */
void test('a day of visitors cannot grow the room past its ceiling', () => {
  const held = room();
  for (let visitor = 0; visitor < GHOSTS_MAX * 3; visitor += 1) {
    rememberDeparture(
      track({ id: `visitor-${visitor}`, path: walk(0.05 + (visitor % 16) * 0.05), dwellSeconds: 6 }),
      held,
    );
    assert.ok(held.ghosts.length <= GHOSTS_MAX, `grew to ${held.ghosts.length}`);
  }
  assert.equal(held.ghosts.length, GHOSTS_MAX);
});

/**
 * The departure draws from the room's stream — a recalled memory mutates, and
 * how far it mutates is a draw. Two rooms given the same seed must remember the
 * same day, which is the whole point of the room having a seed at all.
 */
void test('the same seed remembers the same day', () => {
  const play = (seed: number) => {
    const held = room({ random: new RoomRng(seed).draw });
    const route = walk(0.15);
    for (let visitor = 0; visitor < 6; visitor += 1) {
      rememberDeparture(track({ id: `v-${visitor}`, path: route, dwellSeconds: 6 }), held);
    }
    return held.ghosts.map((ghost) => ({
      fidelity: ghost.fidelity,
      recallCount: ghost.recallCount,
      path: ghost.path.map((point) => [point.x, point.y]),
    }));
  };
  assert.deepEqual(play(7), play(7));
  assert.notDeepEqual(play(7), play(8));
});
