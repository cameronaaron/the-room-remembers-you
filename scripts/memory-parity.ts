/**
 * Cross-implementation parity for what happens to a memory when the room
 * reaches for it.
 *
 * Two runtimes hold the same rules: `memory-engine.ts` and `memory-records.ts`
 * in TypeScript, and `room_engine::memory` compiled natively. This feeds
 * identical memories, an identical seed and an identical run of recalls to
 * both, and reports where they disagree.
 *
 * # Why this one needs a shared random stream
 *
 * Tracking, interest, the memory field and behaviour detection are all
 * deterministic given their observations. Recall is not: what a memory becomes
 * when it is replayed depends on a draw, and so does which memory the room
 * reaches for. Comparing two implementations of that is meaningless unless they
 * are given the same numbers in the same order, which is what `room-rng.ts` and
 * `room_engine::rng` are for.
 *
 * The scenario carries a *seed*, not a list of draws. A scenario that carried
 * the draws could not catch a leg that consumed them in the wrong order — and
 * draw order is the part of this most likely to be got wrong, because it is
 * invisible in every individual value.
 *
 * # What is compared
 *
 * Everything a recall changes, exactly: the whole mutated path, the fidelity,
 * the strength, the recall count, the composite's id and lineage, and which
 * memory a weighted choice landed on. There is no tolerance on the id, the
 * count or the choice; the tolerance on the numbers is stated below.
 *
 * # Why the WASM leg is absent
 *
 * These are not on the boundary. `room-wasm` exposes engines, not primitives,
 * and adding an export purely so a harness could call it would be a boundary
 * widened for the convenience of its own test. The native leg answers the
 * question that matters here — does the Rust do what the TypeScript does — and
 * `tests/vectors/rng.json` already holds the two generators to the same
 * stream, which is the part that could differ between targets.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  createFalseMemory,
  rememberGhost,
  rememberWhisper,
} from '../lib/memory-engine.ts';
import { chooseRareGhost } from '../lib/memory-records.ts';
import { RoomRng } from '../lib/room-rng.ts';
import type { Ghost, WhisperMemory } from '../lib/room-types.ts';

/**
 * Absolute agreement required on anything a recall computes.
 *
 * Fidelity, strength and every path coordinate are products and sums of the
 * same doubles in both languages, so they should agree exactly; the tolerance
 * is here because `normalizePath` divides by a total length and the two
 * compilers are free to contract differently. Chosen before the run rather
 * than rounded up to whatever it produced — if the measured error ever
 * approaches this, that is a finding.
 *
 * Ids, recall counts, lineages and choices carry no tolerance at all. Two
 * engines that remembered different things have not nearly agreed.
 */
const TOLERANCE = 1e-12;

/** Magic of the scenario file handed to the native leg. See the module docs. */
const SCENARIO_MAGIC = 'ROOMMEM1';

/** Step kinds. Mirrors the constants in `examples/memory-parity.rs`. */
const RECALL_GHOST = 0;
const RECALL_WHISPER = 1;
const COMPOSE = 2;
const CHOOSE = 3;

type Step = [kind: number, first: number, second: number, now: number];
type Scenario = {
  name: string;
  seed: number;
  ghosts: Ghost[];
  whispers: WhisperMemory[];
  steps: Step[];
};

const WALL = 1_757_000_000_000;

function ghost(id: string, points: number, age: number): Ghost {
  return {
    id,
    createdAt: WALL - age,
    lastReplayedAt: 0,
    path: Array.from({ length: points }, (_, step) => ({
      // A walk with corners in it, so smoothing has something to lose.
      x: 0.08 + (step % 7) * 0.11,
      y: 0.2 + Math.sin(step * 0.9) * 0.3,
      t: step * 120,
    })),
    dwellSeconds: 4 + points / 6,
    intensity: 0.42,
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
    createdAt: WALL - 600_000,
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

function scenarios(): Scenario[] {
  const built: Scenario[] = [];

  // A memory reached for all evening. The rule the piece rests on is that
  // nothing recalled remains unchanged, so this is the case where the two
  // implementations have the most opportunity to drift apart: each recall
  // feeds the next.
  built.push({
    name: 'one-memory-recalled-all-evening',
    seed: 12_345,
    ghosts: [ghost('g-1a2b3c', 40, 3_600_000)],
    whispers: [],
    steps: Array.from({ length: 400 }, (_, step): Step =>
      [RECALL_GHOST, 0, 0, WALL + step * 9_000]),
  });

  // A short path, which `rememberGhost` resamples *up* to its floor, and a long
  // one, which it resamples down to its ceiling. Both bounds are arithmetic the
  // two sides have to agree about.
  built.push({
    name: 'paths-at-both-resampling-bounds',
    seed: 999,
    ghosts: [ghost('g-short', 5, 60_000), ghost('g-long', 72, 60_000)],
    whispers: [],
    steps: Array.from({ length: 120 }, (_, step): Step =>
      [RECALL_GHOST, step % 2, 0, WALL + step * 5_000]),
  });

  // Voices thinning towards a shape. The envelope's stride depends on the
  // fidelity that the previous recall left, so this compounds the same way.
  built.push({
    name: 'voices-thinning-towards-a-shape',
    seed: 4_242,
    ghosts: [],
    whispers: [whisper('w-1a2b3c', 32), whisper('w-4d5e6f', 9)],
    steps: Array.from({ length: 200 }, (_, step): Step =>
      [RECALL_WHISPER, step % 2, 0, WALL + step * 7_000]),
  });

  // Compositing, including composites of composites: the case that produced an
  // unbounded id, and the one where lineage order and de-duplication matter.
  built.push({
    name: 'composites-of-composites',
    seed: 77,
    ghosts: [ghost('g-aaa', 30, 900_000), ghost('g-bbb', 26, 400_000)],
    whispers: [whisper('w-ccc', 12)],
    steps: Array.from({ length: 40 }, (_, step): Step =>
      [COMPOSE, step % 2, (step + 1) % (step + 2), WALL + step * 60_000]),
  });

  // The weighted choice, over a collection whose weights keep changing because
  // recalling a memory resets how recently it was shown.
  built.push({
    name: 'choosing-what-has-not-been-shown-lately',
    seed: 2_024,
    ghosts: Array.from({ length: 12 }, (_, index) =>
      ghost(`g-${index}`, 12 + index, 60_000 * (index + 1))),
    whispers: [],
    steps: Array.from({ length: 600 }, (_, step): Step =>
      (step % 3 === 0
        ? [CHOOSE, 0, 0, WALL + step * 3_000]
        : [RECALL_GHOST, step % 12, 0, WALL + step * 3_000])),
  });

  // Everything at once, which is the only scenario that checks the draw order
  // *between* subsystems: a run that interleaves them consumes the stream in an
  // order neither of the single-kind scenarios above can get wrong.
  built.push({
    name: 'a-gallery-evening-interleaved',
    seed: 8_675_309,
    ghosts: Array.from({ length: 6 }, (_, index) =>
      ghost(`g-${index}`, 16 + index * 4, 120_000 * (index + 1))),
    whispers: Array.from({ length: 3 }, (_, index) => whisper(`w-${index}`, 8 + index * 8)),
    steps: Array.from({ length: 900 }, (_, step): Step => {
      const now = WALL + step * 4_000;
      if (step % 11 === 0) return [CHOOSE, 0, 0, now];
      if (step % 7 === 0) return [COMPOSE, step % 6, (step + 3) % 6, now];
      if (step % 3 === 0) return [RECALL_WHISPER, step % 3, 0, now];
      return [RECALL_GHOST, step % 6, 0, now];
    }),
  });

  return built;
}

/** One ghost, flattened for comparison. Field order matches the Rust. */
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
    lineage: memory.lineage,
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

/**
 * The TypeScript leg.
 *
 * `rememberGhost` and `rememberWhisper` stamp `lastReplayedAt` from
 * `Date.now()`, which a pure engine cannot do and a replay cannot reproduce.
 * The harness overrides it to the scenario's clock so that the two legs are
 * compared on the arithmetic rather than on which of them ran first — and the
 * override is worth noticing, because it is the last clock read left in this
 * corner of the room.
 */
function typescriptLeg(scenario: Scenario): { steps: Described[]; draws: number } {
  const rng = new RoomRng(scenario.seed);
  const ghosts = scenario.ghosts.map((memory) => ({ ...memory }));
  const whispers = scenario.whispers.map((voice) => ({ ...voice }));
  const steps: Described[] = [];

  for (const [kind, first, second, now] of scenario.steps) {
    if (kind === RECALL_GHOST) {
      const recalled = { ...rememberGhost(ghosts[first], rng.draw), lastReplayedAt: now };
      ghosts[first] = recalled;
      steps.push(describeGhost(recalled));
    } else if (kind === RECALL_WHISPER) {
      const recalled = { ...rememberWhisper(whispers[first], rng.draw), lastReplayedAt: now };
      whispers[first] = recalled;
      steps.push(describeWhisper(recalled));
    } else if (kind === COMPOSE) {
      const made = createFalseMemory(ghosts[first], ghosts[second], now, whispers[0]);
      ghosts.push(made);
      steps.push(describeGhost(made));
    } else if (kind === CHOOSE) {
      // `chooseRareGhost` returns the memory; the Rust returns its index, and
      // both are reported as the id so the comparison names something a human
      // can find in the collection.
      const chose = ghosts.length ? chooseRareGhost(ghosts, now, rng.draw) : undefined;
      // The Rust draws before checking for an empty collection, so that turning
      // recall off does not shift the stream. The TypeScript's guard is here,
      // in the caller, which is where the shell's is too.
      if (!ghosts.length) rng.next();
      steps.push({ chose: chose ? chose.id : null });
    } else {
      throw new Error(`unknown step ${kind}`);
    }
  }
  return { steps, draws: rng.draws };
}

type Disagreement = {
  scenario: string;
  step: number;
  what: string;
  typescript: unknown;
  rust: unknown;
};

const sessions = scenarios();
const found: Disagreement[] = [];
let worst = 0;
let steps = 0;
let composites = 0;
let choices = 0;
let tsMs = 0;

const typescript = sessions.map((scenario) => {
  const start = performance.now();
  const leg = typescriptLeg(scenario);
  tsMs += performance.now() - start;
  return leg;
});

const workspace = mkdtempSync(join(tmpdir(), 'memory-parity-'));
let nativeMs = 0;
try {
  const file = join(workspace, 'scenarios.bin');
  writeFileSync(file, encodeScenarios(sessions));
  const start = performance.now();
  const native = spawnSync(
    'cargo',
    ['run', '--locked', '--quiet', '--release', '-p', 'room-engine',
      '--example', 'memory-parity', '--', file],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  nativeMs = performance.now() - start;
  assert.equal(native.status, 0, native.stderr);
  const reported = JSON.parse(native.stdout) as Array<{
    name: string;
    steps: Described[];
    draws: number;
  }>;
  assert.equal(reported.length, sessions.length);

  for (const [index, scenario] of sessions.entries()) {
    const mine = typescript[index];
    const theirs = reported[index];
    assert.equal(theirs.name, scenario.name, 'the legs disagree about which scenario is which');

    // The draw count is the cheapest possible check on order: two legs that
    // consumed the stream differently cannot have taken the same number of
    // values from it, whatever their outputs look like.
    if (mine.draws !== theirs.draws) {
      found.push({
        scenario: scenario.name,
        step: -1,
        what: 'draws taken from the stream',
        typescript: mine.draws,
        rust: theirs.draws,
      });
    }

    for (const [at, expected] of mine.steps.entries()) {
      const produced = theirs.steps[at];
      if (!produced) {
        found.push({
          scenario: scenario.name, step: at, what: 'missing', typescript: expected, rust: null,
        });
        continue;
      }
      if ('chose' in expected) choices += 1;
      if (expected.falseMemory === true) composites += 1;
      steps += 1;
      for (const key of Object.keys(expected)) {
        const left = expected[key];
        const right = produced[key];
        if (Array.isArray(left) && Array.isArray(right)) {
          if (left.length !== right.length) {
            found.push({
              scenario: scenario.name,
              step: at,
              what: `${key}.length`,
              typescript: left.length,
              rust: right.length,
            });
            continue;
          }
          for (const [slot, value] of left.entries()) {
            if (typeof value === 'number' && typeof right[slot] === 'number') {
              const delta = Math.abs(value - (right[slot] as number));
              worst = Math.max(worst, delta);
              if (delta > TOLERANCE) {
                found.push({
                  scenario: scenario.name,
                  step: at,
                  what: `${key}[${slot}]`,
                  typescript: value,
                  rust: right[slot],
                });
              }
            } else if (value !== right[slot]) {
              found.push({
                scenario: scenario.name,
                step: at,
                what: `${key}[${slot}]`,
                typescript: value,
                rust: right[slot],
              });
            }
          }
          continue;
        }
        if (typeof left === 'number' && typeof right === 'number') {
          const delta = Math.abs(left - right);
          worst = Math.max(worst, delta);
          if (delta > TOLERANCE) {
            found.push({ scenario: scenario.name, step: at, what: key, typescript: left, rust: right });
          }
          continue;
        }
        if (left !== right) {
          found.push({ scenario: scenario.name, step: at, what: key, typescript: left, rust: right });
        }
      }
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

/**
 * Write the scenarios as raw little-endian values.
 *
 * `ROOMMEM1`, a scenario count, then per scenario a length-prefixed name, the
 * seed, the memories, and the steps. The reader in `examples/memory-parity.rs`
 * checks every read and refuses a file with trailing bytes, so a layout change
 * here fails loudly instead of decoding as a different session.
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
    parts.push(u32(scenario.steps.length));
    for (const step of scenario.steps) for (const value of step) parts.push(f64(value));
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
  scenarios: sessions.map((scenario) => ({ name: scenario.name, steps: scenario.steps.length })),
  steps,
  /** Composites made, and choices taken. A run that made none proves nothing. */
  composites,
  choices,
  tolerance: TOLERANCE,
  worstTypescriptVsNative: worst,
  disagreements: found.slice(0, 20),
  disagreementCount: found.length,
  typescriptMs: tsMs,
  nativeMsIncludingCargo: nativeMs,
};
mkdirSync('reports/v2', { recursive: true });
writeFileSync('reports/v2/memory-parity.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(report);
assert.equal(found.length, 0, `${found.length} disagreements; see reports/v2/memory-parity.json`);
assert.ok(composites >= 40, `only ${composites} composites; a run that made none proves nothing`);
assert.ok(choices >= 100, `only ${choices} weighted choices were compared`);
