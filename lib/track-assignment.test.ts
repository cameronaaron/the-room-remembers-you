import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSIGNMENT_CEILING, assignTracks, type Assignment } from './track-assignment.ts';

const INF = Infinity;

function totalCost(costs: readonly (readonly number[])[], assignment: Assignment[]): number {
  return assignment.reduce((sum, { trackIndex, blobIndex }) => sum + costs[trackIndex][blobIndex], 0);
}

/** Old greedy strategy, kept here only to prove it starves a track the new one does not. */
function greedyAssign(costs: readonly (readonly number[])[]): Assignment[] {
  const candidates: Array<{ trackIndex: number; blobIndex: number; cost: number }> = [];
  for (let t = 0; t < costs.length; t++) {
    for (let b = 0; b < costs[t].length; b++) {
      if (Number.isFinite(costs[t][b])) candidates.push({ trackIndex: t, blobIndex: b, cost: costs[t][b] });
    }
  }
  candidates.sort((a, b) => a.cost - b.cost);
  const usedTracks = new Set<number>();
  const usedBlobs = new Set<number>();
  const result: Assignment[] = [];
  for (const { trackIndex, blobIndex } of candidates) {
    if (usedTracks.has(trackIndex) || usedBlobs.has(blobIndex)) continue;
    usedTracks.add(trackIndex);
    usedBlobs.add(blobIndex);
    result.push({ trackIndex, blobIndex });
  }
  return result;
}

/**
 * Exhaustive search for the true objective: the largest number of gated pairs
 * that can be matched simultaneously, and the lowest total distance among
 * matchings of that size. Used only to cross-check the Hungarian solver on
 * small cases — this is deliberately not the algorithm under test.
 */
function bruteForceOptimal(costs: readonly (readonly number[])[]): { size: number; cost: number } {
  const tracks = costs.length;
  const blobs = tracks > 0 ? costs[0].length : 0;
  let best = { size: 0, cost: 0 };
  const usedBlobs = Array.from({ length: blobs }, () => false);
  function search(trackIndex: number, size: number, cost: number) {
    if (trackIndex === tracks) {
      if (size > best.size || (size === best.size && cost < best.cost)) best = { size, cost };
      return;
    }
    search(trackIndex + 1, size, cost); // leave this track unmatched
    for (let b = 0; b < blobs; b++) {
      if (usedBlobs[b] || !Number.isFinite(costs[trackIndex][b])) continue;
      usedBlobs[b] = true;
      search(trackIndex + 1, size + 1, cost + costs[trackIndex][b]);
      usedBlobs[b] = false;
    }
  }
  search(0, 0, 0);
  return best;
}

void test('the starvation case: greedy leaves a gated track unmatched, assignment does not', () => {
  // Track 0 is gated to blobs 0 and 1; track 1 is gated to blob 0 only.
  // Greedy claims the globally-nearest pair first (track 0 x blob 0, cost 1),
  // which starves track 1 even though matching track 0 to blob 1 instead
  // (cost 2) leaves track 1 free to take blob 0 (cost 1) for a lower total.
  const costs = [
    [1, 2],
    [1, INF],
  ];
  const greedy = greedyAssign(costs);
  assert.equal(greedy.length, 1, 'greedy claims only one pair and starves track 1');

  const optimal = assignTracks(costs);
  assert.equal(optimal.length, 2, 'both tracks are matched');
  assert.deepEqual(
    [...optimal].sort((a, b) => a.trackIndex - b.trackIndex),
    [{ trackIndex: 0, blobIndex: 1 }, { trackIndex: 1, blobIndex: 0 }],
  );
  assert.equal(totalCost(costs, optimal), 3);
});

void test('an ungated pair never appears in the result, however cheap the alternative', () => {
  const costs = [[INF]];
  assert.deepEqual(assignTracks(costs), []);
});

void test('empty input matches nothing and does not throw', () => {
  assert.deepEqual(assignTracks([]), []);
  assert.deepEqual(assignTracks([[]]), []);
});

void test('a track or blob count past the ceiling is refused', () => {
  const tooManyTracks = Array.from({ length: ASSIGNMENT_CEILING + 1 }, () => [1]);
  assert.throws(() => assignTracks(tooManyTracks), RangeError);

  const tooManyBlobs = [Array.from({ length: ASSIGNMENT_CEILING + 1 }, () => 1)];
  assert.throws(() => assignTracks(tooManyBlobs), RangeError);
});

void test('exactly at the ceiling is accepted', () => {
  const square = Array.from({ length: ASSIGNMENT_CEILING }, (_, i) =>
    Array.from({ length: ASSIGNMENT_CEILING }, (_, j) => (i === j ? 0 : INF)));
  const result = assignTracks(square);
  assert.equal(result.length, ASSIGNMENT_CEILING);
  for (const { trackIndex, blobIndex } of result) assert.equal(trackIndex, blobIndex);
});

void test('the solver matches a brute-force optimum on random small gated matrices', () => {
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let trial = 0; trial < 200; trial++) {
    const tracks = 1 + Math.floor(rand() * 5);
    const blobs = 1 + Math.floor(rand() * 5);
    const costs = Array.from({ length: tracks }, () =>
      Array.from({ length: blobs }, () => (rand() < 0.35 ? INF : Math.round(rand() * 100) / 10)));
    const optimal = assignTracks(costs);
    // Every reported match must itself be gated (finite cost).
    for (const { trackIndex, blobIndex } of optimal) {
      assert.ok(Number.isFinite(costs[trackIndex][blobIndex]), `trial ${trial}: reported an ungated match`);
    }
    // No track or blob is used twice.
    assert.equal(new Set(optimal.map((m) => m.trackIndex)).size, optimal.length, `trial ${trial}: a track matched twice`);
    assert.equal(new Set(optimal.map((m) => m.blobIndex)).size, optimal.length, `trial ${trial}: a blob matched twice`);
    const expected = bruteForceOptimal(costs);
    assert.equal(optimal.length, expected.size, `trial ${trial}: wrong match count for ${JSON.stringify(costs)}`);
    assert.ok(
      Math.abs(totalCost(costs, optimal) - expected.cost) < 1e-9,
      `trial ${trial}: ${JSON.stringify(costs)}: got ${totalCost(costs, optimal)}, expected ${expected.cost}`,
    );
  }
});

void test('a worst-case 12x12 assignment costs a small fraction of the FULL-tier analysis budget', () => {
  let seed = 0x51ed270;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  // 12 tracks x 12 blobs is MAX_DETECTED_BODIES on both sides — the detector's
  // own cap, and the worst case this ever runs at in the analysis loop.
  const costs = Array.from({ length: ASSIGNMENT_CEILING }, () =>
    Array.from({ length: ASSIGNMENT_CEILING }, () => (rand() < 0.5 ? INF : rand() * 0.3)));
  const iterations = 500;
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) assignTracks(costs);
  const perCallMs = Number(process.hrtime.bigint() - start) / 1e6 / iterations;
  // The FULL hardware tier's whole analysis tick budget is 42ms
  // (lib/simulation.ts's HARDWARE_PROFILES); this call runs once per tick
  // alongside everything else the tick already does, so it must stay a small
  // fraction of that, not merely under it.
  const FULL_TIER_BUDGET_MS = 42;
  assert.ok(perCallMs < FULL_TIER_BUDGET_MS * 0.05,
    `worst-case assignTracks took ${perCallMs.toFixed(4)}ms per call, `
    + `over 5% of the ${FULL_TIER_BUDGET_MS}ms FULL-tier analysis budget`);
});
