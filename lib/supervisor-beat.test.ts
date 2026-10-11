import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SUPERVISOR_BEAT_PATH,
  browserBeatPost,
  isSupervised,
  sendSupervisorBeat,
  supervisorBeat,
} from './supervisor-beat.ts';
import { overrideGlobals } from './test-doubles/browser.ts';

void test('a beat is four counters and a flag, and nothing else', () => {
  const beat = supervisorBeat(true, 12, 340, 56);
  assert.deepEqual(beat, { entered: true, engineTick: 12, renderFrame: 340, sensorFrame: 56 });
  assert.deepEqual(Object.keys(beat).sort(), ['engineTick', 'entered', 'renderFrame', 'sensorFrame']);
});

/**
 * The supervisor parses these as unsigned integers. A fractional or negative
 * value is not a smaller number over there, it is a parse failure — and a
 * parse failure is a room the supervisor cannot see at all, which is worse than
 * any number this could have reported.
 */
void test('a counter that is not a whole positive number is made into one', () => {
  const beat = supervisorBeat(false, 1.7, -3, Number.NaN);
  assert.deepEqual(beat, { entered: false, engineTick: 1, renderFrame: 0, sensorFrame: 0 });
  for (const value of Object.values(beat)) {
    if (typeof value === 'number') assert.ok(Number.isInteger(value) && value >= 0);
  }
  assert.equal(supervisorBeat(true, Number.POSITIVE_INFINITY, 0, 0).engineTick, 0);
});

void test('only a room on loopback is being supervised', () => {
  for (const hostname of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal(isSupervised(hostname), true, hostname);
  }
  // The published copy has no supervisor, and the standards already record that
  // the existing heartbeat is the one way it is not offline. One is enough.
  for (const hostname of ['the-room-remembers-you.pages.dev', '192.168.1.40', '']) {
    assert.equal(isSupervised(hostname), false, hostname);
  }
});

void test('a beat goes to the supervisor path, once, as JSON', () => {
  const sent: Array<[string, string]> = [];
  const beat = supervisorBeat(true, 1, 2, 3);
  assert.equal(sendSupervisorBeat('127.0.0.1', beat, (path, body) => sent.push([path, body])), true);
  assert.deepEqual(sent, [[SUPERVISOR_BEAT_PATH, JSON.stringify(beat)]]);

  assert.equal(sendSupervisorBeat('example.test', beat, () => assert.fail('nothing is listening')), false);
  assert.equal(sent.length, 1);
});

/**
 * Two definitions of one wire format, in two languages, and `roomd` parses it
 * with `deny_unknown_fields` — so a field added on this side and not that one
 * does not degrade the report, it stops the supervisor seeing the room. There
 * is no type system spanning the boundary; reading the Rust source is the only
 * thing that can fail when somebody adds a counter.
 */
void test('the beat is exactly the struct the supervisor accepts', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../crates/roomd/src/lib.rs', import.meta.url)),
    'utf8',
  );
  const struct = /pub struct Progress \{([^}]*)\}/.exec(source);
  assert.ok(struct, 'the Progress struct is not where this test looks for it');
  const rust = [...struct[1].matchAll(/pub (\w+):/g)].map(([, field]) =>
    // Rust spells them snake_case and serialises them camelCase.
    field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()));
  assert.deepEqual(rust.sort(), Object.keys(supervisorBeat(true, 0, 0, 0)).sort());
  assert.match(source, /deny_unknown_fields/, 'the supervisor must keep refusing anything else');
});

/**
 * The browser boundary is four lines, and every one of them matters: a beat in
 * flight has to survive the page being torn down, because that is the moment
 * the supervisor most wants to hear from the room, and a rejected beat must not
 * reach the console every five seconds and bury the messages that matter.
 */
void test('the browser boundary keeps the beat alive and its failures quiet', async () => {
  const calls: Array<[string, RequestInit]> = [];
  let rejected!: Promise<never>;
  const restore = overrideGlobals({
    fetch: (path: string, init: RequestInit) => {
      calls.push([path, init]);
      rejected = Promise.reject(new Error('no supervisor here'));
      return rejected;
    },
  });
  try {
    browserBeatPost(SUPERVISOR_BEAT_PATH, '{"entered":true}');
    assert.equal(calls.length, 1);
    const [path, init] = calls[0];
    assert.equal(path, SUPERVISOR_BEAT_PATH);
    assert.equal(init.method, 'POST');
    assert.equal(init.keepalive, true);
    assert.equal(init.body, '{"entered":true}');
    // If this were unhandled the room would take a rejection every five seconds
    // for the whole of a gallery day.
    await assert.doesNotReject(rejected.catch(() => {}));
  } finally {
    restore();
  }
});
