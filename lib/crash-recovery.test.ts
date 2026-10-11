import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CRASH_WINDOW_MS,
  MAX_REMOUNTS,
  REMOUNT_DELAY_MS,
  decideCrashRecovery,
} from './crash-recovery.ts';

void test('a one-off failure rebuilds the room rather than leaving a blank wall', () => {
  const { decision, history } = decideCrashRecovery([], 1000);
  assert.equal(decision.remount, true);
  assert.equal(decision.delayMs, REMOUNT_DELAY_MS);
  assert.deepEqual(history, [1000]);
  assert.match(decision.reason, /attempt 1 of/);
});

void test('a fault that recurs on every render stops flashing the projector', () => {
  let history: number[] = [];
  for (let attempt = 1; attempt <= MAX_REMOUNTS; attempt += 1) {
    const result = decideCrashRecovery(history, attempt * 1000);
    history = result.history;
    assert.equal(result.decision.remount, true, `attempt ${attempt} should still try`);
  }
  const exhausted = decideCrashRecovery(history, (MAX_REMOUNTS + 1) * 1000);
  assert.equal(exhausted.decision.remount, false);
  assert.equal(exhausted.decision.delayMs, 0);
  assert.match(exhausted.decision.reason, /flashing/);
});

void test('failures spread across a long day never exhaust the budget', () => {
  let history: number[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = decideCrashRecovery(history, attempt * (CRASH_WINDOW_MS + 1000));
    history = result.history;
    assert.equal(result.decision.remount, true);
  }
  assert.equal(history.length, 1, 'the window prunes what is no longer relevant');
});

void test('the delay is long enough not to meet the same sensor frame again', () => {
  // A crash provoked by one frame of sensor data must not be answered with the
  // identical frame, and a visitor must read the gap as a flicker in the work.
  assert.ok(REMOUNT_DELAY_MS >= 500 && REMOUNT_DELAY_MS <= 2000);
});
