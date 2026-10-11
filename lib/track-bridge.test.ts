import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BLOB_STRIDE,
  FIELD,
  HEADER_FIELDS,
  RECORD_FIELDS,
  TrackFrameError,
  decodeTrackFrame,
  encodeBlobs,
} from './track-bridge.ts';

/** One record, built by hand, so the offsets are pinned to values not to code. */
function record(overrides: Partial<Record<keyof typeof FIELD, number>> = {}, path = [[0.5, 0.5, 0]]) {
  const fields = Array.from<number>({ length: RECORD_FIELDS }).fill(0);
  const values: Record<string, number> = {
    id: 7,
    bornAt: 1_000,
    lastSeen: 1_050,
    x: 0.25,
    y: 0.75,
    t: 1_050,
    previousX: 0.2,
    previousY: 0.7,
    previousT: 1_000,
    velocityX: 1,
    velocityY: 1,
    speed: 0.35,
    stillFor: 2,
    dwellSeconds: 9,
    active: 1,
    occluded: 0,
    confidence: 0.81,
    sightings: 4,
    width: 0.09,
    height: 0.24,
    pathLength: path.length,
    ...overrides,
  };
  for (const [name, offset] of Object.entries(FIELD)) fields[offset] = values[name];
  return [...fields, ...path.flat()];
}

void test('a frame decodes into the tracks the room already speaks in', () => {
  const frame = Float64Array.from([1, 0, 12, ...record()]);
  const { active, ended, fragmentRecoveries } = decodeTrackFrame(frame);
  assert.equal(ended.length, 0);
  assert.equal(fragmentRecoveries, 12);
  assert.deepEqual(active, [{
    id: 't-7',
    bornAt: 1_000,
    lastSeen: 1_050,
    position: { x: 0.25, y: 0.75, t: 1_050 },
    previous: { x: 0.2, y: 0.7, t: 1_000 },
    velocity: { x: 1, y: 1 },
    speed: 0.35,
    stillFor: 2,
    dwellSeconds: 9,
    path: [{ x: 0.5, y: 0.5, t: 0 }],
    active: true,
    occluded: false,
    confidence: 0.81,
    sightings: 4,
    extent: { width: 0.09, height: 0.24 },
  }]);
});

void test('ended tracks follow the active ones and carry their whole path', () => {
  const walked = [[0.1, 0.5, 0], [0.2, 0.5, 50], [0.3, 0.5, 100]];
  const frame = Float64Array.from([
    1, 1, 0,
    ...record({ id: 1 }),
    ...record({ id: 2, active: 0, pathLength: walked.length }, walked),
  ]);
  const { active, ended } = decodeTrackFrame(frame);
  assert.deepEqual(active.map((track) => track.id), ['t-1']);
  assert.deepEqual(ended.map((track) => track.id), ['t-2']);
  assert.equal(ended[0].active, false);
  assert.deepEqual(ended[0].path.map((point) => point.t), [0, 50, 100]);
});

/**
 * The failure this validation exists for is not a hostile producer — the buffer
 * comes from our own WASM. It is the two halves of the layout drifting apart,
 * which produces a *plausible* track at the wrong offsets and renders.
 */
void test('a buffer that does not describe a frame is refused rather than half-read', () => {
  for (const [why, frame] of [
    ['shorter than its header', [1, 0]],
    ['a count that is not a count', [1.5, 0, 0]],
    ['a negative count', [-1, 0, 0]],
    ['a record that stops early', [1, 0, 0, 1, 2, 3]],
    ['a path the record promised and did not carry', [1, 0, 0, ...record({ pathLength: 9 })]],
    ['a path with no points at all', [1, 0, 0, ...record({ pathLength: 0 }, [])]],
    ['values nobody claimed', [1, 0, 0, ...record(), 99]],
  ] as Array<[string, number[]]>) {
    assert.throws(
      () => decodeTrackFrame(Float64Array.from(frame)),
      TrackFrameError,
      `should have refused: ${why}`,
    );
  }
});

void test('an empty room decodes as an empty room, not as a failure', () => {
  assert.deepEqual(decodeTrackFrame(Float64Array.from([0, 0, 0])), {
    active: [],
    ended: [],
    fragmentRecoveries: 0,
  });
});

void test('regions pack in the order and stride the engine reads', () => {
  const packed = encodeBlobs([
    { x: 0.1, y: 0.2, width: 0.3, height: 0.4, energy: 0.5 },
    { x: 0.6, y: 0.7, width: 0.8, height: 0.9, energy: 1 },
  ]);
  assert.equal(packed.length, 2 * BLOB_STRIDE);
  assert.deepEqual([...packed], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  assert.deepEqual([...encodeBlobs([])], [], 'an empty room packs as an empty array');
});

/**
 * Two definitions of one wire format, in two languages, with no type system
 * spanning them. Reading the Rust source is ugly and it is the only thing that
 * can fail when somebody adds a field to one side.
 */
void test('the layout matches the engine that writes it', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../crates/room-engine/src/track_engine.rs', import.meta.url)),
    'utf8',
  );
  const numeric = (name: string) => {
    const match = new RegExp(`pub const ${name}: usize = (\\d+);`).exec(source);
    assert.ok(match, `${name} is not declared in track_engine.rs`);
    return Number(match[1]);
  };
  assert.equal(numeric('HEADER_FIELDS'), HEADER_FIELDS);
  assert.equal(numeric('RECORD_FIELDS'), RECORD_FIELDS);
  assert.equal(numeric('BLOB_STRIDE'), BLOB_STRIDE);

  const enumeration = /pub enum Field \{([^}]*)\}/.exec(source);
  assert.ok(enumeration, 'the Field enum is not where this test looks for it');
  const rust = new Map<string, number>();
  for (const line of enumeration[1].matchAll(/(\w+) = (\d+),/g)) {
    // Rust spells the variants in PascalCase; the decoder spells them the way
    // the rest of the TypeScript spells a field.
    rust.set(line[1][0].toLowerCase() + line[1].slice(1), Number(line[2]));
  }
  assert.deepEqual(Object.fromEntries(rust), { ...FIELD });
});
