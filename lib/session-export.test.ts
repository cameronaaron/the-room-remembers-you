import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEBUG_EVENTS_KIND,
  DEBUG_EVENT_LIMIT,
  debugEventsPayload,
  exportFilename,
  exportedConfig,
  parseDebugEvents,
  sensingLogPayload,
  SENSING_LOG_KIND,
} from './session-export.ts';
import { healthyStatus } from './test-doubles/status.ts';
import { DEFAULT_CONFIG, type AnonymousSensorEvent } from './room-types.ts';

const person = (id = 'a'): AnonymousSensorEvent['people'][number] => [id, 0.3, 0.5, 0.01, 0, 0.02, 0];
const event = (t: number): AnonymousSensorEvent => ({ t, people: [person()] });
const file = (events: unknown) => ({ version: 1, kind: DEBUG_EVENTS_KIND, events });

void test('a well-formed recording is accepted', () => {
  const events = [event(0), event(1_000)];
  assert.deepEqual(parseDebugEvents(file(events)), events);
});

void test('an event with nobody in it is still an event', () => {
  // An empty room is a real observation, and the hour before a visitor arrives
  // is exactly the part of a session an operator is trying to explain.
  assert.deepEqual(parseDebugEvents(file([{ t: 0, people: [] }])), [{ t: 0, people: [] }]);
});

void test('anything that is not our file is refused', () => {
  for (const raw of [
    null, undefined, 42, 'a string', [],
    { kind: 'something-else', events: [event(0)] },
    { kind: SENSING_LOG_KIND, events: [event(0)] },
    { events: [event(0)] },
    file(undefined),
    file('not an array'),
    file([]),
  ]) {
    assert.equal(parseDebugEvents(raw), null, `${JSON.stringify(raw)} was accepted`);
  }
});

void test('a file whose events are not events is refused', () => {
  for (const bad of [null, 'a string', 42, [], {}, { t: 0 }, { people: [person()] }]) {
    assert.equal(parseDebugEvents(file([bad])), null, `${JSON.stringify(bad)} passed as an event`);
  }
});

void test('a timestamp that is not a finite number is refused', () => {
  // NaN and Infinity both pass `typeof === 'number'`, and both poison the
  // replay clock silently rather than throwing.
  for (const t of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0', null, undefined]) {
    assert.equal(parseDebugEvents(file([{ t, people: [person()] }])), null, `t of ${String(t)} was accepted`);
  }
});

void test('a person tuple of the wrong shape is refused', () => {
  for (const bad of [
    ['a', 0.3, 0.5, 0.01, 0, 0.02],            // too short
    ['a', 0.3, 0.5, 0.01, 0, 0.02, 0, 9],      // too long
    [1, 0.3, 0.5, 0.01, 0, 0.02, 0],           // id is not a string
    'not a tuple',
    null,
    {},
  ]) {
    assert.equal(parseDebugEvents(file([{ t: 0, people: [bad] }])), null, `${JSON.stringify(bad)} passed as a person`);
  }
});

void test('a coordinate that is not a finite number is refused', () => {
  // These drive the same track manager the camera drives. A NaN position
  // propagates into velocity, dwell and the memory field without ever throwing.
  for (const poison of [Number.NaN, Number.POSITIVE_INFINITY, '0.5', null, undefined, {}]) {
    for (let slot = 1; slot <= 5; slot += 1) {
      const tuple = person();
      (tuple as unknown[])[slot] = poison;
      assert.equal(
        parseDebugEvents(file([{ t: 0, people: [tuple] }])), null,
        `${JSON.stringify(poison) ?? "undefined"} in slot ${slot} was accepted`,
      );
    }
  }
});

void test('one bad event refuses the whole file, rather than replaying the survivors', () => {
  // A half-valid recording is not a recording of anything. Keeping whatever
  // parsed would show the room a visitor who teleports across the gaps where
  // the rejected events used to be.
  const events = [event(0), { t: 1_000, people: [['a', Number.NaN, 0.5, 0, 0, 0, 0]] }, event(2_000)];
  assert.equal(parseDebugEvents(file(events)), null);
});

void test('an over-long file is bounded, keeping its most recent hour', () => {
  // The room holds a ring of this size, so a supplied file must not be able to
  // make it hold more. The end is kept because that is the most recent hour.
  const events = Array.from({ length: DEBUG_EVENT_LIMIT + 500 }, (_, index) => event(index * 1_000));
  const parsed = parseDebugEvents(file(events));
  assert.equal(parsed?.length, DEBUG_EVENT_LIMIT);
  assert.equal(parsed?.at(-1)?.t, (DEBUG_EVENT_LIMIT + 499) * 1_000, 'the end of the session was discarded');
  assert.equal(parsed?.[0].t, 500 * 1_000);
});

void test('a file exactly at the limit is kept whole', () => {
  const events = Array.from({ length: DEBUG_EVENT_LIMIT }, (_, index) => event(index));
  assert.equal(parseDebugEvents(file(events))?.length, DEBUG_EVENT_LIMIT);
});

void test('what the room exports is what the room will read back', () => {
  // The round trip is the contract: an export this parser refuses is a button
  // that produces files the room cannot open.
  const events = [event(0), event(1_000)];
  const round = JSON.parse(JSON.stringify(debugEventsPayload(events)));
  assert.deepEqual(parseDebugEvents(round), events);
  assert.equal(round.kind, DEBUG_EVENTS_KIND);
});

void test('a sensing log carries the settings that explain it and nothing that identifies a machine', () => {
  // These files get attached to messages. The camera device id in particular is
  // a stable per-machine identifier and has no business in one.
  const exported = exportedConfig({ ...DEFAULT_CONFIG, cameraDeviceId: 'gallery-camera-serial-1234' });
  const keys = Object.keys(exported);
  assert.equal(keys.includes('cameraDeviceId'), false, 'a device id was exported');
  assert.equal(keys.includes('spatialCalibration'), false, 'the calibration quad was exported whole');
  assert.equal(exported.calibrated, false, 'calibration is reported as a fact, not as coordinates');
  assert.ok(keys.includes('sceneChangeCoverage'), 'the setting that discards frames was not exported');
  assert.ok(keys.includes('motionSensitivity'));
});

void test('a calibrated room says so without saying where', () => {
  const exported = exportedConfig({
    ...DEFAULT_CONFIG,
    spatialCalibration: { ...DEFAULT_CONFIG.spatialCalibration, calibratedAt: 1_700_000 },
  });
  assert.equal(exported.calibrated, true);
});

void test('a sensing log is shaped the way the analyzer reads it', () => {
  const payload = sensingLogPayload({
    config: DEFAULT_CONFIG,
    status: healthyStatus(),
    samples: [],
    recordedAt: new Date('2026-09-14T23:20:00.000Z'),
    userAgent: 'a browser',
  });
  assert.equal(payload.kind, SENSING_LOG_KIND);
  assert.equal(payload.version, 1);
  assert.equal(payload.recordedAt, '2026-09-14T23:20:00.000Z');
  assert.deepEqual(payload.samples, []);
  assert.ok('camera' in payload && 'renderer' in payload.camera);
});

void test('an exported filename sorts by time and has nothing a filesystem refuses', () => {
  const name = exportFilename('sensing-log', new Date('2026-09-14T23:20:01.000Z'));
  assert.equal(name, 'sensing-log-2026-09-14T23-20-01.000Z.json');
  assert.equal(name.includes(':'), false, 'a colon is not a filename on every platform');
});
