import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOSING_DURATION_MS,
  EMPTY_ROOM_SECONDS,
  OPENING_DURATION_MS,
  OPENING_FIELD_SCALE,
  OVERNIGHT_FLOOR,
  closeDay,
  survivesTheNight,
  compressDay,
  fallsToAfterHours,
  openDay,
} from './room-lifecycle.ts';
import { ghost } from './test-doubles/room.ts';

void test('opening twice is one day, not two', () => {
  // The operator presses it when the doors open and again when they are not
  // sure they pressed it. A day counter that advances twice makes every trace
  // recorded that morning belong to a day that never happened.
  const first = openDay('after-hours', 3);
  assert.equal(first.day, 4);
  assert.equal(openDay(first.lifecycle, first.day).day, 4);
});

void test('the day counter advances from every state a night can end in', () => {
  for (const from of ['active', 'closing', 'after-hours'] as const) {
    assert.equal(openDay(from, 7).day, 8, from);
  }
});

void test('an opening room keeps a trace of yesterday rather than starting blank', () => {
  // Nearly blank, not blank: the piece is about a room that remembers, and a
  // surface wiped every morning is a room with no past at all.
  assert.ok(OPENING_FIELD_SCALE > 0 && OPENING_FIELD_SCALE < 0.25);
  assert.match(openDay('after-hours', 1).event, /day 2/);
});

void test('closing surfaces one of today, and a day with nothing in it stays quiet', () => {
  const today = [ghost({ id: 'today', day: 5 })];
  const surfacing = closeDay(today, 5, 1_000);
  assert.equal(surfacing?.ghost.id, 'today');
  assert.equal(surfacing?.startedAt, 1_000);
  // An ordinary recall, not a kind of its own: the closing ritual is the room
  // remembering, presented at its usual pace.
  assert.equal(surfacing?.kind, 'ghost');
  assert.equal(closeDay([ghost({ id: 'yesterday', day: 4 })], 5, 1_000), null);
  assert.equal(closeDay([], 5, 1_000), null);
});

void test('a closing recall counts as a recall of that memory', () => {
  // It passes through `recallGhost`, so the memory it surfaces is one the room
  // will then be less likely to pick again, the same as any other recall.
  const held = [ghost({ id: 'today', day: 5, recallCount: 0 })];
  const surfacing = closeDay(held, 5, 0);
  assert.ok(surfacing!.ghost.recallCount > 0);
});

void test('today fades hardest when the night compresses it', () => {
  // A room that kept every day equally would never forget anything, and so
  // would remember nothing in particular.
  const compressed = compressDay(
    [ghost({ id: 'today', day: 2, strength: 0.8 }), ghost({ id: 'older', day: 1, strength: 0.8 })],
    2,
  );
  const today = compressed.find((item) => item.id === 'today')!;
  const older = compressed.find((item) => item.id === 'older')!;
  assert.ok(today.strength < older.strength);
  // Fidelity drops with strength: that is what makes an old path drift when it
  // is finally recalled.
  assert.ok(today.fidelity < 1 && older.fidelity < 1);
});

void test('a memory exactly at the overnight floor survives it', () => {
  assert.equal(survivesTheNight(OVERNIGHT_FLOOR), true);
  assert.equal(survivesTheNight(OVERNIGHT_FLOOR - Number.EPSILON), false);
});

void test('a night drops what is too faint to survive it', () => {
  const compressed = compressDay([ghost({ id: 'faint', day: 1, strength: OVERNIGHT_FLOOR })], 2);
  assert.equal(compressed.length, 0);
});

void test('compression is repeatable and monotonic across many nights', () => {
  // Twelve nights of an untouched room. Nothing may grow back, and the count
  // must not be able to rise.
  let held = [ghost({ id: 'a', day: 1, strength: 1 }), ghost({ id: 'b', day: 1, strength: 0.5 })];
  let previous = held.reduce((sum, item) => sum + item.strength, 0);
  for (let night = 0; night < 12; night += 1) {
    held = compressDay(held, 99);
    const total = held.reduce((sum, item) => sum + item.strength, 0);
    assert.ok(total <= previous, `night ${night} gained strength`);
    previous = total;
  }
});

void test('only an active room falls to after-hours', () => {
  // An opening room has not started; a closing one is mid-ritual and gets its
  // full ninety seconds whether or not anybody is there to watch it.
  assert.equal(fallsToAfterHours('active', 0, EMPTY_ROOM_SECONDS + 1), true);
  assert.equal(fallsToAfterHours('opening', 0, 10_000), false);
  assert.equal(fallsToAfterHours('closing', 0, 10_000), false);
  assert.equal(fallsToAfterHours('after-hours', 0, 10_000), false);
});

void test('one person in the room keeps it awake however long it has been quiet', () => {
  assert.equal(fallsToAfterHours('active', 1, 10_000), false);
  assert.equal(fallsToAfterHours('active', 0, EMPTY_ROOM_SECONDS), false, 'the boundary is exclusive');
});

void test('the rituals are long enough to be seen and short enough to end', () => {
  assert.ok(OPENING_DURATION_MS >= 10_000 && OPENING_DURATION_MS <= 60_000);
  assert.ok(CLOSING_DURATION_MS > OPENING_DURATION_MS, 'the day surfacing is the longer gesture');
});
