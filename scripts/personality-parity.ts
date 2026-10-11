/**
 * Cross-implementation parity for the room's mood.
 *
 * Two runtimes hold the same rules: `choosePersonality` in
 * `lib/memory-engine.ts`, and `room_engine::personality` compiled natively.
 * This feeds identical synthetic frames to both and reports where they
 * disagree.
 *
 * # What is compared
 *
 * Which of the eight moods each side names, exactly — there is no tolerance
 * on the answer itself, because it is a discrete choice, not a measurement.
 *
 * # Why the scenario is not JSON
 *
 * `choosePersonality` carries no state between calls and draws from no RNG,
 * unlike recall, so there is no compounding to worry about here. But the
 * point of this harness is specifically to compare exact threshold values —
 * a density of precisely `0.004`, a speed of precisely `0.18` — against
 * strict `</>` comparisons, which is exactly the case a single one-ULP
 * `serde_json` rounding error (see `docs/ARCHITECTURE.md`) would falsify
 * silently rather than loudly. The scenario therefore arrives as raw
 * little-endian `f64`, like every other harness here. Results go back as
 * JSON, which is safe in that direction.
 *
 * # Why the WASM leg is absent
 *
 * Same reason as recall: this is not on the boundary. `room-wasm` exposes
 * engines, not primitives, and personality is called directly from
 * `components/room-installation.tsx` in TypeScript with no plan to change
 * that. The native leg answers the only question that matters here — does
 * the Rust decide what the TypeScript decides.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { choosePersonality } from '../lib/memory-engine.ts';
import type { RoomPersonality, VisitorTrack } from '../lib/room-types.ts';

/** Magic of the scenario file handed to the native leg. See the module docs. */
const SCENARIO_MAGIC = 'ROOMPER1';

/**
 * Wire order for `RoomPersonality`. Mirrors `room_protocol::Personality`'s
 * declaration order exactly (`crates/room-protocol/src/snapshot.rs`) and the
 * `Reader::personality` match in `examples/personality-parity.rs`; changing
 * the order on either side without the other is exactly the bug this harness
 * exists to catch, so it is spelled out here rather than derived.
 */
const PERSONALITIES: readonly RoomPersonality[] = [
  'dormant',
  'curious',
  'attentive',
  'crowded',
  'overwhelmed',
  'lonely',
  'remembering',
  'forgetting',
];

type TrackSample = { speed: number; stillFor: number };
type Step = {
  tracks: TrackSample[];
  emptySeconds: number;
  density: number;
  previous: RoomPersonality;
};
type Scenario = { name: string; steps: Step[] };

/** A minimal `VisitorTrack`: `choosePersonality` reads only these two fields. */
function trackOf(sample: TrackSample): VisitorTrack {
  return {
    id: 't',
    bornAt: 0,
    lastSeen: 0,
    position: { x: 0, y: 0, t: 0 },
    previous: { x: 0, y: 0, t: 0 },
    velocity: { x: 0, y: 0 },
    speed: sample.speed,
    stillFor: sample.stillFor,
    dwellSeconds: 0,
    path: [],
    active: true,
    occluded: false,
    confidence: 1,
    sightings: 5,
    extent: { width: 0.1, height: 0.24 },
  };
}

function scenarios(): Scenario[] {
  const built: Scenario[] = [];

  // A crowd arrives, grows past every headcount threshold, then stops moving.
  built.push({
    name: 'a-crowd-arrives-and-settles',
    steps: [
      { tracks: [], emptySeconds: 0, density: 0.0005, previous: 'dormant' },
      {
        tracks: [{ speed: 0.3, stillFor: 0 }, { speed: 0.3, stillFor: 0 }],
        emptySeconds: 0,
        density: 0.02,
        previous: 'dormant',
      },
      {
        tracks: Array.from({ length: 5 }, () => ({ speed: 0.3, stillFor: 0 })),
        emptySeconds: 0,
        density: 0.03,
        previous: 'attentive',
      },
      {
        tracks: Array.from({ length: 9 }, () => ({ speed: 0.3, stillFor: 0 })),
        emptySeconds: 0,
        density: 0.03,
        previous: 'crowded',
      },
      {
        tracks: [{ speed: 0, stillFor: 20 }, { speed: 0, stillFor: 20 }],
        emptySeconds: 0,
        density: 0.03,
        previous: 'overwhelmed',
      },
    ],
  });

  // One visitor, slow the whole time: curious on arrival, attentive once the
  // room has already noticed them, remembering once they stop.
  built.push({
    name: 'a-lone-visitor-lingers',
    steps: [
      { tracks: [{ speed: 0.02, stillFor: 0 }], emptySeconds: 0, density: 0.001, previous: 'dormant' },
      { tracks: [{ speed: 0.02, stillFor: 0 }], emptySeconds: 0, density: 0.001, previous: 'curious' },
      { tracks: [{ speed: 0.02, stillFor: 16 }], emptySeconds: 0, density: 0.001, previous: 'attentive' },
    ],
  });

  // The room empties and, over the following steps, forgets outright — and
  // once it has, a lower density does not undo that.
  built.push({
    name: 'the-room-empties-and-forgets',
    steps: [
      { tracks: [], emptySeconds: 50, density: 0.01, previous: 'remembering' },
      { tracks: [], emptySeconds: 150, density: 0.01, previous: 'remembering' },
      { tracks: [], emptySeconds: 1_500, density: 0.01, previous: 'lonely' },
      { tracks: [], emptySeconds: 3_000, density: 0.0001, previous: 'forgetting' },
    ],
  });

  // Every threshold, hovered on both sides. This is the point of the harness:
  // agreement on a value a hair off the line is not agreement on the line.
  built.push({
    name: 'hovering-at-every-threshold',
    steps: [
      // headcount
      { tracks: Array.from({ length: 8 }, () => ({ speed: 0, stillFor: 0 })), emptySeconds: 0, density: 0, previous: 'dormant' },
      { tracks: Array.from({ length: 7 }, () => ({ speed: 0.5, stillFor: 0 })), emptySeconds: 0, density: 0, previous: 'dormant' },
      { tracks: Array.from({ length: 4 }, () => ({ speed: 0.5, stillFor: 0 })), emptySeconds: 0, density: 0, previous: 'dormant' },
      // stillness
      { tracks: [{ speed: 0, stillFor: 15 }, { speed: 0, stillFor: 15 }], emptySeconds: 0, density: 0, previous: 'dormant' },
      { tracks: [{ speed: 0, stillFor: 14.999 }], emptySeconds: 0, density: 0, previous: 'dormant' },
      // speed, both sides of the tie
      { tracks: [{ speed: 0.18, stillFor: 0 }], emptySeconds: 0, density: 0, previous: 'dormant' },
      { tracks: [{ speed: 0.180_000_01, stillFor: 0 }], emptySeconds: 0, density: 0, previous: 'dormant' },
      // emptiness -> forgetting
      { tracks: [], emptySeconds: 1_200, density: 0.5, previous: 'lonely' },
      { tracks: [], emptySeconds: 1_200.000_1, density: 0.5, previous: 'lonely' },
      // emptiness + density -> lonely
      { tracks: [], emptySeconds: 120, density: 0.005, previous: 'dormant' },
      { tracks: [], emptySeconds: 120.000_1, density: 0.004, previous: 'dormant' },
      { tracks: [], emptySeconds: 120.000_1, density: 0.004_000_1, previous: 'dormant' },
      // idle density -> dormant
      { tracks: [], emptySeconds: 0, density: 0.001, previous: 'attentive' },
      { tracks: [], emptySeconds: 0, density: 0.000_999_9, previous: 'attentive' },
    ],
  });

  return built;
}

type Disagreement = {
  scenario: string;
  step: number;
  typescript: string;
  rust: string;
};

function typescriptLeg(scenario: Scenario): RoomPersonality[] {
  return scenario.steps.map((step) =>
    choosePersonality(step.tracks.map(trackOf), step.emptySeconds, step.density, step.previous));
}

const sessions = scenarios();
const found: Disagreement[] = [];
const seen = new Set<RoomPersonality>();
let steps = 0;
let tsMs = 0;

const typescript = sessions.map((scenario) => {
  const start = performance.now();
  const leg = typescriptLeg(scenario);
  tsMs += performance.now() - start;
  for (const mood of leg) seen.add(mood);
  return leg;
});

const workspace = mkdtempSync(join(tmpdir(), 'personality-parity-'));
let nativeMs = 0;
try {
  const file = join(workspace, 'scenarios.bin');
  writeFileSync(file, encodeScenarios(sessions));
  const start = performance.now();
  const native = spawnSync(
    'cargo',
    ['run', '--locked', '--quiet', '--release', '-p', 'room-engine',
      '--example', 'personality-parity', '--', file],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
  );
  nativeMs = performance.now() - start;
  assert.equal(native.status, 0, native.stderr);
  const reported = JSON.parse(native.stdout) as Array<{ name: string; steps: string[] }>;
  assert.equal(reported.length, sessions.length);

  for (const [index, scenario] of sessions.entries()) {
    const mine = typescript[index];
    const theirs = reported[index];
    assert.equal(theirs.name, scenario.name, 'the legs disagree about which scenario is which');
    assert.equal(theirs.steps.length, mine.length, `${scenario.name}: step count disagrees`);
    for (const [at, expected] of mine.entries()) {
      const produced = theirs.steps[at];
      steps += 1;
      if (expected !== produced) {
        found.push({ scenario: scenario.name, step: at, typescript: expected, rust: produced });
      }
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

/**
 * Write the scenarios as raw little-endian values.
 *
 * `ROOMPER1`, a scenario count, then per scenario a length-prefixed name and a
 * step count, and per step a track count, that many `(speed, stillFor)`
 * pairs, `emptySeconds`, `density`, and a one-byte `previous` tag from
 * `PERSONALITIES`. The reader in `examples/personality-parity.rs` checks
 * every read and refuses a file with trailing bytes, so a layout change here
 * fails loudly instead of decoding as a different session.
 */
function encodeScenarios(built: Scenario[]): Buffer {
  const parts: Buffer[] = [Buffer.from(SCENARIO_MAGIC, 'ascii'), u32(built.length)];
  for (const scenario of built) {
    parts.push(text(scenario.name), u32(scenario.steps.length));
    for (const step of scenario.steps) {
      parts.push(u32(step.tracks.length));
      for (const track of step.tracks) parts.push(f64(track.speed), f64(track.stillFor));
      parts.push(f64(step.emptySeconds), f64(step.density));
      const tag = PERSONALITIES.indexOf(step.previous);
      assert.notEqual(tag, -1, `unknown personality ${step.previous}`);
      parts.push(Buffer.from([tag]));
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
  scenarios: sessions.map((scenario) => ({ name: scenario.name, steps: scenario.steps.length })),
  steps,
  /** Distinct moods actually returned. A run that reached fewer than all
   *  eight has not exercised every branch, whatever it agreed on. */
  branchesCovered: seen.size,
  moodsSeen: [...seen].sort(),
  tolerance: 0,
  disagreements: found.slice(0, 20),
  disagreementCount: found.length,
  typescriptMs: tsMs,
  nativeMsIncludingCargo: nativeMs,
};
mkdirSync('reports/v2', { recursive: true });
writeFileSync('reports/v2/personality-parity.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(report);
assert.equal(found.length, 0, `${found.length} disagreements; see reports/v2/personality-parity.json`);
assert.equal(seen.size, 8, `only ${seen.size} of 8 moods were reached: ${[...seen].join(', ')}`);
