import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BEHAVIOR,
  BehaviorFrameError,
  EVENT_FIELD,
  EVENT_STRIDE,
  FIELD,
  HEADER_FIELDS,
  MAX_EVENTS,
  NO_TRACK,
  OUTPUT_HEADER_FIELDS,
  PATH_STRIDE,
  RECORD_FIELDS,
  decodeBehaviorFrame,
  encodeBehaviorFrame,
  type ObservedTrack,
} from './behavior-bridge.ts';

function walker(id: string, path: { x: number; y: number; t: number }[] = []): ObservedTrack {
  return { id, x: 0.4, y: 0.6, width: 0.12, velocityX: 0.1, velocityY: -0.2, speed: 0.22, path };
}

void test('a frame packs each track and then its path', () => {
  const packed = encodeBehaviorFrame(1_234, true, [
    walker('t-3', [{ x: 0.1, y: 0.2, t: 900 }, { x: 0.3, y: 0.4, t: 1_000 }]),
  ]);
  assert.deepEqual([...packed], [
    1_234, 1, 1,
    3, 0.4, 0.6, 0.12, 0.1, -0.2, 0.22, 2,
    0.1, 0.2, 900,
    0.3, 0.4, 1_000,
  ]);
  assert.equal(packed.length, HEADER_FIELDS + RECORD_FIELDS + 2 * PATH_STRIDE);
});

void test('an empty gallery is a header and nothing else', () => {
  assert.deepEqual([...encodeBehaviorFrame(0, true, [])], [0, 1, 0]);
  assert.deepEqual([...encodeBehaviorFrame(0, false, [])], [0, 0, 0]);
});

void test('an unsettled pipeline is carried as a flag, not as an empty frame', () => {
  const settled = encodeBehaviorFrame(5, true, [walker('t-1')]);
  const warming = encodeBehaviorFrame(5, false, [walker('t-1')]);
  assert.equal(settled[1], 1);
  assert.equal(warming[1], 0);
  // History still crosses while sensing warms up: the detectors need
  // continuity across the boundary even though nothing may be reported.
  assert.equal(settled.length, warming.length);
});

/**
 * Ids cross as numbers because the engine mints them as integers. A caller
 * mixing two id spaces is a defect, and one that silently encoded `NaN` would
 * make the room announce things about a visitor who does not exist.
 */
void test('an id this engine did not mint is refused rather than encoded as nonsense', () => {
  for (const id of ['visitor-abc-3', 'g-1a2b3c', 't-', 't-x', '3', '', 't-3 ']) {
    assert.throws(
      () => encodeBehaviorFrame(0, true, [walker(id)]),
      BehaviorFrameError,
      `"${id}" should not encode`,
    );
  }
});

void test('a reported event reads back as a kind, a place and its subjects', () => {
  const { events, tracked } = decodeBehaviorFrame(Float64Array.from([
    2, 3,
    BEHAVIOR.revisit, 0.25, 0.75, 4, NO_TRACK,
    BEHAVIOR.follow, 0.5, 0.5, 9, 2,
  ]));
  assert.equal(tracked, 3);
  assert.deepEqual(events, [
    { kind: 'revisit', at: { x: 0.25, y: 0.75 }, subjects: ['t-4'] },
    { kind: 'follow', at: { x: 0.5, y: 0.5 }, subjects: ['t-9', 't-2'] },
  ]);
});

void test('a quiet frame reads back as no events at all', () => {
  assert.deepEqual(decodeBehaviorFrame(Float64Array.from([0, 0])), { events: [], tracked: 0 });
});

/**
 * The failure this validation exists for is not a hostile producer — the buffer
 * comes from our own WASM. It is the two halves of the layout drifting apart,
 * which produces a *plausible* answer at the wrong offsets and then announces
 * the wrong thing about the wrong person, which is the one mistake the room
 * cannot take back.
 */
void test('a buffer that does not describe a frame is refused rather than half-read', () => {
  for (const [why, frame] of [
    ['no header', [1]],
    ['a fractional count', [0.5, 0]],
    ['a negative count', [-1, 0]],
    ['more events than there are behaviours', [MAX_EVENTS + 1, 0]],
    ['a count its length cannot hold', [1, 0]],
    ['a length its count cannot fill', [0, 0, BEHAVIOR.wave, 0, 0, 1, NO_TRACK]],
    ['a held-track count that is not a count', [0, -1]],
    ['a behaviour that does not exist', [1, 0, 6, 0, 0, 1, NO_TRACK]],
    ['nowhere to be addressed', [1, 0, BEHAVIOR.wave, Number.NaN, 0, 1, NO_TRACK]],
    ['no subject', [1, 0, BEHAVIOR.wave, 0, 0, -1, NO_TRACK]],
    ['a fractional subject', [1, 0, BEHAVIOR.wave, 0, 0, 1.5, NO_TRACK]],
    ['a second subject that is not a track', [1, 0, BEHAVIOR.follow, 0, 0, 1, -2]],
    ['the same person twice', [1, 0, BEHAVIOR.follow, 0, 0, 1, 1]],
    [
      'the same behaviour twice, which a cooldown makes impossible',
      [2, 0, BEHAVIOR.wave, 0, 0, 1, NO_TRACK, BEHAVIOR.wave, 0, 0, 2, NO_TRACK],
    ],
  ] as [string, number[]][]) {
    assert.throws(() => decodeBehaviorFrame(Float64Array.from(frame)), BehaviorFrameError, why);
  }
});

/**
 * The two sides of a boundary no type system spans.
 *
 * `behavior_engine.rs` declares the layout and this file mirrors it. Reading
 * the Rust here is what turns "keep them in step" from a comment into a check:
 * a field added on one side alone fails this rather than shipping.
 */
void test('the layout this decodes is the layout the engine writes', () => {
  const engine = readFileSync(
    fileURLToPath(new URL('../crates/room-engine/src/behavior_engine.rs', import.meta.url)),
    'utf8',
  );
  const numeric = (name: string) => {
    const match = new RegExp(`pub const ${name}: usize = (\\d+);`).exec(engine);
    assert.ok(match, `${name} is not declared in behavior_engine.rs`);
    return Number(match[1]);
  };
  assert.equal(numeric('HEADER_FIELDS'), HEADER_FIELDS);
  assert.equal(numeric('RECORD_FIELDS'), RECORD_FIELDS);
  assert.equal(numeric('PATH_STRIDE'), PATH_STRIDE);
  assert.equal(numeric('OUTPUT_HEADER_FIELDS'), OUTPUT_HEADER_FIELDS);
  assert.equal(numeric('EVENT_STRIDE'), EVENT_STRIDE);

  const offsets = (name: string) => {
    const enumeration = new RegExp(`pub enum ${name} \\{([^}]*)\\}`).exec(engine);
    assert.ok(enumeration, `the ${name} enum is not where this test looks for it`);
    const fields = new Map<string, number>();
    for (const line of enumeration[1].matchAll(/(\w+) = (\d+),/g)) {
      fields.set(line[1][0].toLowerCase() + line[1].slice(1), Number(line[2]));
    }
    return Object.fromEntries(fields);
  };
  assert.deepEqual(offsets('Field'), { ...FIELD });
  assert.deepEqual(offsets('EventField'), { ...EVENT_FIELD });

  const sentinel = /pub const NO_TRACK: f64 = (-?[\d.]+);/.exec(engine);
  assert.ok(sentinel, 'NO_TRACK is not declared in behavior_engine.rs');
  assert.equal(Number(sentinel[1]), NO_TRACK);

  // `MAX_EVENTS` is `BEHAVIORS.len()` in Rust, so the count is read from the
  // table of behaviours rather than from a literal that could drift.
  const behaviours = readFileSync(
    fileURLToPath(new URL('../crates/room-engine/src/behavior.rs', import.meta.url)),
    'utf8',
  );
  const table = /pub const BEHAVIORS: \[Behavior; (\d+)\]/.exec(behaviours);
  assert.ok(table, 'BEHAVIORS is not declared in behavior.rs');
  assert.equal(Number(table[1]), MAX_EVENTS);
});

void test('the behaviour codes are the ones the engine reads', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../crates/room-engine/src/behavior.rs', import.meta.url)),
    'utf8',
  );
  const table = /pub const fn index\(self\) -> usize \{\s*match self \{([^}]*)\}/.exec(source);
  assert.ok(table, 'Behavior::index is not where this test looks for it');
  const codes = new Map<string, number>();
  for (const line of table[1].matchAll(/Self::(\w+) => (\d+),/g)) {
    codes.set(line[1].toLowerCase(), Number(line[2]));
  }
  assert.deepEqual(Object.fromEntries(codes), { ...BEHAVIOR });

  // And the names, so a kind spelled differently on the two sides is caught
  // here rather than by a voice table that silently has nothing to say.
  const names = /pub const fn name\(self\) -> &'static str \{\s*match self \{([^}]*)\}/.exec(source);
  assert.ok(names, 'Behavior::name is not where this test looks for it');
  for (const line of names[1].matchAll(/Self::(\w+) => "(\w+)",/g)) {
    assert.equal(line[1].toLowerCase(), line[2]);
    assert.ok(line[2] in BEHAVIOR, `${line[2]} is not a kind this bridge knows`);
  }
});

/**
 * The cooldowns are the reason one kind can appear at most once per frame,
 * which is the reason `MAX_EVENTS` is the number of behaviours rather than a
 * guess. Reading them here keeps that argument checkable.
 */
void test('every behaviour the engine knows has a cooldown', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../crates/room-engine/src/behavior.rs', import.meta.url)),
    'utf8',
  );
  const table = /pub const fn cooldown_ms\(self\) -> f64 \{\s*match self \{([^}]*)\}/.exec(source);
  assert.ok(table, 'Behavior::cooldown_ms is not where this test looks for it');
  const cooled = new Set<string>();
  for (const line of table[1].matchAll(/Self::(\w+) => ([\d_]+)\.0,/g)) {
    assert.ok(Number(line[2].replaceAll('_', '')) > 0, `${line[1]} has no cooldown`);
    cooled.add(line[1].toLowerCase());
  }
  assert.deepEqual([...cooled].sort(), Object.keys(BEHAVIOR).sort());
});
