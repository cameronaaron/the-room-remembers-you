import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  DEPOSIT_STRIDE,
  FIELD_PARITY_TOLERANCE,
  FieldRuntime,
  MAX_DEPOSITS,
  type WasmField,
  mountField,
  startField,
} from './field-runtime.ts';
import { createMemoryField, decayMemory, depositMemory, memoryDensity } from './memory-engine.ts';

/**
 * A stand-in engine that actually keeps a field.
 *
 * It applies deposits and decay with the same TypeScript the room uses, which
 * makes it useless for proving Rust agrees — that is what `npm run test:parity`
 * is for, against real WASM. What it proves is the part the parity harness
 * cannot see: that this adapter batches, orders, validates and retires
 * correctly, and hands the room an unbroken field when it does.
 */
class Engine implements WasmField {
  field = createMemoryField();
  steps = 0;
  batches: number[][] = [];
  freed = 0;
  /** Bend the snapshot on the way out, to stand in for a divergence. */
  bend: ((out: Float32Array) => Float32Array) | null = null;
  fail: 'step' | 'restore' | 'reset' | 'free' | null = null;

  step(deposits: Float64Array, elapsed: number, halfLife: number, empty: number): Float32Array {
    if (this.fail === 'step') throw new Error('trap');
    // The engine's own validation, mirrored: a batch it would refuse must be
    // refused here too, or this double would pass work real WASM rejects.
    if (deposits.length > MAX_DEPOSITS * DEPOSIT_STRIDE || deposits.length % DEPOSIT_STRIDE !== 0) {
      throw new Error('invalid deposit count');
    }
    if (!(elapsed >= 0 && elapsed <= 86_400) || !(halfLife >= 1 && halfLife <= 1440)
      || !(empty >= 1 && empty <= 10_000)) {
      throw new Error('invalid decay parameters');
    }
    this.steps += 1;
    this.batches.push([...deposits]);
    for (let index = 0; index < deposits.length; index += DEPOSIT_STRIDE) {
      const [x, y, amount, radius] = deposits.slice(index, index + DEPOSIT_STRIDE);
      depositMemory(this.field, { x: x ?? 0, y: y ?? 0 }, amount ?? 0, radius ?? 2);
    }
    if (elapsed > 0) decayMemory(this.field, elapsed, halfLife, empty);
    const out = new Float32Array(this.field);
    return this.bend ? this.bend(out) : out;
  }

  restore(field: Float32Array) {
    if (this.fail === 'restore') throw new Error('trap');
    this.field.set(field);
  }

  reset() {
    if (this.fail === 'reset') throw new Error('trap');
    this.field.fill(0);
  }

  free() {
    this.freed += 1;
    if (this.fail === 'free') throw new Error('trap');
  }
}

const RUNNING = 'Rust/WASM memory field (verified against TS)';
const at = (x: number, y: number) => ({ x, y });
/** Let a mount's promise chain run to completion. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

void test('a field with no engine behind it is inert and says so', () => {
  const room = new FieldRuntime();
  assert.equal(room.label, 'TypeScript memory field');
  room.deposit(at(0.5, 0.5), 0.02, 2);
  room.flush();
  room.decay(15, 120);
  assert.ok(memoryDensity(room.values) > 0, 'the room still remembers');
  assert.equal(room.label, 'TypeScript memory field', 'nothing can retire what was never running');
});

void test('the field handed out is the field kept, across every operation', () => {
  const room = new FieldRuntime(undefined, new Engine());
  const handed = room.values;
  room.deposit(at(0.4, 0.6), 0.05, 3);
  room.flush();
  room.decay(60, 120);
  room.adopt();
  room.reset();
  // The renderer uploads this array as a texture and `memoryDensity` reads it.
  // Replacing it on a reset or a fallback would leave both pointed at a field
  // the room has stopped using, which on the wall is a frozen memory.
  assert.equal(room.values, handed);
});

void test('deposits cross once per batch, not once per visitor', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  for (let index = 0; index < 5; index += 1) room.deposit(at(0.1 * index, 0.5), 0.01, 2);
  assert.equal(engine.steps, 0, 'nothing crosses until the batch is sent');
  room.flush();
  assert.equal(engine.steps, 1);
  assert.equal(engine.batches[0]?.length, 5 * DEPOSIT_STRIDE);
  assert.equal(room.label, RUNNING);
});

void test('an empty batch with nothing to decay is not worth a crossing', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  room.flush();
  room.decayed([]);
  assert.equal(engine.steps, 0);
});

/**
 * A deposit is additive and a decay is multiplicative, so `decay(a + b)` is not
 * `decay(a) + b`. The engine applies the batch and then one decay, which is the
 * order the shell used: deposits landed as they arrived, decay when the
 * fifteen-second timer fired.
 */
void test('a batch is deposited before it is decayed, and the field proves it', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  room.deposit(at(0.5, 0.5), 0.5, 3);
  // What `upkeep` does: the field moves first, then the record of what moved it
  // is handed over. Deposit then decay, which is the order the engine applies.
  decayMemory(room.values, 600, 10, 1);
  room.decayed([{ seconds: 600, halfLifeMinutes: 10, emptyMultiplier: 1 }]);
  assert.equal(room.label, RUNNING, 'the two agree, which is the claim');

  // The other order, computed directly, is a different field — so the test
  // above is distinguishing them rather than accepting either.
  const decayedFirst = createMemoryField();
  decayMemory(decayedFirst, 600, 10, 1);
  depositMemory(decayedFirst, at(0.5, 0.5), 0.5, 3);
  assert.notEqual(memoryDensity(decayedFirst).toFixed(9), memoryDensity(room.values).toFixed(9));
});

void test('a night that decays twice sends two decays, deposits riding the first', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  room.deposit(at(0.5, 0.5), 0.2, 2);
  decayMemory(room.values, 15, 120, 1);
  decayMemory(room.values, 28_800, 120, 1);
  room.decayed([
    { seconds: 15, halfLifeMinutes: 120, emptyMultiplier: 1 },
    { seconds: 28_800, halfLifeMinutes: 120, emptyMultiplier: 1 },
  ]);
  assert.equal(engine.steps, 2);
  assert.equal(engine.batches[0]?.length, DEPOSIT_STRIDE, 'the deposits went with the first');
  assert.equal(engine.batches[1]?.length, 0, 'and were not sent twice');
  assert.equal(room.label, RUNNING);
});

void test('a divergence retires WASM and leaves the room its own field', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  room.deposit(at(0.5, 0.5), 0.4, 3);
  const expected = memoryDensity(new FieldRuntime(room.values).values);
  engine.bend = (out) => { out[0] = 0.9; return out; };
  room.flush();
  assert.match(room.label, /^TypeScript memory field — WASM failed or diverged/);
  assert.equal(memoryDensity(room.values), expected, 'the field the room draws is untouched');
  assert.equal(engine.freed, 1, 'and the engine was released');
});

void test('an engine that traps is retired rather than retried forever', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  engine.fail = 'step';
  room.deposit(at(0.5, 0.5), 0.1, 2);
  room.flush();
  assert.match(room.label, /^TypeScript memory field — WASM failed/);
  const steps = engine.steps;
  room.deposit(at(0.2, 0.2), 0.1, 2);
  room.flush();
  assert.equal(engine.steps, steps, 'a retired engine is not stepped again');
});

void test('a snapshot of the wrong size is a boundary that drifted, not a field', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  engine.bend = () => new Float32Array(16);
  room.deposit(at(0.5, 0.5), 0.1, 2);
  room.flush();
  assert.match(room.label, /^TypeScript memory field — WASM failed or diverged/);
});

void test('a cell that comes back as NaN is refused', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  engine.bend = (out) => { out[100] = Number.NaN; return out; };
  room.deposit(at(0.5, 0.5), 0.1, 2);
  room.flush();
  assert.match(room.label, /^TypeScript memory field — WASM failed or diverged/);
});

/**
 * Read from the module, never copied: two literals here fold to a constant and
 * the brackets would keep passing after the tolerance moved away from them.
 */
void test('the parity tolerance is the stated one, bracketed either side', () => {
  const offsetBy = (delta: number) => {
    const engine = new Engine();
    const room = new FieldRuntime(undefined, engine);
    room.deposit(at(0.5, 0.5), 0.5, 3);
    engine.bend = (out) => { out[out.length - 1] = (out[out.length - 1] ?? 0) + delta; return out; };
    room.flush();
    return room.label;
  };
  // Against a cell of zero the difference is the delta and nothing else.
  assert.equal(offsetBy(2 ** -21), RUNNING, 'a difference under the tolerance is agreement');
  assert.match(offsetBy(2 ** -19), /^TypeScript memory field — WASM/, 'a difference over it is not');
  assert.ok(2 ** -21 < FIELD_PARITY_TOLERANCE, 'the lower bracket must be under the tolerance');
  assert.ok(2 ** -19 > FIELD_PARITY_TOLERANCE, 'the upper bracket must be over it');
});

/**
 * More deposits than the engine accepts is a defect upstream, and refusing is
 * how it gets reported as one. Trimming would send the two engines different
 * work and surface as a parity failure — the same outcome, wrong diagnosis.
 */
void test('a batch past the engine capacity is refused rather than trimmed', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  for (let index = 0; index <= MAX_DEPOSITS; index += 1) room.deposit(at(0.5, 0.5), 0.001, 2);
  assert.match(room.label, /more deposits in one batch than the engine accepts/);
  // The field still has every one of them: refusing the engine is not refusing
  // the room's memory.
  assert.ok(memoryDensity(room.values) > 0);
});

void test('an out-of-band change to the field is pushed across rather than guessed at', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  // The opening day's ramp scales every cell; a restored room replaces the lot.
  room.deposit(at(0.5, 0.5), 0.5, 3);
  room.flush();
  for (let index = 0; index < room.values.length; index += 1) room.values[index] *= 0.25;
  room.adopt();
  room.deposit(at(0.2, 0.8), 0.1, 2);
  room.flush();
  assert.equal(room.label, RUNNING, 'the engine followed the scaling instead of diverging');
});

void test('a restored room starts with the memory it was holding', () => {
  const saved = createMemoryField();
  depositMemory(saved, at(0.3, 0.3), 0.6, 4);
  const engine = new Engine();
  const room = new FieldRuntime(saved, engine);
  assert.equal(memoryDensity(room.values), memoryDensity(saved));
  assert.equal(memoryDensity(engine.field), memoryDensity(saved), 'and so does the engine');
});

void test('a reset empties both sides and keeps the array the room is holding', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  const handed = room.values;
  room.deposit(at(0.5, 0.5), 0.5, 3);
  room.flush();
  room.reset();
  assert.equal(room.values, handed);
  assert.equal(memoryDensity(room.values), 0);
  assert.equal(memoryDensity(engine.field), 0);
  assert.equal(room.label, RUNNING);
});

void test('an engine that will not reset is retired rather than left half-cleared', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  engine.fail = 'reset';
  room.reset();
  assert.match(room.label, /^TypeScript memory field — WASM reset failed/);
  assert.equal(memoryDensity(room.values), 0, 'the room was still cleared');
});

void test('a disposed runtime refuses work rather than half-doing it', () => {
  const room = new FieldRuntime(undefined, new Engine());
  room.dispose();
  assert.throws(() => room.deposit(at(0.5, 0.5), 0.1, 2), /disposed/);
  assert.throws(() => room.flush(), /disposed/);
  room.dispose();
});

void test('a retired engine is released exactly once', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  engine.fail = 'step';
  room.deposit(at(0.5, 0.5), 0.1, 2);
  room.flush();
  room.dispose();
  assert.equal(engine.freed, 1);
});

void test('a trapped destructor cannot block a fallback', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  engine.fail = 'free';
  room.dispose();
  assert.equal(engine.freed, 1);
});

void test('?field=ts opts out; the room does not go looking for WASM', async () => {
  let asked = false;
  const room = new FieldRuntime();
  mountField('?field=ts', room, (search) => startField(search, async () => {
    asked = true;
    return new Engine();
  }));
  await settle();
  assert.equal(asked, false);
  assert.equal(room.label, 'TypeScript memory field');
});

void test('WASM is the default: an unrelated parameter still goes looking for it', async () => {
  let asked = false;
  const room = new FieldRuntime();
  mountField('?tracking=ts', room, (search) => startField(search, async () => {
    asked = true;
    return new Engine();
  }));
  await settle();
  assert.equal(asked, true);
});

void test('a WASM build that loads gets the memory the room already holds', async () => {
  const engine = new Engine();
  const room = new FieldRuntime();
  // The room runs from the first frame and only later acquires an engine, so
  // an engine that started empty would disagree on its very first comparison.
  room.deposit(at(0.5, 0.5), 0.3, 3);
  mountField('?field=wasm', room, (search) => startField(search, async () => engine));
  await settle();
  assert.equal(room.label, RUNNING);
  assert.equal(memoryDensity(engine.field), memoryDensity(room.values));
  room.deposit(at(0.2, 0.2), 0.1, 2);
  room.flush();
  assert.equal(room.label, RUNNING, 'and it agrees from there on');
});

void test('the field the renderer holds survives an engine arriving', async () => {
  const room = new FieldRuntime();
  const handed = room.values;
  mountField('?field=wasm', room, (search) => startField(search, async () => new Engine()));
  await settle();
  // The swarm uploads this array as a texture. Swapping in a second runtime
  // when WASM arrived would leave it pointed at a field nothing updates.
  assert.equal(room.values, handed);
});

void test('a build that will not load leaves a working room and an explanation', async () => {
  const room = new FieldRuntime();
  mountField('?field=wasm', room,
    (search) => startField(search, async () => { throw new Error('404'); }));
  await settle();
  assert.match(room.label, /^TypeScript memory field — WASM unavailable/);
  room.deposit(at(0.5, 0.5), 0.1, 2);
  assert.ok(memoryDensity(room.values) > 0);
});

void test('a build that arrives after the timeout is freed, never installed', async () => {
  const engine = new Engine();
  const room = new FieldRuntime();
  mountField('?field=wasm', room, (search) => startField(
    search,
    () => new Promise((resolve) => { setTimeout(() => resolve(engine), 40); }),
    1,
  ));
  await settle();
  assert.match(room.label, /^TypeScript memory field — WASM unavailable/);
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.equal(engine.freed, 1, 'a late engine is a leaked WASM instance unless it is freed');
});

void test('an engine that arrives after the mount is retired is freed, not attached', async () => {
  const engine = new Engine();
  const room = new FieldRuntime();
  const stop = mountField('?field=wasm', room, (search) => startField(
    search,
    () => new Promise((resolve) => { setTimeout(() => resolve(engine), 20); }),
  ));
  stop();
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.equal(engine.freed, 1);
  assert.equal(room.label, 'TypeScript memory field');
});

/**
 * The boundary has no type system spanning it, so the numbers are declared on
 * one side and mirrored on the other. A stride or a capacity changed in Rust
 * and not here would decode a radius as an amount, silently.
 */
void test('the batch layout is the layout the Rust engine declares', () => {
  const source = readFileSync(new URL('../crates/room-engine/src/field_engine.rs', import.meta.url), 'utf8');
  const stride = /pub const DEPOSIT_STRIDE: usize = (\d+);/.exec(source);
  const max = /pub const MAX_DEPOSITS: usize = TRACKS_MAX \+ (\d+);/.exec(source);
  assert.ok(stride && max, 'the engine must still declare both');
  assert.equal(Number(stride[1]), DEPOSIT_STRIDE);
  // TRACKS_MAX is 12, declared in room-protocol's bounded module.
  const bounded = readFileSync(new URL('../crates/room-protocol/src/bounded.rs', import.meta.url), 'utf8');
  const tracks = /pub const TRACKS_MAX: usize = (\d+);/.exec(bounded);
  assert.ok(tracks, 'TRACKS_MAX must still be declared');
  assert.equal(Number(tracks[1]) + Number(max[1]), MAX_DEPOSITS);
});

void test('a saved room is restored into both sides, and truncated if it is stale', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  const saved = Array.from({ length: room.values.length + 64 }, () => 0.25);
  room.restore(saved);
  assert.equal(room.values.length, 2304, 'a longer saved field does not resize the room');
  assert.ok(Math.abs(memoryDensity(room.values) - 0.25) < 1e-6);
  assert.equal(memoryDensity(engine.field), memoryDensity(room.values));
  room.deposit(at(0.5, 0.5), 0.1, 2);
  room.flush();
  assert.equal(room.label, RUNNING, 'and the two agree from there on');
});

void test('the opening ramp scales every cell and the engine follows it', () => {
  const engine = new Engine();
  const room = new FieldRuntime(undefined, engine);
  room.deposit(at(0.5, 0.5), 0.8, 4);
  room.flush();
  const full = memoryDensity(room.values);
  room.scale(0.25);
  assert.ok(Math.abs(memoryDensity(room.values) - full * 0.25) < 1e-6);
  room.deposit(at(0.3, 0.3), 0.1, 2);
  room.flush();
  assert.equal(room.label, RUNNING, 'a whole-field change the engine was not told about would diverge');
});
