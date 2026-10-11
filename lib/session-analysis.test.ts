import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

void test('session analysis uses each audio threshold and does not label missing tracks an empty room', () => {
  const directory = mkdtempSync(join(tmpdir(), 'room-log-test-'));
  try {
    const base = { hz: 20, live: 0, hidden: 0, candidates: 0, blobs: 0, state: 'tracking',
      changedPercent: 0, candidateCells: 0, activeCells: 0, rejectedFraction: 0 };
    const path = join(directory, 'log.json');
    writeFileSync(path, JSON.stringify({ kind: 'sensing-log',
      camera: { state: 'ready', resolution: '640×360' },
      samples: [
        { ...base, t: 0 },
        { ...base, t: 500, micLevel: 0.005, micThreshold: 0.001 },
        { ...base, t: 1000, micLevel: 0.03, micThreshold: 0.1 },
      ],
    }));
    const output = execFileSync(process.execPath, ['scripts/analyze-session.ts', path], { encoding: 'utf8' });
    assert.match(output, /50\.0% of audio samples/);
    assert.match(output, /no visible track/);
    assert.doesNotMatch(output, /of the time empty/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
