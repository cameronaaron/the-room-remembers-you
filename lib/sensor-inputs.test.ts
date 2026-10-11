import assert from 'node:assert/strict';
import test from 'node:test';
import { describeSources, gatherBlobs, type SensorInput } from './sensor-inputs.ts';
import type { MotionBlob } from './room-types.ts';

const body = (x: number): MotionBlob => ({ x, y: 0.5, width: 0.08, height: 0.18, energy: 0.7 });

const nothing = (): SensorInput => ({
  camera: null,
  demo: { on: false, pointer: null },
  simulation: { rate: 0, blobs: [] },
  replay: null,
  maxBodies: 12,
});

void test('a room with nothing sensing says so rather than reading as empty', () => {
  // `source: none` on the instrument is how an operator tells a room that sees
  // nobody from a room that is not looking at all. They are different faults.
  const reading = gatherBlobs(nothing());
  assert.deepEqual(reading.blobs, []);
  assert.equal(describeSources(reading.sources), 'none');
});

void test('every live source contributes, and each is named', () => {
  const reading = gatherBlobs({
    ...nothing(),
    camera: [body(0.1)],
    demo: { on: true, pointer: body(0.2) },
    simulation: { rate: 60, blobs: [body(0.3)] },
  });
  assert.equal(reading.blobs.length, 3);
  assert.equal(describeSources(reading.sources), 'camera + demo + simulation');
});

void test('demo mode is named from the setting, not from whether anyone moved', () => {
  // A pointer at rest is still the reason the room is watching a pointer; an
  // operator who turned demo mode on must see it acknowledged.
  const reading = gatherBlobs({ ...nothing(), demo: { on: true, pointer: null } });
  assert.deepEqual(reading.blobs, []);
  assert.deepEqual(reading.sources, ['demo']);
});

void test('a replay is an account of a room that already happened', () => {
  // Mixing live bodies into it would make reproducing a defect depend on who
  // walked past the machine while it was being reproduced.
  const reading = gatherBlobs({
    ...nothing(),
    camera: [body(0.1)],
    demo: { on: true, pointer: body(0.2) },
    simulation: { rate: 720, blobs: [body(0.3)] },
    replay: [body(0.9)],
  });
  assert.deepEqual(reading.blobs, [body(0.9)]);
  assert.deepEqual(reading.sources, ['replay']);
});

void test('the hardware profile caps what any source can produce', () => {
  // Including a replay: a supplied file must not be able to make a CHEAP
  // machine consider more bodies than it can afford.
  const crowd = Array.from({ length: 40 }, (_unused, index) => body(index / 40));
  assert.equal(gatherBlobs({ ...nothing(), camera: crowd, maxBodies: 4 }).blobs.length, 4);
  assert.equal(gatherBlobs({ ...nothing(), replay: crowd, maxBodies: 4 }).blobs.length, 4);
});

void test('a simulation contributes bodies whether or not anything else did', () => {
  const alone = gatherBlobs({ ...nothing(), simulation: { rate: 60, blobs: [body(0.5)] } });
  assert.equal(alone.blobs.length, 1);
  const beside = gatherBlobs({
    ...nothing(),
    camera: [body(0.1)],
    simulation: { rate: 60, blobs: [body(0.5)] },
  });
  assert.equal(beside.blobs.length, 2);
});

void test('a rate of zero is not a running simulation even if it produced nothing', () => {
  const reading = gatherBlobs({ ...nothing(), simulation: { rate: 0, blobs: [] } });
  assert.deepEqual(reading.sources, []);
});

void test('the log separator is tighter than the instrument one', () => {
  // Both are read by people, but a session log is a column in a file rather
  // than a line on a screen.
  assert.equal(describeSources(['camera', 'demo'], '+'), 'camera+demo');
  assert.equal(describeSources([], '+'), 'none');
});
