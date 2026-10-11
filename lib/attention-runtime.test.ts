import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AttentionRuntime,
  type Decision,
  type WasmAttention,
  INTEREST_PARITY_TOLERANCE,
  mountAttention,
  startAttention,
} from './attention-runtime.ts';
import {
  ATTENDED_DEPOSIT_GAIN,
  INTEREST_ATTACK_MS,
  INTEREST_FADE_MS,
  INTEREST_HOLD_MS,
  INTEREST_REST_MS,
  RoomAttention,
} from './attention.ts';
import { EvidenceGate } from './attention-evidence.ts';
import {
  FIELD,
  NO_TRACK,
  OUTPUT_FIELDS,
  decodeAttentionFrame,
  encodeAttentionFrame,
  MAX_FILINGS,
} from './attention-bridge.ts';
import type { VisitorTrack } from './room-types.ts';

const FRAME_MS = 50;

/** A present track, in the shell's own spelling of an id. */
function present(sequence: number, dwellSeconds = 0, stillFor = 0): VisitorTrack {
  return { id: `visitor-abc-${sequence}`, dwellSeconds, stillFor } as VisitorTrack;
}

/**
 * A stand-in engine that holds the real rules.
 *
 * `RoomAttention` and `EvidenceGate` are the behavioural specification, so a
 * double built out of them agrees with the runtime's companion by
 * construction — which is what makes a *disagreement* in these tests a
 * deliberate injection rather than an accident of a hand-written fake.
 */
class Engine implements WasmAttention {
  private readonly room = new RoomAttention();
  private readonly gate = new EvidenceGate();
  freed = false;
  cleared = 0;
  frames: Float64Array[] = [];
  /** Set to bend the answer, to exercise the parity check. */
  bend: ((out: number[]) => number[]) | null = null;
  throwOn: number | null = null;

  step(frame: Float64Array): Float64Array {
    this.frames.push(frame);
    if (this.throwOn !== null && this.frames.length >= this.throwOn) {
      throw new Error('trap carrying data that must not escape');
    }
    const now = frame[0];
    const filings = frame[1];
    const tracks: { id: string; dwellSeconds: number; stillFor: number }[] = [];
    let cursor = 3;
    for (let filed = 0; filed < filings; filed += 1) {
      this.room.observe(
        frame[cursor] === 1 ? 'revisit' : 'crossing',
        `t-${frame[cursor + 1]}`,
        frame[cursor + 2],
      );
      cursor += 3;
    }
    for (let track = 0; track < frame[2]; track += 1) {
      tracks.push({
        id: `t-${frame[cursor]}`,
        dwellSeconds: frame[cursor + 1],
        stillFor: frame[cursor + 2],
      });
      cursor += 3;
    }
    for (const evidence of this.gate.observe(tracks as VisitorTrack[], now)) {
      this.room.observe(evidence.kind, evidence.trackId, now);
    }
    this.room.update(tracks.map((track) => track.id), now);
    const focus = this.room.focus(now);
    const out = focus
      ? [1, Number(focus.trackId.slice(2)), focus.weight, 0, 0]
      : [0, NO_TRACK, 0, 0, 0];
    return Float64Array.from(this.bend ? this.bend(out) : out);
  }

  clear() {
    this.cleared += 1;
    this.room.reset();
    this.gate.reset();
  }

  free() {
    this.freed = true;
  }
}

/** Run a session against a runtime, returning what it decided each frame. */
function run(
  runtime: AttentionRuntime,
  frames: number,
  at: (frame: number, now: number) => VisitorTrack[],
  file?: (frame: number, now: number, runtime: AttentionRuntime) => void,
): Decision[] {
  const decided: Decision[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const now = frame * FRAME_MS;
    file?.(frame, now, runtime);
    decided.push({ ...runtime.update(at(frame, now), now) });
  }
  return decided;
}

/** The whole spell: earned, risen, held, faded, and then the rest. */
function spell(runtime: AttentionRuntime): Decision[] {
  return run(
    runtime,
    2_000,
    () => [present(1, 60, 30), present(2, 0, 0)],
    (frame, now, live) => {
      if (frame === 1) live.observe('revisit', 'visitor-abc-1', now);
      if (frame === 2) live.observe('crossing', 'visitor-abc-1', now - FRAME_MS);
    },
  );
}

void test('with no WASM the runtime is the TypeScript room, decided per frame', () => {
  const runtime = new AttentionRuntime();
  assert.equal(runtime.label, 'TypeScript interest');
  const decided = spell(runtime);

  const attended = decided.filter((frame) => frame.trackId !== null);
  assert.ok(attended.length > 0, 'the session must actually reach a spell');
  assert.ok(attended.every((frame) => frame.trackId === 'visitor-abc-1'),
    'the room must attend to the visitor who earned it, in the shell spelling');
  assert.equal(Math.max(...decided.map((frame) => frame.weight)), 1);

  // Attack, hold and fade, and then nothing for the rest of the session.
  const length = attended.length * FRAME_MS;
  assert.ok(
    Math.abs(length - (INTEREST_ATTACK_MS + INTEREST_HOLD_MS + INTEREST_FADE_MS)) <= FRAME_MS,
    `a spell lasted ${length} ms`,
  );
});

/**
 * The contract that reads like an off-by-one and is the point: interest that
 * switches on reads as a trigger, so the frame a spell begins on still reports
 * nobody, because its weight is exactly zero.
 */
void test('the frame a spell begins on reports nobody', () => {
  const decided = spell(new AttentionRuntime());
  const first = decided.findIndex((frame) => frame.trackId !== null);
  assert.ok(first > 0);
  assert.equal(decided[first - 1].trackId, null);
  assert.ok(decided[first].weight > 0);
});

void test('WASM drives the room while it agrees, and both halves are compared', () => {
  const engine = new Engine();
  const runtime = new AttentionRuntime(engine);
  assert.equal(runtime.label, 'Rust/WASM interest (verified against TS)');
  const withWasm = spell(runtime);
  const without = spell(new AttentionRuntime());

  assert.equal(runtime.label, 'Rust/WASM interest (verified against TS)', 'must not have retired');
  assert.deepEqual(withWasm, without);
  assert.ok(engine.frames.length > 0, 'the engine must actually have been stepped');
});

/**
 * The reason a filing carries the instant it happened. A crossing is filed
 * after the frame that found it, so the buffer hands it to the engine one
 * frame later and it must still age from when the visitor walked into the
 * memory.
 */
void test('a filing reaches the engine stamped with when it happened', () => {
  const engine = new Engine();
  const runtime = new AttentionRuntime(engine);
  runtime.observe('crossing', 'visitor-abc-1', 1_000);
  runtime.update([present(1)], 1_050);

  const frame = engine.frames.at(-1)!;
  assert.equal(frame[1], 1, 'one filing');
  assert.equal(frame[0], 1_050, 'the frame is of now');
  assert.equal(frame[FIELD.attending + 3 + 2], 1_000, 'the filing is of when it happened');
});

void test('a disagreement retires WASM and keeps the spell the companion is holding', () => {
  const engine = new Engine();
  const runtime = new AttentionRuntime(engine);
  // Mid-spell, the engine starts reporting a weight that is not the one the
  // room is actually at. Continuity is the whole reason the companion runs.
  let frames = 0;
  engine.bend = (out) => {
    frames += 1;
    return frames > 1_000 && out[FIELD.attending] === 1
      ? [out[0], out[1], out[2] * 0.5, out[3], out[4]]
      : out;
  };
  const decided = spell(runtime);
  const reference = spell(new AttentionRuntime());

  assert.match(runtime.label, /^TypeScript interest — WASM failed or diverged/);
  assert.deepEqual(decided, reference, 'the room must not notice the handover');
  assert.ok(engine.freed, 'a retired engine is released');
});

void test('a trap retires WASM without carrying its payload into the diagnostic', () => {
  const engine = new Engine();
  engine.throwOn = 900;
  const runtime = new AttentionRuntime(engine);
  const decided = spell(runtime);

  assert.equal(runtime.label,
    'TypeScript interest — WASM failed or diverged; continued with live TS interest');
  assert.deepEqual(decided, spell(new AttentionRuntime()));
});

/**
 * The frame the engine refuses is the one this would have sent. Filing past
 * the bound is a defect upstream, and it is reported as that rather than
 * arriving a moment later as a parity disagreement, which would send an
 * operator to the wrong subsystem.
 */
void test('more filings than the engine accepts is its own fault, not a disagreement', () => {
  const engine = new Engine();
  const runtime = new AttentionRuntime(engine);
  for (let filing = 0; filing <= MAX_FILINGS; filing += 1) {
    runtime.observe('revisit', 'visitor-abc-0', 0);
  }
  assert.equal(runtime.label,
    'TypeScript interest — more filings in one frame than the engine accepts');
  assert.ok(engine.freed);
  // And it still works, on the companion, with every filing it was given.
  const decided = runtime.update([present(0), present(1)], FRAME_MS);
  assert.equal(decided.trackId, null, 'a spell still has to rise from zero');
  assert.equal(runtime.update([present(0), present(1)], INTEREST_ATTACK_MS).trackId,
    'visitor-abc-0');
});

void test('a decision names a deposit scale and a preference, and no clock is involved', () => {
  const runtime = new AttentionRuntime();
  const decided = spell(runtime);
  assert.ok(decided.some((frame) => frame.weight === 1));

  // Drive to full interest and read without passing an instant.
  const live = new AttentionRuntime();
  run(live, 200, () => [present(1, 60, 30)], (frame, now, room) => {
    if (frame === 1) room.observe('revisit', 'visitor-abc-1', now);
  });
  const at = live.decision();
  assert.equal(live.depositScale('visitor-abc-1'), 1 + ATTENDED_DEPOSIT_GAIN * at.weight);
  assert.equal(live.depositScale('visitor-abc-9'), 1, 'exactly one for everybody else');
  assert.equal(live.favours('visitor-abc-1'), at.weight);
  assert.equal(live.favours('visitor-abc-9'), 0);
  assert.equal(live.favours(undefined), 0);
});

void test('reset forgets everyone on both sides and stops resting', () => {
  const engine = new Engine();
  const runtime = new AttentionRuntime(engine);
  spell(runtime);
  runtime.reset();
  assert.equal(engine.cleared, 1);
  assert.equal(runtime.decision().trackId, null);

  // The rest period is gone too: a new visitor can earn interest immediately.
  const after = run(runtime, 200, () => [present(5, 60, 30)], (frame, now, room) => {
    if (frame === 1) room.observe('revisit', 'visitor-abc-5', now);
  });
  assert.ok(after.some((frame) => frame.trackId === 'visitor-abc-5'),
    'a reset room must not still be resting');
});

/**
 * Interest dies with the track. A room that carried it across a departure
 * would be persisting an identity, which this installation does not do.
 */
void test('interest ends when its subject leaves and never transfers', () => {
  const runtime = new AttentionRuntime(new Engine());
  const decided = run(
    runtime,
    1_600,
    (frame) => frame < 1_000 ? [present(1, 60, 30), present(2, 60, 30)] : [present(2, 60, 30)],
    (frame, now, room) => {
      if (frame === 1) room.observe('revisit', 'visitor-abc-1', now);
      if (frame === 2) room.observe('crossing', 'visitor-abc-1', now);
    },
  );
  assert.ok(decided.slice(0, 1_000).some((frame) => frame.trackId === 'visitor-abc-1'));
  assert.ok(decided.slice(1_000).every((frame) => frame.trackId === null),
    'the room must not move its interest to whoever is still there');
});

/**
 * Ids cross the boundary as numbers, and only the two spellings the trackers
 * actually mint are read. A trailing number alone would also accept an id from
 * another space, and two spaces sharing a sequence is how the room ends up
 * attending to somebody who is not the person who earned it.
 */
void test('an id the tracker did not mint retires WASM rather than encoding nonsense', () => {
  for (const id of ['ghost-7', 'visitor-7', 'visitor--7', 't-', 't-x', '7', 'visitor-abc-7x']) {
    const engine = new Engine();
    const runtime = new AttentionRuntime(engine);
    runtime.update([{ id, dwellSeconds: 0, stillFor: 0 } as VisitorTrack], 0);
    assert.match(runtime.label, /^TypeScript interest — WASM failed or diverged/, id);
  }
  // And the two it does mint are accepted.
  for (const id of ['t-7', 'visitor-3kf.8i-12']) {
    const runtime = new AttentionRuntime(new Engine());
    runtime.update([{ id, dwellSeconds: 0, stillFor: 0 } as VisitorTrack], 0);
    assert.equal(runtime.label, 'Rust/WASM interest (verified against TS)', id);
  }
});

void test('a disposed runtime refuses to be advanced', () => {
  const engine = new Engine();
  const runtime = new AttentionRuntime(engine);
  runtime.dispose();
  assert.ok(engine.freed);
  assert.throws(() => runtime.update([], 0), /disposed/);
  assert.throws(() => runtime.observe('revisit', 'visitor-abc-1', 0), /disposed/);
  runtime.dispose();
});

void test('?attention=ts opts out; no WASM is loaded at all', async () => {
  let loads = 0;
  const runtime = await startAttention('?attention=ts', async () => { loads += 1; return new Engine(); });
  assert.equal(loads, 0);
  assert.equal(runtime.label, 'TypeScript interest');
});

void test('WASM is the default: an unrelated or unrecognized parameter still loads it', async () => {
  let loads = 0;
  const runtime = await startAttention('?other=1', async () => { loads += 1; return new Engine(); });
  assert.equal(loads, 1);
  assert.match(runtime.label, /^Rust\/WASM/);
});

void test('a WASM build that will not load falls back and says so', async () => {
  const runtime = await startAttention('?attention=wasm', () => Promise.reject(new Error('404')));
  assert.equal(runtime.label,
    'TypeScript interest — WASM unavailable; check the local WASM build');
});

void test('an engine that arrives after the timeout is freed, not installed', async () => {
  const engine = new Engine();
  const runtime = await startAttention(
    '?attention=wasm',
    () => new Promise<WasmAttention>((resolve) => { setTimeout(() => resolve(engine), 20); }),
    1,
  );
  assert.match(runtime.label, /^TypeScript interest — WASM unavailable/);
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  assert.ok(engine.freed, 'a late engine must not be left holding WASM memory');
});

void test('unmounting before startup finishes retires the runtime it was building', async () => {
  const engine = new Engine();
  let attached: AttentionRuntime | null | undefined;
  const stop = mountAttention('?attention=wasm', (runtime) => { attached = runtime; },
    () => Promise.resolve(new AttentionRuntime(engine)));
  stop();
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  assert.equal(attached, null);
  assert.ok(engine.freed);
});

void test('mounting attaches the runtime and cleanup detaches and disposes it', async () => {
  const engine = new Engine();
  let attached: AttentionRuntime | null | undefined;
  const stop = mountAttention('?attention=wasm', (runtime) => { attached = runtime; },
    () => Promise.resolve(new AttentionRuntime(engine)));
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  assert.ok(attached instanceof AttentionRuntime);
  stop();
  assert.equal(attached, null);
  assert.ok(engine.freed);
});

/**
 * The bound on what the runtime accumulates between frames. Every structure in
 * this installation has a documented bound; this one is the filing buffer, and
 * it is emptied by every step whether or not WASM is running.
 */
void test('nothing accumulates across a long session', () => {
  const runtime = new AttentionRuntime(new Engine());
  // A gallery day at 24 Hz, compressed: evidence offered at every opportunity.
  run(runtime, 20_000, () => [present(1, 60, 30), present(2, 60, 30)], (frame, now, room) => {
    if (frame % 800 === 0) room.observe('revisit', 'visitor-abc-1', now);
    if (frame % 900 === 0) room.observe('crossing', 'visitor-abc-2', now);
  });
  assert.equal(runtime.label, 'Rust/WASM interest (verified against TS)');
  const rested = INTEREST_REST_MS / FRAME_MS;
  assert.ok(rested > 0);
});

void test('a decision buffer of zero filings is still a frame', () => {
  const engine = new Engine();
  const runtime = new AttentionRuntime(engine);
  assert.deepEqual(runtime.update([], 0), { trackId: null, weight: 0 });
  assert.equal(engine.frames.at(-1)!.length, 3, 'a header and nothing else');
  const out = decodeAttentionFrame(
    Float64Array.from([0, NO_TRACK, 0, 0, 0]),
  );
  assert.equal(out.trackId, null);
  assert.equal(encodeAttentionFrame(0, [], []).length, 3);
  assert.equal(OUTPUT_FIELDS, 5);
});

/**
 * Both halves of the parity check, separately.
 *
 * A check that compared only the weight would accept an engine attending to
 * the wrong person at exactly the right intensity, which is the one failure
 * nothing on the wall would show and no operator could report.
 */
void test('attending the wrong person is a disagreement even at the right weight', () => {
  const engine = new Engine();
  const runtime = new AttentionRuntime(engine);
  let frames = 0;
  engine.bend = (out) => {
    frames += 1;
    // The same weight, a different visitor. Track 2 is present throughout.
    return frames > 500 && out[FIELD.attending] === 1
      ? [out[0], 2, out[2], out[3], out[4]]
      : out;
  };
  spell(runtime);
  assert.match(runtime.label, /^TypeScript interest — WASM failed or diverged/);
});

/**
 * The tolerance is the one the parity harness states.
 *
 * Chosen before the runs rather than rounded up to whatever they produced: the
 * measured difference on every leg is currently exactly zero, so any weight
 * reaching this check at all is already a finding.
 *
 * Bracketed rather than landed on, because the boundary is not reachable. The
 * nearest double to `1 - 1e-6` differs from 1 by 1.0000000000287557e-6, and
 * the next one up differs by 9.99999999917e-7 — one ulp near 1 is 1.11e-16,
 * which steps straight over a gap of 2.88e-17. No pair of weights differs by
 * exactly the tolerance, so `<` and `<=` are the same rule here, and the test
 * says which side of it each representable difference falls on instead of
 * pretending to test an equality that cannot occur.
 */
void test('the parity tolerance is the stated one, bracketed either side', () => {
  const offsetBy = (delta: number) => {
    const engine = new Engine();
    const runtime = new AttentionRuntime(engine);
    let frames = 0;
    engine.bend = (out) => {
      frames += 1;
      // Only on the plateau, where the weight is exactly 1 and the subtraction
      // is therefore the delta and nothing else. Anywhere on the ramp the
      // weight is a ratio of two clock readings and `w - d` differs from `w`
      // by its own rounding as well, which would make this a test of
      // floating-point subtraction rather than of the tolerance.
      return frames > 500 && out[FIELD.attending] === 1 && out[2] === 1
        ? [out[0], out[1], out[2] - delta, out[3], out[4]]
        : out;
    };
    spell(runtime);
    return runtime.label;
  };
  // Exactly representable against a weight of 1, so the difference is the
  // delta and nothing else: 2**-20 is 9.537e-7 and 2**-19 is 1.907e-6.
  assert.equal(offsetBy(2 ** -20), 'Rust/WASM interest (verified against TS)',
    'a difference under the tolerance is agreement');
  assert.match(offsetBy(2 ** -19), /^TypeScript interest — WASM failed or diverged/,
    'a difference over it is not');
  // Read from the module, never copied: two literals here fold to `true` and
  // the brackets would keep "passing" after the tolerance moved away from them.
  assert.ok(2 ** -20 < INTEREST_PARITY_TOLERANCE, 'the lower bracket must be under the tolerance');
  assert.ok(2 ** -19 > INTEREST_PARITY_TOLERANCE, 'the upper bracket must be over it');
});

/**
 * Sequence zero is the first visitor of a session, not an absent one, and an
 * id too large to be an integer is a boundary that has drifted.
 */
void test('the first track of a session is a track, and an impossible one is not', () => {
  const first = new AttentionRuntime(new Engine());
  first.update([present(0, 60, 30)], 0);
  assert.equal(first.label, 'Rust/WASM interest (verified against TS)',
    'track zero must not read as no track at all');

  const absurd = new AttentionRuntime(new Engine());
  absurd.update([{ id: 't-99999999999999999999', dwellSeconds: 0, stillFor: 0 } as VisitorTrack], 0);
  assert.match(absurd.label, /^TypeScript interest — WASM failed or diverged/,
    'a sequence past a safe integer is not an id this engine minted');
});

void test('a track with no id at all is ignored rather than filed', () => {
  const engine = new Engine();
  const runtime = new AttentionRuntime(engine);
  runtime.observe('revisit', '', 0);
  runtime.update([present(1)], 0);
  assert.equal(engine.frames.at(-1)![1], 0, 'nothing was filed');
  assert.equal(runtime.label, 'Rust/WASM interest (verified against TS)');
});

/**
 * The default path must be inert. Without WASM there is no buffer to fill, no
 * engine to step and nothing that can retire — a TypeScript room that started
 * reporting a fallback reason would send an operator hunting a WASM build that
 * was never asked for.
 */
void test('a TypeScript-only room never retires, however much it is told', () => {
  const runtime = new AttentionRuntime();
  for (let filing = 0; filing < MAX_FILINGS * 20; filing += 1) {
    runtime.observe('revisit', 'visitor-abc-1', filing);
  }
  for (let frame = 0; frame < 50; frame += 1) runtime.update([present(1, 60, 30)], frame * FRAME_MS);
  assert.equal(runtime.label, 'TypeScript interest');
  // And neither reset nor dispose may reach for an engine that is not there.
  runtime.reset();
  assert.equal(runtime.label, 'TypeScript interest');
  runtime.dispose();
});

/** The deposit gain multiplies the weight. At full interest the two are the
 * same number, so the assertion has to be made somewhere on the ramp. */
void test('an attended visitor deposits by the weight, not by a fixed amount', () => {
  const runtime = new AttentionRuntime(new Engine());
  const decided = spell(runtime);
  const rising = decided.find((frame) => frame.weight > 0 && frame.weight < 1);
  assert.ok(rising, 'the session never passed through a partial weight');

  const live = new AttentionRuntime();
  const at = run(live, 200, () => [present(1, 60, 30)], (frame, now, room) => {
    if (frame === 1) room.observe('revisit', 'visitor-abc-1', now);
  }).findIndex((frame) => frame.weight > 0 && frame.weight < 1);
  assert.ok(at > 0);
  const partial = new AttentionRuntime();
  run(partial, at + 1, () => [present(1, 60, 30)], (frame, now, room) => {
    if (frame === 1) room.observe('revisit', 'visitor-abc-1', now);
  });
  const weight = partial.decision().weight;
  assert.ok(weight > 0 && weight < 1, `weight was ${weight}`);
  assert.equal(partial.depositScale('visitor-abc-1'), 1 + ATTENDED_DEPOSIT_GAIN * weight);
  assert.notEqual(partial.depositScale('visitor-abc-1'), 1 + ATTENDED_DEPOSIT_GAIN / weight);
});

void test('a reset drops what was filed for the next frame as well', () => {
  const engine = new Engine();
  const runtime = new AttentionRuntime(engine);
  runtime.observe('crossing', 'visitor-abc-1', 0);
  runtime.reset();
  runtime.update([present(1)], FRAME_MS);
  assert.equal(engine.frames.at(-1)![1], 0, 'a filing survived the reset');
});

void test('an engine that will not reset is retired rather than left half-cleared', () => {
  const engine = new Engine();
  engine.clear = () => { throw new Error('trap'); };
  const runtime = new AttentionRuntime(engine);
  runtime.reset();
  assert.equal(runtime.label, 'TypeScript interest — WASM reset failed; continued with TS interest');
  // And the room itself did reset, whatever the engine did.
  assert.equal(runtime.decision().trackId, null);
});

void test('a retired engine is released exactly once', () => {
  let frees = 0;
  const engine = new Engine();
  engine.free = () => { frees += 1; };
  const runtime = new AttentionRuntime(engine);
  runtime.dispose();
  runtime.dispose();
  assert.equal(frees, 1, 'dispose is idempotent');

  // And a destructor that traps must not prevent the fallback or the cleanup.
  const trapping = new Engine();
  trapping.free = () => { throw new Error('trap'); };
  const second = new AttentionRuntime(trapping);
  second.dispose();
  assert.throws(() => second.update([], 0), /disposed/);
});

void test('a WASM build that loads is the one the room runs', async () => {
  const engine = new Engine();
  const runtime = await startAttention('?attention=wasm', () => Promise.resolve(engine));
  assert.equal(runtime.label, 'Rust/WASM interest (verified against TS)');
  runtime.update([present(1)], 0);
  assert.ok(engine.frames.length > 0, 'the loaded engine must actually be stepped');
  runtime.dispose();
});
