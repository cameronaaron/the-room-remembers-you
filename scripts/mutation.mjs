/**
 * Mutation testing over the whole installation, in groups.
 *
 * Stryker's command runner knows nothing about which file a mutant is in, so
 * one configuration covering everything runs all 549 tests for each of 7,342
 * mutants: nineteen seconds apiece, about six hours at this machine's
 * concurrency. That is not a gate anybody runs, and a gate nobody runs is a
 * suggestion.
 *
 * Each group therefore pairs a set of sources with the suites that actually
 * exercise them, so a mutant is judged in a fraction of a second. The mapping
 * is deliberately generous — a suite that might kill a mutant is included —
 * because a group that is too narrow reports a survivor that the full suite
 * would have killed, which is a false alarm, while one that is too wide only
 * costs time.
 *
 * `--group=<name>` runs one group. `--list` prints them. With no argument every
 * group runs and the run fails if any of them does.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Sources, and the suites that are allowed to have an opinion about them. */
const GROUPS = [
  {
    name: 'tracking-runtime',
    mutate: ['lib/tracking-runtime.ts'],
    tests: ['tracking-runtime'],
  },
  {
    // The live WASM adapters decide what the room runs on and what it does
    // when that fails, which is exactly the part a passing test suite can be
    // wrong about quietly. Its own group for the same reason tracking has one:
    // the suite is small and the sources are the failover path.
    name: 'attention-runtime',
    mutate: ['lib/attention-runtime.ts'],
    tests: ['attention-runtime'],
  },
  {
    name: 'field-runtime',
    mutate: ['lib/field-runtime.ts'],
    tests: ['field-runtime'],
  },
  {
    name: 'sensing',
    mutate: ['lib/motion-tracker.ts', 'lib/body-scale.ts', 'lib/homography.ts', 'lib/analysis-clock.ts', 'lib/track-bridge.ts'],
    tests: ['camera-tracker', 'crowd-sensing', 'tracker-recovery', 'memory-engine', 'homography', 'body-scale', 'session-faults', 'adaptive-crossing', 'track-bridge'],
  },
  {
    name: 'memory',
    mutate: ['lib/memory-engine.ts', 'lib/memory-disturbance.ts', 'lib/persistence.ts', 'lib/simulation.ts', 'lib/crash-recovery.ts'],
    tests: ['memory-engine', 'memory-disturbance', 'persistence', 'storage', 'simulation', 'crash-recovery', 'adaptive-crossing', 'session-faults'],
  },
  {
    name: 'behaviour',
    mutate: ['lib/behaviors.ts', 'lib/attention.ts', 'lib/room-voice.ts', 'lib/room-types.ts', 'lib/utils.ts'],
    tests: ['behaviors', 'attention', 'room-voice', 'voice-naming', 'crowd-sensing', 'ui-primitives'],
  },
  {
    name: 'sound',
    mutate: ['lib/audio-memory.ts', 'lib/session-audio.ts', 'lib/spatial-audio.ts', 'lib/whisper-tone.ts', 'lib/room-speech.ts', 'lib/rendered-speech.ts'],
    tests: ['audio-engine', 'audio-memory', 'session-audio', 'spatial-audio', 'whisper-tone', 'room-speech', 'rendered-speech', 'voice-playback'],
  },
  {
    // swarm-renderer.ts is deliberately absent, and so are webgpu-renderer.ts
    // and webgpu-shaders.ts. They are the GPU backends, and what establishes
    // that they are right is `npm run test:render` — real pixel checks against
    // a real GPU in headless Chrome. A Node test runner cannot observe a mutant
    // inside a shader at all, so scoring them here would report a number for
    // something that was never run: measured at 12.5% with 314 survivors for
    // the GL renderer, none of which says anything about the renderer. The
    // parts of both backends that are decisions rather than draw calls —
    // choosing a backend, reading a device's limits — are in `room-renderer.ts`
    // and `webgpu-capability.ts`, which are mutated.
    name: 'projection',
    mutate: [
      'lib/palette.ts', 'lib/swarm.ts', 'lib/room-renderer.ts',
      'lib/webgpu-capability.ts', 'lib/renderer-startup.ts',
      'lib/gpu-surface.ts', 'lib/renderer-mount.ts',
    ],
    tests: [
      'palette', 'swarm', 'installation-rendering', 'room-renderer',
      'webgpu-capability', 'renderer-startup', 'gpu-surface', 'renderer-mount',
      'installation-runtime',
    ],
  },
  {
    name: 'operations',
    mutate: [
      'lib/commissioning.ts', 'lib/liveness.ts', 'lib/renderer-health.ts',
      'lib/sensing-diagnosis.ts', 'lib/hardware-profile.ts', 'lib/supervisor-beat.ts',
    ],
    tests: [
      'commissioning', 'commissioning-ui', 'liveness', 'renderer-health',
      'sensing-diagnosis', 'sensing-diagnostics-ui', 'hardware-profile',
      'gallery-launch', 'supervisor-beat', 'installation-runtime',
    ],
  },
  {
    name: 'scripts',
    mutate: ['scripts/autostart-plist.ts', 'scripts/exhibit-runtime.ts', 'scripts/analyze-session.ts', 'scripts/render-voice.ts'],
    tests: ['gallery-launch', 'exhibit-launcher', 'session-analysis', 'voice-naming'],
  },
  {
    name: 'console',
    mutate: ['components/operator-console.tsx', 'components/gallery-preflight.tsx', 'components/sensing-diagnostics.tsx', 'components/room-boundary.tsx'],
    tests: ['operator-console', 'commissioning-ui', 'sensing-diagnostics-ui', 'room-boundary'],
  },
  {
    name: 'room-modules',
    mutate: ['lib/pointer-presence.ts', 'lib/room-projection.ts', 'lib/room-canvas.ts', 'lib/room-drawing.ts', 'lib/memory-records.ts', 'lib/room-bodies.ts', 'lib/room-capture.ts', 'lib/room-status.ts', 'lib/room-telemetry.ts', 'lib/swarm-frame.ts'],
    tests: ['pointer-presence', 'room-projection', 'room-canvas', 'room-drawing', 'memory-records', 'room-modules', 'swarm-renderer'],
  },
  {
    // What the room decides, now that none of it is inside the component. The
    // suites are generous on purpose: a mutant in the recall order can be
    // killed by the whole-installation runs as well as by its own unit test.
    name: 'room-logic',
    mutate: [
      'lib/room-emergence.ts', 'lib/room-upkeep.ts', 'lib/room-lifecycle.ts',
      'lib/sensor-inputs.ts', 'lib/debug-recorder.ts', 'lib/attention-evidence.ts',
    ],
    tests: [
      'room-emergence', 'room-upkeep', 'room-lifecycle', 'sensor-inputs',
      'debug-recorder', 'attention-evidence', 'memory-records', 'attention',
      'session-export', 'memory-disturbance',
    ],
  },
  {
    // What the room presents with, and the numbers it reports about itself.
    name: 'room-surface',
    mutate: [
      'lib/room-frame.ts', 'lib/projection-surface.ts', 'lib/rate-meter.ts',
      'lib/room-keys.ts', 'lib/media-devices.ts',
    ],
    tests: [
      'room-frame', 'projection-surface', 'rate-meter', 'room-keys',
      'media-devices', 'room-drawing', 'room-canvas', 'installation-rendering',
    ],
  },
  {
    name: 'installation',
    mutate: ['components/room-installation.tsx'],
    tests: ['installation-runtime', 'installation-rendering'],
  },
];

const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  for (const group of GROUPS) console.log(`${group.name.padEnd(14)} ${group.mutate.length} source(s), ${group.tests.length} suite(s)`);
  process.exit(0);
}
const only = argv.find((argument) => argument.startsWith('--group='))?.slice('--group='.length);
const selected = only ? GROUPS.filter((group) => group.name === only) : GROUPS;
if (!selected.length) {
  console.error(`No such group: ${only}. Known groups: ${GROUPS.map((group) => group.name).join(', ')}`);
  process.exit(1);
}

mkdirSync('reports/mutation', { recursive: true });
const summary = [];
let failed = false;

for (const group of selected) {
  const directory = mkdtempSync(join(tmpdir(), `stryker-${group.name}-`));
  const configPath = join(directory, 'stryker.json');
  const suites = group.tests.map((name) => `lib/${name}.test.ts`);
  writeFileSync(configPath, JSON.stringify({
    testRunner: 'command',
    commandRunner: { command: `node --import tsx --test ${suites.join(' ')}` },
    mutate: group.mutate,
    coverageAnalysis: 'off',
    concurrency: 6,
    timeoutMS: 60_000,
    incremental: true,
    incrementalFile: `reports/mutation/incremental-${group.name}.json`,
    reporters: ['clear-text', 'html', 'json'],
    htmlReporter: { fileName: `reports/mutation/${group.name}.html` },
    jsonReporter: { fileName: `reports/mutation/${group.name}.json` },
    thresholds: { high: 100, low: 90, break: 90 },
  }, null, 2));

  console.log(`\n=== ${group.name} · ${group.mutate.join(', ')} ===`);
  const result = spawnSync('npx', ['stryker', 'run', configPath], { stdio: 'inherit' });
  rmSync(directory, { recursive: true, force: true });
  if (result.status !== 0) failed = true;

  const report = `reports/mutation/${group.name}.json`;
  if (existsSync(report)) {
    const parsed = JSON.parse(readFileSync(report, 'utf8'));
    const counts = {};
    for (const file of Object.values(parsed.files)) {
      for (const mutant of file.mutants) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
    }
    const killed = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
    const total = killed + (counts.Survived ?? 0) + (counts.NoCoverage ?? 0);
    summary.push({ group: group.name, killed, total, score: total ? (100 * killed) / total : 100 });
  }
}

console.log('\n=== mutation score by group ===');
for (const row of summary) {
  console.log(`${row.group.padEnd(14)} ${row.score.toFixed(1).padStart(6)}%  (${row.killed}/${row.total})`);
}
const overall = summary.reduce((totals, row) => ({ killed: totals.killed + row.killed, total: totals.total + row.total }), { killed: 0, total: 0 });
if (overall.total) console.log(`${'all'.padEnd(14)} ${((100 * overall.killed) / overall.total).toFixed(1).padStart(6)}%  (${overall.killed}/${overall.total})`);
process.exit(failed ? 1 : 0);
