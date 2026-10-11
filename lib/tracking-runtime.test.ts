import assert from 'node:assert/strict';
import test from 'node:test';
import { AnonymousTrackManager } from './motion-tracker';
import { TrackingRuntime, startTracking, mountTracking, type WasmTracker } from './tracking-runtime.ts';
import type { MotionBlob, VisitorTrack } from './room-types';

const body = (x = 0.4): MotionBlob => ({ x, y: 0.5, width: 0.1, height: 0.2, energy: 0.6 });
function pack(t: VisitorTrack): number[] {
  return [Number(t.id.split('-').at(-1)), t.bornAt, t.lastSeen, t.position.x, t.position.y, t.position.t,
    t.previous.x, t.previous.y, t.previous.t, t.velocity.x, t.velocity.y, t.speed,
    t.stillFor, t.dwellSeconds, Number(t.active), Number(t.occluded), t.confidence,
    t.sightings, t.extent.width, t.extent.height, t.path.length,
    ...t.path.flatMap((p) => [p.x, p.y, p.t])];
}
function double() {
  const manager = new AnonymousTrackManager();
  let freed = 0;
  let steps = 0;
  const engine: WasmTracker = {
    step(input, now) {
      steps++;
      const blobs: MotionBlob[] = [];
      for (let i = 0; i < input.length; i += 5) {
        blobs.push({ x: input[i], y: input[i + 1], width: input[i + 2], height: input[i + 3], energy: input[i + 4] });
      }
      const { active, ended } = manager.update(blobs, now);
      return Float64Array.from([active.length, ended.length, manager.getFragmentRecoveries(),
        ...active.flatMap(pack), ...ended.flatMap(pack)]);
    },
    clear: () => manager.clear(),
    free: () => { freed++; },
  };
  return { engine, freed: () => freed, steps: () => steps };
}

void test('opting out with ?tracking=ts needs no WASM, and reset keeps the id sequence', async () => {
  const runtime = await startTracking('?tracking=ts', () => { throw new Error('must not load'); });
  assert.equal(runtime.label, 'TypeScript tracking');
  const first = runtime.update([body()], 0).active[0].id;
  runtime.clear();
  assert.notEqual(runtime.update([body()], 100).active[0].id, first);
  assert.equal(runtime.getFragmentRecoveries(), 0);
  runtime.dispose();
  runtime.dispose();
  assert.throws(() => runtime.update([], 200), /disposed/);
});

void test('WASM drives snapshots; a trap falls back with the whole live history', async () => {
  const fake = double();
  const runtime = await startTracking('?tracking=wasm', async () => fake.engine);
  assert.match(runtime.label, /^Rust\/WASM/);
  const first = runtime.update([body()], 0).active[0];
  const second = runtime.update([body(0.42)], 100).active[0];
  assert.notEqual(first, second, 'WASM results are owned snapshots');
  assert.equal(first.position.x, 0.4);
  assert.equal(second.sightings, 2);
  fake.engine.step = () => { throw new Error('private observation must not reach diagnostics'); };
  const recovered = runtime.update([body(0.44)], 200).active[0];
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.sightings, 3);
  assert.equal(recovered.bornAt, 0);
  assert.equal(recovered.path.length, 3);
  assert.match(runtime.label, /failed or diverged/);
  assert.doesNotMatch(runtime.label, /private observation/);
  assert.equal(fake.freed(), 1);
  runtime.update([body(0.46)], 300);
  assert.equal(fake.steps(), 2);
  runtime.dispose();
  assert.equal(fake.freed(), 1);
});

void test('malformed and divergent frames retire WASM before they reach the artwork', () => {
  for (const corrupt of [
    (frame: Float64Array) => { frame[6] += 0.1; return frame; },
    (frame: Float64Array) => { frame[6] = NaN; return frame; },
    (frame: Float64Array) => { frame[2] = 1; return frame; },
    (frame: Float64Array) => { frame[20] += 1e-7; return frame; },
    () => new Float64Array([0, 0, 0]),
    () => new Float64Array([1]),
    (frame: Float64Array) => { frame[3] = 99; return frame; },
    (frame: Float64Array) => { frame[17] = 0; return frame; },
  ]) {
    const fake = double();
    const original = fake.engine.step.bind(fake.engine);
    fake.engine.step = (input, now) => corrupt(original(input, now));
    const runtime = new TrackingRuntime(fake.engine);
    assert.equal(runtime.update([body()], 0).active[0].position.x, 0.4);
    assert.match(runtime.label, /failed or diverged/);
    assert.equal(fake.freed(), 1);
  }
});

void test('reset and ended tracks agree; disposal frees the native allocation once', () => {
  const fake = double();
  const runtime = new TrackingRuntime(fake.engine);
  const id = runtime.update([body()], 0).active[0].id;
  assert.equal(runtime.update([], 4100).ended[0].id, id);
  runtime.clear();
  assert.notEqual(runtime.update([body()], 0).active[0].id, id);
  assert.match(runtime.label, /^Rust/);
  runtime.dispose();
  runtime.dispose();
  assert.equal(fake.freed(), 1);
});

void test('reset and destructor failures still release ownership and preserve TS operation', () => {
  const fake = double();
  fake.engine.clear = () => { throw new Error('reset'); };
  fake.engine.free = () => { throw new Error('free'); };
  const runtime = new TrackingRuntime(fake.engine);
  runtime.update([body()], 0);
  runtime.clear();
  assert.match(runtime.label, /reset failed/);
  assert.equal(runtime.update([body()], 10).active[0].sightings, 1);
  runtime.dispose();
});

void test('missing, synchronously failed and slow builds fall back; late allocations are freed', async () => {
  for (const load of [() => { throw new Error('sync'); }, async () => { throw new Error('missing'); }]) {
    const runtime = await startTracking('?tracking=wasm', load);
    assert.match(runtime.label, /WASM unavailable/);
    assert.equal(runtime.update([body()], 0).active.length, 1);
  }
  const fake = double();
  let complete!: (engine: WasmTracker) => void;
  const pending = new Promise<WasmTracker>((resolve) => { complete = resolve; });
  const runtime = await startTracking('?tracking=wasm', () => pending, 1);
  assert.match(runtime.label, /WASM unavailable/);
  complete(fake.engine);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fake.freed(), 1);
  assert.equal(runtime.update([body()], 0).active.length, 1);
});


void test('mount owns both completed and still-pending startup', async () => {
  for (const finishBeforeUnmount of [true, false]) {
    const fake = double();
    const runtime = new TrackingRuntime(fake.engine);
    let complete!: (runtime: TrackingRuntime) => void;
    const pending = new Promise<TrackingRuntime>((resolve) => { complete = resolve; });
    const attached: Array<TrackingRuntime | null> = [];
    const stop = mountTracking('?tracking=wasm', (value) => attached.push(value), (search) => {
      assert.equal(search, '?tracking=wasm');
      return pending;
    });
    if (finishBeforeUnmount) {
      complete(runtime);
      await Promise.resolve();
      assert.deepEqual(attached, [runtime]);
    }
    stop();
    if (!finishBeforeUnmount) { complete(runtime); await Promise.resolve(); }
    assert.equal(attached.at(-1), null);
    assert.equal(attached.filter(Boolean).length, Number(finishBeforeUnmount));
    assert.equal(fake.freed(), 1);
  }
});

void test('the default mount attempts WASM, verified against a live TS companion', async () => {
  const fake = double();
  const attached: Array<TrackingRuntime | null> = [];
  const stop = mountTracking('', (runtime) => attached.push(runtime), (search) => startTracking(search, async () => fake.engine));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attached.length, 1);
  assert.match(attached[0]!.label, /^Rust\/WASM/);
  const runtime = attached[0]!;
  assert.equal(runtime.update([body()], 0).active.length, 1);
  stop();
  assert.throws(() => runtime.update([], 100), /disposed/);
  assert.equal(attached.at(-1), null);
});

void test('an unrecognized tracking value still attempts WASM; only ?tracking=ts opts out', async () => {
  const runtime = await startTracking('?tracking=unknown', () => { throw new Error('no WASM build in this test'); });
  assert.match(runtime.label, /WASM unavailable/);
});

void test('?tracking=ts opts a mount out of WASM entirely', async () => {
  const attached: Array<TrackingRuntime | null> = [];
  const stop = mountTracking('?tracking=ts', (runtime) => attached.push(runtime), (search) => { assert.equal(search, '?tracking=ts'); return startTracking(search, () => { throw new Error('must not load'); }); });
  await Promise.resolve();
  assert.equal(attached.length, 1);
  assert.equal(attached[0]?.label, 'TypeScript tracking');
  stop();
});
