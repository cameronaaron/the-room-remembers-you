/**
 * Read a sensing log exported from a running installation and say what is wrong
 * with it.
 *
 *   node scripts/analyze-session.ts sensing-log-....json
 *
 * The instrument on screen shows the present moment. This shows the shape of a
 * whole session, which is where intermittent faults live: tracking that churns,
 * a scene-change guard that only trips when someone walks close, a sensing loop
 * that degrades as the room warms up. None of those are visible in a snapshot.
 */

import { readFileSync } from 'node:fs';
import { blockingStage, diagnoseSensing, type SensingSnapshot } from '../lib/sensing-diagnosis.ts';
import type { SensingSample } from '../lib/room-types.ts';

type SessionFile = {
  kind?: string;
  recordedAt?: string;
  userAgent?: string;
  config?: Record<string, unknown>;
  camera?: { state?: string; resolution?: string; renderer?: string };
  samples?: SensingSample[];
};

/** The motion grid is a fixed 40x23. */
const GRID_CELLS = 40 * 23;

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/analyze-session.ts <sensing-log.json>');
  process.exit(2);
}

const file = JSON.parse(readFileSync(path, 'utf8')) as SessionFile;
if (file.kind !== 'sensing-log' || !Array.isArray(file.samples)) {
  console.error(`${path} is not a sensing log export.`);
  process.exit(2);
}

const samples = file.samples;
if (!samples.length) {
  console.error('The log is empty. Enter the room, let it run, then export.');
  process.exit(2);
}

const number = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    min: sorted[0],
    median: at(0.5),
    p90: at(0.9),
    max: sorted[sorted.length - 1],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
};

const pct = (count: number) => `${((count / samples.length) * 100).toFixed(1)}%`;
const heading = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`);

const durationSeconds = (samples.at(-1)!.t - samples[0].t) / 1000;

console.log(`\x1b[1mSensing log\x1b[0m  ${path}`);
console.log(`${samples.length} samples over ${durationSeconds.toFixed(0)}s · recorded ${file.recordedAt ?? 'unknown'}`);
if (file.camera) console.log(`camera ${file.camera.state} ${file.camera.resolution} · ${file.camera.renderer}`);
if (file.config) console.log(`config ${JSON.stringify(file.config)}`);

heading('Sensing loop');
// The first sample or two are taken before the rate has been measured at all.
// Counting those zeros as stalls reports a fault in every healthy session.
const measured = samples.map((sample) => sample.hz).filter((value) => value > 0);
const hz = number(measured.length ? measured : [0]);
const settled = measured.slice(2);
console.log(`  rate       ${hz.median.toFixed(1)} Hz median · ${hz.min.toFixed(1)} min · ${hz.max.toFixed(1)} max`);
if (settled.length > 4 && Math.min(...settled) < hz.median * 0.6) {
  console.log('  \x1b[33m! the loop stalls intermittently — something is competing for the main thread\x1b[0m');
}

heading('Pixels and cells');
const coverage = number(samples.map((sample) => sample.coveragePercent ?? (sample.candidateCells / GRID_CELLS) * 100));
console.log(`  coverage   ${coverage.median.toFixed(0)}% of the grid median · ${coverage.max.toFixed(0)}% max`);
const changed = number(samples.map((sample) => sample.changedPercent));
const rejected = samples.filter((sample) => sample.state === 'scene-change').length;
console.log(`  changed    ${changed.median.toFixed(1)}% median · ${changed.p90.toFixed(1)}% p90 · ${changed.max.toFixed(1)}% max`);
console.log(`  rejected   ${pct(rejected)} of samples were discarded as a scene change`);
if (rejected / samples.length > 0.1) {
  console.log('  \x1b[31m! frequent scene-change rejection — check lighting and camera placement before changing sceneChangeCoverage\x1b[0m');
}
const starved = samples.filter((sample) => sample.candidateCells > 0 && sample.activeCells === 0).length;
if (starved / samples.length > 0.15) {
  console.log(`  \x1b[33m! ${pct(starved)} of samples had candidate cells that never survived the two-frame rule\x1b[0m`);
}

heading('People');
const live = samples.map((sample) => sample.live);
const liveStats = number(live);
console.log(`  live       ${liveStats.median} median · ${liveStats.max} max · ${pct(live.filter((n) => n === 0).length)} of samples had no visible track`);
console.log(`  hidden     ${number(samples.map((s) => s.hidden)).mean.toFixed(2)} mean occluded tracks`);
console.log(`  candidates ${number(samples.map((s) => s.candidates)).mean.toFixed(2)} mean unconfirmed`);
console.log(`  blobs      ${number(samples.map((s) => s.blobs)).mean.toFixed(2)} mean detected bodies`);
// How large a body is in this camera's view, which is what the plausibility
// bound divides by. A room systematically under-counting people produces a log
// otherwise indistinguishable from a quiet gallery, so this is worth printing
// even when nothing looks wrong.
const scales = samples.map((s) => s.cellsPerBody).filter((value): value is number => typeof value === 'number');
if (scales.length) {
  const measured = number(scales);
  console.log(`  scale      ${measured.mean.toFixed(0)} cells per body (${measured.min.toFixed(0)}–${measured.max.toFixed(0)})`);
  if (measured.mean < 12) {
    console.log('             a body this small is a camera across a room; bodies and gaps are only a few cells wide');
  } else if (measured.mean > 120) {
    console.log('             a body this large fills the frame — desk range, where one visitor can look like a crowd');
  }
} else {
  console.log('  scale      not recorded — a log from before body scale was measured rather than assumed');
}
const fragmentRecoveries = samples.at(-1)?.fragmentRecoveries;
if (fragmentRecoveries !== undefined) console.log(`  fragments  ${fragmentRecoveries} recent-outline recoveries since tracking started`);


// Churn: how often the reported population changes between samples. A room
// with one steady visitor should be near zero.
let changes = 0;
let jumps = 0;
for (let index = 1; index < samples.length; index += 1) {
  const delta = Math.abs(samples[index].live - samples[index - 1].live);
  if (delta > 0) changes += 1;
  if (delta > 1) jumps += 1;
}
const churn = changes / Math.max(1, samples.length - 1);
console.log(`  churn      ${(churn * 100).toFixed(1)}% of samples changed the count (${jumps} jumps of more than one)`);
if (churn > 0.35) {
  console.log('  \x1b[31m! the population is unstable — detections are fragmenting or association is failing\x1b[0m');
} else if (churn > 0.18) {
  console.log('  \x1b[33m! some instability in the reported population\x1b[0m');
}
const overcount = samples.filter((sample) => sample.blobs > sample.live + sample.hidden + sample.candidates).length;
if (overcount > 0) console.log(`  \x1b[33m! ${pct(overcount)} of samples detected more bodies than tracks held\x1b[0m`);

heading('Sound');
const withAudio = samples.filter((sample) => sample.micLevel !== undefined);
if (!withAudio.length) {
  console.log('  this log predates audio telemetry');
} else {
  const level = number(withAudio.map((sample) => sample.micLevel ?? 0));
  const threshold = withAudio.at(-1)!.micThreshold ?? 0;
  const captured = withAudio.at(-1)!.whispersCaptured ?? 0;
  const replayed = withAudio.at(-1)!.whispersReplayed ?? 0;
  const held = withAudio.at(-1)!.whispersHeld ?? 0;
  const over = withAudio.filter((sample) => (sample.micLevel ?? 0) > (sample.micThreshold ?? threshold)).length;
  console.log(`  level      ${level.median.toFixed(4)} median · ${level.max.toFixed(4)} peak · threshold ${threshold.toFixed(3)}`);
  console.log(`  above      ${((over / withAudio.length) * 100).toFixed(1)}% of audio samples exceeded their contemporaneous threshold`);
  console.log(`  whispers   ${captured} captured · ${held} held · ${replayed} replayed`);
  const contexts = new Set(withAudio.map((sample) => sample.audioContext).filter(Boolean));
  if (contexts.size) console.log(`  context    ${[...contexts].join(', ')}`);
  const volume = typeof file.config?.masterVolume === 'number' ? file.config.masterVolume : undefined;
  if (volume !== undefined) console.log(`  volume     ${volume}`);
  if (contexts.size && !contexts.has('running')) {
    console.log('  \x1b[31m! the audio context is not running — nothing can be heard at all\x1b[0m');
  }
  if (volume === 0) {
    console.log('  \x1b[31m! master volume is zero; the room is muted (M toggles it)\x1b[0m');
  }
  if (replayed > 0 && level.max > 0) {
    console.log(`  \x1b[33mnote: ${replayed} whispers were replayed. If none were heard, the chain past the counter is at fault, not the capture.\x1b[0m`);
  }
  if (level.max === 0) {
    console.log('  \x1b[31m! the sampled microphone level stayed at zero — check permission and device\x1b[0m');
  } else if (over === 0) {
    console.log(`  \x1b[33m! nothing ever crossed the threshold; lower it toward ${(level.p90).toFixed(3)}\x1b[0m`);
  } else if (captured === 0) {
    console.log('  \x1b[33m! loud enough, but no whisper completed — sound may be too loud or too brief\x1b[0m');
  }
}

heading('What was blocking, over the whole session');
const stages = new Map<string, number>();
for (const sample of samples) {
  const snapshot: SensingSnapshot = {
    cameraState: file.camera?.state === 'ready' ? 'ready' : 'failed',
    videoWidth: Number(file.camera?.resolution?.split('×')[0]) || 640,
    videoHeight: Number(file.camera?.resolution?.split('×')[1]) || 360,
    videoReadyState: 4,
    analysisHz: sample.hz,
    warmingUp: sample.state === 'warming',
    settling: sample.state === 'settling',
    changedPercent: sample.changedPercent,
    // Logs recorded before coverage was tracked can still be read: the grid is
    // a fixed 40x23, so coverage is recoverable from the candidate count.
    coveragePercent: sample.coveragePercent ?? (sample.candidateCells / GRID_CELLS) * 100,
    sceneChangeLimitPercent: Number(file.config?.sceneChangeCoverage ?? file.config?.sceneChangeLimit ?? 0.85) * 100,
    rejectedFraction: sample.rejectedFraction,
    candidateCells: sample.candidateCells,
    activeCells: sample.activeCells,
    blobCount: sample.blobs,
    visibleTracks: sample.live,
    occludedTracks: sample.hidden,
    sensitivity: Number(file.config?.motionSensitivity ?? 24),
    demoMode: Boolean(file.config?.demoMode),
    simulationRate: Number(file.config?.simulationRate ?? 0),
  };
  const findings = diagnoseSensing(snapshot);
  const finding = blockingStage(findings) ?? findings[0];
  const key = `${finding.severity}:${finding.stage}  ${finding.headline}`;
  stages.set(key, (stages.get(key) ?? 0) + 1);
}
for (const [key, count] of [...stages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ${pct(count).padStart(6)}  ${key}`);
}
console.log('');
