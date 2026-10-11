import assert from 'node:assert/strict';
import test from 'node:test';
import { CountedRate, FRAME_BUDGET_MS, RateMeter, RenderLoad } from './rate-meter.ts';

void test('a rate is counted over elapsed time, not averaged from reciprocals', () => {
  // The defect this class exists to remove. Fifty-nine 16 ms frames and one
  // 200 ms stall took 1.144 s to present sixty frames, so the room ran at 52 Hz;
  // the mean of instantaneous reciprocals calls it 61 Hz, which is above the
  // rate of the fastest frame window that actually occurred.
  const meter = new RateMeter(60);
  for (let index = 0; index < 59; index += 1) meter.add(16);
  meter.add(200);
  const elapsedSeconds = (59 * 16 + 200) / 1000;
  assert.ok(Math.abs(meter.hz - 60 / elapsedSeconds) < 1e-9);
  const reciprocalMean = (59 * (1000 / 16) + 1000 / 200) / 60;
  assert.ok(reciprocalMean - meter.hz > 8, 'the old arithmetic hid most of the stall');
});

void test('a counted rate can never flatter a run of frames', () => {
  // The general property, not just the one stall above: the harmonic-correct
  // rate is bounded by the mean of reciprocals for every set of intervals.
  const gaps = [8, 12, 16, 16, 33, 50, 120, 400];
  const meter = new RateMeter(gaps.length);
  for (const gap of gaps) meter.add(gap);
  const reciprocalMean = gaps.reduce((sum, gap) => sum + 1000 / gap, 0) / gaps.length;
  assert.ok(meter.hz <= reciprocalMean);
});

void test('even frames report the rate they were delivered at', () => {
  const meter = new RateMeter(45);
  for (let index = 0; index < 45; index += 1) meter.add(1000 / 24);
  assert.ok(Math.abs(meter.hz - 24) < 1e-9);
});

void test('an empty window is zero rather than a division by nothing', () => {
  const meter = new RateMeter(10);
  assert.equal(meter.hz, 0);
  assert.equal(meter.size, 0);
});

void test('a clock that does not advance is not a sample', () => {
  // A zero or backwards gap divides by an elapsed time smaller than the work
  // being measured, and reports an infinite rate for a loop that is stalled.
  const meter = new RateMeter(10);
  for (const gap of [0, -5, Number.NaN]) meter.add(gap);
  assert.equal(meter.size, 0);
  assert.equal(meter.hz, 0);
});

void test('the window forgets, so recovery is visible while it is happening', () => {
  const meter = new RateMeter(4);
  for (let index = 0; index < 4; index += 1) meter.add(500);
  assert.ok(Math.abs(meter.hz - 2) < 1e-9);
  for (let index = 0; index < 4; index += 1) meter.add(20);
  assert.equal(meter.size, 4);
  assert.ok(Math.abs(meter.hz - 50) < 1e-9, 'the stall must age out of the window');
});

void test('resetting empties the window rather than holding a stale rate', () => {
  const meter = new RateMeter(5);
  meter.add(16);
  meter.reset();
  assert.equal(meter.hz, 0);
});

void test('a loop that has stopped reports zero, not its last healthy number', () => {
  // The one failure the heartbeat exists to catch. A frozen render loop leaves
  // its last good average sitting in status forever; counting frames against
  // the watcher's own clock makes it read as dead.
  const presented = new CountedRate(0, 0);
  assert.ok(Math.abs(presented.sample(60, 1000) - 60) < 1e-9);
  assert.equal(presented.sample(60, 6000), 0, 'no new frames is zero frames a second');
});

void test('two beats at the same instant cannot report an infinite rate', () => {
  const presented = new CountedRate(0, 1000);
  assert.equal(presented.sample(10, 1000), 0);
});

void test('render load is a smoothed share of the frame budget', () => {
  const load = new RenderLoad();
  let percent = 0;
  for (let index = 0; index < 200; index += 1) percent = load.add(FRAME_BUDGET_MS / 2);
  assert.ok(Math.abs(percent - 50) < 1, `half a budget should settle near 50%, got ${percent}`);
});

void test('one expensive frame is not a machine that cannot keep up', () => {
  // An operator watching the instrument has to be able to tell a memory-field
  // repaint from a projector that is falling behind.
  const load = new RenderLoad();
  for (let index = 0; index < 100; index += 1) load.add(1);
  const settled = load.percent;
  const spike = load.add(FRAME_BUDGET_MS * 4);
  assert.ok(spike < settled + 45, 'a single spike must not saturate the reading');
});

void test('the reading is capped where it stops being a measurement', () => {
  const load = new RenderLoad();
  for (let index = 0; index < 500; index += 1) load.add(FRAME_BUDGET_MS * 30);
  assert.equal(load.percent, 100);
});
