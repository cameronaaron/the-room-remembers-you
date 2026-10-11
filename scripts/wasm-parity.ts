import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { initSync, WasmFieldEngine } from '../public/wasm/room_wasm.js';
import { createMemoryField, depositMemory, decayMemory, memoryDensity } from '../lib/memory-engine.ts';
import { FieldRuntime } from '../lib/field-runtime.ts';

const wasm = initSync({ module: readFileSync(new URL('../public/wasm/room_wasm_bg.wasm', import.meta.url)) });
const brain = new WasmFieldEngine();
const field = createMemoryField();
const deposits = new Float64Array([0, 0.5, 0.0018, 3.4]);
let maxError = 0;
let wasmMs = 0;
let tsMs = 0;
const initialBytes = wasm.memory.buffer.byteLength;
let snapshot: Float32Array<ArrayBufferLike> = new Float32Array(field.length);
try {
  for (let tick = 0; tick < 43_200; tick++) {
    deposits[0] = (tick % 100) / 100;
    let start = performance.now();
    snapshot = brain.step(deposits, 1, 120, 1);
    wasmMs += performance.now() - start;
    start = performance.now();
    depositMemory(field, { x: deposits[0], y: 0.5 }, 0.0018, 3.4);
    decayMemory(field, 1, 120, 1);
    tsMs += performance.now() - start;
    for (let i = 0; i < field.length; i++) maxError = Math.max(maxError, Math.abs(field[i] - snapshot[i]));
  }
  // f32 libm differences may differ by a final ULP; this is an absolute cell
  // density tolerance, not a percentage chosen from the measured result.
  assert.ok(maxError <= 1e-6, `field error ${maxError}`);
  assert.equal(Number(brain.tick()), 43_200);
  const native = spawnSync('cargo', ['run', '--locked', '--quiet', '--release', '-p', 'room-engine', '--example', 'parity'], { encoding: 'utf8' });
  assert.equal(native.status, 0, native.stderr);
  const expected = JSON.parse(native.stdout) as { field: number[]; tick: number };
  assert.equal(expected.tick, Number(brain.tick()));
  assert.ok(expected.field.every((v, i) => Math.abs(v - snapshot[i]) <= 1e-6));
  const kept = snapshot.slice();
  assert.throws(() => brain.step(new Float64Array([0.5, 0.5, 0.1, 2, NaN, 0, 0, 1]), 0, 120, 1));
  assert.deepEqual(brain.step(new Float64Array(), 0, 120, 1), kept);
  assert.throws(() => brain.restore(new Float32Array(1)));
  brain.restore(kept);
  brain.reset();
  assert.ok(brain.step(new Float64Array(), 0, 120, 1).every(v => v === 0));
  assert.deepEqual(snapshot, kept, 'returned arrays remain owned by JS after later calls');
  assert.ok(wasm.memory.buffer.byteLength - initialBytes <= 2 * 1024 * 1024);
  // The live adapter, against the same real WASM over the same twelve hours.
  //
  // The loop above proves the engine agrees with `memory-engine.ts`. It says
  // nothing about `FieldRuntime`, which is what the installation actually runs:
  // the batching, the deposit-then-decay ordering and the per-cell comparison
  // are all its own, and a fault in any of them retires WASM silently and
  // leaves the room on TypeScript for the rest of the day. So drive it and
  // require that it never fell back.
  let liveSteps = 0;
  // `FieldRuntime` owns every engine it is handed and frees it on retire, so
  // these are disposed rather than freed. Freeing one here as well threw a null
  // pointer out of the cleanup and buried the assertion that had just failed —
  // the harness reported a wasm-bindgen stack for a parity defect.
  const live = new FieldRuntime(undefined, new WasmFieldEngine());
  const overflowed = new FieldRuntime(undefined, new WasmFieldEngine());
  const ordered = new FieldRuntime(undefined, new WasmFieldEngine());
  try {
    assert.match(live.label, /^Rust\/WASM/, 'the adapter must start on WASM to be a test of it');
    for (let tick = 0; tick < 43_200; tick++) {
      live.deposit({ x: (tick % 100) / 100, y: 0.5 }, 0.0018, 3.4);
      live.decay(1, 120, 1);
      liveSteps += 1;
    }
    assert.match(
      live.label,
      /^Rust\/WASM/,
      `the live adapter fell back after ${liveSteps} steps: ${live.label}`,
    );
    // Same inputs as the standalone loop, so the same field. A run that agreed
    // with itself while diverging from the engine above would be an adapter
    // quietly running its own arithmetic.
    assert.ok(
      Math.abs(memoryDensity(live.values) - memoryDensity(field)) <= 1e-6,
      'the adapter and the engine must reach the same field',
    );
    // Ordering, on a decay steep enough to separate the two orders at once.
    //
    // At the room's real rate — one second against a 120-minute half-life — a
    // single step of deposit-then-decay differs from decay-then-deposit by
    // about 1.7e-7, under the 1e-6 tolerance. The long run above still catches
    // a reversed adapter, because the field is stateful and that error
    // compounds until it crosses, but it reports it as a fallback after 43,200
    // steps with no indication of which of the adapter's rules broke. A
    // one-minute half-life over thirty seconds separates the orders by 0.146,
    // so this fails immediately and names the rule. Verified by reversing the
    // adapter and watching both legs fail.
    ordered.deposit({ x: 0.5, y: 0.5 }, 0.5, 3);
    ordered.decay(30, 1, 1);
    assert.match(ordered.label, /^Rust\/WASM/, `deposits must be applied before decay: ${ordered.label}`);

    // A batch the engine refuses must retire the adapter rather than throw
    // through it: this is the path a gallery hits, not an exception.
    for (let extra = 0; extra <= 20; extra++) overflowed.deposit({ x: 0.5, y: 0.5 }, 0.001, 2);
    assert.match(overflowed.label, /^TypeScript/, 'an over-capacity batch must fall back, not throw');
  } finally {
    for (const runtime of [live, overflowed, ordered]) runtime.dispose();
  }

  const report = { virtualHours: 12, steps: 43_200, liveAdapterSteps: liveSteps, maxError, tolerance: 1e-6, wasmMsPerStepIncludingCopies: wasmMs / 43_200, tsMsPerStep: tsMs / 43_200, wasmInitialBytes: initialBytes, wasmFinalBytes: wasm.memory.buffer.byteLength, nativeParity: true };
  mkdirSync('reports/v2', { recursive: true });
  writeFileSync('reports/v2/wasm-parity.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(report);
} finally { brain.free(); }
