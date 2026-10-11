import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisClock } from './analysis-clock.ts';

void test('12ms polling delivers the 42ms target rather than rounding every frame to 48ms', () => {
  const clock = new AnalysisClock();
  const stamps: number[] = [];
  for (let now = 0; now <= 42000; now += 12) if (clock.due(now, 42)) stamps.push(now);
  const rate = (stamps.length - 1) * 1000 / (stamps.at(-1)! - stamps[0]);
  assert.ok(Math.abs(rate - 1000 / 42) < 0.02);
});

void test('a long pause skips missed analyses and does not bank a burst', () => {
  const clock = new AnalysisClock();
  assert.equal(clock.due(0, 42), true);
  assert.equal(clock.due(5000, 42), true);
  assert.equal(clock.due(5000, 42), false);
  assert.equal(clock.due(5012, 42), false);
  assert.equal(clock.due(5042, 42), true);
});

void test('profile changes establish the new cadence immediately', () => {
  const clock = new AnalysisClock();
  clock.due(0, 100);
  assert.equal(clock.due(12, 42), true);
  assert.equal(clock.due(48, 42), false);
  assert.equal(clock.due(60, 42), true);
});
