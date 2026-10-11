/**
 * Cross-implementation parity for the room's interest.
 *
 * Three runtimes hold the same rules: `RoomAttention` and `EvidenceGate` in
 * TypeScript, `room_engine::attention` compiled natively, and the same Rust
 * compiled to WASM. This feeds identical synthetic sessions to all three and
 * reports where they disagree.
 *
 * What it is *not*: proof that the Rust is correct. It is proof that it does
 * what the implementation the gallery has been running does. The TypeScript is
 * the behavioural specification — the eight-minute rest came from a measured
 * 96.8% occupancy with it set to zero, the twenty-second evidence gap came from
 * the room becoming interested in the first person who stopped walking — and
 * the gate here is that none of those lessons was lost in translation.
 *
 * The scenarios are chosen to hit the decisions, not to look like a gallery: a
 * passer-by who must never be chosen, a threshold crossed, a spell run to its
 * end, the rest period held against someone who deserves attention, a subject
 * who leaves mid-spell, a tie between two visitors on one frame, evidence aged
 * out of its window, and a crowd. A scenario in which nobody is ever chosen
 * agrees trivially, so `spells` in the report is the number that says the run
 * was worth anything.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { initSync, WasmAttentionEngine } from '../public/wasm/room_wasm.js';
import { AttentionRuntime } from '../lib/attention-runtime.ts';
import { RoomAttention } from '../lib/attention.ts';
import { EvidenceGate } from '../lib/attention-evidence.ts';
import {
  decodeAttentionFrame,
  encodeAttentionFrame,
  type Filing,
  type Presence,
} from '../lib/attention-bridge.ts';
import type { VisitorTrack } from '../lib/room-types.ts';

/**
 * Absolute agreement required on an interest weight.
 *
 * The weight is a ratio of two clock readings and reaches the artwork as a
 * deposit multiplier and a preference in the voice. A millionth of it is
 * several orders of magnitude below anything a visitor could see. Chosen before
 * the run rather than rounded up to whatever the run produced — if the measured
 * error ever approaches this, that is a finding, not a reason to move it.
 */
const TOLERANCE = 1e-9;

/**
 * Magic of the scenario file handed to the native leg.
 *
 * Raw little-endian `f64` rather than JSON, and that is a measurement rather
 * than a preference: `serde_json` 1.0.151 does not always parse a
 * seventeen-digit decimal to the nearest `f64`, and here a timestamp one unit
 * in the last place early is a filing on the wrong side of a twenty-second
 * gate — a different session, not a rounding difference. See
 * `docs/ARCHITECTURE.md`.
 */
const SCENARIO_MAGIC = 'ROOMATT1';

/** Sensing interval used by the scenarios, roughly the STANDARD profile. */
const FRAME_MS = 50;

type Frame = { now: number; filings: Filing[]; present: Presence[] };
type Scenario = { name: string; frames: Frame[] };

const track = (id: number, dwellSeconds = 0, stillFor = 0): Presence =>
  ({ id: `t-${id}`, dwellSeconds, stillFor });

function scenarios(): Scenario[] {
  const built: Scenario[] = [];
  const add = (name: string, frames: number, at: (frame: number) => Omit<Frame, 'now'>) => {
    built.push({
      name,
      frames: Array.from({ length: frames }, (_, frame) => ({
        now: frame * FRAME_MS,
        ...at(frame),
      })),
    });
  };

  // Rule 1, and the baseline. Someone walks through for eight seconds and does
  // nothing else. If the room ever attends to them, nothing below matters.
  add('passer-by', 160, (frame) => ({
    filings: [],
    present: [track(1, frame * FRAME_MS / 1000, 0)],
  }));

  // Somebody stands still for four minutes. The gate is the only thing between
  // this and a room that attends to whoever stops first.
  add('someone-stands-still', 4_800, (frame) => ({
    filings: [],
    present: [track(1, 40 + frame * FRAME_MS / 1000, 30)],
  }));

  // A full spell: earned, risen, held, faded, and then the rest period, with a
  // second visitor offering evidence throughout who must not be chosen.
  add('a-spell-and-then-the-rest', 24_000, (frame) => ({
    // Revisits at their own 40 s cooldown, from both people.
    filings: frame % 800 === 0 && frame > 0
      ? [
          { kind: 'revisit', trackId: 't-1', at: frame * FRAME_MS },
          { kind: 'revisit', trackId: 't-2', at: frame * FRAME_MS },
        ] as Filing[]
      : [],
    present: [track(1, 60, 30), track(2, 60, 30)],
  }));

  // Rule 2: the subject leaves in the middle of the spell. Interest must end,
  // must not transfer to the person still standing there, and the rest must
  // start from the departure.
  add('the-subject-leaves-mid-spell', 4_000, (frame) => ({
    filings: frame === 10
      ? [
          { kind: 'revisit', trackId: 't-1', at: 10 * FRAME_MS },
          // Filed after the previous frame's step, as the shell files it.
          { kind: 'crossing', trackId: 't-1', at: 9 * FRAME_MS },
        ] as Filing[]
      : [],
    present: frame < 400 ? [track(1, 60, 30), track(2, 60, 30)] : [track(2, 60, 30)],
  }));

  // Two visitors reach the same total on the same frame. Insertion order
  // decides, which is the case a hash map would get wrong in both languages.
  add('a-tie-on-one-frame', 400, (frame) => ({
    filings: frame === 5
      ? [
          { kind: 'revisit', trackId: 't-2', at: 5 * FRAME_MS },
          { kind: 'revisit', trackId: 't-1', at: 5 * FRAME_MS },
          { kind: 'revisit', trackId: 't-2', at: 5 * FRAME_MS },
          { kind: 'revisit', trackId: 't-1', at: 5 * FRAME_MS },
        ] as Filing[]
      : [],
    present: [track(1), track(2)],
  }));

  // Evidence offered just slower than the window, so it can never accumulate
  // into a spell. The room must stay uninterested for the whole session.
  add('evidence-aged-out-of-its-window', 8_000, (frame) => ({
    filings: frame % 2_000 === 0
      ? [{ kind: 'revisit', trackId: 't-1', at: frame * FRAME_MS }] as Filing[]
      : [],
    present: [track(1)],
  }));

  // The one frame on which "when it happened" and "when it arrived" disagree.
  //
  // A crossing is filed after the step, so it reaches the engine one frame
  // later. Aged from the instant it happened it leaves the ninety-second
  // window at t=90 050; aged from the instant it arrived it would still be
  // held there. The scenario delivers a second crossing on exactly that frame,
  // where the difference decides whether the room becomes interested — 1.34
  // against 0.92 — and then earns a spell cleanly ten seconds later so the
  // session is not only a negative. Nobody may dwell or stand still here, or
  // the gate's own filings drown the arithmetic under test.
  add('a-filing-on-the-edge-of-its-window', 2_200, (frame) => {
    const now = frame * FRAME_MS;
    const filings: Filing[] = [];
    if (frame === 1) {
      filings.push({ kind: 'crossing', trackId: 't-1', at: 0 });
      filings.push({ kind: 'revisit', trackId: 't-1', at: now });
    }
    if (frame === 1_801) filings.push({ kind: 'crossing', trackId: 't-1', at: now });
    if (frame === 2_000) {
      filings.push({ kind: 'revisit', trackId: 't-1', at: now });
      filings.push({ kind: 'crossing', trackId: 't-1', at: now });
      filings.push({ kind: 'revisit', trackId: 't-1', at: now });
    }
    return { filings, present: [track(1)] };
  });

  // Six people milling, all dwelling and all occasionally still, with crossings
  // landing on whoever the room happened to disturb. The case where the
  // candidate search actually has to choose.
  add('a-crowd-worth-choosing-from', 12_000, (frame) => ({
    filings: frame % 4_800 === 0 && frame > 0
      // A crossing is always a frame old by the time it is sent.
      ? [{ kind: 'crossing', trackId: `t-${frame % 6}`, at: (frame - 1) * FRAME_MS }] as Filing[]
      : [],
    present: Array.from({ length: 6 }, (_, person) => track(
      person,
      // Staggered, so the dwell gate fires for different people at different
      // times and the order evidence arrives in is not the order of the array.
      30 + person * 7 + frame * FRAME_MS / 1000,
      person % 2 === 0 ? 14 : 0,
    )),
  }));

  // Arrivals and departures for an hour of virtual gallery time: nothing may
  // accumulate across the gaps, and a new visitor must be able to earn the
  // room's interest once the rest from the last one has run out.
  add('an-hour-of-arrivals-and-departures', 20_000, (frame) => {
    const visitor = Math.floor(frame / 500);
    const inside = frame % 500 < 400;
    return {
      filings: inside && frame % 500 === 50
        ? [
            { kind: 'revisit', trackId: `t-${visitor}`, at: frame * FRAME_MS },
            { kind: 'crossing', trackId: `t-${visitor}`, at: (frame - 1) * FRAME_MS },
          ] as Filing[]
        : [],
      present: inside ? [track(visitor, 60, 20)] : [],
    };
  });

  return built;
}

type Decision = { trackId: string | null; weight: number };

/**
 * The TypeScript leg, run in the shell's own order.
 *
 * `room-installation.tsx` files behaviours first, then the gate, then updates.
 * That order is part of the contract — it settles a tie — so the harness
 * reproduces it rather than doing whatever is convenient here.
 */
function typescriptLeg(scenario: Scenario): Decision[] {
  const room = new RoomAttention();
  const gate = new EvidenceGate();
  return scenario.frames.map((frame) => {
    // Each filing at the instant it happened, not at the instant it arrived.
    // The shell files a crossing after the step, so it reaches the next one
    // already a frame old, and both legs must age it from the same moment.
    for (const filing of frame.filings) room.observe(filing.kind, filing.trackId, filing.at);
    const tracks = frame.present.map((entry) => ({
      id: entry.id,
      dwellSeconds: entry.dwellSeconds,
      stillFor: entry.stillFor,
    })) as VisitorTrack[];
    for (const evidence of gate.observe(tracks, frame.now)) {
      room.observe(evidence.kind, evidence.trackId, frame.now);
    }
    room.update(frame.present.map((entry) => entry.id), frame.now);
    const focus = room.focus(frame.now);
    return { trackId: focus?.trackId ?? null, weight: focus?.weight ?? 0 };
  });
}

type Disagreement = {
  scenario: string;
  frame: number;
  what: string;
  typescript: string | number;
  rust: string | number;
};

const wasm = initSync({
  module: readFileSync(new URL('../public/wasm/room_wasm_bg.wasm', import.meta.url)),
});
const initialBytes = wasm.memory.buffer.byteLength;
const sessions = scenarios();
const found: Disagreement[] = [];
const worst = { value: 0 };
let wasmMs = 0;
let tsMs = 0;
let frames = 0;
let spells = 0;

for (const scenario of sessions) {
  let start = performance.now();
  const typescript = typescriptLeg(scenario);
  tsMs += performance.now() - start;

  const engine = new WasmAttentionEngine();
  let attended: string | null = null;
  try {
    for (const [index, frame] of scenario.frames.entries()) {
      const packed = encodeAttentionFrame(frame.now, frame.filings, frame.present);
      start = performance.now();
      const out = engine.step(packed);
      wasmMs += performance.now() - start;
      const rust = decodeAttentionFrame(out);
      const left = typescript[index];

      if (left.trackId !== rust.trackId) {
        found.push({
          scenario: scenario.name,
          frame: index,
          what: 'trackId',
          typescript: left.trackId ?? 'nobody',
          rust: rust.trackId ?? 'nobody',
        });
      }
      const delta = Math.abs(left.weight - rust.weight);
      worst.value = Math.max(worst.value, delta);
      if (delta > TOLERANCE) {
        found.push({
          scenario: scenario.name,
          frame: index,
          what: 'weight',
          typescript: left.weight,
          rust: rust.weight,
        });
      }
      // Count the spells, so a run in which nobody was ever chosen cannot pass
      // itself off as agreement.
      if (rust.trackId !== null && rust.trackId !== attended) spells += 1;
      attended = rust.trackId;
      frames += 1;
    }
  } finally {
    engine.free();
  }
}

// Exercise the adapter the live React shell uses, with real WASM, rather than
// only the standalone decoder. Three things live only in that adapter and in
// nothing above: the shell's spelling of a track id against the engine's, the
// filing buffer that carries a crossing into the following frame, and the
// per-frame read model. A scenario that agrees here agrees as the gallery runs
// it, which is a different claim from agreeing as the harness calls it.
//
// The runtime retires WASM on any disagreement, so its label is the assertion:
// there is no way for it to fall back quietly and still look like a pass.
let liveSpells = 0;
for (const scenario of sessions) {
  const runtime = new AttentionRuntime(new WasmAttentionEngine());
  try {
    let attended: string | null = null;
    for (const frame of scenario.frames) {
      // The shell spells a track `visitor-<birth in base 36>-<sequence>`; the
      // scenarios are written in the engine's own `t-<sequence>`. Translating
      // here is what puts the adapter's own translation under test.
      const spell = (id: string) => `visitor-abc-${id.slice(2)}`;
      for (const filing of frame.filings) {
        runtime.observe(filing.kind, spell(filing.trackId), filing.at);
      }
      const tracks = frame.present.map((entry) => ({
        id: spell(entry.id),
        dwellSeconds: entry.dwellSeconds,
        stillFor: entry.stillFor,
      })) as VisitorTrack[];
      const decided = runtime.update(tracks, frame.now);
      assert.match(runtime.label, /^Rust\/WASM/,
        `${scenario.name}: the live adapter fell back — ${runtime.label}`);
      if (decided.trackId !== null && decided.trackId !== attended) liveSpells += 1;
      attended = decided.trackId;
    }
    runtime.reset();
    runtime.update([], scenario.frames.at(-1)!.now);
    assert.match(runtime.label, /^Rust\/WASM/, 'a reset must keep both engines aligned');
  } finally {
    runtime.dispose();
  }
}
// The same guard the WASM leg carries: a run in which nobody was ever chosen
// cannot pass itself off as agreement about choosing.
assert.ok(liveSpells >= 8, `the live adapter reached only ${liveSpells} spells`);

// The native leg. Same Rust, different target: the interest rules reach no
// transcendental functions at all, so this is the leg that should never move —
// which is what makes it worth running. A divergence here is a finding about
// the toolchain, not about the artwork.
const workspace = mkdtempSync(join(tmpdir(), 'attention-parity-'));
let nativeWorst = 0;
try {
  const file = join(workspace, 'scenarios.bin');
  writeFileSync(file, encodeScenarios(sessions));
  const native = spawnSync(
    'cargo',
    ['run', '--locked', '--quiet', '--release', '-p', 'room-engine', '--example', 'attention-parity', '--', file],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  assert.equal(native.status, 0, native.stderr);
  const reported = JSON.parse(native.stdout) as Array<{ name: string; frames: number[][] }>;
  assert.equal(reported.length, sessions.length);

  for (const [index, scenario] of sessions.entries()) {
    const engine = new WasmAttentionEngine();
    try {
      for (const [frame, step] of scenario.frames.entries()) {
        const produced = [...engine.step(encodeAttentionFrame(step.now, step.filings, step.present))];
        const expected = reported[index].frames[frame];
        assert.equal(produced.length, expected.length,
          `${scenario.name} frame ${frame}: native reported ${expected.length} values, wasm ${produced.length}`);
        for (let value = 0; value < produced.length; value += 1) {
          const delta = Math.abs(produced[value] - expected[value]);
          nativeWorst = Math.max(nativeWorst, delta);
          if (delta > TOLERANCE) {
            found.push({
              scenario: `${scenario.name} (native vs wasm)`,
              frame,
              what: `value[${value}]`,
              typescript: expected[value],
              rust: produced[value],
            });
          }
        }
      }
    } finally {
      engine.free();
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

/**
 * Write the scenarios as raw little-endian values.
 *
 * `ROOMATT1`, a scenario count, then per scenario a length-prefixed name, a
 * frame count, and per frame a length-prefixed run of the packed engine frame.
 * The reader in `examples/attention-parity.rs` checks every read and refuses a
 * file with trailing bytes, so a layout change here fails loudly instead of
 * decoding as a different session.
 */
function encodeScenarios(built: Scenario[]): Buffer {
  const parts: Buffer[] = [Buffer.from(SCENARIO_MAGIC, 'ascii'), u32(built.length)];
  for (const scenario of built) {
    const name = Buffer.from(scenario.name, 'utf8');
    parts.push(u32(name.length), name, u32(scenario.frames.length));
    for (const frame of scenario.frames) {
      const packed = encodeAttentionFrame(frame.now, frame.filings, frame.present);
      const values = Buffer.alloc(4 + packed.length * 8);
      values.writeUInt32LE(packed.length, 0);
      for (const [index, value] of packed.entries()) values.writeDoubleLE(value, 4 + index * 8);
      parts.push(values);
    }
  }
  return Buffer.concat(parts);
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

const report = {
  scenarios: sessions.map((scenario) => ({ name: scenario.name, frames: scenario.frames.length })),
  frames,
  spells,
  /** Spells reached through the adapter the shell actually runs. */
  liveAdapterSpells: liveSpells,
  tolerance: TOLERANCE,
  worstTypescriptVsWasm: worst.value,
  worstNativeVsWasm: nativeWorst,
  disagreements: found.slice(0, 20),
  disagreementCount: found.length,
  wasmMsPerFrameIncludingCopies: wasmMs / frames,
  typescriptMsPerFrame: tsMs / frames,
  wasmInitialBytes: initialBytes,
  wasmFinalBytes: wasm.memory.buffer.byteLength,
};
mkdirSync('reports/v2', { recursive: true });
writeFileSync('reports/v2/attention-parity.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(report);
assert.equal(found.length, 0, `${found.length} disagreements; see reports/v2/attention-parity.json`);
assert.ok(
  spells >= 8,
  `only ${spells} spells of interest across the run; a session nobody is chosen in agrees trivially`,
);
assert.ok(
  wasm.memory.buffer.byteLength - initialBytes <= 2 * 1024 * 1024,
  'the interest engine must not grow the WASM heap across a session',
);
