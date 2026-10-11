import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The session analyzer, read back over synthetic sessions.
 *
 * This is the tool that answers "what was wrong with the room last night",
 * and every one of its findings is a sentence an operator will act on: move the
 * camera, lower a threshold, check a permission. A finding that fires on a
 * healthy session sends somebody to adjust equipment that was working; one that
 * stays quiet on a broken session is the silence the instrument exists to
 * break. Both are only observable by feeding it sessions with known faults.
 *
 * The logs here are fabricated rather than recorded, which is the point: a real
 * log contains whatever happened to go wrong that night, and these contain one
 * named thing each.
 */

type Sample = Record<string, unknown>;

const HEALTHY: Sample = {
  hz: 23.8,
  live: 1,
  hidden: 0,
  candidates: 0,
  blobs: 1,
  state: 'tracking',
  changedPercent: 12,
  coveragePercent: 14,
  candidateCells: 30,
  activeCells: 24,
  rejectedFraction: 0,
  cellsPerBody: 7,
  micLevel: 0.002,
  micThreshold: 0.004,
  whispersCaptured: 1,
  whispersReplayed: 1,
  whispersHeld: 1,
  audioContext: 'running',
};

function analyze(samples: Sample[], extra: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'room-faults-'));
  try {
    const path = join(directory, 'log.json');
    writeFileSync(path, JSON.stringify({
      kind: 'sensing-log',
      camera: { state: 'ready', resolution: '640×360' },
      config: { masterVolume: 0.32, motionSensitivity: 24 },
      ...extra,
      samples: samples.map((sample, index) => ({ t: index * 500, ...HEALTHY, ...sample })),
    }));
    return execFileSync(process.execPath, ['scripts/analyze-session.ts', path], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const many = (count: number, sample: Sample = {}) => Array.from({ length: count }, () => sample);

void test('a healthy session raises no alarms', () => {
  // The one that matters most. Every finding below is a sentence that sends an
  // operator to change something; none of them may fire on a room that works.
  const output = analyze(many(40));
  assert.doesNotMatch(output, /stalls intermittently/);
  assert.doesNotMatch(output, /frequent scene-change rejection/);
  assert.doesNotMatch(output, /population is unstable/);
  assert.doesNotMatch(output, /not running/);
  assert.doesNotMatch(output, /muted/);
  assert.doesNotMatch(output, /check permission/);
  assert.match(output, /Tracking 1 person/);
});

void test('an intermittently stalling loop is named as contention, not as a slow machine', () => {
  const samples = many(40);
  samples[7] = { hz: 4 };
  samples[19] = { hz: 3 };
  samples[31] = { hz: 5 };
  const output = analyze(samples);
  assert.match(output, /stalls intermittently/);
  assert.match(output, /competing for the main thread/);
});

void test('frequent scene-change rejection points at the room before the setting', () => {
  // Raising sceneChangeCoverage to silence this hides a camera pointed at a
  // window or at the projection itself.
  const output = analyze([
    ...many(20),
    ...many(20, { state: 'scene-change', rejectedFraction: 1 }),
  ]);
  assert.match(output, /frequent scene-change rejection/);
  assert.match(output, /check lighting and camera placement/);
});

void test('motion that never survives the two-frame rule is reported as such', () => {
  const output = analyze(many(40, { candidateCells: 40, activeCells: 0, blobs: 0, live: 0 }));
  assert.match(output, /never survived the two-frame rule/);
});

void test('a churning population is distinguished from a busy one', () => {
  // Churn above about 35% means detections are fragmenting or association is
  // failing, which looks identical from the front of the room to a gallery
  // that happens to be busy.
  const churning = Array.from({ length: 40 }, (_, index) => ({ live: index % 2 ? 1 : 2, blobs: 2 }));
  const output = analyze(churning);
  assert.match(output, /population is unstable/);

  const steady = analyze(many(40, { live: 2, blobs: 2 }));
  assert.doesNotMatch(steady, /population is unstable/);
});

void test('mild instability is a note, and only severe churn is an alarm', () => {
  // The two bands say different things to an operator: one is worth watching,
  // the other means association is failing and the room is answering fragments
  // instead of people. Collapsing them into one would send somebody to rebuild
  // a tracker that is merely busy.
  // A second person appearing once every eight samples is two transitions in
  // eight: 25% churn, between the 18% note and the 35% alarm.
  const samples = Array.from({ length: 40 }, (_, index) => ({
    live: index % 8 === 0 ? 2 : 1,
    blobs: 1,
  }));
  const output = analyze(samples);
  assert.match(output, /some instability in the reported population/);
  assert.doesNotMatch(output, /population is unstable/);
});

void test('more bodies than tracks is surfaced without being called a fault', () => {
  // Expected when body fragments are merged, so it is a note rather than an
  // alarm — the analyzer must not send an operator chasing it on its own.
  const output = analyze(many(40, { blobs: 3, live: 1 }));
  assert.match(output, /detected more bodies than tracks held/);
});

void test('the body scale is read back, and its two regimes are named', () => {
  const gallery = analyze(many(20, { cellsPerBody: 7 }));
  assert.match(gallery, /7 cells per body/);
  assert.match(gallery, /a camera across a room/);

  const desk = analyze(many(20, { cellsPerBody: 300 }));
  assert.match(desk, /a body this large fills the frame/);
  assert.match(desk, /desk range/);
});

void test('a log from before body scale was recorded says so rather than guessing', () => {
  const output = analyze(many(20, { cellsPerBody: undefined }));
  assert.match(output, /not recorded/);
});

void test('a suspended audio context is the loudest thing in the report', () => {
  // A suspended context accepts every sound and plays none of them, without
  // erroring. Nothing else in the installation can tell you this.
  const output = analyze(many(20, { audioContext: 'suspended' }));
  assert.match(output, /audio context is not running/);
});

void test('a muted room is reported as muted rather than as silent', () => {
  const output = analyze(many(20), { config: { masterVolume: 0 } });
  assert.match(output, /master volume is zero/);
  assert.match(output, /M toggles it/);
});

void test('a dead microphone is distinguished from a quiet room', () => {
  const output = analyze(many(20, { micLevel: 0, whispersCaptured: 0, whispersReplayed: 0 }));
  assert.match(output, /stayed at zero/);
  assert.match(output, /check permission and device/);
});

void test('a threshold nothing ever reaches is reported with the value to try', () => {
  const output = analyze(many(20, {
    micLevel: 0.001,
    micThreshold: 0.9,
    whispersCaptured: 0,
    whispersReplayed: 0,
  }));
  assert.match(output, /nothing ever crossed the threshold/);
  assert.match(output, /lower it toward/);
});

void test('sound that crosses the threshold but never completes a whisper is named', () => {
  const output = analyze(many(20, {
    micLevel: 0.5,
    micThreshold: 0.004,
    whispersCaptured: 0,
    whispersReplayed: 0,
  }));
  assert.match(output, /no whisper completed/);
  assert.match(output, /too loud or too brief/);
});

void test('replayed whispers point past the counter when none were heard', () => {
  const output = analyze(many(20, { whispersCaptured: 2, whispersReplayed: 5, whispersHeld: 2 }));
  assert.match(output, /whispers were replayed/);
  assert.match(output, /the chain past the counter is at fault/);
});

void test('fragment recoveries are reported as a count and never as geometry', () => {
  const output = analyze(many(20, { fragmentRecoveries: 4 }));
  assert.match(output, /4 recent-outline recoveries/);
});

void test('a log predating audio telemetry says so instead of reporting zeros', () => {
  const output = analyze(many(20, {
    micLevel: undefined,
    micThreshold: undefined,
    audioContext: undefined,
    whispersCaptured: undefined,
    whispersReplayed: undefined,
    whispersHeld: undefined,
  }));
  assert.match(output, /predates audio telemetry/);
});

void test('the analyzer refuses what it cannot read rather than reporting nonsense', () => {
  const directory = mkdtempSync(join(tmpdir(), 'room-faults-'));
  const status = (args: string[]) => {
    try {
      execFileSync(process.execPath, ['scripts/analyze-session.ts', ...args], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    }
  };
  const withBody = (body: string) => {
    const path = join(directory, 'bad.json');
    writeFileSync(path, body);
    return status([path]);
  };
  try {
    assert.equal(status([]), 2, 'invoked with no log at all, it prints usage');
    assert.equal(
      withBody(JSON.stringify({ kind: 'something-else', samples: [] })),
      2,
      'a JSON file that is not a sensing log',
    );
    assert.equal(
      withBody(JSON.stringify({ kind: 'sensing-log', samples: [] })),
      2,
      'an export taken before anybody entered the room',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
