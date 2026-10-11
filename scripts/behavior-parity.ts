/**
 * Cross-implementation parity for what the room notices people doing.
 *
 * Three runtimes hold the same rules: `BehaviorWatcher` in TypeScript,
 * `room_engine::behavior` compiled natively, and the same Rust compiled to
 * WASM. This feeds identical synthetic sessions to all three and reports where
 * they disagree.
 *
 * What it is *not*: proof that the Rust is correct. It is proof that it does
 * what the implementation the gallery has been running does. The TypeScript is
 * the behavioural specification — the edge test on `together` came from a real
 * session where the room told a single visitor "two of you, at once" within
 * three seconds of starting, and the reversal count on `wave` came from a lean
 * reading as a greeting — and the gate here is that none of those lessons was
 * lost in translation.
 *
 * # Why this one is harder than interest
 *
 * The interest rules are comparisons and one division. These reach `hypot` on
 * almost every frame, `signum` on the wave, and a square-root ratio on the
 * mirror, and then they threshold the result into a yes or a no. A last-place
 * difference that would vanish into a memory field is, on the wrong side of a
 * 0.06 radius or a 0.82 alignment, the difference between the room speaking and
 * the room staying silent. So the comparison here is not "are the numbers
 * close": it is **the same events, in the same order, naming the same people**,
 * with a tolerance only on where the room addresses them.
 *
 * # Why a quiet run proves nothing
 *
 * A scenario nobody does anything in agrees trivially, and six detectors give
 * six ways to build one by accident. The report therefore carries how many
 * times each kind fired, and the run fails if any of the six never did.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { initSync, WasmBehaviorEngine } from '../public/wasm/room_wasm.js';
import { BehaviorWatcher, type BehaviorEvent, type BehaviorKind } from '../lib/behaviors.ts';
import { BehaviorRuntime } from '../lib/behavior-runtime.ts';
import {
  decodeBehaviorFrame,
  encodeBehaviorFrame,
  type ObservedTrack,
} from '../lib/behavior-bridge.ts';
import type { Point, VisitorTrack } from '../lib/room-types.ts';

/**
 * Absolute agreement required on where the room addresses something.
 *
 * A room coordinate is 0..1 across a wall a few metres wide, so a billionth of
 * one is nanometres of projected light. Chosen before the run rather than
 * rounded up to whatever the run produced — if the measured error ever
 * approaches this, that is a finding, not a reason to move it.
 *
 * Kinds and subjects carry no tolerance at all. Two engines that noticed
 * different things have not nearly agreed.
 */
const TOLERANCE = 1e-9;

/**
 * Magic of the scenario file handed to the native leg.
 *
 * Raw little-endian `f64` rather than JSON, and that is a measurement rather
 * than a preference: `serde_json` 1.0.151 does not always parse a
 * seventeen-digit decimal to the nearest `f64`, and here a coordinate one unit
 * in the last place out is a distance on the wrong side of a threshold — a
 * different session, not a rounding difference. See `docs/ARCHITECTURE.md`.
 */
const SCENARIO_MAGIC = 'ROOMBEH1';

/** Sensing interval used by the scenarios, roughly the STANDARD profile. */
const FRAME_MS = 125;

/** Every kind, so a missing one is a failure rather than an absence nobody counted. */
const KINDS: readonly BehaviorKind[] =
  ['wave', 'approach', 'follow', 'together', 'revisit', 'mirror'];

type Walker = {
  id: number;
  x: number;
  y: number;
  width: number;
  vx: number;
  vy: number;
  speed: number;
};
type Frame = { now: number; stable: boolean; walkers: Walker[] };
type Scenario = { name: string; frames: Frame[] };

const walker = (id: number, x: number, y: number, extra: Partial<Walker> = {}): Walker =>
  ({ id, x, y, width: 0.12, vx: 0, vy: 0, speed: 0, ...extra });

/**
 * The tracker's own path, rebuilt from the frames.
 *
 * `motion-tracker.ts` appends a point when the visitor has moved more than
 * 0.008 or when half a second has passed, and keeps the last 280. The path is
 * the tracker's, not the watcher's, so a harness that invented its own rule
 * would be testing the detectors against a path the gallery never produces —
 * and `revisit`, the one detector that reads it, is the one whose thresholds
 * are tightest.
 */
class Paths {
  private readonly held = new Map<number, Point[]>();

  observe(who: Walker, now: number): Point[] {
    const point: Point = { x: who.x, y: who.y, t: now };
    const path = this.held.get(who.id);
    if (!path) {
      this.held.set(who.id, [point]);
      return [point];
    }
    const last = path[path.length - 1];
    if (Math.hypot(last.x - point.x, last.y - point.y) > 0.008 || now - last.t > 500) {
      path.push(point);
      if (path.length > 280) path.shift();
    }
    return path;
  }

  forget(present: Set<number>) {
    // Deleting during iteration is defined for a Map: the iterator visits each
    // remaining entry once, so no copy is needed to make this safe.
    for (const id of this.held.keys()) if (!present.has(id)) this.held.delete(id);
  }
}

function scenarios(): Scenario[] {
  const built: Scenario[] = [];
  const add = (name: string, frames: number, at: (frame: number) => Walker[], warm = 0) => {
    built.push({
      name,
      frames: Array.from({ length: frames }, (_, frame) => ({
        now: frame * FRAME_MS,
        stable: frame >= warm,
        walkers: at(frame),
      })),
    });
  };

  // The baseline. Someone walks straight through the middle of the room for
  // twelve seconds and does nothing else. If anything fires here, nothing
  // below matters.
  add('a-passer-by', 96, (frame) => [
    walker(1, 0.2 + frame * 0.007, 0.5, { vx: 0.056, speed: 0.056 }),
  ]);

  // A still centroid whose outline keeps widening and narrowing.
  add('someone-waving', 200, (frame) => [
    walker(1, 0.5, 0.45, { width: frame % 2 === 0 ? 0.10 : 0.17 }),
  ]);

  // The negative that shares its shape: the same body, a steady outline.
  add('someone-standing-still', 200, () => [walker(1, 0.5, 0.45)]);

  // Two people, both in from the edge, within the same second and a half.
  add('two-people-arriving-together', 120, (frame) => [
    walker(1, 0.03 + frame * 0.004, 0.42),
    walker(2, 0.06 + frame * 0.004, 0.55),
  ]);

  // Apart, then not. Starts past APPROACH_START and ends inside APPROACH_END.
  add('two-people-approaching', 200, (frame) => {
    const gap = Math.max(0.12, 0.5 - frame * 0.01);
    return [
      walker(1, 0.5 - gap / 2, 0.5, { vx: 0.04, speed: 0.04 }),
      walker(2, 0.5 + gap / 2, 0.5, { vx: -0.04, speed: 0.04 }),
    ];
  });

  // One walking the line the other walked a second earlier.
  add('one-following-another', 200, (frame) => {
    const step = 0.006;
    const behind = Math.max(0, frame - 10);
    return [
      walker(1, 0.08 + frame * step, 0.5, { vx: 0.048, speed: 0.048 }),
      walker(2, 0.08 + behind * step, 0.5, { vx: 0.048, speed: 0.048 }),
    ];
  });

  // The negative: the same progress, a different line. Side by side is not
  // following, and this is also a mirror, so one scenario carries both claims.
  add('two-walking-in-step', 200, (frame) => {
    const travel = frame * 0.004;
    return [
      walker(1, 0.1 + travel, 0.25, { vx: 0.032, speed: 0.032 }),
      walker(2, 0.1 + travel, 0.75, { vx: 0.032, speed: 0.032 }),
    ];
  });

  // Opposite headings, well apart: the negative for mirroring.
  add('two-walking-apart', 200, (frame) => {
    const travel = frame * 0.004;
    return [
      walker(1, 0.45 - travel, 0.3, { vx: -0.032, speed: 0.032 }),
      walker(2, 0.55 + travel, 0.7, { vx: 0.032, speed: 0.032 }),
    ];
  });

  // A loop out and back: five minutes of walking a circle and stopping where
  // it began. The path has to be old enough and the excursion wide enough.
  add('someone-coming-back', 2_400, (frame) => {
    // Two and a half minutes out around a wide arc, then home and stay there.
    const around = Math.min(frame, 1_200) / 1_200;
    const angle = around * Math.PI * 2;
    return [walker(1, 0.5 + 0.22 * Math.cos(angle), 0.5 + 0.22 * Math.sin(angle), {
      vx: 0.02,
      speed: frame < 1_200 ? 0.02 : 0,
    })];
  });

  // Six people milling: every pair detector runs on fifteen pairs a frame,
  // which is both the worst case for the boundary's cost and the case where a
  // tie between two visitors on one frame is decided by the cooldown.
  add('a-crowd', 1_200, (frame) => Array.from({ length: 6 }, (_, person) => {
    const phase = frame * 0.03 + person;
    return walker(person, 0.2 + 0.25 * Math.cos(phase) + person * 0.08,
      0.5 + 0.2 * Math.sin(phase * 0.7), {
        width: 0.1 + 0.03 * Math.sin(phase * 2),
        vx: -0.0075 * Math.sin(phase),
        vy: 0.0042 * Math.cos(phase * 0.7),
        speed: 0.05,
      });
  }));

  // Arrivals and departures over half an hour of virtual gallery time: nothing
  // may accumulate across the gaps, and the watcher must forget whoever left.
  add('an-hour-of-arrivals-and-departures', 14_400, (frame) => {
    const visitor = Math.floor(frame / 400);
    const inside = frame % 400 < 320;
    if (!inside) return [];
    const step = frame % 400;
    return [
      walker(visitor, 0.05 + step * 0.0028, 0.5, { vx: 0.0224, speed: 0.0224 }),
      walker(visitor + 1_000, 0.08 + Math.max(0, step - 10) * 0.0028, 0.5,
        { vx: 0.0224, speed: 0.0224 }),
    ];
  });

  // The warm-up boundary: history is recorded while sensing settles and
  // nothing is reported, and then the first stable frame is not starting cold.
  add('sensing-settling', 200, (frame) => [
    walker(1, 0.5, 0.45, { width: frame % 2 === 0 ? 0.10 : 0.17 }),
  ], 40);

  return built;
}

/** One frame's tracks, as each leg needs them. */
function tracksOf(frame: Frame, paths: Paths, spell: (id: number) => string): VisitorTrack[] {
  const present = new Set(frame.walkers.map((who) => who.id));
  paths.forget(present);
  return frame.walkers.map((who) => ({
    id: spell(who.id),
    bornAt: 0,
    lastSeen: frame.now,
    position: { x: who.x, y: who.y, t: frame.now },
    previous: { x: who.x, y: who.y, t: frame.now },
    velocity: { x: who.vx, y: who.vy },
    speed: who.speed,
    stillFor: 0,
    dwellSeconds: 5,
    path: paths.observe(who, frame.now),
    active: true,
    occluded: false,
    confidence: 1,
    sightings: 5,
    extent: { width: who.width, height: 0.26 },
  }));
}

/** The packed frame every Rust leg reads, built from one scenario frame. */
function packed(frame: Frame, paths: Paths): Float64Array {
  const observed: ObservedTrack[] = tracksOf(frame, paths, (id) => `t-${id}`).map((track) => ({
    id: track.id,
    x: track.position.x,
    y: track.position.y,
    width: track.extent.width,
    velocityX: track.velocity.x,
    velocityY: track.velocity.y,
    speed: track.speed,
    path: track.path,
  }));
  return encodeBehaviorFrame(frame.now, frame.stable, observed);
}

type Disagreement = {
  scenario: string;
  frame: number;
  what: string;
  typescript: string | number;
  rust: string | number;
};

/** A compact spelling of an event, for a disagreement a human has to read. */
const describe = (event: BehaviorEvent) =>
  `${event.kind}(${event.subjects.join(',')})@${event.at.x.toFixed(4)},${event.at.y.toFixed(4)}`;

const wasm = initSync({
  module: readFileSync(new URL('../public/wasm/room_wasm_bg.wasm', import.meta.url)),
});
const initialBytes = wasm.memory.buffer.byteLength;
const sessions = scenarios();
const found: Disagreement[] = [];
const noticed = new Map<BehaviorKind, number>(KINDS.map((kind) => [kind, 0]));
let worst = 0;
// Split three ways, because the headline figure for this subsystem is that
// Rust across the boundary is *slower* than the TypeScript, and a single
// number cannot say why. `encode` builds the frame, `step` is the
// wasm-bindgen call — the copy in, the detectors, the copy out — and `decode`
// reads the answer. The TypeScript leg does none of the first and third.
let encodeMs = 0;
let wasmMs = 0;
let decodeMs = 0;
let tsMs = 0;
let frames = 0;
let events = 0;
// What the copy actually costs is driven by how much path crosses, so the
// report carries that rather than leaving a reader to guess at it.
let pathPoints = 0;

for (const scenario of sessions) {
  const watcher = new BehaviorWatcher();
  const engine = new WasmBehaviorEngine();
  const tsPaths = new Paths();
  const rustPaths = new Paths();
  try {
    for (const [index, frame] of scenario.frames.entries()) {
      let start = performance.now();
      const left = watcher.update(tracksOf(frame, tsPaths, (id) => `t-${id}`), frame.now, frame.stable);
      tsMs += performance.now() - start;

      start = performance.now();
      const buffer = packed(frame, rustPaths);
      encodeMs += performance.now() - start;
      pathPoints += (buffer.length - 3 - frame.walkers.length * 8) / 3;

      start = performance.now();
      const out = engine.step(buffer);
      wasmMs += performance.now() - start;

      start = performance.now();
      const right = decodeBehaviorFrame(out).events;
      decodeMs += performance.now() - start;

      if (left.length !== right.length) {
        found.push({
          scenario: scenario.name,
          frame: index,
          what: 'event count',
          typescript: left.map(describe).join(' ') || 'nothing',
          rust: right.map(describe).join(' ') || 'nothing',
        });
      }
      for (const [at, mine] of left.entries()) {
        const theirs = right[at];
        if (!theirs) continue;
        if (mine.kind !== theirs.kind || mine.subjects.join(',') !== theirs.subjects.join(',')) {
          found.push({
            scenario: scenario.name,
            frame: index,
            what: `event[${at}]`,
            typescript: describe(mine),
            rust: describe(theirs),
          });
          continue;
        }
        for (const axis of ['x', 'y'] as const) {
          const delta = Math.abs(mine.at[axis] - theirs.at[axis]);
          worst = Math.max(worst, delta);
          if (delta > TOLERANCE) {
            found.push({
              scenario: scenario.name,
              frame: index,
              what: `event[${at}].at.${axis}`,
              typescript: mine.at[axis],
              rust: theirs.at[axis],
            });
          }
        }
      }
      for (const event of right) noticed.set(event.kind, (noticed.get(event.kind) ?? 0) + 1);
      events += right.length;
      frames += 1;
    }
  } finally {
    engine.free();
  }
}

// Exercise the adapter the live React shell uses, with real WASM, rather than
// only the standalone decoder. Two things live only in that adapter and in
// nothing above: the shell's spelling of a track id against the engine's, and
// the per-frame comparison that retires WASM. A scenario that agrees here
// agrees as the gallery runs it, which is a different claim from agreeing as
// the harness calls it.
//
// The runtime retires WASM on any disagreement, so its label is the assertion:
// there is no way for it to fall back quietly and still look like a pass.
let liveEvents = 0;
for (const scenario of sessions) {
  const runtime = new BehaviorRuntime(new WasmBehaviorEngine());
  const paths = new Paths();
  try {
    for (const frame of scenario.frames) {
      // The shell spells a track `visitor-<birth in base 36>-<sequence>`; the
      // scenarios are written in the engine's own `t-<sequence>`. Translating
      // here is what puts the adapter's own translation under test.
      const tracks = tracksOf(frame, paths, (id) => `visitor-abc-${id}`);
      liveEvents += runtime.update(tracks, frame.now, frame.stable).length;
      assert.match(runtime.label, /^Rust\/WASM/,
        `${scenario.name}: the live adapter fell back — ${runtime.label}`);
    }
    runtime.reset();
    runtime.update([], scenario.frames[scenario.frames.length - 1].now);
    assert.match(runtime.label, /^Rust\/WASM/, 'a reset must keep both engines aligned');
  } finally {
    runtime.dispose();
  }
}
assert.equal(liveEvents, events,
  `the live adapter noticed ${liveEvents} things where the harness noticed ${events}`);

// The native leg. Same Rust, different target, and this is the subsystem with
// the most room to differ between them: `hypot` and `signum` on every frame,
// thresholded into a yes or a no. A divergence here is a finding about the
// toolchain, not about the artwork — and it would be a finding worth having.
const workspace = mkdtempSync(join(tmpdir(), 'behavior-parity-'));
let nativeWorst = 0;
try {
  const file = join(workspace, 'scenarios.bin');
  writeFileSync(file, encodeScenarios(sessions));
  const native = spawnSync(
    'cargo',
    ['run', '--locked', '--quiet', '--release', '-p', 'room-engine',
      '--example', 'behavior-parity', '--', file],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  assert.equal(native.status, 0, native.stderr);
  const reported = JSON.parse(native.stdout) as Array<{ name: string; frames: number[][] }>;
  assert.equal(reported.length, sessions.length);

  for (const [index, scenario] of sessions.entries()) {
    const engine = new WasmBehaviorEngine();
    const paths = new Paths();
    try {
      for (const [frame, step] of scenario.frames.entries()) {
        const produced = [...engine.step(packed(step, paths))];
        const expected = reported[index].frames[frame];
        assert.equal(produced.length, expected.length,
          `${scenario.name} frame ${frame}: native reported ${expected.length} values, `
          + `wasm ${produced.length}`);
        for (let value = 0; value < produced.length; value += 1) {
          const delta = Math.abs(produced[value] - expected[value]);
          nativeWorst = Math.max(nativeWorst, delta);
          if (delta > TOLERANCE) {
            found.push({
              scenario: `${scenario.name} (native vs wasm)`,
              frame,
              what: `value[${value}]`,
              typescript: expected[value],
              rust: produced[value],
            });
          }
        }
      }
    } finally {
      engine.free();
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

/**
 * Write the scenarios as raw little-endian values.
 *
 * `ROOMBEH1`, a scenario count, then per scenario a length-prefixed name, a
 * frame count, and per frame a length-prefixed run of the packed engine frame.
 * The reader in `examples/behavior-parity.rs` checks every read and refuses a
 * file with trailing bytes, so a layout change here fails loudly instead of
 * decoding as a different session.
 */
function encodeScenarios(built: Scenario[]): Buffer {
  const parts: Buffer[] = [Buffer.from(SCENARIO_MAGIC, 'ascii'), u32(built.length)];
  for (const scenario of built) {
    const name = Buffer.from(scenario.name, 'utf8');
    parts.push(u32(name.length), name, u32(scenario.frames.length));
    const paths = new Paths();
    for (const frame of scenario.frames) {
      const frameValues = packed(frame, paths);
      const values = Buffer.alloc(4 + frameValues.length * 8);
      values.writeUInt32LE(frameValues.length, 0);
      for (const [index, value] of frameValues.entries()) {
        values.writeDoubleLE(value, 4 + index * 8);
      }
      parts.push(values);
    }
  }
  return Buffer.concat(parts);
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

const silent = KINDS.filter((kind) => (noticed.get(kind) ?? 0) === 0);
const report = {
  scenarios: sessions.map((scenario) => ({ name: scenario.name, frames: scenario.frames.length })),
  frames,
  events,
  /** Times each detector actually fired. A zero here makes the run worthless. */
  noticed: Object.fromEntries(noticed),
  /** Events reached through the adapter the shell actually runs. */
  liveAdapterEvents: liveEvents,
  tolerance: TOLERANCE,
  worstTypescriptVsWasm: worst,
  worstNativeVsWasm: nativeWorst,
  disagreements: found.slice(0, 20),
  disagreementCount: found.length,
  /**
   * Where a frame's time goes. The TypeScript leg reads the tracks it was
   * handed; the Rust leg has to have them packed, copied in, and copied back.
   */
  encodeMsPerFrame: encodeMs / frames,
  wasmMsPerFrameIncludingCopies: wasmMs / frames,
  decodeMsPerFrame: decodeMs / frames,
  rustTotalMsPerFrame: (encodeMs + wasmMs + decodeMs) / frames,
  typescriptMsPerFrame: tsMs / frames,
  /** Path points crossing per frame, which is what the copy above is made of. */
  pathPointsPerFrame: pathPoints / frames,
  wasmInitialBytes: initialBytes,
  wasmFinalBytes: wasm.memory.buffer.byteLength,
};
mkdirSync('reports/v2', { recursive: true });
writeFileSync('reports/v2/behavior-parity.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(report);
assert.equal(found.length, 0, `${found.length} disagreements; see reports/v2/behavior-parity.json`);
assert.deepEqual(silent, [],
  `${silent.join(', ')} never fired; a run that noticed nothing agrees trivially`);
assert.ok(
  wasm.memory.buffer.byteLength - initialBytes <= 8 * 1024 * 1024,
  'the behaviour engine must not grow the WASM heap across a session',
);
