/**
 * Cross-implementation parity for anonymous tracking.
 *
 * Three runtimes hold the same association rules: `AnonymousTrackManager` in
 * TypeScript, `room_engine::tracking` compiled natively, and the same Rust
 * compiled to WASM. This feeds identical synthetic sessions to all three and
 * reports where they disagree.
 *
 * What it is *not*: proof that the Rust tracker is correct. It is proof that it
 * does what the implementation the gallery has been running does. The
 * TypeScript is the behavioural specification; every constant in it came from a
 * measured failure in a real room, and the gate here is that none of those
 * lessons was lost in translation.
 *
 * Tolerances are stated, not discovered. Floating-point agreement to the last
 * bit is not required and not meaningful across three `libm` implementations;
 * agreement to a millionth of a room, on numbers that decide what the artwork
 * does, is.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { initSync, WasmTrackEngine } from '../public/wasm/room_wasm.js';
import { TrackingRuntime } from '../lib/tracking-runtime.ts';
import { AnonymousTrackManager } from '../lib/motion-tracker.ts';
import { decodeTrackFrame, encodeBlobs } from '../lib/track-bridge.ts';
import type { MotionBlob, VisitorTrack } from '../lib/room-types.ts';

/**
 * Absolute agreement required on a room coordinate, a speed, a dwell time or a
 * confidence.
 *
 * A millionth of the room is about a thousandth of a body width; nothing in the
 * artwork can express a difference that small. Chosen before the run rather
 * than rounded up to whatever the run produced — if the measured error ever
 * approaches this, that is a finding, not a reason to move the number.
 */
const TOLERANCE = 1e-6;

/**
 * Magic of the scenario file handed to the native leg.
 *
 * It is raw little-endian `f64` rather than JSON, and that is a measurement
 * rather than a preference. `serde_json` 1.0.151 does not always parse a
 * seventeen-digit decimal to the nearest `f64` — `0.20400000000000001` comes
 * back one unit in the last place low — so every coordinate `JSON.stringify`
 * wrote was arriving at the native engine as a slightly different session, and
 * the gate reported sixty-nine disagreements that belonged entirely to its own
 * transport. Results come back as JSON, which is safe in that direction:
 * `ryu`'s shortest form round trips through V8's correctly-rounded parser.
 */
const SCENARIO_MAGIC = 'ROOMSCN1';

/** Sensing interval used by the scenarios, roughly the STANDARD profile. */
const FRAME_MS = 50;

type Frame = { now: number; blobs: number[] };
type Scenario = { name: string; frames: Frame[] };

/**
 * A seeded xorshift, so a scenario is the same session every time it runs.
 *
 * `Math.random()` here would make a parity failure unreproducible, which is the
 * one thing a parity report has to be.
 */
function noise(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const body = (x: number, y: number, width = 0.09, height = 0.24, energy = 0.6): MotionBlob =>
  ({ x, y, width, height, energy });

/** Clamp into the room, because the engine refuses anything outside it. */
const inRoom = (value: number) => Math.min(1, Math.max(0, value));

function scenarios(): Scenario[] {
  const built: Scenario[] = [];
  const add = (name: string, frames: number, blobsAt: (frame: number) => MotionBlob[]) => {
    built.push({
      name,
      frames: Array.from({ length: frames }, (_, frame) => ({
        now: frame * FRAME_MS,
        blobs: [...encodeBlobs(blobsAt(frame))],
      })),
    });
  };

  // One visitor crossing the room. The baseline: if this disagrees, nothing
  // below is worth reading.
  add('single-walk', 240, (frame) => [body(inRoom(0.08 + frame * 0.0035), 0.5)]);

  // Two visitors walking through each other. The case where greedy association
  // can hand the wrong identity to the wrong person, and where the two
  // implementations' sort stability has to match.
  add('crossing', 240, (frame) => [
    body(inRoom(0.1 + frame * 0.003), 0.5),
    body(inRoom(0.9 - frame * 0.003), 0.52),
  ]);

  // Someone walks behind a pillar for a second and a half, then comes out the
  // other side. Exercises prediction, the widening gate and reacquisition.
  add('occlusion', 300, (frame) => {
    const hidden = frame >= 80 && frame < 110;
    if (hidden) return [];
    return [body(inRoom(0.2 + frame * 0.002), 0.5)];
  });

  // A visitor whose coat matches the wall: the torso drops out and the body
  // arrives as a head and a pair of legs inside its own previous outline.
  add('fragmenting', 300, (frame) => {
    const x = inRoom(0.3 + Math.sin(frame * 0.02) * 0.15);
    if (frame % 7 < 3) return [body(x, 0.5, 0.1, 0.3, 0.7)];
    return [body(x, 0.41, 0.07, 0.09, 0.3), body(x, 0.59, 0.08, 0.1, 0.3)];
  });

  // One nearly-still visitor registering as disconnected scraps. The session
  // that reported two or more people in 44 of 307 samples.
  add('still-scraps', 300, (frame) => {
    const jitter = Math.sin(frame * 0.31) * 0.004;
    return [
      body(0.5 + jitter, 0.46 + jitter, 0.04, 0.04, 0.3),
      body(0.53 - jitter, 0.52, 0.05, 0.05, 0.3),
    ];
  });

  // Six visitors milling, at the sensing side's own plausibility cap.
  const milling = noise(0x51ce);
  add('crowd', 300, (frame) => Array.from({ length: 6 }, (_, person) => body(
    inRoom(0.1 + person * 0.14 + Math.sin(frame * 0.03 + person) * 0.05),
    inRoom(0.3 + Math.cos(frame * 0.02 + person * 2) * 0.15),
  )).concat(milling() < 0.05 ? [body(0.5, 0.8, 0.05, 0.06, 0.3)] : []));

  // Noisy detections with dropouts: the shape of a real camera in a dim room.
  const flicker = noise(0xbeef);
  add('flicker', 400, (frame) => {
    const people: MotionBlob[] = [];
    for (let person = 0; person < 3; person += 1) {
      if (flicker() < 0.15) continue;
      people.push(body(
        inRoom(0.2 + person * 0.25 + (flicker() - 0.5) * 0.02 + Math.sin(frame * 0.017 + person) * 0.08),
        inRoom(0.5 + (flicker() - 0.5) * 0.02),
        0.08 + flicker() * 0.03,
        0.22 + flicker() * 0.05,
      ));
    }
    return people;
  });

  // An empty gallery with brief appearances. Nothing may accumulate across the
  // gaps, and every arrival must be reported once.
  add('empty-with-visits', 400, (frame) => (
    frame % 100 < 20 ? [body(inRoom(0.3 + (frame % 100) * 0.01), 0.5)] : []
  ));

  return built;
}

type Reading = { name: string; value: number; exact: boolean };

/** The numbers a disagreement would actually change the artwork through. */
function readings(track: VisitorTrack): Reading[] {
  return [
    { name: 'x', value: track.position.x, exact: false },
    { name: 'y', value: track.position.y, exact: false },
    { name: 'speed', value: track.speed, exact: false },
    { name: 'stillFor', value: track.stillFor, exact: false },
    { name: 'dwellSeconds', value: track.dwellSeconds, exact: false },
    { name: 'confidence', value: track.confidence, exact: false },
    { name: 'velocityX', value: track.velocity.x, exact: false },
    { name: 'velocityY', value: track.velocity.y, exact: false },
    { name: 'sightings', value: track.sightings, exact: true },
    { name: 'occluded', value: track.occluded ? 1 : 0, exact: true },
    { name: 'active', value: track.active ? 1 : 0, exact: true },
    { name: 'pathLength', value: track.path.length, exact: true },
  ];
}

type Disagreement = { scenario: string; frame: number; what: string; typescript: number; rust: number };

function compare(
  scenario: string,
  frame: number,
  typescript: { active: VisitorTrack[]; ended: VisitorTrack[] },
  rust: { active: VisitorTrack[]; ended: VisitorTrack[] },
  found: Disagreement[],
  worst: { value: number },
) {
  const counts: Array<[string, number, number]> = [
    ['activeCount', typescript.active.length, rust.active.length],
    ['endedCount', typescript.ended.length, rust.ended.length],
  ];
  for (const [what, left, right] of counts) {
    if (left !== right) found.push({ scenario, frame, what, typescript: left, rust: right });
  }
  // Order is part of the contract: both implementations report tracks in the
  // order they acquired them, and coalescing resolves ties by that order. A
  // divergence here is a real difference even when the sets match.
  const pairs = Math.min(typescript.active.length, rust.active.length);
  for (let index = 0; index < pairs; index += 1) {
    const left = readings(typescript.active[index]);
    const right = readings(rust.active[index]);
    for (let field = 0; field < left.length; field += 1) {
      const delta = Math.abs(left[field].value - right[field].value);
      if (!left[field].exact) worst.value = Math.max(worst.value, delta);
      const failed = left[field].exact ? delta !== 0 : delta > TOLERANCE;
      if (failed) {
        found.push({
          scenario,
          frame,
          what: `track[${index}].${left[field].name}`,
          typescript: left[field].value,
          rust: right[field].value,
        });
      }
    }
  }
}

const wasm = initSync({ module: readFileSync(new URL('../public/wasm/room_wasm_bg.wasm', import.meta.url)) });
const initialBytes = wasm.memory.buffer.byteLength;
const sessions = scenarios();
const found: Disagreement[] = [];
const worst = { value: 0 };
let wasmMs = 0;
let tsMs = 0;
let frames = 0;

for (const scenario of sessions) {
  const typescript = new AnonymousTrackManager();
  const engine = new WasmTrackEngine();
  try {
    for (const [index, frame] of scenario.frames.entries()) {
      // Fresh objects each frame: the TypeScript tracker keys outlines by blob
      // identity, and reusing objects would quietly change what it does.
      const blobs: MotionBlob[] = [];
      for (let base = 0; base < frame.blobs.length; base += 5) {
        blobs.push({
          x: frame.blobs[base],
          y: frame.blobs[base + 1],
          width: frame.blobs[base + 2],
          height: frame.blobs[base + 3],
          energy: frame.blobs[base + 4],
        });
      }
      let start = performance.now();
      const left = typescript.update(blobs, frame.now);
      tsMs += performance.now() - start;

      start = performance.now();
      const buffer = engine.step(Float64Array.from(frame.blobs), frame.now);
      wasmMs += performance.now() - start;
      const right = decodeTrackFrame(buffer);

      compare(scenario.name, index, left, right, found, worst);
      if (typescript.getFragmentRecoveries() !== right.fragmentRecoveries) {
        found.push({
          scenario: scenario.name,
          frame: index,
          what: 'fragmentRecoveries',
          typescript: typescript.getFragmentRecoveries(),
          rust: right.fragmentRecoveries,
        });
      }
      frames += 1;
    }
  } finally {
    engine.free();
  }
}

// Exercise the adapter used by the live React shell with real WASM, not just
// the standalone decoder. In particular, Rust and TS spell track IDs differently.
for (const scenario of sessions) {
  const runtime = new TrackingRuntime(new WasmTrackEngine());
  try {
    for (const frame of scenario.frames) {
      const blobs: MotionBlob[] = [];
      for (let i = 0; i < frame.blobs.length; i += 5) {
        const b = frame.blobs;
        blobs.push({ x: b[i], y: b[i + 1], width: b[i + 2], height: b[i + 3], energy: b[i + 4] });
      }
      runtime.update(blobs, frame.now);
      assert.match(runtime.label, /^Rust\/WASM/, `${scenario.name}: live adapter fell back`);
    }
    runtime.clear();
    runtime.update([], 0);
    assert.match(runtime.label, /^Rust\/WASM/, 'reset must keep both engines aligned');
  } finally { runtime.dispose(); }
}

// The native leg. Same Rust, different target, different libm: "it is the same
// source" is not evidence that it is the same room.
const workspace = mkdtempSync(join(tmpdir(), 'tracking-parity-'));
let nativeWorst = 0;
try {
  const file = join(workspace, 'scenarios.bin');
  writeFileSync(file, encodeScenarios(sessions));
  const native = spawnSync(
    'cargo',
    ['run', '--locked', '--quiet', '--release', '-p', 'room-engine', '--example', 'tracking-parity', '--', file],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  assert.equal(native.status, 0, native.stderr);
  const reported = JSON.parse(native.stdout) as Array<{ name: string; frames: number[][] }>;
  assert.equal(reported.length, sessions.length);

  for (const [index, scenario] of sessions.entries()) {
    const engine = new WasmTrackEngine();
    try {
      for (const [frame, step] of scenario.frames.entries()) {
        const summary = summarise(engine.step(Float64Array.from(step.blobs), step.now));
        const expected = reported[index].frames[frame];
        assert.equal(summary.length, expected.length,
          `${scenario.name} frame ${frame}: native reported ${expected.length} values, wasm ${summary.length}`);
        for (let value = 0; value < summary.length; value += 1) {
          const delta = Math.abs(summary[value] - expected[value]);
          nativeWorst = Math.max(nativeWorst, delta);
          if (delta > TOLERANCE) {
            found.push({
              scenario: `${scenario.name} (native vs wasm)`,
              frame,
              what: `value[${value}]`,
              typescript: expected[value],
              rust: summary[value],
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
 * `ROOMSCN1`, a scenario count, then per scenario a length-prefixed name, a
 * frame count, and per frame a timestamp and a length-prefixed run of values.
 * The reader in `examples/tracking-parity.rs` checks every read and refuses a
 * file with trailing bytes, so a layout change here fails loudly instead of
 * decoding as a different session.
 */
function encodeScenarios(built: Scenario[]): Buffer {
  const parts: Buffer[] = [Buffer.from(SCENARIO_MAGIC, 'ascii'), u32(built.length)];
  for (const scenario of built) {
    const name = Buffer.from(scenario.name, 'utf8');
    parts.push(u32(name.length), name, u32(scenario.frames.length));
    for (const frame of scenario.frames) {
      const values = Buffer.alloc(8 + 4 + frame.blobs.length * 8);
      values.writeDoubleLE(frame.now, 0);
      values.writeUInt32LE(frame.blobs.length, 8);
      for (const [index, value] of frame.blobs.entries()) values.writeDoubleLE(value, 12 + index * 8);
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

/** The same reduction `examples/tracking-parity.rs` prints, over a WASM frame. */
function summarise(frame: Float64Array): number[] {
  const HEADER = 3;
  const RECORD = 21;
  // x, y, speed, stillFor, dwell, confidence, sightings, occluded, active, vx, vy
  const REPORTED = [3, 4, 11, 12, 13, 16, 17, 15, 14, 9, 10];
  const out = [frame[0], frame[1], frame[2]];
  let cursor = HEADER;
  for (let track = 0; track < frame[0]; track += 1) {
    for (const field of REPORTED) out.push(frame[cursor + field]);
    const length = frame[cursor + 20];
    out.push(length);
    cursor += RECORD + length * 3;
  }
  return out;
}

const report = {
  scenarios: sessions.map((scenario) => ({ name: scenario.name, frames: scenario.frames.length })),
  frames,
  tolerance: TOLERANCE,
  worstTypescriptVsWasm: worst.value,
  worstNativeVsWasm: nativeWorst,
  disagreements: found.slice(0, 20),
  disagreementCount: found.length,
  wasmMsPerFrameIncludingCopies: wasmMs / frames,
  typescriptMsPerFrame: tsMs / frames,
  wasmInitialBytes: initialBytes,
  wasmFinalBytes: wasm.memory.buffer.byteLength,
};
mkdirSync('reports/v2', { recursive: true });
writeFileSync('reports/v2/tracking-parity.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(report);
assert.equal(found.length, 0, `${found.length} disagreements; see reports/v2/tracking-parity.json`);
assert.ok(
  wasm.memory.buffer.byteLength - initialBytes <= 2 * 1024 * 1024,
  'the tracker must not grow the WASM heap across a session',
);
