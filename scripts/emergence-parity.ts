/**
 * Cross-implementation parity for the room's recall scheduler.
 *
 * Two runtimes hold the same rules: `RoomEmergence.detect()` in
 * `lib/room-emergence.ts`, and `room_engine::emergence::detect` compiled
 * natively. This feeds identical rooms, an identical seed and an identical
 * run of ticks to both, and reports where they disagree.
 *
 * # Why this one needs a shared random stream
 *
 * Five of the six branches draw, in an order that is part of the contract —
 * the same reasoning `memory-parity.ts` gives, extended across a scheduler
 * that shares one stream between all of them in one call.
 *
 * # What is compared
 *
 * Every tick: the utterances (kind and position), the event line, the voice
 * cues a disturbance qualified, and — because this is the first ported
 * function that mutates three collections in place rather than returning a
 * value — the full flattened state of `ghosts`, `whispers` and `active`
 * afterward. A tick that agreed on the event but silently wrote back the
 * wrong ghost would pass every earlier harness's style of check and corrupt
 * every later decision; only comparing the archives themselves catches that.
 *
 * # Coordinates
 *
 * The TypeScript computes `mapRoomPoint` from `room.config`; the Rust side
 * takes a bare projection closure (see `disturbance-parity.ts`). Both are
 * made to agree by using `DEFAULT_CONFIG`'s identity calibration quad with
 * `cameraRotation: 90`, which reduces `mapRoomPoint` to exactly the fixed
 * quarter-turn `examples/emergence-parity.rs` uses.
 *
 * # Why the scenario is not JSON
 *
 * The same reason every other harness here gives: `serde_json` 1.0.151 does
 * not parse every `f64` to the nearest representable value. The scenario
 * arrives as raw little-endian `f64`. Results come back as JSON, which is
 * safe in that direction.
 *
 * # Why the WASM leg is absent
 *
 * Same reason as recall, personality and the collision detector: this is not
 * on the boundary. Nothing in the shell calls this module yet.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { RoomEmergence, type EmergenceRoom, type WhisperAudio } from '../lib/room-emergence.ts';
import { MemoryCollisions } from '../lib/memory-disturbance.ts';
import { RoomRng } from '../lib/room-rng.ts';
import { DEFAULT_CONFIG } from '../lib/room-types.ts';
import type { RoomInterest, Decision } from '../lib/attention.ts';
import type { Ghost, RoomLifecycle, VisitorTrack, WhisperMemory } from '../lib/room-types.ts';

const SCENARIO_MAGIC = 'ROOMEMR1';
const TOLERANCE = 1e-9;

const LIFECYCLES: readonly RoomLifecycle[] = ['opening', 'active', 'closing', 'after-hours'];

const WALL = 1_757_000_000_000;

function ghost(id: string, points: number, createdAt: number): Ghost {
  return {
    id,
    createdAt,
    lastReplayedAt: 0,
    path: Array.from({ length: points }, (_, step) => ({
      x: 0.08 + (step % 7) * 0.11,
      y: 0.2 + Math.sin(step * 0.9) * 0.3,
      t: step * 120,
    })),
    dwellSeconds: 4,
    intensity: 0.5,
    strength: 0.5,
    fidelity: 1,
    recallCount: 0,
    lineage: [],
    falseMemory: false,
    day: 1,
  };
}

function whisper(id: string, points: number): WhisperMemory {
  return {
    id,
    createdAt: 0,
    lastReplayedAt: 0,
    duration: 1.8,
    envelope: Array.from({ length: points }, (_, step) =>
      Math.round((0.15 + Math.abs(Math.sin(step * 0.7)) * 0.8) * 1000) / 1000),
    brightness: 0.44,
    position: { x: 0.5, y: 0.5 },
    strength: 0.5,
    fidelity: 1,
    recallCount: 0,
    lineage: [],
    day: 1,
  };
}

type TickTrack = {
  id: number;
  position: { x: number; y: number; t: number };
  previous: { x: number; y: number; t: number };
  extent: { width: number; height: number };
  occluded?: boolean;
  sightings?: number;
  stillFor?: number;
  /** Only the retrace branch reads this; every other track-consuming branch
   * needs just position/previous/extent, which is why it defaults empty. */
  path?: { x: number; y: number; t: number }[];
};

function track(spec: TickTrack): VisitorTrack {
  return {
    id: `t-${spec.id}`,
    bornAt: 0,
    lastSeen: spec.position.t,
    position: spec.position,
    previous: spec.previous,
    velocity: { x: 0, y: 0 },
    speed: 0,
    stillFor: spec.stillFor ?? 0,
    dwellSeconds: 0,
    path: spec.path ?? [],
    active: true,
    occluded: spec.occluded ?? false,
    confidence: 1,
    sightings: spec.sightings ?? 5,
    extent: spec.extent,
  };
}

type TickSpec = {
  tracks: TickTrack[];
  ghostFrequency: number;
  lifecycle: RoomLifecycle;
  emptySeconds: number;
  now: number;
  wall: number;
  attention?: { trackId: number; weight: number };
  hasRecording: boolean;
};

type Scenario = {
  name: string;
  seed: number;
  ghosts: Ghost[];
  whispers: WhisperMemory[];
  ticks: TickSpec[];
};

const BODY = { width: 0.1, height: 0.24 };

function tick(spec: Partial<TickSpec> & { tracks: TickTrack[]; now: number }): TickSpec {
  return {
    ghostFrequency: 1,
    lifecycle: 'active',
    emptySeconds: 0,
    wall: WALL + spec.now,
    hasRecording: false,
    ...spec,
  };
}

function scenarios(): Scenario[] {
  const built: Scenario[] = [];

  // A still crowd surfaces the oldest ghost, then rests for ninety seconds.
  built.push({
    name: 'a-still-room-surfaces-the-oldest-ghost-then-rests',
    seed: 101,
    ghosts: [ghost('g-newer', 12, 5_000), ghost('g-oldest', 10, 1_000)],
    whispers: [],
    ticks: [
      tick({ tracks: [{ id: 1, position: { x: 0.5, y: 0.5, t: 0 }, previous: { x: 0.5, y: 0.5, t: 0 }, extent: BODY, stillFor: 20 }], now: 10_000 }),
      tick({ tracks: [{ id: 1, position: { x: 0.5, y: 0.5, t: 1_000 }, previous: { x: 0.5, y: 0.5, t: 0 }, extent: BODY, stillFor: 30 }], now: 10_000 + 89_000 }),
      tick({ tracks: [{ id: 1, position: { x: 0.5, y: 0.5, t: 2_000 }, previous: { x: 0.5, y: 0.5, t: 0 }, extent: BODY, stillFor: 40 }], now: 10_000 + 91_000 }),
    ],
  });

  // A genuine retrace, and the stationary negative that must not read as one.
  built.push({
    name: 'a-genuine-retrace-answers-ahead-of-its-visitor',
    seed: 202,
    ghosts: [],
    whispers: [],
    ticks: [
      tick({
        tracks: [{
          id: 5,
          position: { x: 0.79, y: 0.5, t: 2_300 },
          previous: { x: 0.76, y: 0.5, t: 2_250 },
          extent: BODY,
          stillFor: 0,
          // Out and straight back: RETRACE_MIN_POINTS(22) exceeded, extent
          // well past RETURN_MIN_EXTENT(0.28), and the second half repeats
          // the first almost exactly.
          path: [
            ...Array.from({ length: 24 }, (_, step) => ({ x: 0.1 + step * 0.03, y: 0.5, t: step * 100 })),
            ...Array.from({ length: 24 }, (_, step) => ({ x: 0.1 + step * 0.03, y: 0.5, t: 2_400 + step * 100 })),
          ],
        }],
        now: 0,
      }),
    ],
  });

  // The stationary negative: a "path" that never went anywhere must not read
  // as a retrace, however many points it has.
  built.push({
    name: 'standing-still-is-not-a-retrace',
    seed: 203,
    ghosts: [],
    whispers: [],
    ticks: [
      tick({
        tracks: [{
          id: 6,
          position: { x: 0.5, y: 0.5, t: 2_300 },
          previous: { x: 0.5, y: 0.5, t: 2_250 },
          extent: BODY,
          stillFor: 0,
          path: Array.from({ length: 24 }, (_, step) => ({ x: 0.5, y: 0.5, t: step * 100 })),
        }],
        now: 0,
      }),
    ],
  });

  // False-memory gating: fewer than two ghosts never fires it, however high
  // the rate; with two or more and a saturating rate, it eventually does.
  built.push({
    name: 'false-memory-needs-two-ghosts-and-the-gate-to-clear',
    seed: 303,
    ghosts: [ghost('g-1', 14, 60_000), ghost('g-2', 10, 120_000)],
    whispers: [whisper('w-1', 10)],
    ticks: Array.from({ length: 40 }, (_, step) =>
      tick({ tracks: [], ghostFrequency: 200, now: step * 5_000 })),
  });

  // Ordinary recall: an empty room speaks; a present one, attended toward a
  // nearby memory, stays quiet but the archive still moves.
  built.push({
    name: 'ordinary-recall-empty-speaks-present-is-quiet-and-attended',
    seed: 404,
    ghosts: [ghost('g-far', 10, 60_000), ghost('g-near', 10, 90_000)],
    whispers: [],
    ticks: [
      ...Array.from({ length: 20 }, (_, step) =>
        tick({ tracks: [], ghostFrequency: 80, emptySeconds: 500, now: step * 3_000 })),
      ...Array.from({ length: 20 }, (_, step) =>
        tick({
          tracks: [{
            id: 2,
            position: { x: 0.08, y: 0.2, t: 60_000 + step * 3_000 },
            previous: { x: 0.08, y: 0.2, t: 60_000 + step * 3_000 },
            extent: BODY,
          }],
          ghostFrequency: 80,
          attention: { trackId: 2, weight: 1 },
          now: 60_000 + step * 3_000,
        })),
    ],
  });

  // A crossing disturbs a memory; the disturbance qualifies for a voice once
  // it is far enough into its presentation, and is admitted near its end.
  built.push({
    name: 'a-crossing-disturbs-qualifies-a-voice-and-is-admitted',
    seed: 505,
    ghosts: [ghost('g-line', 2, 0)].map((memory) => ({
      ...memory,
      path: [{ x: 0.0, y: 0.5, t: 0 }, { x: 1.0, y: 0.5, t: 100 }],
      fidelity: 0.3, // high loss quickly, so admission is reachable inside the scenario
      createdAt: -10_000_000,
    })),
    whispers: [{ ...whisper('w-near', 8), position: { x: 0.5, y: 0.5 }, createdAt: -1_000_000 }],
    ticks: [
      tick({
        tracks: [{
          id: 3,
          position: { x: 0.7, y: 0.8, t: 0 },
          previous: { x: 0.3, y: 0.2, t: -200 },
          extent: BODY,
        }],
        now: 0,
        hasRecording: true,
      }),
      // Progress far enough into the presentation for the voice to qualify.
      tick({ tracks: [], now: recallDurationMs('ghost') * 0.5, hasRecording: true }),
      // Progress to near the end, for admission.
      tick({ tracks: [], now: recallDurationMs('ghost') * 0.98, hasRecording: true }),
    ],
  });

  // The cap: three already-active recalls, nothing new fires.
  built.push({
    name: 'a-capped-room-answers-nothing',
    seed: 606,
    ghosts: [ghost('g-1', 10, 0), ghost('g-2', 10, 0)],
    whispers: [],
    ticks: [
      tick({
        tracks: [{ id: 1, position: { x: 0.5, y: 0.5, t: 0 }, previous: { x: 0.5, y: 0.5, t: 0 }, extent: BODY, stillFor: 20 }],
        ghostFrequency: 200,
        now: 0,
      }),
    ],
  });

  // Lifecycle suppression: opening and closing both silence every branch.
  for (const lifecycle of ['opening', 'closing'] as const) {
    built.push({
      name: `${lifecycle}-suppresses-every-branch`,
      seed: 707,
      ghosts: [ghost('g-1', 10, 0)],
      whispers: [],
      ticks: [
        tick({
          tracks: [{ id: 1, position: { x: 0.5, y: 0.5, t: 0 }, previous: { x: 0.5, y: 0.5, t: 0 }, extent: BODY, stillFor: 20 }],
          lifecycle,
          ghostFrequency: 200,
          now: 0,
        }),
      ],
    });
  }

  // Priority: stillness AND a crossing both available on the same tick.
  // Stillness must win, because it is checked first.
  built.push({
    name: 'stillness-outranks-a-crossing-on-the-same-tick',
    seed: 808,
    ghosts: [{
      ...ghost('g-line', 2, -10_000_000),
      path: [{ x: 0.0, y: 0.5, t: 0 }, { x: 1.0, y: 0.5, t: 100 }],
    }],
    whispers: [],
    ticks: [
      tick({
        tracks: [{
          id: 1,
          position: { x: 0.5, y: 0.5, t: 0 },
          previous: { x: 0.5, y: 0.5, t: 0 },
          extent: BODY,
          stillFor: 20,
        }],
        now: 0,
      }),
    ],
  });

  return built;
}

/** `RecallKind.presentation` from `crates/room-protocol/src/snapshot.rs`. */
const PRESENTATION_MS: Record<string, number> = {
  ghost: 11_000, stillness: 16_000, empty: 15_000, return: 9_000, convergence: 18_000, false: 13_000,
};
function recallDurationMs(kind: string): number {
  return PRESENTATION_MS[kind];
}

const RECALL_KIND_TAG: Record<string, number> = {
  ghost: 0, stillness: 1, empty: 2, return: 3, convergence: 4, false: 5,
};

/** Matches `EmergenceVoice`'s declared order in `crates/room-engine/src/emergence.rs`. */
const EMERGENCE_VOICE_TAG: Record<string, number> = {
  stillness: 0, return: 1, false: 2, empty: 3, forgetting: 4,
};

/**
 * `rememberGhost`/`rememberWhisper` stamp `lastReplayedAt` from `Date.now()`,
 * which a pure engine cannot do and a scenario cannot reproduce — the same
 * fact `memory-parity.ts` documents and works around by overriding the
 * return value at the one call site it controls. Here the call is buried
 * inside `RoomEmergence.detect()` across several branches, so the fix is
 * applied uniformly after the fact instead: any `lastReplayedAt` that looks
 * like a real epoch millisecond (order 1e12) rather than one of this
 * harness's small deterministic clock values is replaced with the
 * scenario's own wall clock, in place, so the correction also holds for
 * whatever a later tick reads back (`chooseRareGhost`'s neglect weighting
 * reads exactly this field).
 *
 * Detecting contamination by magnitude alone does not work across ticks: once
 * an entry has been corrected to this harness's own wall clock — itself well
 * above 1e12, by the same convention `memory-parity.ts` uses — it would look
 * "contaminated" again on every later tick and get re-stamped whether or not
 * anything touched it that tick. So this instead snapshots `lastReplayedAt`
 * for every *pre-existing* ghost/whisper before `detect()` runs, and only
 * corrects entries whose value changed — which is exactly the set `detect()`
 * called `rememberGhost`/`rememberWhisper` on this tick, no more and no less.
 * A brand-new ghost (false memory) is never touched: `createFalseMemory` sets
 * this field deterministically, not from `Date.now()`.
 */
function snapshotClocks(ghosts: readonly Ghost[], whispers: readonly WhisperMemory[]) {
  return {
    ghosts: new Map(ghosts.map((memory) => [memory.id, memory.lastReplayedAt])),
    whispers: new Map(whispers.map((voice) => [voice.id, voice.lastReplayedAt])),
  };
}

function sanitizeClock(
  before: ReturnType<typeof snapshotClocks>,
  ghosts: Ghost[],
  whispers: WhisperMemory[],
  newlyActive: EmergenceRoom['active'],
  wall: number,
) {
  for (const memory of ghosts) {
    const previous = before.ghosts.get(memory.id);
    if (previous !== undefined && memory.lastReplayedAt !== previous) memory.lastReplayedAt = wall;
  }
  for (const voice of whispers) {
    const previous = before.whispers.get(voice.id);
    if (previous !== undefined && voice.lastReplayedAt !== previous) voice.lastReplayedAt = wall;
  }
  // Entries pushed to `active` this tick only: an id-based correction here
  // (matching an active ghost back to its archive entry) would conflate two
  // *different* pushes of the same underlying ghost id on two different
  // ticks — stillness can recall "the oldest ghost" again once its rest
  // clears, and the earlier push must keep its own tick's stamp, not adopt
  // the later one's. Restricting to what `detect()` just pushed means each
  // entry is only ever considered once, at the tick that created it. A fresh
  // push's `lastReplayedAt` is either the `Date.now()` a real recall stamped
  // (magnitude order 1e12, the same signal used above) or the deterministic
  // small value `createFalseMemory`/the retrace literal set, which is left
  // alone.
  for (const entry of newlyActive) {
    if (entry.ghost.lastReplayedAt > 1e12) entry.ghost.lastReplayedAt = wall;
  }
}

/** One ghost, flattened. Field order matches `examples/emergence-parity.rs`. */
function describeGhost(memory: Ghost) {
  return {
    id: memory.id,
    lastReplayedAt: memory.lastReplayedAt,
    dwellSeconds: memory.dwellSeconds,
    intensity: memory.intensity,
    strength: memory.strength,
    fidelity: memory.fidelity,
    recallCount: memory.recallCount,
    falseMemory: memory.falseMemory,
    day: memory.day,
    path: memory.path.flatMap((point) => [point.x, point.y, point.t]),
  };
}
function describeWhisper(voice: WhisperMemory) {
  return {
    id: voice.id,
    lastReplayedAt: voice.lastReplayedAt,
    strength: voice.strength,
    fidelity: voice.fidelity,
    recallCount: voice.recallCount,
    envelope: voice.envelope,
  };
}

type Described = Record<string, unknown>;

function typescriptLeg(scenario: Scenario) {
  const rng = new RoomRng(scenario.seed);
  const ghosts = scenario.ghosts.map((memory) => ({ ...memory }));
  const whispers = scenario.whispers.map((voice) => ({ ...voice }));
  const active: EmergenceRoom['active'] = [];
  const collisions = new MemoryCollisions();
  const emergence = new RoomEmergence();
  const steps: Described[] = [];

  for (const spec of scenario.ticks) {
    let decision: Decision = { trackId: null, weight: 0 };
    if (spec.attention) decision = { trackId: `t-${spec.attention.trackId}`, weight: spec.attention.weight };
    const attention: RoomInterest = {
      observe: () => {},
      decision: () => decision,
      depositScale: () => 1,
      favours: () => 0,
    };
    const voiceCues: Array<{ whisperId: string; loss: number }> = [];
    const audio: WhisperAudio = {
      hasRecording: () => spec.hasRecording,
      replay: (played, _volume, loss) => voiceCues.push({ whisperId: played.id, loss: loss ?? 0 }),
    };
    const room: EmergenceRoom = {
      tracks: spec.tracks.map(track),
      ghosts,
      whispers,
      active,
      config: { ...DEFAULT_CONFIG, cameraRotation: 90, ghostFrequency: spec.ghostFrequency },
      day: 1,
      lifecycle: spec.lifecycle,
      emptySeconds: spec.emptySeconds,
      now: spec.now,
      wall: spec.wall,
      attention,
      collisions,
      audio,
      random: rng.draw,
    };
    const before = snapshotClocks(ghosts, whispers);
    const activeCountBefore = active.length;
    const outcome = emergence.detect(room);
    sanitizeClock(before, ghosts, whispers, active.slice(activeCountBefore), spec.wall);
    steps.push({
      utterances: outcome.utterances.map((u) => ({ kind: EMERGENCE_VOICE_TAG[u.kind], at: [u.at.x, u.at.y] })),
      event: outcome.event ?? null,
      voiceCues: voiceCues.map((cue) => ({
        whisperIndex: whispers.findIndex((w) => w.id === cue.whisperId),
        loss: cue.loss,
      })),
      ghosts: ghosts.map(describeGhost),
      whispers: whispers.map(describeWhisper),
      active: active.map((entry) => ({
        ghost: describeGhost(entry.ghost),
        startedAt: entry.startedAt,
        kind: RECALL_KIND_TAG[entry.kind],
        disturbance: entry.disturbance
          ? {
            loss: entry.disturbance.loss,
            at: [entry.disturbance.at.x, entry.disturbance.at.y],
            voicePlayed: entry.disturbance.voicePlayed,
            admitted: entry.disturbance.admitted,
          }
          : null,
      })),
    });
    pruneExpired(active, spec.now);
  }
  return { steps, draws: rng.draws };
}

/**
 * `detect()` never removes a presentation that has finished — that is
 * `composeRoomBodies`' job in the real shell (`components/room-installation.tsx:817-819`),
 * not the scheduler's. Without simulating it here, a scenario spanning more
 * than a few successful recalls hits `MAX_ACTIVE_RECALLS` and stays capped
 * for the rest of the run, which would make every later tick agree
 * trivially by never reaching a decision at all. Both legs prune identically
 * — see the matching step in `examples/emergence-parity.rs`'s main loop —
 * so this does not change what is compared, only what is fed forward.
 */
function pruneExpired(active: EmergenceRoom['active'], now: number) {
  const survivors = active.filter((entry) => now - entry.startedAt < PRESENTATION_MS[entry.kind]);
  active.length = 0;
  active.push(...survivors);
}

type Disagreement = { scenario: string; step: number; what: string; typescript: unknown; rust: unknown };

const sessions = scenarios();
const found: Disagreement[] = [];
let worst = 0;
let steps = 0;
const branchesSeen = new Set<string>();
let tsMs = 0;

const typescript = sessions.map((scenario) => {
  const start = performance.now();
  const leg = typescriptLeg(scenario);
  tsMs += performance.now() - start;
  return leg;
});

const workspace = mkdtempSync(join(tmpdir(), 'emergence-parity-'));
let nativeMs = 0;
try {
  const file = join(workspace, 'scenarios.bin');
  writeFileSync(file, encodeScenarios(sessions));
  const start = performance.now();
  const native = spawnSync(
    'cargo',
    ['run', '--locked', '--quiet', '--release', '-p', 'room-engine',
      '--example', 'emergence-parity', '--', file],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  nativeMs = performance.now() - start;
  assert.equal(native.status, 0, native.stderr);
  const reported = JSON.parse(native.stdout) as Array<{ name: string; steps: Described[]; draws: number }>;
  assert.equal(reported.length, sessions.length);

  for (const [index, scenario] of sessions.entries()) {
    const mine = typescript[index];
    const theirs = reported[index];
    assert.equal(theirs.name, scenario.name, 'the legs disagree about which scenario is which');

    if (mine.draws !== theirs.draws) {
      found.push({ scenario: scenario.name, step: -1, what: 'draws taken from the stream', typescript: mine.draws, rust: theirs.draws });
    }

    for (const [at, expected] of mine.steps.entries()) {
      const produced = theirs.steps[at];
      steps += 1;
      if (typeof expected.event === 'string') branchesSeen.add(expected.event);
      if (!produced) {
        found.push({ scenario: scenario.name, step: at, what: 'missing', typescript: expected, rust: null });
        continue;
      }
      compareValue(scenario.name, at, '', expected, produced);
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function compareValue(scenario: string, step: number, path: string, left: unknown, right: unknown) {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      found.push({ scenario, step, what: `${path}.length`, typescript: left.length, rust: right.length });
      return;
    }
    for (const [i, value] of left.entries()) compareValue(scenario, step, `${path}[${i}]`, value, right[i]);
    return;
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right as object)]);
    for (const key of keys) {
      compareValue(scenario, step, `${path}.${key}`, (left as Described)[key], (right as Described)[key]);
    }
    return;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    const delta = Math.abs(left - right);
    worst = Math.max(worst, delta);
    if (delta > TOLERANCE) found.push({ scenario, step, what: path, typescript: left, rust: right });
    return;
  }
  if (left !== right) found.push({ scenario, step, what: path, typescript: left, rust: right });
}

/**
 * Write the scenarios as raw little-endian values. `ROOMEMR1`, then per
 * scenario a name, a seed, the initial ghosts and whispers, then the ticks.
 * The reader in `examples/emergence-parity.rs` checks every read and refuses
 * a file with trailing bytes, so a layout change here fails loudly instead of
 * decoding as a different session.
 */
function encodeScenarios(built: Scenario[]): Buffer {
  const parts: Buffer[] = [Buffer.from(SCENARIO_MAGIC, 'ascii'), u32(built.length)];
  for (const scenario of built) {
    parts.push(text(scenario.name), f64(scenario.seed));
    parts.push(u32(scenario.ghosts.length));
    for (const memory of scenario.ghosts) {
      parts.push(text(memory.id), f64(memory.createdAt), f64(memory.lastReplayedAt));
      parts.push(u32(memory.path.length));
      for (const point of memory.path) parts.push(f64(point.x), f64(point.y), f64(point.t));
      parts.push(
        f64(memory.dwellSeconds), f64(memory.intensity), f64(memory.strength),
        f64(memory.fidelity), u32(memory.recallCount), u32(memory.day),
      );
    }
    parts.push(u32(scenario.whispers.length));
    for (const voice of scenario.whispers) {
      parts.push(text(voice.id), f64(voice.createdAt), u32(voice.envelope.length));
      for (const value of voice.envelope) parts.push(f64(value));
      parts.push(
        f64(voice.lastReplayedAt), f64(voice.duration), f64(voice.brightness),
        f64(voice.position.x), f64(voice.position.y), f64(voice.strength),
        f64(voice.fidelity), u32(voice.recallCount), u32(voice.day),
      );
    }
    parts.push(u32(scenario.ticks.length));
    for (const spec of scenario.ticks) {
      parts.push(u32(spec.tracks.length));
      for (const t of spec.tracks) {
        const path = t.path ?? [];
        parts.push(
          u32(t.id),
          f64(t.position.x), f64(t.position.y), f64(t.position.t),
          f64(t.previous.x), f64(t.previous.y), f64(t.previous.t),
          f64(t.extent.width), f64(t.extent.height),
          Buffer.from([t.occluded ? 1 : 0]),
          u32(t.sightings ?? 5),
          f64(t.stillFor ?? 0),
          u32(path.length),
        );
        for (const point of path) parts.push(f64(point.x), f64(point.y), f64(point.t));
      }
      parts.push(f64(spec.ghostFrequency));
      parts.push(Buffer.from([LIFECYCLES.indexOf(spec.lifecycle)]));
      parts.push(f64(spec.emptySeconds), f64(spec.now), f64(spec.wall));
      if (spec.attention) {
        parts.push(Buffer.from([1]), u32(spec.attention.trackId), f64(spec.attention.weight));
      } else {
        parts.push(Buffer.from([0]));
      }
      parts.push(Buffer.from([spec.hasRecording ? 1 : 0]));
    }
  }
  return Buffer.concat(parts);
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
  steps,
  eventsSeen: [...branchesSeen].sort(),
  tolerance: TOLERANCE,
  worstTypescriptVsNative: worst,
  disagreements: found.slice(0, 20),
  disagreementCount: found.length,
  typescriptMs: tsMs,
  nativeMsIncludingCargo: nativeMs,
};
mkdirSync('reports/v2', { recursive: true });
writeFileSync('reports/v2/emergence-parity.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(report);
assert.equal(found.length, 0, `${found.length} disagreements; see reports/v2/emergence-parity.json`);
assert.ok(
  branchesSeen.size >= 5,
  `only ${branchesSeen.size} distinct events were ever reported: ${[...branchesSeen].join(', ')}`,
);
