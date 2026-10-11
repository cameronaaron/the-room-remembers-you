import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOSS_WINDOW_MS,
  MAX_LOSSES,
  RESTORE_GRACE_MS,
  RendererHealth,
} from './renderer-health.ts';

void test('a display waking is recovered from rather than treated as a fault', () => {
  const health = new RendererHealth();
  assert.equal(health.contextLost(1000), 'hold');
  assert.equal(health.blocked, true, 'nothing may be drawn into a lost context');
  assert.equal(health.contextRestored(1400), 'rebuild');
  assert.equal(health.blocked, false);
  assert.equal(health.state.recoveries, 1);
});

void test('a restore that never arrives falls back instead of waiting forever', () => {
  const health = new RendererHealth();
  health.contextLost(1000);
  // Cancelling webglcontextlost only asks for a restore. A driver that has
  // given up sends nothing at all, and no listener can report that.
  assert.equal(health.poll(1000 + RESTORE_GRACE_MS - 1), 'hold');
  assert.equal(health.poll(1000 + RESTORE_GRACE_MS), 'fallback');
  assert.equal(health.state.abandoned, true);
  assert.match(health.describe(), /trace engine/);
});

void test('a GPU that keeps dropping the context stops being followed', () => {
  const health = new RendererHealth();
  let now = 0;
  for (let attempt = 0; attempt < MAX_LOSSES; attempt += 1) {
    now += 1000;
    health.contextLost(now);
    assert.equal(health.contextRestored(now + 200), 'rebuild');
  }
  now += 1000;
  health.contextLost(now);
  assert.equal(
    health.contextRestored(now + 200),
    'fallback',
    'each rebuild reseeds the field, so repeated recovery reads as strobing',
  );
  assert.equal(health.state.abandoned, true);
});

void test('losses spread across the day never accumulate into abandonment', () => {
  const health = new RendererHealth();
  // A gallery day is long. One loss every few hours is a display sleeping, not
  // a GPU that cannot hold a context.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const now = attempt * (LOSS_WINDOW_MS + 60_000);
    health.contextLost(now);
    assert.equal(health.contextRestored(now + 200), 'rebuild');
  }
  assert.equal(health.state.abandoned, false);
  assert.equal(health.state.recoveries, 8);
});

void test('an abandoned field is never rebuilt by a later restore', () => {
  const health = new RendererHealth();
  health.contextLost(0);
  assert.equal(health.poll(RESTORE_GRACE_MS), 'fallback');
  health.contextLost(60_000);
  assert.equal(health.contextRestored(60_200), 'fallback');
  assert.equal(health.state.recoveries, 0);
});

void test('a held context reports that it is held, not that it is unknown', () => {
  const health = new RendererHealth();
  assert.equal(health.poll(60_000), 'hold');
  assert.equal(health.blocked, false);
  assert.match(health.describe(), /held since start/);
});

void test('the console is told which of the three states the renderer is in', () => {
  // The operator has no other way to tell a recovered context from one that
  // never faltered, and both from a field that has been given up on.
  const health = new RendererHealth();
  assert.match(health.describe(), /held since start/);

  health.contextLost(1000);
  assert.match(health.describe(), /lost — waiting/);

  health.contextRestored(1200);
  assert.match(health.describe(), /recovered from 1 GPU context loss\b/, 'singular for one');

  health.contextLost(2000);
  health.contextRestored(2200);
  assert.match(health.describe(), /recovered from 2 GPU context losses/, 'plural for more');
});
