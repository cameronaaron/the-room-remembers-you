import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryField, depositMemory, memoryDensity } from './memory-engine.ts';
import { CLOSING_DURATION_MS, EMPTY_ROOM_SECONDS } from './room-lifecycle.ts';
import {
  FAINTEST_MEMORY,
  GHOSTS_MAX,
  WHISPERS_MAX,
  remember,
  stillHeld,
  UPKEEP_INTERVAL_MS,
  forgettingRate,
  snapshotBytes,
  upkeep,
  type UpkeepState,
} from './room-upkeep.ts';
import { DEFAULT_CONFIG, type WhisperMemory } from './room-types.ts';
import { ghost } from './test-doubles/room.ts';

const NOW = 1_700_000_000_000;

/** A trace this room actually made, rather than one from the doubles' own epoch. */
const trace = (overrides: Parameters<typeof ghost>[0] = {}) =>
  ghost({ createdAt: NOW - 60_000, ...overrides });

const whisper = (overrides: Partial<WhisperMemory> = {}): WhisperMemory => ({
  id: 'whisper',
  createdAt: NOW - 60_000,
  lastReplayedAt: 0,
  duration: 1.2,
  envelope: [0.2, 0.4, 0.2],
  brightness: 0.5,
  position: { x: 0.5, y: 0.5 },
  strength: 0.6,
  fidelity: 1,
  recallCount: 0,
  lineage: ['whisper'],
  day: 1,
  ...overrides,
});

const room = (overrides: Partial<UpkeepState> = {}): UpkeepState => {
  const field = createMemoryField();
  depositMemory(field, { x: 0.5, y: 0.5 }, 0.5, 6);
  return {
    field,
    ghosts: [trace()],
    whispers: [whisper()],
    lifecycle: 'active',
    day: 1,
    closingStartedAt: 0,
    emptySeconds: 0,
    installationStartedAt: NOW - 3_600_000,
    debugEvents: [],
    ...overrides,
  };
};

void test('an occupied room forgets at its ordinary rate', () => {
  assert.equal(forgettingRate(0, 40), 1);
  assert.equal(forgettingRate(EMPTY_ROOM_SECONDS, 40), 1, 'the boundary is not yet empty');
});

void test('the longer a room stays empty the faster it lets go', () => {
  // The piece's one deliberately unbounded rate: a room nobody enters for a
  // week should be close to blank, not merely dim.
  const anHour = forgettingRate(3_600, 40);
  const aDay = forgettingRate(86_400, 40);
  assert.ok(anHour > 1);
  assert.ok(aDay > anHour);
});

void test('a shorter forgetting setting forgets faster', () => {
  assert.ok(forgettingRate(3_600, 10) > forgettingRate(3_600, 80));
});

void test('a turn of the loop leaves less than it found', () => {
  const state = room();
  const before = memoryDensity(state.field);
  const result = upkeep(state, DEFAULT_CONFIG, NOW);
  assert.ok(memoryDensity(state.field) < before, 'the field is decayed in place');
  assert.ok(result.ghosts[0].strength < state.ghosts[0].strength);
  assert.ok(result.whispers[0].strength < state.whispers[0].strength);
});

void test('a false memory fades faster than one the room actually observed', () => {
  // The room made it up. It should not outlast the paths it was made from.
  const state = room({
    ghosts: [trace({ id: 'real', strength: 0.6 }), trace({ id: 'false', strength: 0.6, falseMemory: true })],
  });
  // An hour of upkeep, so the difference in half-lives is visible.
  let result = upkeep(state, DEFAULT_CONFIG, NOW);
  for (let turn = 0; turn < 240; turn += 1) {
    result = upkeep({ ...state, ghosts: result.ghosts, whispers: result.whispers }, DEFAULT_CONFIG, NOW);
  }
  const real = result.ghosts.find((item) => item.id === 'real')!;
  const fabricated = result.ghosts.find((item) => item.id === 'false')!;
  assert.ok(fabricated.strength < real.strength);
});

void test('what cannot be seen or heard is dropped rather than carried forever', () => {
  const state = room({
    ghosts: [trace({ strength: FAINTEST_MEMORY })],
    whispers: [whisper({ strength: FAINTEST_MEMORY })],
  });
  const result = upkeep(state, DEFAULT_CONFIG, NOW);
  assert.equal(result.ghosts.length, 0);
  assert.equal(result.whispers.length, 0);
});

void test('nothing outlives the persistence window an operator set', () => {
  const old = NOW - 9 * 86_400_000;
  const state = room({ ghosts: [ghost({ createdAt: old })], whispers: [whisper({ createdAt: old })] });
  const result = upkeep(state, { ...DEFAULT_CONFIG, persistenceDays: 7 }, NOW);
  assert.equal(result.ghosts.length, 0);
  assert.equal(result.whispers.length, 0);
});

void test('the night arrives once, at the end of the closing ritual', () => {
  const state = room({ lifecycle: 'closing', closingStartedAt: NOW - CLOSING_DURATION_MS - 1 });
  const passed = upkeep(state, DEFAULT_CONFIG, NOW);
  assert.equal(passed.lifecycle, 'after-hours');
  assert.match(passed.event!, /long-term memory/);
  // And the next turn is an ordinary one, not another compression.
  const after = upkeep({ ...state, lifecycle: passed.lifecycle }, DEFAULT_CONFIG, NOW);
  assert.equal(after.event, undefined);
});

void test('a ritual still running is left alone', () => {
  const state = room({ lifecycle: 'closing', closingStartedAt: NOW - CLOSING_DURATION_MS + 1_000 });
  const result = upkeep(state, DEFAULT_CONFIG, NOW);
  assert.equal(result.lifecycle, 'closing');
  assert.equal(result.event, undefined);
});

void test('the night costs the field more than an ordinary turn does', () => {
  const ordinary = room();
  const ordinaryBefore = memoryDensity(ordinary.field);
  upkeep(ordinary, DEFAULT_CONFIG, NOW);
  const overnight = room({ lifecycle: 'closing', closingStartedAt: NOW - CLOSING_DURATION_MS - 1 });
  const overnightBefore = memoryDensity(overnight.field);
  upkeep(overnight, DEFAULT_CONFIG, NOW);
  const ordinaryLoss = ordinaryBefore - memoryDensity(ordinary.field);
  const overnightLoss = overnightBefore - memoryDensity(overnight.field);
  assert.ok(overnightLoss > ordinaryLoss);
});

void test('privacy mode keeps voices in the session and out of the saved room', () => {
  // A whisper still returns while the room is open; nothing about it survives
  // the machine being turned off.
  const state = room();
  const result = upkeep(state, { ...DEFAULT_CONFIG, privacyMode: true }, NOW);
  assert.equal(result.whispers.length, 1, 'the session keeps holding it');
  assert.deepEqual(result.snapshot.whispers, [], 'the disk does not');
  const kept = upkeep(room(), { ...DEFAULT_CONFIG, privacyMode: false }, NOW);
  assert.equal(kept.snapshot.whispers.length, 1);
});

void test('the snapshot is what the room will be restored from', () => {
  const state = room({ debugEvents: [{ t: 0, people: [] }] });
  const result = upkeep(state, DEFAULT_CONFIG, NOW);
  assert.equal(result.snapshot.savedAt, NOW);
  assert.equal(result.snapshot.day, state.day);
  assert.equal(result.snapshot.installationStartedAt, state.installationStartedAt);
  assert.equal(result.snapshot.field.length, state.field.length);
  assert.equal(result.snapshot.debugEvents!.length, 1);
  // Faded, not pre-fade: saving what was just let go of would undo the loop.
  assert.equal(result.snapshot.ghosts, result.ghosts);
});

void test('the saved size is measured in bytes, not estimated from counts', () => {
  // The burn-in asserts a bound of 2 MiB on serialized state, and a count of
  // ghosts is not a count of bytes once paths are inside them.
  const small = snapshotBytes(upkeep(room(), DEFAULT_CONFIG, NOW).snapshot);
  const many = snapshotBytes(upkeep(
    room({ ghosts: Array.from({ length: 50 }, (_unused, index) => trace({ id: `g${index}` })) }),
    DEFAULT_CONFIG,
    NOW,
  ).snapshot);
  assert.ok(many > small);
  assert.equal(small, upkeep(room(), DEFAULT_CONFIG, NOW).storageBytes);
});

void test('a memory exactly at the floor is still a memory', () => {
  // The boundary is the whole content of the rule, and a decay curve cannot be
  // made to land on it, so it is asked directly.
  assert.equal(stillHeld(FAINTEST_MEMORY), true);
  assert.equal(stillHeld(FAINTEST_MEMORY - Number.EPSILON), false);
  assert.equal(stillHeld(0), false);
});

void test('emptiness divides into the forgetting setting rather than multiplying it', () => {
  // An hour empty against a forty-minute setting is one extra unit of
  // forgetting: 3600 / 2400. Multiplied instead, the same room would forget
  // several million times faster and be blank by the time anyone returned.
  assert.ok(Math.abs(forgettingRate(2_400, 40) - 2) < 1e-12);
  assert.ok(Math.abs(forgettingRate(4_800, 40) - 3) < 1e-12);
});

void test('the closing ritual runs its full length before the night arrives', () => {
  // Exactly at the boundary is still the ritual. An operator who closes the
  // gallery gets the ninety seconds the piece promises, not eighty-nine.
  const state = room({ lifecycle: 'closing', closingStartedAt: NOW - CLOSING_DURATION_MS });
  assert.equal(upkeep(state, DEFAULT_CONFIG, NOW).lifecycle, 'closing');
});

void test('the loop runs often enough to be smooth and rarely enough to be cheap', () => {
  assert.ok(UPKEEP_INTERVAL_MS >= 5_000 && UPKEEP_INTERVAL_MS <= 60_000);
});

/**
 * The ceilings that hold whatever the day does, and the reason the trim is a
 * loop. These lived as two inline comparisons inside the render component,
 * where no test could reach them — which is how the restore case below stayed
 * wrong.
 */
void test('a bounded collection stays bounded, and a room over its bound comes back inside it', () => {
  const held: number[] = [];
  for (let memory = 0; memory < GHOSTS_MAX * 3; memory += 1) remember(held, memory, GHOSTS_MAX);
  assert.equal(held.length, GHOSTS_MAX);
  assert.equal(held.at(-1), GHOSTS_MAX * 3 - 1, 'the newest memory is kept');
  assert.equal(held[0], GHOSTS_MAX * 2, 'the oldest are the ones dropped');

  // Read back from storage trimmed by age, not by count: over the ceiling on
  // the very first capture, and inside it on the very same one.
  const restored = Array.from({ length: 300 }, (_, memory) => memory);
  remember(restored, 300, GHOSTS_MAX);
  assert.equal(restored.length, GHOSTS_MAX);
  assert.equal(restored.at(-1), 300);

  // Whispers are the smaller ceiling, because each one holds session audio.
  assert.ok(WHISPERS_MAX < GHOSTS_MAX);
  const whispers: number[] = [];
  for (let whisper = 0; whisper < 500; whisper += 1) remember(whispers, whisper, WHISPERS_MAX);
  assert.equal(whispers.length, WHISPERS_MAX);

  // A capacity of zero is a caller defect, not a room that remembers nothing.
  assert.deepEqual(remember([], 1, 0), [1]);
});
