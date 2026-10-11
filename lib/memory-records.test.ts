import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseRareGhost,
  isRememberable,
  normalizeGhost,
  normalizeWhisper,
  recallGhost,
  round,
} from './memory-records.ts';
import type { Ghost, WhisperMemory } from './room-types.ts';

const NOW = 10_000_000;
const MINUTE = 60_000;

const ghost = (overrides: Partial<Ghost> = {}): Ghost => ({
  id: 'ghost', createdAt: NOW - MINUTE, lastReplayedAt: 0,
  path: [{ x: 0.1, y: 0.2, t: 0 }, { x: 0.5, y: 0.5, t: 1 }, { x: 0.9, y: 0.3, t: 2 }],
  dwellSeconds: 4, intensity: 0.4, strength: 0.3, fidelity: 1, recallCount: 0,
  lineage: ['ghost'], falseMemory: false, day: 1, ...overrides,
});

const whisper = (overrides: Partial<WhisperMemory> = {}): WhisperMemory => ({
  id: 'voice', createdAt: NOW, lastReplayedAt: 0, duration: 900, envelope: [0.2, 0.6, 0.3],
  brightness: 0.4, position: { x: 0.4, y: 0.5 }, strength: 0.4, fidelity: 1, recallCount: 0,
  lineage: ['voice'], day: 1, ...overrides,
});

/** A record saved before a field existed, as it actually comes back off disk. */
const without = <T extends object>(record: T, ...fields: Array<keyof T>): T => {
  const copy = { ...record };
  for (const field of fields) delete copy[field];
  return copy;
};

void test('a ghost that already has every field is returned unchanged', () => {
  const complete = ghost();
  assert.deepEqual(normalizeGhost(complete), complete);
});

void test('a ghost saved by an older build is given every missing default', () => {
  // Not cosmetic: an undefined strength propagates as NaN through decay and
  // reinforcement, and a NaN ghost renders as nothing. The room reopens having
  // silently forgotten everything it was holding.
  const old = without(ghost(), 'strength', 'fidelity', 'recallCount', 'lineage', 'falseMemory', 'day');
  const restored = normalizeGhost(old);
  assert.equal(restored.fidelity, 1);
  assert.equal(restored.recallCount, 0);
  assert.equal(restored.falseMemory, false);
  assert.equal(restored.day, 1);
  assert.deepEqual(restored.lineage, ['ghost'], 'a ghost with no lineage is its own ancestor');
  for (const value of Object.values(restored)) assert.ok(!Number.isNaN(value as number));
});

void test('a restored ghost falls back to its intensity before a constant', () => {
  // Strength replaced intensity. A room saved in between has the old field and
  // not the new one, and its own intensity is a better answer than 0.35.
  assert.equal(normalizeGhost(without(ghost({ intensity: 0.9 }), 'strength')).strength, 0.9);
  assert.equal(normalizeGhost(without(ghost(), 'strength', 'intensity')).strength, 0.35);
});

void test('a legitimate zero is not mistaken for a missing field', () => {
  // `??` and `||` differ exactly here, and every one of these is a real value:
  // a fully faded ghost, one never recalled, day zero.
  const faded = normalizeGhost(ghost({ strength: 0, fidelity: 0, recallCount: 0, day: 0 }));
  assert.equal(faded.strength, 0);
  assert.equal(faded.fidelity, 0);
  assert.equal(faded.day, 0);
  assert.equal(normalizeWhisper(whisper({ strength: 0, fidelity: 0, day: 0 })).strength, 0);
});

void test('a whisper saved by an older build is given every missing default', () => {
  const old = without(whisper(), 'strength', 'fidelity', 'recallCount', 'lineage', 'day');
  const restored = normalizeWhisper(old);
  assert.equal(restored.strength, 0.35);
  assert.equal(restored.fidelity, 1);
  assert.equal(restored.recallCount, 0);
  assert.equal(restored.day, 1);
  assert.deepEqual(restored.lineage, ['voice']);
});

void test('normalising copies rather than mutating what it was handed', () => {
  const original = without(ghost(), 'strength');
  normalizeGhost(original);
  assert.equal('strength' in original, false, 'the stored record was written to');
});

void test('a recalled ghost replaces the one in the collection', () => {
  // The memory invariant: nothing recalled remains unchanged. Returning the
  // mutated ghost while leaving the original in the array gives the room a
  // memory that degrades on screen and resets every time it is remembered.
  const collection = [ghost({ id: 'a' }), ghost({ id: 'b' })];
  const remembered = recallGhost(collection[1], collection, () => 0.5);
  assert.equal(collection[1], remembered);
  assert.equal(collection[1].recallCount, 1);
  assert.ok(collection[1].fidelity < 1, 'a recalled memory must have degraded');
  assert.equal(collection[0].recallCount, 0, 'the other ghost was disturbed');
});

void test('recalling a ghost the collection does not hold changes nothing else', () => {
  const collection = [ghost({ id: 'a' })];
  const stranger = recallGhost(ghost({ id: 'elsewhere' }), collection, () => 0.5);
  assert.equal(stranger.recallCount, 1);
  assert.equal(collection.length, 1);
  assert.equal(collection[0].id, 'a');
  assert.equal(collection[0].recallCount, 0);
});

void test('a neglected ghost is likelier to return than a fresh one', () => {
  // Weighted by minutes since it was last seen: an hour of neglect outweighs a
  // ghost replayed a minute ago by roughly sixty to one. Swept deterministically
  // rather than sampled, so this measures the weighting and not today's luck.
  const ghosts = [
    ghost({ id: 'fresh', createdAt: NOW - MINUTE, lastReplayedAt: NOW - MINUTE }),
    ghost({ id: 'neglected', createdAt: NOW - 60 * MINUTE, lastReplayedAt: NOW - 60 * MINUTE }),
  ];
  const counts = new Map<string, number>();
  for (let step = 0; step < 1_000; step += 1) {
    const chosen = chooseRareGhost(ghosts, NOW, () => step / 1_000);
    counts.set(chosen.id, (counts.get(chosen.id) ?? 0) + 1);
  }
  const neglected = counts.get('neglected') ?? 0;
  assert.ok(neglected > (counts.get('fresh') ?? 0) * 10, `neglected won only ${neglected} of 1000`);
});

void test('a ghost replayed recently is judged on the replay, not on its birth', () => {
  // An old ghost the room showed a minute ago is not a rare one.
  const ghosts = [
    ghost({ id: 'old-but-just-shown', createdAt: NOW - 600 * MINUTE, lastReplayedAt: NOW - MINUTE }),
    ghost({ id: 'younger-but-unseen', createdAt: NOW - 30 * MINUTE, lastReplayedAt: 0 }),
  ];
  let unseen = 0;
  for (let step = 0; step < 1_000; step += 1) {
    if (chooseRareGhost(ghosts, NOW, () => step / 1_000).id === 'younger-but-unseen') unseen += 1;
  }
  assert.ok(unseen > 900, `the unseen ghost won only ${unseen} of 1000`);
});

void test('every ghost remains reachable, and the draw never falls off the end', () => {
  const ghosts = ['a', 'b', 'c'].map((id, index) =>
    ghost({ id, createdAt: NOW - (index + 1) * 10 * MINUTE, lastReplayedAt: 0 }));
  const reached = new Set<string>();
  for (let step = 0; step <= 1_000; step += 1) {
    const chosen = chooseRareGhost(ghosts, NOW, () => step / 1_000);
    assert.ok(chosen, `a draw of ${step / 1_000} chose nothing`);
    reached.add(chosen.id);
  }
  assert.deepEqual([...reached].sort(), ['a', 'b', 'c']);
});

void test('a single ghost is always the one chosen', () => {
  const only = [ghost({ id: 'only' })];
  for (const draw of [0, 0.5, 0.999_999, 1]) {
    assert.equal(chooseRareGhost(only, NOW, () => draw).id, 'only');
  }
});

void test('rounding keeps three decimals and is stable at the edges', () => {
  assert.equal(round(0.123_456), 0.123);
  assert.equal(round(0.123_556), 0.124);
  assert.equal(round(-0.000_4), -0);
  assert.equal(round(5), 5);
  assert.equal(round(0), 0);
});

void test('a restored record with no path is not a memory', () => {
  // Normalisation can supply a missing strength — a faded memory is still a
  // memory — but it cannot invent a path. A pathless ghost reaches
  // `createFalseMemory`, which reads its first point, and throws; every place
  // that indexes into a path would otherwise need its own defensive fallback.
  assert.equal(isRememberable(ghost({ path: [] })), false);
  assert.equal(isRememberable({ ...ghost(), path: undefined as never }), false);
  assert.equal(isRememberable(ghost()), true);
});

void test('normalisation keeps a memory the room can still draw', () => {
  const restored = normalizeGhost({ ...ghost(), strength: undefined as never });
  assert.ok(Number.isFinite(restored.strength));
  assert.ok(isRememberable(restored));
});
