/**
 * Cross-implementation parity for whether a visitor is crossing a stored
 * memory's path, and what a disturbed memory looks like as it decays.
 *
 * Two runtimes hold the same rules: `MemoryCollisions`/`memoryLoss`/
 * `disturbanceFrame` in `lib/memory-disturbance.ts`, and
 * `room_engine::disturbance` compiled natively. This feeds identical tracks,
 * ghosts and clock ticks to both and reports where they disagree.
 *
 * # Why this one carries no seed
 *
 * Nothing here draws. A crossing is a deterministic function of geometry and
 * two cooldown clocks, unlike recall.
 *
 * # Why the scenario is not JSON
 *
 * The same reason every other harness here gives: `serde_json` 1.0.151 does
 * not parse every `f64` to the nearest representable value. Several
 * scenarios below exist specifically to hover a projected point right at a
 * body radius or a cooldown boundary, which is exactly the case a one-ULP
 * rounding error would falsify silently. The scenario arrives as raw
 * little-endian `f64`. Results come back as JSON, which is safe in that
 * direction.
 *
 * # Why the WASM leg is absent
 *
 * Same reason as recall and personality: this is not on the boundary.
 * `room-wasm` exposes engines, not primitives, and nothing in the shell
 * calls `MemoryCollisions` yet — the scheduler that will is a later slice.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  MemoryCollisions,
  disturbanceFrame,
  memoryLoss,
  CROSSING_COOLDOWN_MS,
  MEMORY_REST_MS,
  MEMORY_RIPENS_MS,
} from '../lib/memory-disturbance.ts';
import type { Ghost, Point, VisitorTrack } from '../lib/room-types.ts';

/** Magic of the scenario file handed to the native leg. See the module docs. */
const SCENARIO_MAGIC = 'ROOMDIS1';

/** Absolute agreement required on anything measured, not merely compared. */
const TOLERANCE = 1e-9;

/**
 * A quarter turn, matching `mapCameraPoint`'s `rotation === 90` case. Fixed
 * and shared by both legs (see `examples/disturbance-parity.rs`) so a bug in
 * the plumbing that carries `project` through cannot hide behind an
 * accidental identity mapping.
 */
function project(point: Point): { x: number; y: number } {
  return { x: 1 - point.y, y: point.x };
}

const BASE = MEMORY_RIPENS_MS * 4;

function track(
  id: number,
  position: Point,
  previous: Point,
  extent: { width: number; height: number },
  extra: Partial<VisitorTrack> = {},
): VisitorTrack {
  return {
    id: `t-${id}`,
    bornAt: 0,
    lastSeen: position.t,
    position,
    previous,
    velocity: { x: 0, y: 0 },
    speed: 0,
    stillFor: 0,
    dwellSeconds: 0,
    path: [],
    active: true,
    occluded: false,
    confidence: 1,
    sightings: 5,
    extent,
    ...extra,
  };
}

function ghost(id: string, createdAt: number, points: [number, number][]): Ghost {
  return {
    id,
    createdAt,
    lastReplayedAt: 0,
    path: points.map(([x, y], i) => ({ x, y, t: i * 100 })),
    dwellSeconds: 0,
    intensity: 0.5,
    strength: 0.5,
    fidelity: 1,
    recallCount: 0,
    lineage: [],
    falseMemory: false,
    day: 1,
  };
}

type Tick = { tracks: VisitorTrack[]; ghosts: Ghost[]; now: number };
type CrossingScenario = { name: string; ticks: Tick[] };

const BODY = { width: 0.1, height: 0.24 };
const NEAR_LINE = ghost('g-near', 0, [[0, 0.5], [1, 0.5]]);

function scenarios(): CrossingScenario[] {
  // The whole point of the next scenario is that its retry lands past the
  // global cooldown but short of the memory's own rest; assert that rather
  // than trust the arithmetic silently.
  assert.ok(CROSSING_COOLDOWN_MS + 1 < MEMORY_REST_MS);

  const built: CrossingScenario[] = [];

  // The track's projected position ends exactly on the ghost's line; the
  // approach distance starts outside the body radius. Radius-entry, not a
  // true segment crossing (the endpoint sits ON the line).
  built.push({
    name: 'a-clean-crossing-by-radius-entry',
    ticks: [{
      tracks: [track(1,
        { x: 0.5, y: 0.5, t: BASE },
        { x: 0.5, y: 0.3, t: BASE - 200 },
        BODY)],
      ghosts: [NEAR_LINE],
      now: BASE,
    }],
  });

  // Both endpoints project farther from the line than the body radius can
  // reach, on opposite sides of it, so `enters` is false on both distance
  // checks and only the segment-intersection test can catch this.
  built.push({
    name: 'a-true-segment-crossing-too-fast-for-radius-entry',
    ticks: [{
      tracks: [track(1,
        { x: 0.7, y: 0.8, t: BASE },
        { x: 0.3, y: 0.2, t: BASE - 200 },
        BODY)],
      ghosts: [NEAR_LINE],
      now: BASE,
    }],
  });

  // A global cooldown blocks a second crossing of a different memory, and
  // releases it once the cooldown has elapsed.
  built.push({
    name: 'a-second-crossing-is-blocked-by-the-global-cooldown',
    ticks: [
      {
        tracks: [track(1,
          { x: 0.5, y: 0.5, t: BASE },
          { x: 0.3, y: 0.3, t: BASE - 200 },
          BODY)],
        ghosts: [
          ghost('g-1', 0, [[0.5, 0], [0.5, 1]]),
          ghost('g-2', 0, [[0, 0.5], [1, 0.5]]),
        ],
        now: BASE,
      },
      {
        tracks: [track(1,
          { x: 0.5, y: 0.5, t: BASE + 1 },
          { x: 0.3, y: 0.3, t: BASE - 199 },
          BODY)],
        ghosts: [
          ghost('g-1', 0, [[0.5, 0], [0.5, 1]]),
          ghost('g-2', 0, [[0, 0.5], [1, 0.5]]),
        ],
        now: BASE + 1,
      },
      {
        tracks: [track(1,
          { x: 0.5, y: 0.5, t: BASE + CROSSING_COOLDOWN_MS + 1 },
          { x: 0.3, y: 0.3, t: BASE + CROSSING_COOLDOWN_MS - 199 },
          BODY)],
        ghosts: [
          ghost('g-1', 0, [[0.5, 0], [0.5, 1]]),
          ghost('g-2', 0, [[0, 0.5], [1, 0.5]]),
        ],
        now: BASE + CROSSING_COOLDOWN_MS + 1,
      },
    ],
  });

  // Once the global cooldown clears, the same memory still rests longer.
  built.push({
    name: 'a-memory-still-resting-blocks-even-once-the-global-cooldown-clears',
    ticks: [
      {
        tracks: [track(1,
          { x: 0.5, y: 0.5, t: BASE },
          { x: 0.3, y: 0.3, t: BASE - 200 },
          BODY)],
        ghosts: [NEAR_LINE],
        now: BASE,
      },
      {
        tracks: [track(1,
          { x: 0.5, y: 0.5, t: BASE + CROSSING_COOLDOWN_MS + 1 },
          { x: 0.3, y: 0.3, t: BASE + CROSSING_COOLDOWN_MS - 199 },
          BODY)],
        ghosts: [NEAR_LINE],
        now: BASE + CROSSING_COOLDOWN_MS + 1,
      },
    ],
  });

  // A ghost younger than MEMORY_RIPENS_MS is never crossed.
  built.push({
    name: 'a-too-young-ghost-is-never-crossed',
    ticks: [{
      tracks: [track(1,
        { x: 0.5, y: 0.5, t: 1_000 + MEMORY_RIPENS_MS - 1 },
        { x: 0.3, y: 0.3, t: 800 },
        BODY)],
      ghosts: [ghost('g-young', 1_000, [[0, 0.5], [1, 0.5]])],
      now: 1_000 + MEMORY_RIPENS_MS - 1,
    }],
  });

  // An occluded track and an unconfirmed one, both otherwise crossing, never
  // fire.
  built.push({
    name: 'an-occluded-or-unconfirmed-track-never-crosses',
    ticks: [{
      tracks: [
        track(1,
          { x: 0.5, y: 0.5, t: BASE },
          { x: 0.3, y: 0.3, t: BASE - 200 },
          BODY,
          { occluded: true }),
        track(2,
          { x: 0.5, y: 0.5, t: BASE },
          { x: 0.3, y: 0.3, t: BASE - 200 },
          BODY,
          { sightings: 1 }),
      ],
      ghosts: [NEAR_LINE],
      now: BASE,
    }],
  });

  // Sub-threshold movement accumulates on the anchor across several ticks
  // instead of resetting, so a slow sensing loop does not make the same walk
  // less likely to register than a fast one.
  built.push({
    name: 'jitter-accumulates-on-the-anchor-rather-than-resetting',
    ticks: [
      // Anchor starts at the track's own `previous` on tick 1: a tiny step,
      // too small relative to the body radius (0.1 wide) to count.
      {
        tracks: [track(1,
          { x: 0.2003, y: 0.5003, t: BASE },
          { x: 0.2, y: 0.5, t: BASE - 200 },
          BODY)],
        ghosts: [NEAR_LINE],
        now: BASE,
      },
      // Another sub-threshold step from the *same* anchor (0.2, 0.5), since
      // the first tick's movement was too small to advance it.
      {
        tracks: [track(1,
          { x: 0.2006, y: 0.5006, t: BASE + 200 },
          { x: 0.2003, y: 0.5003, t: BASE },
          BODY)],
        ghosts: [NEAR_LINE],
        now: BASE + 200,
      },
      // Now a real step clear across the room, still measured from the
      // original (0.2, 0.5) anchor rather than tick 2's position: large
      // enough on its own to register, and it crosses the line transversally
      // rather than sliding along it.
      {
        tracks: [track(1,
          { x: 0.8, y: 0.5, t: BASE + 400 },
          { x: 0.2006, y: 0.5006, t: BASE + 200 },
          BODY)],
        ghosts: [NEAR_LINE],
        now: BASE + 400,
      },
    ],
  });

  // A cooldown held for a memory is pruned once that memory leaves the
  // archive, reported via `tracked()`.
  built.push({
    name: 'a-cooldown-is-pruned-once-its-memory-leaves-the-archive',
    ticks: [
      {
        tracks: [track(1,
          { x: 0.5, y: 0.5, t: BASE },
          { x: 0.3, y: 0.3, t: BASE - 200 },
          BODY)],
        ghosts: [NEAR_LINE],
        now: BASE,
      },
      {
        tracks: [track(1,
          { x: 0.5, y: 0.5, t: BASE + 1 },
          { x: 0.3, y: 0.3, t: BASE - 199 },
          BODY)],
        ghosts: [],
        now: BASE + 1,
      },
    ],
  });

  return built;
}

type LossCase = { createdAt: number; fidelity: number; now: number };
function lossCases(): LossCase[] {
  return [
    { createdAt: 0, fidelity: 1, now: 4 * 60_000 }, // inside the 5-minute grace period
    { createdAt: 0, fidelity: 1, now: 5 * 60_000 + 6 * 3_600_000 }, // exactly the ramp's end
    { createdAt: 0, fidelity: 1, now: 5 * 60_000 + 3 * 3_600_000 }, // mid-ramp
    { createdAt: 0, fidelity: 0.1, now: 0 }, // low fidelity from the very start
    { createdAt: 1_000, fidelity: 0.5, now: 1_000 + 5 * 60_000 + 12 * 3_600_000 }, // well past the ramp
  ];
}

type FrameCase = { path: Point[]; progress: number; loss: number };
function frameCases(): FrameCase[] {
  const path: Point[] = [{ x: 0.2, y: 0.2, t: 0 }, { x: 0.5, y: 0.5, t: 100 }, { x: 0.8, y: 0.2, t: 200 }];
  return [
    { path, progress: 0.5, loss: 0 }, // no loss: shape untouched
    { path, progress: 0.5, loss: 0.1 }, // below the loss > 0.2 branch
    { path, progress: 0.5, loss: 0.9 }, // above it, mid-progress: drifting
    { path, progress: 0.05, loss: 0.9 }, // before drift's own 0.2 floor
    { path, progress: 0.99, loss: 0.9 }, // near the end, high loss
  ];
}

const sessions = scenarios();
const losses = lossCases();
const frames = frameCases();

function typescriptLeg(scenario: CrossingScenario) {
  const collisions = new MemoryCollisions();
  const hits = scenario.ticks.map((tick) => {
    const hit = collisions.find(tick.tracks, tick.ghosts, tick.now, project);
    if (!hit) return null;
    return {
      ghostIndex: tick.ghosts.indexOf(hit.ghost),
      at: [hit.at.x, hit.at.y],
      segmentIndex: hit.index,
      trackId: Number(hit.trackId.slice(2)),
    };
  });
  return { name: scenario.name, hits, tracked: collisions.tracked };
}

type Disagreement = { what: string; typescript: unknown; rust: unknown };
const found: Disagreement[] = [];
let crossingsChecked = 0;
let hitsFound = 0;

const startTs = performance.now();
const typescript = sessions.map(typescriptLeg);
const typescriptMs = performance.now() - startTs;
const typescriptLosses = losses.map((c) => memoryLoss(c.createdAt, c.fidelity, c.now));
const typescriptFrames = frames.map((c) => disturbanceFrame(c.path, c.progress, c.loss));

function numbersAgree(what: string, a: number, b: number) {
  if (Math.abs(a - b) > TOLERANCE) found.push({ what, typescript: a, rust: b });
}

const workspace = mkdtempSync(join(tmpdir(), 'disturbance-parity-'));
let nativeMs = 0;
try {
  const file = join(workspace, 'scenarios.bin');
  writeFileSync(file, encodeScenarios(sessions, losses, frames));
  const start = performance.now();
  const native = spawnSync(
    'cargo',
    ['run', '--locked', '--quiet', '--release', '-p', 'room-engine',
      '--example', 'disturbance-parity', '--', file],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  nativeMs = performance.now() - start;
  assert.equal(native.status, 0, native.stderr);
  const reported = JSON.parse(native.stdout) as {
    crossings: Array<{ name: string; hits: Array<null | {
      ghostIndex: number; at: [number, number]; segmentIndex: number; trackId: number;
    }>; tracked: number }>;
    losses: number[];
    frames: Array<{ end: number; fade: number; path: number[] }>;
  };

  assert.equal(reported.crossings.length, sessions.length);
  for (const [index, scenario] of typescript.entries()) {
    const theirs = reported.crossings[index];
    assert.equal(theirs.name, scenario.name, 'the legs disagree about which scenario is which');
    assert.equal(theirs.hits.length, scenario.hits.length, `${scenario.name}: tick count disagrees`);
    for (const [at, mine] of scenario.hits.entries()) {
      crossingsChecked += 1;
      const theirHit = theirs.hits[at];
      if ((mine === null) !== (theirHit === null)) {
        found.push({ what: `${scenario.name}[${at}] hit/miss`, typescript: mine, rust: theirHit });
        continue;
      }
      if (mine && theirHit) {
        hitsFound += 1;
        if (mine.ghostIndex !== theirHit.ghostIndex) {
          found.push({ what: `${scenario.name}[${at}].ghostIndex`, typescript: mine.ghostIndex, rust: theirHit.ghostIndex });
        }
        if (mine.segmentIndex !== theirHit.segmentIndex) {
          found.push({ what: `${scenario.name}[${at}].segmentIndex`, typescript: mine.segmentIndex, rust: theirHit.segmentIndex });
        }
        if (mine.trackId !== theirHit.trackId) {
          found.push({ what: `${scenario.name}[${at}].trackId`, typescript: mine.trackId, rust: theirHit.trackId });
        }
        numbersAgree(`${scenario.name}[${at}].at.x`, mine.at[0], theirHit.at[0]);
        numbersAgree(`${scenario.name}[${at}].at.y`, mine.at[1], theirHit.at[1]);
      }
    }
    if (scenario.tracked !== theirs.tracked) {
      found.push({ what: `${scenario.name}.tracked`, typescript: scenario.tracked, rust: theirs.tracked });
    }
  }

  assert.equal(reported.losses.length, typescriptLosses.length);
  for (const [index, mine] of typescriptLosses.entries()) {
    numbersAgree(`losses[${index}]`, mine, reported.losses[index]);
  }

  assert.equal(reported.frames.length, typescriptFrames.length);
  for (const [index, mine] of typescriptFrames.entries()) {
    const theirs = reported.frames[index];
    numbersAgree(`frames[${index}].end`, mine.end, theirs.end);
    numbersAgree(`frames[${index}].fade`, mine.fade, theirs.fade);
    const flat = mine.path.flatMap((p) => [p.x, p.y, p.t]);
    assert.equal(flat.length, theirs.path.length, `frames[${index}].path length disagrees`);
    for (const [slot, value] of flat.entries()) {
      numbersAgree(`frames[${index}].path[${slot}]`, value, theirs.path[slot]);
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

/**
 * Write the scenarios as raw little-endian values.
 *
 * `ROOMDIS1`, then crossing scenarios, loss cases and frame cases in that
 * order. The reader in `examples/disturbance-parity.rs` checks every read
 * and refuses a file with trailing bytes, so a layout change here fails
 * loudly instead of decoding as a different session.
 */
function encodeScenarios(built: CrossingScenario[], losses: LossCase[], frames: FrameCase[]): Buffer {
  const parts: Buffer[] = [Buffer.from(SCENARIO_MAGIC, 'ascii'), u32(built.length)];
  for (const scenario of built) {
    parts.push(text(scenario.name), u32(scenario.ticks.length));
    for (const tick of scenario.ticks) {
      parts.push(u32(tick.tracks.length));
      for (const track of tick.tracks) {
        parts.push(
          u32(Number(track.id.slice(2))),
          point(track.position), point(track.previous),
          f64(track.extent.width), f64(track.extent.height),
          Buffer.from([track.occluded ? 1 : 0]),
          u32(track.sightings),
        );
      }
      parts.push(u32(tick.ghosts.length));
      for (const ghost of tick.ghosts) {
        parts.push(text(ghost.id), f64(ghost.createdAt), u32(ghost.path.length));
        for (const p of ghost.path) parts.push(point(p));
      }
      parts.push(f64(tick.now));
    }
  }
  parts.push(u32(losses.length));
  for (const loss of losses) parts.push(f64(loss.createdAt), f64(loss.fidelity), f64(loss.now));
  parts.push(u32(frames.length));
  for (const frame of frames) {
    parts.push(u32(frame.path.length));
    for (const p of frame.path) parts.push(point(p));
    parts.push(f64(frame.progress), f64(frame.loss));
  }
  return Buffer.concat(parts);
}

function point(p: Point): Buffer {
  return Buffer.concat([f64(p.x), f64(p.y), f64(p.t)]);
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function f64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeDoubleLE(value, 0);
  return out;
}

function text(value: string): Buffer {
  const encoded = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(encoded.length), encoded]);
}

const report = {
  scenarios: sessions.map((scenario) => ({ name: scenario.name, ticks: scenario.ticks.length })),
  crossingsChecked,
  hitsFound,
  lossCases: losses.length,
  frameCases: frames.length,
  tolerance: TOLERANCE,
  disagreements: found.slice(0, 20),
  disagreementCount: found.length,
  typescriptMs,
  nativeMsIncludingCargo: nativeMs,
};
mkdirSync('reports/v2', { recursive: true });
writeFileSync('reports/v2/disturbance-parity.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(report);
assert.equal(found.length, 0, `${found.length} disagreements; see reports/v2/disturbance-parity.json`);
assert.ok(hitsFound >= 5, `only ${hitsFound} crossings actually fired; a run that found none proves nothing`);
