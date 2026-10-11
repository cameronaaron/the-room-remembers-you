import assert from 'node:assert/strict';
import test from 'node:test';
import { GallerySimulation, HARDWARE_PROFILES } from './simulation.ts';
import type { HardwareProfile } from './room-types.ts';

/**
 * Synthetic gallery traffic.
 *
 * The operator console can run this at 60x or 720x real time, and the burn-in
 * gate runs twelve virtual hours of it before every release. Both uses depend
 * on it being deterministic and on its bodies being inside the room, so a
 * defect here shows up as a release gate that measures a different room each
 * time it runs.
 */

const PROFILES: HardwareProfile[] = ['CHEAP', 'STANDARD', 'FULL'];

void test('the same seed replays the same gallery day', () => {
  // The burn-in asserts numerical bounds against this traffic. If it drifted,
  // a failing gate would not distinguish a regression from a different day.
  const first = new GallerySimulation(0xdecafbad);
  const second = new GallerySimulation(0xdecafbad);
  first.reset(0);
  second.reset(0);
  for (let second_ = 0; second_ < 400; second_ += 1) {
    const clock = second_ * 1000;
    assert.deepEqual(first.sample(clock, 60, 'FULL'), second.sample(clock, 60, 'FULL'));
  }
});

void test('different seeds produce different days', () => {
  const a = new GallerySimulation(1);
  const b = new GallerySimulation(2);
  a.reset(0);
  b.reset(0);
  let differences = 0;
  for (let step = 0; step < 200; step += 1) {
    const clock = step * 1000;
    if (JSON.stringify(a.sample(clock, 60, 'FULL')) !== JSON.stringify(b.sample(clock, 60, 'FULL'))) {
      differences += 1;
    }
  }
  assert.ok(differences > 100, `only ${differences} of 200 samples differed`);
});

void test('a simulation that is switched off produces nobody', () => {
  const simulation = new GallerySimulation();
  simulation.reset(0);
  assert.deepEqual(simulation.sample(10_000, 0, 'FULL'), []);
});

void test('every simulated body is inside the room', () => {
  // These blobs are fed to the same tracker and memory field real sensing
  // feeds. A coordinate outside the unit square would deposit memory off the
  // edge of the field and silently distort the burn-in's density figure.
  const simulation = new GallerySimulation(0x51f15e);
  simulation.reset(0);
  for (let step = 0; step < 3000; step += 1) {
    for (const blob of simulation.sample(step * 100, 720, 'FULL')) {
      assert.ok(blob.x >= 0.03 && blob.x <= 0.97, `x escaped the room: ${blob.x}`);
      assert.ok(blob.y >= 0.05 && blob.y <= 0.95, `y escaped the room: ${blob.y}`);
      assert.ok(blob.width > 0 && blob.height > 0);
      assert.ok(blob.energy > 0 && blob.energy <= 1, `energy out of range: ${blob.energy}`);
    }
  }
});

void test('a profile is never asked to hold more bodies than it declares', () => {
  for (const profile of PROFILES) {
    const simulation = new GallerySimulation(0xabcdef);
    simulation.reset(0);
    let peak = 0;
    for (let step = 0; step < 4000; step += 1) {
      peak = Math.max(peak, simulation.sample(step * 100, 720, profile).length);
    }
    assert.ok(
      peak <= HARDWARE_PROFILES[profile].maxBodies,
      `${profile} produced ${peak} bodies against a declared ${HARDWARE_PROFILES[profile].maxBodies}`,
    );
    assert.ok(peak > 1, `${profile} never filled up, so its capacity is untested`);
  }
});

void test('the room both empties out and fills up over a simulated day', () => {
  // A simulation that sat at one occupancy would exercise none of the room's
  // states: no lonely stretch, no crowd, no personality change.
  const simulation = new GallerySimulation(0xdecafbad);
  simulation.reset(0);
  const counts = new Set<number>();
  for (let step = 0; step < 6000; step += 1) {
    counts.add(simulation.sample(step * 100, 720, 'FULL').length);
  }
  assert.ok(counts.size >= 4, `occupancy only took ${counts.size} distinct values`);
  assert.ok(Math.min(...counts) <= 2 && Math.max(...counts) >= 8);
});

void test('visitors cluster, which is what the crowd behaviours need', () => {
  // The cluster phase pulls bodies toward the middle of the room. Without it
  // convergence, approach and together would never fire under simulation.
  const simulation = new GallerySimulation(0x51f15e);
  simulation.reset(0);
  let tightest = Number.POSITIVE_INFINITY;
  for (let step = 0; step < 4000; step += 1) {
    const blobs = simulation.sample(step * 100, 720, 'FULL');
    if (blobs.length < 2) continue;
    const spread = Math.max(...blobs.map((b) => b.x)) - Math.min(...blobs.map((b) => b.x));
    tightest = Math.min(tightest, spread);
  }
  assert.ok(tightest < 0.3, `bodies never gathered: tightest spread was ${tightest}`);
});

void test('the first sample starts the clock rather than reporting a huge elapsed time', () => {
  // `sample` is called without `reset` when the operator raises the rate
  // mid-session. Taking realNow as elapsed would jump the simulation hours
  // forward on its first frame.
  const simulation = new GallerySimulation(7);
  const started = simulation.sample(9_999_999, 60, 'FULL');
  assert.ok(started.length >= 1);
  assert.deepEqual(started, simulation.sample(9_999_999, 60, 'FULL'));
});

void test('each profile declares a faster sensing cadence than the one below it', () => {
  assert.ok(HARDWARE_PROFILES.FULL.analysisIntervalMs < HARDWARE_PROFILES.STANDARD.analysisIntervalMs);
  assert.ok(HARDWARE_PROFILES.STANDARD.analysisIntervalMs < HARDWARE_PROFILES.CHEAP.analysisIntervalMs);
  assert.ok(HARDWARE_PROFILES.FULL.maxBodies > HARDWARE_PROFILES.CHEAP.maxBodies);
});
