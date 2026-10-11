import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { RoomRng, freshSeed, sessionSeed } from './room-rng.ts';

/**
 * The shared evidence that this and `room_engine::rng` are one generator.
 *
 * Generated from the Rust by `cargo run -p room-engine --example rng-vectors`.
 * Both suites read it, so neither implementation can drift without a test going
 * red — which is the whole reason a 32-bit generator was chosen over a better
 * one that JavaScript cannot express exactly.
 */
type Stream = {
  seed: number;
  words: number[];
  units: number[];
  ranges: number[];
  chances: boolean[];
  indices: (number | null)[];
  neverFiresAtZero: boolean;
  alwaysFiresAtOne: boolean;
  emptyPicks: (number | null)[];
  drawsAfterSamples: number;
  restoreAt: number;
  restoreMatchesAdvance: boolean;
  afterRestore: number[];
};

const vectors = JSON.parse(readFileSync(
  fileURLToPath(new URL('../tests/vectors/rng.json', import.meta.url)),
  'utf8',
)) as { samples: number; streams: Stream[] };

void test('the vectors cover the seeds that could hide a port error', () => {
  const seeds = vectors.streams.map((stream) => stream.seed);
  // Zero and one, because a generator seeded by assignment rather than by
  // mixing breaks on the first and looks identical on the second. The word
  // boundary, because a JavaScript port can agree for small seeds and diverge
  // for large ones exactly there. And the largest seed a number carries.
  assert.deepEqual(seeds, [0, 1, 12_345, 0xffff_ffff, 0x1_0000_0000, Number.MAX_SAFE_INTEGER]);
  assert.ok(vectors.samples >= 32, 'too few samples to catch a late state error');
});

void test('this generator produces the stream the Rust produces', () => {
  for (const stream of vectors.streams) {
    const words = new RoomRng(stream.seed);
    assert.deepEqual(
      Array.from({ length: vectors.samples }, () => words.nextUint32()),
      stream.words,
      `raw words diverged for seed ${stream.seed}`,
    );

    // Each derived form from its own generator, so a vector records what a
    // caller actually gets rather than what the previous line left behind.
    const units = new RoomRng(stream.seed);
    assert.deepEqual(
      Array.from({ length: vectors.samples }, () => units.next()),
      stream.units,
      `unit interval diverged for seed ${stream.seed}`,
    );

    const ranges = new RoomRng(stream.seed);
    assert.deepEqual(
      Array.from({ length: vectors.samples }, () => ranges.range(-2.5, 7.25)),
      stream.ranges,
      `range diverged for seed ${stream.seed}`,
    );

    const chances = new RoomRng(stream.seed);
    assert.deepEqual(
      Array.from({ length: vectors.samples }, () => chances.chance(0.08)),
      stream.chances,
      `chance diverged for seed ${stream.seed}`,
    );

    const indices = new RoomRng(stream.seed);
    assert.deepEqual(
      Array.from({ length: vectors.samples }, () => indices.index(7)),
      stream.indices,
      `index diverged for seed ${stream.seed}`,
    );
  }
});

/**
 * The property that keeps the stream independent of the operator console.
 *
 * `chance` and `index` draw even when they cannot fire. Without that, turning
 * recall off would silently change every unrelated random decision the room
 * makes afterwards — and the operator would have no way to know that the
 * session they are now debugging is not the session they saw.
 */
void test('a decision that cannot fire still costs a draw', () => {
  for (const stream of vectors.streams) {
    const never = new RoomRng(stream.seed);
    const fired = Array.from({ length: vectors.samples }, () => never.chance(0));
    assert.equal(fired.includes(true), !stream.neverFiresAtZero);
    assert.equal(never.draws, vectors.samples, 'a refused roll is still a draw');

    const always = new RoomRng(stream.seed);
    const certain = Array.from({ length: vectors.samples }, () => always.chance(1));
    assert.equal(certain.every(Boolean), stream.alwaysFiresAtOne);
    assert.equal(always.draws, vectors.samples);

    const empty = new RoomRng(stream.seed);
    assert.deepEqual(
      Array.from({ length: vectors.samples }, () => empty.index(0)),
      stream.emptyPicks,
    );
    assert.equal(empty.draws, vectors.samples, 'picking from nothing is still a draw');
  }
});

void test('a restored generator resumes exactly where it was', () => {
  for (const stream of vectors.streams) {
    assert.ok(stream.restoreMatchesAdvance, 'the Rust disagrees with itself');
    const restored = RoomRng.restore(stream.seed, stream.restoreAt);
    assert.equal(restored.draws, stream.restoreAt);
    assert.equal(restored.seed, stream.seed);
    assert.deepEqual(
      Array.from({ length: stream.afterRestore.length }, () => restored.nextUint32()),
      stream.afterRestore,
      `restore diverged for seed ${stream.seed}`,
    );
  }
});

void test('a fork starts where its parent is and does not disturb it', () => {
  const room = new RoomRng(99);
  for (let draw = 0; draw < 50; draw += 1) room.nextUint32();
  const forked = room.fork();
  const expected = Array.from({ length: 8 }, () => forked.nextUint32());
  // The parent has not moved, so it produces the same values the fork did.
  assert.deepEqual(Array.from({ length: 8 }, () => room.nextUint32()), expected);
  assert.equal(room.draws, 58);
  assert.equal(forked.draws, 58);
});

void test('the bound function is this room\'s stream, not a copy of it', () => {
  const room = new RoomRng(7);
  const draw = room.draw;
  const direct = new RoomRng(7);
  assert.equal(draw(), direct.next());
  assert.equal(draw(), direct.next());
  assert.equal(room.draws, 2, 'the bound function advances the room');
});

void test('every draw lands in its stated interval', () => {
  const room = new RoomRng(2_024);
  for (let draw = 0; draw < 20_000; draw += 1) {
    const unit = room.next();
    assert.ok(unit >= 0 && unit < 1, `${unit} is not in [0, 1)`);
    const ranged = room.range(-3, 5);
    assert.ok(ranged >= -3 && ranged < 5, `${ranged} is not in [-3, 5)`);
    const index = room.index(4);
    assert.ok(index !== null && index >= 0 && index < 4, `${index} is not an index of four`);
  }
});

/**
 * Restoring replays the stream rather than storing the four state words, which
 * makes a saved room independent of the generator's internals. That trade is
 * only sound if the replay is fast enough to do at startup, so it is measured
 * rather than asserted. A fortnight of gallery days is a few million draws.
 */
void test('restoring a fortnight of draws is fast enough to do at startup', () => {
  const draws = 5_000_000;
  const start = performance.now();
  const restored = RoomRng.restore(1, draws);
  const elapsed = performance.now() - start;
  assert.equal(restored.draws, draws);
  assert.ok(elapsed < 2_000, `replaying ${draws} draws took ${elapsed.toFixed(0)} ms`);
});

void test('a fresh seed is one a person can write down and type back in', () => {
  const seeds = new Set<number>();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const seed = freshSeed();
    assert.ok(Number.isSafeInteger(seed) && seed >= 0, `${seed} does not survive a round trip`);
    assert.equal(JSON.parse(JSON.stringify(seed)), seed);
    seeds.add(seed);
  }
  assert.ok(seeds.size > 90, 'a gallery day must not open on yesterday\'s stream');
});

void test('a pinned seed is the one the session runs on', () => {
  for (const [query, expected] of [
    ['?seed=0', 0],
    ['?seed=12345', 12_345],
    ['?behavior=wasm&seed=987654321', 987_654_321],
    [`?seed=${Number.MAX_SAFE_INTEGER}`, Number.MAX_SAFE_INTEGER],
  ] as [string, number][]) {
    assert.equal(sessionSeed(query), expected);
  }
});

/**
 * A seed that does not round trip is a reproduction that quietly is not one, so
 * anything unreadable takes a fresh seed rather than being mangled into a
 * number that looks deliberate.
 */
void test('a seed that cannot be reproduced is refused rather than mangled', () => {
  for (const query of [
    '',
    '?seed=',
    '?seed=abc',
    '?seed=-1',
    '?seed=1.5',
    '?seed=1e6',
    '?seed= 12',
    `?seed=${Number.MAX_SAFE_INTEGER + 2}`,
  ]) {
    const seed = sessionSeed(query);
    assert.ok(Number.isSafeInteger(seed) && seed >= 0, `${query} produced ${seed}`);
    assert.notEqual(seed, Number.NaN);
  }
  // Two unreadable queries must not land on the same stream, or an operator
  // would think they had reproduced a session by typing nothing.
  const seeds = new Set(Array.from({ length: 50 }, () => sessionSeed('?seed=nonsense')));
  assert.ok(seeds.size > 45);
});
