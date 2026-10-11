/**
 * Forgetting, on a clock of its own.
 *
 * Every fifteen seconds the room lets go of a little of everything it holds and
 * writes down what is left. It is the slowest loop in the piece and the one
 * whose defects take a gallery day to appear: a half-life applied at the wrong
 * cadence looks perfectly normal for an hour and empties the room by evening.
 *
 * All of it is arithmetic over plain values, which is the only reason twelve
 * virtual hours of it can run in a second in `burn-in.ts`.
 */
import { decayMemory, decayStrength, trimExpired } from './memory-engine.ts';
import { CLOSING_DURATION_MS, EMPTY_ROOM_SECONDS, compressDay } from './room-lifecycle.ts';
import type { PersistedRoom } from './persistence.ts';
import type {
  AnonymousSensorEvent,
  Ghost,
  RoomConfig,
  RoomLifecycle,
  WhisperMemory,
} from './room-types.ts';

/** How often the room forgets a little and saves what is left. */
export const UPKEEP_INTERVAL_MS = 15_000;

/**
 * Half-lives, in hours. A false memory fades fastest because the room made it
 * up; a whisper outlives it and an observed path outlives them both.
 */
export const GHOST_HALF_LIFE_HOURS = 96;
export const FALSE_MEMORY_HALF_LIFE_HOURS = 18;
export const WHISPER_HALF_LIFE_HOURS = 36;

/** Below this a memory cannot be seen or heard, so it is dropped rather than kept. */
export const FAINTEST_MEMORY = 0.018;

/**
 * Whether a memory is still worth holding.
 *
 * A predicate rather than an inline comparison because the boundary is the
 * whole content of the rule, and a decay curve cannot be made to land on it
 * exactly — so the only way to test "exactly this faint is still kept" is to
 * ask the question directly.
 */
export function stillHeld(strength: number): boolean {
  return strength >= FAINTEST_MEMORY;
}

/**
 * How many memories of each kind the room holds at once.
 *
 * Forgetting is by age; these are the ceilings that hold regardless of it. A
 * gallery day that never empties the room still cannot make either collection
 * grow without limit, which is the bound every accumulating structure in this
 * installation is required to have.
 *
 * Whispers are the smaller number because each one carries session audio in
 * memory, and the audio bound is the one that decides whether a machine
 * running for weeks stays inside its heap.
 */
export const GHOSTS_MAX = 120;
export const WHISPERS_MAX = 80;

/**
 * Hold a new memory, dropping the oldest once the collection is full.
 *
 * Trims until it fits, rather than dropping one per call. The difference only
 * shows after a restore — memories are read back from storage trimmed by *age*
 * and not by count, so a room saved by a build with a larger ceiling comes back
 * over this one and, dropping one per capture, would sit over its bound for
 * hours of gallery time. That is the unbounded case this constant exists to
 * rule out, so the trim is a loop.
 *
 * Mutates and returns the same array: the callers hold it in a ref and a copy
 * per captured path is a copy per visitor who leaves.
 */
export function remember<T>(held: T[], memory: T, capacity: number): T[] {
  held.push(memory);
  // A capacity of zero is a caller defect rather than a room that remembers
  // nothing, and `splice` on a negative count would silently do neither.
  const excess = held.length - Math.max(1, capacity);
  if (excess > 0) held.splice(0, excess);
  return held;
}

/** Seconds of forgetting applied when the night compresses the day. */
export const OVERNIGHT_SECONDS = 3_600;

export type UpkeepState = {
  field: Float32Array;
  ghosts: Ghost[];
  whispers: WhisperMemory[];
  lifecycle: RoomLifecycle;
  day: number;
  closingStartedAt: number;
  emptySeconds: number;
  installationStartedAt: number;
  debugEvents: readonly AnonymousSensorEvent[];
};

/**
 * One decay this turn applied to the field, in the order it applied them.
 *
 * The field is a typed array the renderer holds, so it is still decayed in
 * place — but *what* was decayed comes back as a value, because a second engine
 * has to be able to apply the same thing. `FieldRuntime` replays these into
 * Rust and compares the result. Recovering them by re-deriving `forgettingRate`
 * and the overnight rule at the call site would put half of this function
 * somewhere else, where the two copies could drift.
 */
export type FieldDecay = {
  seconds: number;
  halfLifeMinutes: number;
  emptyMultiplier: number;
};

export type UpkeepResult = {
  ghosts: Ghost[];
  whispers: WhisperMemory[];
  lifecycle: RoomLifecycle;
  snapshot: PersistedRoom;
  storageBytes: number;
  /** What was done to the field, in order. Usually one; two across the night. */
  decays: FieldDecay[];
  /** Set only when the night passed, so the status line is not rewritten every tick. */
  event?: string;
};

/**
 * An empty room forgets faster, and the longer it stays empty the faster it
 * goes. This is the piece's one deliberately unbounded rate: a room nobody
 * enters for a week should be close to blank, not merely dim.
 */
export function forgettingRate(emptySeconds: number, forgettingMinutes: number): number {
  if (emptySeconds <= EMPTY_ROOM_SECONDS) return 1;
  return 1 + emptySeconds / (forgettingMinutes * 60);
}

/** Fade, drop what is too faint, and never keep anything past its persistence window. */
function fade<T extends { createdAt: number; strength: number }>(
  held: T[],
  now: number,
  persistenceDays: number,
  seconds: number,
  halfLife: (item: T) => number,
): T[] {
  return trimExpired(held, now, persistenceDays)
    .map((item) => ({ ...item, strength: decayStrength(item.strength, seconds, halfLife(item)) }))
    .filter((item) => stillHeld(item.strength));
}

/**
 * The size the saved room would take on disk.
 *
 * Measured rather than estimated, because the bound the burn-in asserts — under
 * 2 MiB of serialized state after twelve hours — is a bound on the bytes, and a
 * count of ghosts is not a count of bytes once paths are in them.
 */
export function snapshotBytes(snapshot: PersistedRoom): number {
  return new Blob([JSON.stringify(snapshot)]).size;
}

/**
 * One turn of the slow loop. The field is decayed in place — it is a typed
 * array the renderer is holding a reference to — and everything else is
 * returned rather than mutated.
 */
export function upkeep(
  state: UpkeepState,
  config: RoomConfig,
  now: number,
  seconds = UPKEEP_INTERVAL_MS / 1000,
): UpkeepResult {
  const decays: FieldDecay[] = [];
  /** Decay the field and record exactly what was done to it. */
  const decay = (forSeconds: number, emptyMultiplier: number) => {
    decayMemory(state.field, forSeconds, config.memoryMinutes, emptyMultiplier);
    decays.push({ seconds: forSeconds, halfLifeMinutes: config.memoryMinutes, emptyMultiplier });
  };
  decay(seconds, forgettingRate(state.emptySeconds, config.forgettingMinutes));
  let ghosts = fade(state.ghosts, now, config.persistenceDays, seconds, (ghost) =>
    ghost.falseMemory ? FALSE_MEMORY_HALF_LIFE_HOURS : GHOST_HALF_LIFE_HOURS);
  const whispers = fade(
    state.whispers,
    now,
    config.persistenceDays,
    seconds,
    () => WHISPER_HALF_LIFE_HOURS,
  );
  let lifecycle = state.lifecycle;
  let event: string | undefined;
  if (lifecycle === 'closing' && now - state.closingStartedAt > CLOSING_DURATION_MS) {
    lifecycle = 'after-hours';
    ghosts = compressDay(ghosts, state.day);
    // `decayMemory`'s own default for the multiplier; named here so the
    // record is the whole call rather than a call plus a remembered default.
    decay(OVERNIGHT_SECONDS, 1);
    event = 'the day compressed into long-term memory';
  }
  const snapshot: PersistedRoom = {
    field: Array.from(state.field),
    ghosts,
    // Privacy mode is enforced where the room is written, not where a voice is
    // recorded: a whisper still returns during the session, and nothing about
    // it survives the machine being turned off.
    whispers: config.privacyMode ? [] : whispers,
    installationStartedAt: state.installationStartedAt,
    savedAt: now,
    day: state.day,
    lifecycle,
    debugEvents: [...state.debugEvents],
  };
  return { ghosts, whispers, lifecycle, snapshot, storageBytes: snapshotBytes(snapshot), decays, event };
}
