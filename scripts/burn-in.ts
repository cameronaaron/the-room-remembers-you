import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  createFalseMemory,
  createMemoryField,
  decayMemory,
  decayStrength,
  depositMemory,
  memoryDensity,
  simplifyPath,
} from '../lib/memory-engine.ts';
import { CROSSING_COOLDOWN_MS, MemoryCollisions } from '../lib/memory-disturbance.ts';
import { AttentionRuntime } from '../lib/attention-runtime.ts';
import { RECALL_PRESENTATION } from '../lib/swarm.ts';
import { AnonymousTrackManager } from '../lib/motion-tracker.ts';
import { GallerySimulation } from '../lib/simulation.ts';
import { DEFAULT_CONFIG } from '../lib/room-types.ts';
import type { AnonymousSensorEvent, Ghost, VisitorTrack, WhisperMemory } from '../lib/room-types.ts';

const VIRTUAL_HOURS = 12;
const VIRTUAL_SECONDS = VIRTUAL_HOURS * 3600;

/**
 * heapUsed sampled without collecting first measures whatever garbage happens
 * to be uncollected at that instant, not what the room retains. Identical runs
 * of this script reported 9.34 MB and 75.17 MB while producing byte-identical
 * state, so the number could neither catch a leak nor be trusted when it rose.
 * Collecting on both sides makes it a retention measurement and reproducible.
 */
const collect = globalThis.gc;
assert.ok(collect, 'burn-in must run with --expose-gc; heap growth is unmeasurable without it');
function retainedHeap(): number {
  collect!();
  collect!();
  return process.memoryUsage().heapUsed;
}

const startHeap = retainedHeap();
const field = createMemoryField();
const simulation = new GallerySimulation(0xdecafbad);
const manager = new AnonymousTrackManager();
const collisions = new MemoryCollisions();
const attention = new AttentionRuntime();
let disturbances = 0;
/** Seconds of the gallery day on which the room was interested in somebody. */
let attendedSeconds = 0;
let attentionSpells = 0;
let wasAttending = false;
const ghosts: Ghost[] = [];
const whispers: WhisperMemory[] = [];
const events: AnonymousSensorEvent[] = [];
simulation.reset(0);

for (let second = 0; second < VIRTUAL_SECONDS; second += 1) {
  const virtualNow = second * 1000;
  const simulationClock = (second * 1000) / 60;
  const blobs = simulation.sample(simulationClock, 60, 'FULL');
  const { active, ended } = manager.update(blobs, virtualNow);
  // The room's one preference, driven through the adapter the shell runs, so
  // that twelve virtual hours are twelve hours of what ships. Dwelling and
  // stopping are read from the tracks by the engine's own rate-limited gate —
  // evidence is an event, and a standing visitor would otherwise file one on
  // every tick — and crossing an old path is filed below, with the collision.
  const present = active.filter((track) => !track.occluded);
  const attending = attention.update(present, virtualNow).trackId !== null;
  if (attending) attendedSeconds += 1;
  if (attending && !wasAttending) attentionSpells += 1;
  wasAttending = attending;

  for (const track of active) {
    if (!track.occluded) {
      depositMemory(
        field,
        track.position,
        (track.speed < 0.025 ? 0.0018 : 0.0008) * attention.depositScale(track.id),
        2,
      );
    }
  }
  for (const track of ended) {
    if (track.path.length < 5) continue;
    ghosts.push({
      id: `burn-${second}-${ghosts.length}`,
      createdAt: virtualNow,
      lastReplayedAt: 0,
      path: simplifyPath(track.path),
      dwellSeconds: track.dwellSeconds,
      intensity: 0.35,
      strength: 0.48,
      fidelity: 1,
      recallCount: 0,
      lineage: [track.id],
      falseMemory: false,
      day: 1,
    });
  }
  if (second > 0 && second % 3600 === 0 && ghosts.length >= 2) {
    ghosts.push(createFalseMemory(ghosts[ghosts.length - 1], ghosts[ghosts.length - 2], virtualNow));
  }
  if (second % 53 === 0) {
    whispers.push({
      id: `whisper-${second}`, createdAt: virtualNow, lastReplayedAt: 0, duration: 1.2,
      envelope: [0.1, 0.45, 0.7, 0.35, 0.12], brightness: 0.4,
      position: { x: (second % 997) / 997, y: 0.5 }, strength: 0.38,
      fidelity: 1, recallCount: 0, lineage: [`whisper-${second}`], day: 1,
    });
  }
  if (second % 10 === 0) {
    events.push({
      t: virtualNow,
      people: active.map((track) => [
        track.id,
        Math.round(track.position.x * 1000) / 1000,
        Math.round(track.position.y * 1000) / 1000,
        Math.round(track.velocity.x * 1000) / 1000,
        Math.round(track.velocity.y * 1000) / 1000,
        Math.round(track.speed * 1000) / 1000,
        track.occluded ? 1 : 0,
      ]),
    });
  }
  if (events.length > 3600) events.shift();
  if (ghosts.length > 120) ghosts.shift();
  if (whispers.length > 80) whispers.shift();
  // Crossing cooldowns are the only per-memory state that outlives a recall,
  // and the archive it is keyed against churns all day.
  const collision = collisions.find(active, ghosts, virtualNow, (point) => point);
  if (collision) {
    disturbances += 1;
    attention.observe('crossing', collision.trackId, virtualNow);
  }
  assert.ok(collisions.tracked <= ghosts.length, 'crossing cooldowns outlived the archive');
  if (second % 15 === 0) {
    // Use the shipped default rather than a literal, so the gate exercises the
    // configuration that actually runs in the gallery.
    decayMemory(field, 15, DEFAULT_CONFIG.memoryMinutes);
    for (const ghost of ghosts) ghost.strength = decayStrength(ghost.strength, 15, ghost.falseMemory ? 18 : 96);
    for (const whisper of whispers) whisper.strength = decayStrength(whisper.strength, 15, 36);
  }
}

/**
 * The ceiling, measured against a visitor who stays.
 *
 * A separate, deliberately narrow run: one presence, never leaving, filing
 * evidence as fast as the sensing loop's rate limits allow. Nothing else in the
 * burn-in can reach this state, because its simulated visitors keep walking out
 * of the room and taking the room's interest with them.
 */
const sustained = new AttentionRuntime();
const SUSTAINED_ID = 'one-visitor-who-stays';
// Standing in one place from the first second, which is what makes the gate
// file at its own limit rather than at this loop's.
const staying = [{ id: SUSTAINED_ID, dwellSeconds: 600, stillFor: 600 } as VisitorTrack];
let sustainedAttendedSeconds = 0;
for (let second = 0; second < VIRTUAL_SECONDS; second += 1) {
  const at = second * 1000;
  if (sustained.update(staying, at).trackId !== null) sustainedAttendedSeconds += 1;
}
const sustainedAttendedOccupancy = sustainedAttendedSeconds / VIRTUAL_SECONDS;

const snapshot = JSON.stringify({ field: Array.from(field), ghosts, whispers, events });

/**
 * V8 collects module-scope bindings that are never read again, so anything not
 * demonstrably reachable after this point is not measured: an injected leak of
 * 43,200 unpruned entries registered 0.01 MB while write-only, and 82.17 MB
 * once read afterwards. This anchor is what makes the sample a measurement of
 * retained room state rather than of statement order; keep it last.
 */
const retained: unknown[] = [field, ghosts, whispers, events, snapshot, collisions, attention];
const heapDeltaMb = (retainedHeap() - startHeap) / (1024 * 1024);
assert.equal(retained.length, 7, 'the retention anchor must stay reachable across the measurement');
/** Share of gallery time a disturbed memory is visible, at one recall per crossing. */
const disturbedOccupancy = (disturbances * RECALL_PRESENTATION.ghost.durationMs) / (VIRTUAL_SECONDS * 1000);
const report = {
  virtualHours: VIRTUAL_HOURS,
  fieldCells: field.length,
  density: memoryDensity(field),
  ghostCount: ghosts.length,
  whisperCount: whispers.length,
  eventCount: events.length,
  disturbances,
  disturbedOccupancy: Math.round(disturbedOccupancy * 1000) / 1000,
  attentionSpells,
  attendedOccupancy: Math.round((attendedSeconds / VIRTUAL_SECONDS) * 1000) / 1000,
  sustainedAttendedOccupancy: Math.round(sustainedAttendedOccupancy * 1000) / 1000,
  serializedBytes: Buffer.byteLength(snapshot),
  heapDeltaMb: Math.round(heapDeltaMb * 100) / 100,
};

assert.equal(field.length, 64 * 36);
assert.ok(report.density >= 0 && report.density <= 1, 'memory density escaped its numerical bound');
assert.ok(ghosts.length <= 120, 'ghost retention grew without bound');
assert.ok(whispers.length <= 80, 'whisper retention grew without bound');
assert.ok(events.length <= 3600, 'debug recording grew without bound');
// Visitors in this simulation cross history far more often than the room is
// willing to answer, so the cooldown alone sets the pace. This checks the
// mechanism honours it — deriving the ceiling from the same constant means it
// cannot speak to whether the constant is tuned well.
const disturbanceCeiling = Math.ceil((VIRTUAL_SECONDS * 1000) / CROSSING_COOLDOWN_MS) + 1;
assert.ok(
  disturbances <= disturbanceCeiling,
  `crossings outpaced their cooldown: ${disturbances} > ${disturbanceCeiling}`,
);

// The tuning itself, stated as the thing the work cares about: a disturbed
// memory is meant to read as an accident the visitor caused, which it stops
// doing once it is on screen a large fraction of the time. At a 20 s cooldown
// this measured 0.53; the bound is what separates rare from ambient, and is
// deliberately independent of the cooldown so retuning has to face it.
assert.ok(
  disturbedOccupancy < 0.1,
  `a disturbed memory occupied ${(disturbedOccupancy * 100).toFixed(1)}% of gallery time; it should be rare`,
);
/**
 * The room's interest is meant to be preference, not surveillance.
 *
 * The figure above, from the churning simulation, is not the gate. It measured
 * 0.005 and moved only to 0.009 when the refractory period was deleted
 * entirely, because what actually limits attention in that traffic is that the
 * simulated visitors do not stay: tracks end before evidence accumulates, and
 * interest dies with them. A bound the constant it polices cannot move is not a
 * gate, it is a number that happens to be small.
 *
 * So the tuning is measured against the case it exists for — one visitor who
 * stays — and `sustainedAttendedOccupancy` is the ceiling on how much of a
 * gallery day the room could possibly spend interested in somebody. That is
 * exactly what the rest period governs, and deleting it takes this figure from
 * 0.118 to 0.968.
 */
assert.ok(
  report.sustainedAttendedOccupancy < 0.15,
  `a visitor who stays held the room's interest for ${(report.sustainedAttendedOccupancy * 100).toFixed(1)}% of the day; preference should be rare, not ambient`,
);
assert.ok(
  attentionSpells > 0,
  'the room never took an interest in anybody across twelve hours of traffic — the mechanism is dead, not restrained',
);
assert.ok(report.serializedBytes < 2 * 1024 * 1024, 'persistent state exceeded 2 MiB');
// Retention is reproducible to the hundredth of a megabyte (5.66 MB at the
// time of writing), so this bound is tight enough to fail on a real leak
// rather than merely on an unbounded one. Raise it only alongside a measured
// reason for the room to hold more.
assert.ok(heapDeltaMb < 16, `heap growth exceeded the burn-in budget: ${heapDeltaMb} MB`);

await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
await writeFile(new URL('../reports/burn-in-latest.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
