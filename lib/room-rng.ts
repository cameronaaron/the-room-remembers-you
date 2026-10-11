/**
 * The room's randomness, made reproducible.
 *
 * The installation calls `Math.random()` from about a dozen places: whether to
 * surface a memory, which memory, how much a recalled path mutates, where a
 * whisper sits on the wall. That is fine for an artwork and fatal for debugging
 * one. A gallery reports that "it did something strange at about half past
 * seven" and there is no way to make it happen again.
 *
 * So randomness here is a value, not an ambient capability. One `RoomRng` per
 * session, seeded explicitly, and its draw count saved with the room, so a
 * restarted installation continues its stream instead of restarting it.
 *
 * # The algorithm, and why this one
 *
 * `sfc32` — Small Fast Counting, 32-bit, four words of state — seeded through
 * `splitmix32`. It is chosen for a property most generators do not have and
 * that this project needs above speed or statistical pedigree: **it is exactly
 * reproducible in both languages.** Every operation is a 32-bit add, xor,
 * shift or rotate, all of which JavaScript expresses precisely with `>>> 0`
 * and `Math.imul`. A 64-bit generator such as PCG64 or xoshiro256 would need
 * `BigInt` here, and a floating-point generator would not agree bit for bit at
 * all.
 *
 * That matters because the migration runs both engines against the same inputs
 * and compares. If the two cannot be given the same random stream, a parity
 * report can only ever say "these look similar", which is not a claim anything
 * can be built on. `crates/room-engine/src/rng.rs` is the same generator, and
 * `tests/vectors/rng.json` is the shared evidence that they agree — generated
 * from the Rust, read by both suites, so neither side can drift without a test
 * failing.
 *
 * It is not cryptographic and does not need to be. Nothing here protects
 * anything; it decides whether a room remembers you.
 *
 * # Why the seed is 64 bits when the generator is 32
 *
 * The seed is what an operator writes down to reproduce a session, and it is
 * the one number that has to survive being read off a screen and typed back
 * in. Sixty-four bits of it costs nothing here — the low half seeds the mixer
 * and the high half is folded into the second state word, exactly as the Rust
 * does — and it leaves room for a seed derived from a date and a session
 * counter rather than a bare `Math.random()`.
 */

/** The number `next()` divides by. `2^32`, written out so it reads as a bound. */
const TWO_TO_THE_32 = 4_294_967_296;

/**
 * Outputs discarded after seeding.
 *
 * `sfc32`'s authors specify twelve, before which the low bits of the state are
 * still visible in the output.
 */
const WARMUP_DRAWS = 12;

/** Seeding mixer: spreads a small or structured seed across all 32 bits. */
function splitMix32(state: number): { value: number; state: number } {
  const next = (state + 0x9e3779b9) >>> 0;
  let z = next;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return { value: (z ^ (z >>> 15)) >>> 0, state: next };
}

/**
 * A deterministic 32-bit generator.
 *
 * `fork` makes a stream for a subsystem without disturbing this one.
 */
export class RoomRng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;
  private count = 0;
  private readonly from: number;

  /**
   * Create a generator from a seed.
   *
   * Seed 0 is permitted and is not a special case: `splitmix32` mixes the
   * counter before it mixes the seed, so an all-zero seed still produces a
   * well-distributed state rather than the all-zero state that would make
   * `sfc32` emit a constant.
   *
   * The seed is a JavaScript number, so it carries 53 bits exactly rather than
   * 64. That is deliberate and is what the Rust side is given too: a seed that
   * could not survive a round trip through JSON is a seed an operator cannot
   * write down, and reproducing a session is the entire point of having one.
   */
  constructor(seed = 0) {
    this.from = seed;
    const low = seed >>> 0;
    // `Math.floor(seed / 2^32)` rather than `seed >>> 32`, which is a no-op:
    // JavaScript's shift operators take their right operand modulo 32.
    const high = Math.floor(seed / TWO_TO_THE_32) >>> 0;
    let mixer = low;
    let drawn = splitMix32(mixer);
    this.a = drawn.value;
    mixer = drawn.state;
    drawn = splitMix32(mixer);
    this.b = (drawn.value ^ high) >>> 0;
    mixer = drawn.state;
    drawn = splitMix32(mixer);
    this.c = drawn.value;
    mixer = drawn.state;
    drawn = splitMix32(mixer);
    this.d = drawn.value;
    for (let discard = 0; discard < WARMUP_DRAWS; discard += 1) this.nextUint32();
    this.count = 0;
  }

  /**
   * Restore a generator to an exact position in its stream.
   *
   * Replays the discarded draws rather than storing the four state words.
   * Storing the words would be faster and would also make the saved room
   * depend on the generator's internals, so a change of algorithm would resume
   * a room into a stream that no longer exists. Seed plus position is the
   * smaller, more durable claim.
   *
   * Restoring is O(`draws`), and `draws` grows by a handful per engine step.
   * A fortnight of gallery days is a few million draws; `room-rng.test.ts`
   * measures the replay rather than assuming it is fast enough.
   */
  static restore(seed: number, draws: number): RoomRng {
    const rng = new RoomRng(seed);
    for (let draw = 0; draw < draws; draw += 1) rng.nextUint32();
    return rng;
  }

  /** The seed this stream came from. */
  get seed(): number {
    return this.from;
  }

  /** How far into the stream this generator is. */
  get draws(): number {
    return this.count;
  }

  /** The next raw 32-bit value. */
  nextUint32(): number {
    const t = (this.a + this.b + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = (this.b ^ (this.b >>> 9)) >>> 0;
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (((this.c << 21) | (this.c >>> 11)) + t) >>> 0;
    this.count += 1;
    return t;
  }

  /**
   * The next value in `[0, 1)`, matching what `Math.random()` returns.
   *
   * Divided by 2^32 rather than scaled by a reciprocal, so this and the Rust
   * produce the identical double.
   */
  next(): number {
    return this.nextUint32() / TWO_TO_THE_32;
  }

  /** A value in `[low, high)`. */
  range(low: number, high: number): number {
    return low + this.next() * (high - low);
  }

  /**
   * Whether an event with probability `chance` fires.
   *
   * `chance <= 0` never fires and `chance >= 1` always does, and **both still
   * draw**. A conditional draw would make the stream depend on the settings, so
   * turning recall off in the operator console would silently change every
   * unrelated random decision the room makes afterwards.
   */
  chance(chance: number): boolean {
    const roll = this.next();
    return chance > 0 && roll < chance;
  }

  /**
   * Pick an index in `0..length`, or `null` for an empty collection.
   *
   * Draws either way, for the same reason `chance` does.
   */
  index(length: number): number | null {
    const roll = this.next();
    if (length <= 0) return null;
    // `roll` is strictly below 1, so the product is strictly below `length`
    // and the truncation cannot reach it. The `min` is belt and braces against
    // a future change to `next`'s range.
    return Math.min(Math.floor(roll * length), length - 1);
  }

  /**
   * A generator that starts where this one is, without advancing it.
   *
   * Used where a subsystem wants its own stream — a simulation, a replay, a
   * parity harness — and must not perturb the room's.
   */
  fork(): RoomRng {
    const forked = new RoomRng(this.from);
    forked.a = this.a;
    forked.b = this.b;
    forked.c = this.c;
    forked.d = this.d;
    forked.count = this.count;
    return forked;
  }

  /**
   * The generator as a plain function, for the many call sites that take one.
   *
   * Bound to this instance, so passing `rng.draw` to a collaborator gives it
   * this room's stream rather than a copy of it.
   */
  get draw(): () => number {
    return () => this.next();
  }
}

/**
 * A seed for a session that has none.
 *
 * `Math.random()` is used here and only here, at the one point where an
 * unpredictable starting value is the correct answer — a gallery day should not
 * open on the same stream as yesterday's. Everything downstream of this is
 * deterministic given the value it returns, which is the property that makes a
 * session reproducible once it is written down.
 *
 * Kept to 53 bits so it survives JSON, an operator's notebook, and being typed
 * back into a query parameter.
 */
export function freshSeed(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/**
 * The seed this session runs on.
 *
 * `?seed=<n>` pins it, which is the whole point of having one: a gallery
 * reports that something strange happened, the operator reads the seed off the
 * console, and the session can be re-run. Anything else — absent, not a number,
 * negative, fractional, or past what a `number` carries exactly — is refused in
 * favour of a fresh seed rather than silently mangled, because a seed that does
 * not round trip is a reproduction that quietly is not one.
 *
 * `search` defaults to the browser's query string, and to none at all off the
 * browser: this is read while the component renders, and the shell is rendered
 * on the server before it is rendered in a page.
 */
export function sessionSeed(search?: string): number {
  const query = search ?? (typeof window === 'undefined' ? '' : window.location.search);
  const asked = new URLSearchParams(query).get('seed');
  if (asked === null || !/^\d+$/.test(asked)) return freshSeed();
  const seed = Number(asked);
  return Number.isSafeInteger(seed) ? seed : freshSeed();
}
