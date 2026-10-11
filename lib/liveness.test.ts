import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEARTBEAT_STALE_MS,
  LAUNCH_GRACE_MS,
  RELAUNCH_BACKOFF_MS,
  RENDER_FLOOR_FPS,
  RenderWatchdog,
  assessLiveness,
  parseHeartbeat,
} from './liveness.ts';
import type { Heartbeat } from './liveness.ts';

const healthy: Heartbeat = {
  at: 1_000_000,
  uptimeMs: 600_000,
  fps: 60,
  sensingHz: 23.8,
  tracks: 1,
  entered: true,
  engine: 'WebGL2 swarm · 360k',
};

void test('a running room is left alone', () => {
  const verdict = assessLiveness({ beat: healthy, receivedAt: 100_000 }, 102_000, 0);
  assert.equal(verdict.state, 'ok');
  assert.equal(verdict.relaunch, false);
  assert.match(verdict.reason, /23.8 Hz sensing/);
});

void test('a slow launch is not mistaken for a dead one', () => {
  assert.equal(assessLiveness(null, LAUNCH_GRACE_MS - 1, 0).state, 'starting');
  assert.equal(assessLiveness(null, LAUNCH_GRACE_MS - 1, 0).relaunch, false);
  const failed = assessLiveness(null, LAUNCH_GRACE_MS + 1, 0);
  assert.equal(failed.state, 'gone');
  assert.equal(failed.relaunch, true);
});

void test('one missed beat is tolerated and four are not', () => {
  const last = { beat: healthy, receivedAt: 0 };
  // A long GC pause or a starved timer loses a beat. Taking the room away from
  // a visitor standing in front of it costs more than waiting one more cycle.
  assert.equal(assessLiveness(last, HEARTBEAT_STALE_MS - 1, 0).state, 'ok');
  const gone = assessLiveness(last, HEARTBEAT_STALE_MS + 1, 0);
  assert.equal(gone.state, 'gone');
  assert.equal(gone.relaunch, true);
  assert.match(gone.reason, /not running/);
});

void test('a page that reports while frozen is caught, which a crash check cannot do', () => {
  // The failure this exists for: the tab is alive, the beacon still fires, and
  // the wall has been showing one frame for an hour.
  const frozen = { ...healthy, fps: RENDER_FLOOR_FPS - 1 };
  const verdict = assessLiveness({ beat: frozen, receivedAt: 0 }, 1_000, 0);
  assert.equal(verdict.state, 'frozen');
  assert.equal(verdict.relaunch, true);
  assert.match(verdict.reason, /still image/);
});

void test('the threshold screen is not judged on frame rate', () => {
  // Nobody has entered; the room is a static page and is meant to be.
  const waiting = { ...healthy, entered: false, fps: 0 };
  assert.equal(assessLiveness({ beat: waiting, receivedAt: 0 }, 1_000, 0).state, 'ok');
});

void test('a relaunch that does not take never becomes a loop', () => {
  const watchdog = new RenderWatchdog(0);
  const now = LAUNCH_GRACE_MS + 1;
  assert.equal(watchdog.check(null, now).relaunch, true);
  watchdog.relaunched(now);

  // The new page gets the full grace period before its silence counts.
  assert.equal(watchdog.check(null, now + 1_000).state, 'starting');
  const stillDead = watchdog.check(null, now + LAUNCH_GRACE_MS + 1);
  assert.equal(stillDead.state, 'gone');
  assert.equal(stillDead.relaunch, false, 'inside the backoff');
  assert.match(stillDead.reason, /waiting/);

  const later = watchdog.check(null, now + RELAUNCH_BACKOFF_MS + 1);
  assert.equal(later.relaunch, true);
  assert.equal(watchdog.count, 1);
});

void test('a half-parsed body is rejected rather than read as a frozen page', () => {
  assert.equal(parseHeartbeat({ ...healthy, fps: undefined }), null);
  assert.equal(parseHeartbeat({ ...healthy, fps: Number.NaN }), null);
  assert.equal(parseHeartbeat({ ...healthy, entered: 'yes' }), null);
  assert.equal(parseHeartbeat({ ...healthy, engine: '' }), null);
  assert.equal(parseHeartbeat('{}'), null);
  assert.equal(parseHeartbeat(null), null);
  assert.deepEqual(parseHeartbeat({ ...healthy, extra: 'ignored' }), healthy);
});

void test('a zero frame rate is a real reading, not a missing one', () => {
  const stopped = parseHeartbeat({ ...healthy, fps: 0 });
  assert.ok(stopped);
  assert.equal(assessLiveness({ beat: stopped, receivedAt: 0 }, 1_000, 0).state, 'frozen');
});

void test('every numeric field of a heartbeat is checked, not only the ones that were reported', () => {
  // A half-parsed body is the failure mode the launcher cannot survive: an
  // undefined field compares false against every floor, so a frozen page reads
  // as a healthy one and stays frozen on the gallery wall all day. The fields
  // are checked as a set because a defect fixed in one of them is a defect in
  // all of them — this is the sweep for the class, not a point fix on `fps`.
  for (const field of ['at', 'uptimeMs', 'fps', 'sensingHz', 'tracks'] as const) {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, '60', null]) {
      assert.equal(parseHeartbeat({ ...healthy, [field]: bad }), null, `${field} accepted ${String(bad)}`);
    }
  }
  // A negative rate or count is not merely implausible, it is unorderable
  // against a floor: -1 fps is below RENDER_FLOOR_FPS and would relaunch, while
  // -1 tracks would read as a room with fewer than no visitors in it.
  for (const field of ['fps', 'sensingHz', 'tracks'] as const) {
    assert.equal(parseHeartbeat({ ...healthy, [field]: -1 }), null, `${field} accepted a negative`);
    assert.ok(parseHeartbeat({ ...healthy, [field]: 0 }), `${field} must still accept zero`);
  }
  assert.ok(parseHeartbeat({ ...healthy, at: -1, uptimeMs: -1 }), 'only rates and counts are bounded below');
  assert.equal(parseHeartbeat({ ...healthy, engine: 7 }), null);
  assert.equal(parseHeartbeat(undefined), null);
  assert.equal(parseHeartbeat(42), null);
});
