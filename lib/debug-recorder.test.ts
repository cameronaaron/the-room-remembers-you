import assert from 'node:assert/strict';
import test from 'node:test';
import { DEBUG_RECORD_INTERVAL_MS, DebugRecorder, DebugReplay } from './debug-recorder.ts';
import { DEBUG_EVENT_LIMIT, debugEventsPayload, parseDebugEvents } from './session-export.ts';
import { track } from './test-doubles/room.ts';

const walking = (id: string, x: number) => track({ id, position: { x, y: 0.5, t: 0 } });

void test('a recording is one sample a second, whatever the sensing rate', () => {
  // FULL senses twenty-four times a second. Recording every tick would fill
  // the cap in two and a half minutes and describe nobody any better.
  const recorder = new DebugRecorder();
  let recorded = 0;
  for (let tick = 0; tick < 24 * 10; tick += 1) {
    if (recorder.record([walking('a', 0.5)], tick * (1000 / 24))) recorded += 1;
  }
  assert.equal(recorded, 10);
});

void test('an empty room records nothing', () => {
  const recorder = new DebugRecorder();
  assert.equal(recorder.record([], 1_000), false);
  assert.equal(recorder.size, 0);
});

void test('the first sample is at zero and later ones are offsets from it', () => {
  // The recording carries its own timeline, not the page's: an event file is
  // replayable on a machine whose clock has nothing to do with the capture.
  const recorder = new DebugRecorder();
  recorder.record([walking('a', 0.2)], 812_345);
  recorder.record([walking('a', 0.3)], 812_345 + DEBUG_RECORD_INTERVAL_MS);
  assert.equal(recorder.all[0].t, 0);
  assert.equal(recorder.all[1].t, DEBUG_RECORD_INTERVAL_MS);
});

void test('a restored recording continues its own timeline rather than restarting', () => {
  // The clock defect this class was extracted to make visible. The component
  // seeded the origin from a wall clock and then stamped events with the
  // animation clock, so the first event recorded after a restore carried a `t`
  // about fifty years in the past — and the exporter wrote it out as fact.
  const recorder = new DebugRecorder();
  const adopted = recorder.adopt([{ t: 5_000, people: [['a', 0.5, 0.5, 0, 0, 0, 0]] }], 60_000);
  assert.equal(adopted, 1);
  recorder.record([walking('a', 0.5)], 61_000);
  const stamped = recorder.all.at(-1)!.t;
  assert.ok(stamped > 5_000 && stamped < 7_000, `restored timeline broken: ${stamped}`);
});

void test('adopting nothing is a recording that starts where it is adopted', () => {
  // The empty case reaches `at(-1)` on an empty array. An operator importing a
  // file the room then rejects leaves the recorder here.
  const recorder = new DebugRecorder();
  assert.equal(recorder.adopt([], 400_000), 0);
  recorder.record([walking('a', 0.5)], 400_000);
  assert.equal(recorder.all[0].t, 0);
});

void test('a live recording cannot grow past the bound the burn-in asserts', () => {
  const recorder = new DebugRecorder();
  for (let second = 0; second < DEBUG_EVENT_LIMIT + 120; second += 1) {
    recorder.record([walking('a', 0.5)], second * DEBUG_RECORD_INTERVAL_MS);
  }
  assert.equal(recorder.size, DEBUG_EVENT_LIMIT);
  // The oldest go first: what an operator wants after a long day is the end.
  assert.equal(recorder.all[0].t, 120 * DEBUG_RECORD_INTERVAL_MS);
});

void test('a restored recording is held to the same bound as a live one', () => {
  // Restoring took the last 36,000 events where recording caps at 3,600, so a
  // room reopened after a long day came back holding ten times the recording it
  // is allowed to keep — against a documented 2 MiB bound on saved state.
  const recorder = new DebugRecorder();
  const long = Array.from({ length: DEBUG_EVENT_LIMIT * 4 }, (_unused, index) => ({
    t: index * 1_000,
    people: [['a', 0.5, 0.5, 0, 0, 0, 0] as [string, number, number, number, number, number, 0 | 1]],
  }));
  assert.equal(recorder.adopt(long, 0), DEBUG_EVENT_LIMIT);
});

void test('a body predicted through an occlusion is recorded as hidden', () => {
  // The flag is the difference between "the room saw two people" and "the room
  // saw one and believed in another", which is the distinction a sensing defect
  // is diagnosed by.
  const recorder = new DebugRecorder();
  recorder.record([
    track({ id: 'seen', occluded: false }),
    track({ id: 'hidden', occluded: true }),
  ], 1_000);
  assert.deepEqual(recorder.all[0].people.map((person) => person[6]), [0, 1]);
});

void test('recorded people carry no more precision than the format admits', () => {
  // Coordinates are rounded on the way in, not on the way out: an exported file
  // is the record, and a file is the one thing here that leaves the machine.
  const recorder = new DebugRecorder();
  recorder.record([track({ id: 'a', position: { x: 0.123456789, y: 0.5, t: 0 } })], 1_000);
  const [, x] = recorder.all[0].people[0];
  assert.ok(String(x).length <= 5, `coordinate kept full precision: ${x}`);
});

void test('what the recorder holds is what the importer accepts', () => {
  // The exported shape and the validated shape are the same shape, or a session
  // exported from the gallery cannot be replayed at a desk.
  const recorder = new DebugRecorder();
  recorder.record([walking('a', 0.4), walking('b', 0.6)], 1_000);
  const file = JSON.parse(JSON.stringify(debugEventsPayload(recorder.all)));
  const accepted = parseDebugEvents(file);
  assert.ok(accepted, 'the room exported a recording its own importer refuses');
  assert.deepEqual(accepted, [...recorder.all]);
});

void test('clearing leaves nothing behind for the next session to inherit', () => {
  const recorder = new DebugRecorder();
  recorder.record([walking('a', 0.5)], 500_000);
  recorder.clear();
  recorder.record([walking('a', 0.5)], 500_000 + DEBUG_RECORD_INTERVAL_MS * 4);
  assert.equal(recorder.size, 1);
  assert.equal(recorder.all[0].t, 0, 'a cleared recorder must not keep the old origin');
});

void test('a replay runs at the speed it was captured at', () => {
  const events = [
    { t: 0, people: [['a', 0.1, 0.5, 0, 0, 0, 0]] },
    { t: 1_000, people: [['a', 0.9, 0.5, 0, 0, 0, 0]] },
  ] as const;
  const replay = new DebugReplay(events as never, 10_000);
  assert.equal(replay.at(10_000)?.[0].x, 0.1);
  assert.equal(replay.at(10_500)?.[0].x, 0.9, 'the next event is the one still ahead');
  assert.equal(replay.at(11_000)?.[0].x, 0.9);
});

void test('a replay that has run out says so rather than repeating its last moment', () => {
  // The loop uses this to know the recording is over. A cursor that clamped to
  // the end would leave a body standing in the room forever.
  const replay = new DebugReplay([{ t: 0, people: [] }], 0);
  assert.deepEqual(replay.at(0), []);
  assert.equal(replay.at(1), null);
});

void test('replayed bodies are shaped like people, not like points', () => {
  const replay = new DebugReplay([{ t: 100, people: [['a', 0.25, 0.75, 0, 0, 0, 0]] }] as never, 0);
  const body = replay.at(0)![0];
  assert.equal(body.x, 0.25);
  assert.equal(body.y, 0.75);
  assert.ok(body.height > body.width, 'a replayed body must pass the same plausibility bounds');
});
