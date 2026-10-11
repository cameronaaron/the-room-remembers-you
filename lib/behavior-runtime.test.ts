import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BehaviorRuntime,
  BEHAVIOR_PARITY_TOLERANCE,
  mountBehavior,
  startBehavior,
  type WasmBehavior,
} from './behavior-runtime.ts';
import { BehaviorWatcher, type BehaviorEvent } from './behaviors.ts';
import {
  BEHAVIOR,
  FIELD,
  HEADER_FIELDS,
  NO_TRACK,
  OUTPUT_HEADER_FIELDS,
  PATH_STRIDE,
  RECORD_FIELDS,
} from './behavior-bridge.ts';
import type { Point, VisitorTrack } from './room-types.ts';

const FRAME_MS = 125;

/** A present track, in the shell's own spelling of an id. */
function present(
  sequence: number,
  x: number,
  y: number,
  now: number,
  width = 0.12,
  path: Point[] = [],
): VisitorTrack {
  return {
    id: `visitor-abc-${sequence}`,
    bornAt: 0,
    lastSeen: now,
    position: { x, y, t: now },
    previous: { x, y, t: now },
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

/**
 * A stand-in engine that holds the real rules.
 *
 * `BehaviorWatcher` is the behavioural specification, so a double built out of
 * it agrees with the runtime's companion by construction — which is what makes
 * a *disagreement* in these tests a deliberate injection rather than an
 * accident of a hand-written fake. It decodes the frame the bridge encoded, so
 * the encoder is exercised rather than bypassed.
 */
class Engine implements WasmBehavior {
  private readonly watcher = new BehaviorWatcher();
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
    const stable = frame[1] === 1;
    const tracks: VisitorTrack[] = [];
    let cursor = HEADER_FIELDS;
    for (let index = 0; index < frame[2]; index += 1) {
      const pathLength = frame[cursor + FIELD.pathLength];
      const path: Point[] = [];
      let point = cursor + RECORD_FIELDS;
      for (let step = 0; step < pathLength; step += 1) {
        path.push({ x: frame[point], y: frame[point + 1], t: frame[point + 2] });
        point += PATH_STRIDE;
      }
      tracks.push({
        ...present(
          frame[cursor + FIELD.id],
          frame[cursor + FIELD.x],
          frame[cursor + FIELD.y],
          now,
          frame[cursor + FIELD.width],
          path,
        ),
        id: `t-${frame[cursor + FIELD.id]}`,
        velocity: { x: frame[cursor + FIELD.velocityX], y: frame[cursor + FIELD.velocityY] },
        speed: frame[cursor + FIELD.speed],
      });
      cursor = point;
    }
    const events = this.watcher.update(tracks, now, stable);
    const out = [events.length, tracks.length];
    for (const event of events) {
      out.push(
        BEHAVIOR[event.kind],
        event.at.x,
        event.at.y,
        Number(event.subjects[0].slice(2)),
        event.subjects[1] === undefined ? NO_TRACK : Number(event.subjects[1].slice(2)),
      );
    }
    return Float64Array.from(this.bend ? this.bend(out) : out);
  }

  clear() {
    this.cleared += 1;
    this.watcher.reset();
  }

  free() {
    this.freed = true;
  }
}

/** A loop out and back, old enough for the revisit detector to consider. */
function roundTrip(): Point[] {
  return Array.from({ length: 16 }, (_, step) => {
    const angle = (step / 15) * Math.PI * 2;
    return { x: 0.5 + 0.2 * Math.cos(angle), y: 0.5 + 0.2 * Math.sin(angle), t: step * 3_000 };
  });
}

/**
 * A session with something in it: two people arriving at the edge together,
 * one of them waving, and one of them standing where they stood a minute ago.
 */
function session(runtime: BehaviorRuntime, frames = 40): BehaviorEvent[] {
  const path = roundTrip();
  const seen: BehaviorEvent[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const now = 60_000 + frame * FRAME_MS;
    const waver = present(1, path[0].x, path[0].y, now, frame % 2 === 0 ? 0.10 : 0.16, path);
    const other = present(2, 0.06, 0.5, now);
    for (const event of runtime.update([waver, other], now)) seen.push(event);
  }
  return seen;
}

void test('with no WASM the runtime is the TypeScript watcher', () => {
  const runtime = new BehaviorRuntime();
  assert.equal(runtime.label, 'TypeScript behaviour');
  const seen = session(runtime);
  const kinds = seen.map((event) => event.kind);
  assert.ok(kinds.includes('revisit'), `no revisit in ${kinds.join(', ')}`);
  assert.ok(kinds.includes('wave'), `no wave in ${kinds.join(', ')}`);
  assert.ok(
    seen.every((event) => event.subjects.every((id) => id.startsWith('visitor-'))),
    'subjects must be named in the shell spelling',
  );
});

void test('WASM drives the room while it agrees, and both halves are compared', () => {
  const engine = new Engine();
  const runtime = new BehaviorRuntime(engine);
  assert.equal(runtime.label, 'Rust/WASM behaviour (verified against TS)');
  const withWasm = session(runtime);
  const without = session(new BehaviorRuntime());

  assert.equal(runtime.label, 'Rust/WASM behaviour (verified against TS)', 'must not have retired');
  assert.deepEqual(withWasm, without);
  assert.ok(engine.frames.length > 0, 'the engine must actually have been stepped');
  assert.ok(withWasm.length > 0, 'the session must actually notice something');
});

/**
 * The path crosses whole, because `revisit` is a claim about minutes and the
 * path belongs to the tracker. A frame that carried only a window of it would
 * make the detector silent in a way that looks exactly like a room with no
 * returning visitors.
 */
void test('the tracker path reaches the engine whole', () => {
  const engine = new Engine();
  const runtime = new BehaviorRuntime(engine);
  const path = roundTrip();
  runtime.update([present(1, 0.5, 0.5, 1_000, 0.12, path)], 1_000);

  const frame = engine.frames.at(-1)!;
  assert.equal(frame[HEADER_FIELDS + FIELD.pathLength], path.length);
  assert.equal(frame.length, HEADER_FIELDS + RECORD_FIELDS + path.length * PATH_STRIDE);
  const first = HEADER_FIELDS + RECORD_FIELDS;
  assert.equal(frame[first], path[0].x);
  assert.equal(frame[first + 2], path[0].t);
});

/** No pixels, no outline height, no identity: only what the detectors read. */
void test('nothing crosses the boundary but anonymous motion', () => {
  const engine = new Engine();
  const runtime = new BehaviorRuntime(engine);
  const track = present(3, 0.4, 0.6, 500);
  runtime.update([track], 500);

  const frame = engine.frames.at(-1)!;
  assert.equal(frame.length, HEADER_FIELDS + RECORD_FIELDS);
  // The id is a sequence number, not the shell's spelling: nothing that could
  // outlive the track crosses.
  assert.equal(frame[HEADER_FIELDS + FIELD.id], 3);
  assert.ok(![...frame].includes(track.extent.height), 'heights are never sent');
});

void test('a disagreement retires WASM and keeps the history the companion holds', () => {
  const engine = new Engine();
  const runtime = new BehaviorRuntime(engine);
  // Once the engine reports an event, it starts naming the wrong person.
  engine.bend = (out) => {
    if (out[0] === 0) return out;
    const bent = [...out];
    bent[OUTPUT_HEADER_FIELDS + 3] += 1;
    return bent;
  };
  const withWasm = session(runtime);
  const without = session(new BehaviorRuntime());

  assert.match(runtime.label, /^TypeScript behaviour — WASM failed or diverged/);
  assert.ok(engine.freed, 'a retired engine is released');
  // The companion was advancing all along, so the session is unbroken: the
  // same events, in the same order, as a run that never had WASM at all.
  assert.deepEqual(withWasm, without);
});

/** Place may differ by arithmetic; kinds and subjects may not. */
void test('a difference smaller than the tolerance is not a disagreement', () => {
  for (const [nudge, retires] of [
    [BEHAVIOR_PARITY_TOLERANCE / 2, false],
    [BEHAVIOR_PARITY_TOLERANCE * 10, true],
  ] as [number, boolean][]) {
    const engine = new Engine();
    const runtime = new BehaviorRuntime(engine);
    engine.bend = (out) => {
      if (out[0] === 0) return out;
      const bent = [...out];
      bent[OUTPUT_HEADER_FIELDS + 1] += nudge;
      return bent;
    };
    session(runtime);
    assert.equal(
      runtime.label.startsWith('TypeScript'),
      retires,
      `a nudge of ${nudge} should ${retires ? '' : 'not '}retire`,
    );
  }
});

void test('a trap retires WASM without carrying its payload into the room', () => {
  const engine = new Engine();
  const runtime = new BehaviorRuntime(engine);
  // Third frame, which is before anything has been noticed: the companion has
  // to carry the whole session, not just the tail of it.
  engine.throwOn = 3;
  const seen = session(runtime);

  assert.match(runtime.label, /^TypeScript behaviour — WASM failed or diverged/);
  assert.ok(!runtime.label.includes('trap carrying'), 'a thrown payload must not reach a label');
  assert.deepEqual(seen, session(new BehaviorRuntime()), 'the session is unbroken across the trap');
  assert.ok(seen.length > 0, 'a session that noticed nothing would prove nothing');
});

void test('a malformed answer is refused rather than half-read', () => {
  const engine = new Engine();
  const runtime = new BehaviorRuntime(engine);
  // A count its length cannot hold: the shape of a layout that has drifted.
  engine.bend = (out) => [out[0] + 1, ...out.slice(1)];
  session(runtime, 4);
  assert.match(runtime.label, /^TypeScript behaviour — WASM failed or diverged/);
});

void test('a reset clears both halves, and a failed one retires WASM', () => {
  const engine = new Engine();
  const runtime = new BehaviorRuntime(engine);
  session(runtime, 4);
  runtime.reset();
  assert.equal(engine.cleared, 1);
  assert.equal(runtime.label, 'Rust/WASM behaviour (verified against TS)');

  const trapped = new Engine();
  trapped.clear = () => { throw new Error('gone'); };
  const second = new BehaviorRuntime(trapped);
  second.reset();
  assert.match(second.label, /^TypeScript behaviour — WASM reset failed/);
});

void test('a disposed runtime is not a runtime', () => {
  const engine = new Engine();
  const runtime = new BehaviorRuntime(engine);
  runtime.dispose();
  assert.ok(engine.freed);
  assert.throws(() => runtime.update([], 0), /disposed/);
  runtime.dispose();
});

void test('an unsettled pipeline records history on both sides and reports nothing', () => {
  const engine = new Engine();
  const runtime = new BehaviorRuntime(engine);
  const path = roundTrip();
  const events = runtime.update([present(1, path[0].x, path[0].y, 60_000, 0.12, path)], 60_000, false);
  assert.deepEqual(events, []);
  assert.equal(engine.frames.at(-1)![1], 0, 'the flag crosses, not an empty frame');
  assert.equal(runtime.label, 'Rust/WASM behaviour (verified against TS)');
});

void test('an id this engine did not mint retires WASM rather than being guessed at', () => {
  const engine = new Engine();
  const runtime = new BehaviorRuntime(engine);
  const stranger = { ...present(1, 0.5, 0.5, 0), id: 'g-1a2b3c' };
  runtime.update([stranger], 0);
  assert.match(runtime.label, /^TypeScript behaviour — WASM failed or diverged/);
});

void test('?behavior=ts opts out, and no WASM is even loaded', async () => {
  let asked = 0;
  const runtime = await startBehavior('?behavior=ts', async () => {
    asked += 1;
    return new Engine();
  });
  assert.equal(asked, 0);
  assert.equal(runtime.label, 'TypeScript behaviour');
});

void test('WASM is the default: another engine\'s parameter does not opt behaviour out', async () => {
  let asked = 0;
  const runtime = await startBehavior('?tracking=ts', async () => {
    asked += 1;
    return new Engine();
  });
  assert.equal(asked, 1, 'the behaviour engine reads only its own parameter');
  assert.equal(runtime.label, 'Rust/WASM behaviour (verified against TS)');
});

void test('a WASM build that will not load falls back and says why', async () => {
  const runtime = await startBehavior('?behavior=wasm', () => Promise.reject(new Error('404')));
  assert.match(runtime.label, /^TypeScript behaviour — WASM unavailable/);
});

void test('a slow load is abandoned, and its late engine is freed rather than installed', async () => {
  const engine = new Engine();
  let release: (() => void) | undefined;
  const runtime = await startBehavior(
    '?behavior=wasm',
    () => new Promise<WasmBehavior>((resolve) => { release = () => resolve(engine); }),
    5,
  );
  assert.match(runtime.label, /^TypeScript behaviour — WASM unavailable/);
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(engine.freed, 'a late engine must not be installed into a running session');
});

void test('unmounting before startup finishes retires the runtime that arrives', async () => {
  let started: BehaviorRuntime | undefined;
  let attached: BehaviorRuntime | null = null;
  const pending = new Promise<BehaviorRuntime>((resolve) => {
    setTimeout(() => {
      started = new BehaviorRuntime(new Engine());
      resolve(started);
    }, 1);
  });
  const unmount = mountBehavior('?behavior=wasm', (runtime) => { attached = runtime; }, () => pending);
  unmount();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(attached, null);
  assert.throws(() => started!.update([], 0), /disposed/);
});

/**
 * A frame the engine refuses is not forward progress for the room either. The
 * companion still advanced, so its cooldowns are stamped and its history is
 * intact — which is what makes the next frame after a retirement continuous
 * rather than a watcher starting from cold.
 */
void test('the companion is advanced on every frame, including the ones WASM fails', () => {
  const engine = new Engine();
  const runtime = new BehaviorRuntime(engine);
  engine.throwOn = 1;
  const withTrap = session(runtime);
  assert.deepEqual(withTrap, session(new BehaviorRuntime()));

  // And a cooldown stamped during the WASM half is still held afterwards: the
  // room must not repeat what it already said the moment WASM retires.
  const kinds = withTrap.map((event) => event.kind);
  assert.deepEqual([...new Set(kinds)].sort(), kinds.sort(), 'no kind is announced twice');
});
