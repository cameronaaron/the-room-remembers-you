import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ATTENDED_DEPOSIT_GAIN,
  AttentionFrameError,
  EVIDENCE,
  FIELD,
  FILEABLE,
  FILING_STRIDE,
  HEADER_FIELDS,
  MAX_FILINGS,
  NO_TRACK,
  OUTPUT_FIELDS,
  PRESENCE_STRIDE,
  decodeAttentionFrame,
  depositScale,
  encodeAttentionFrame,
} from './attention-bridge.ts';

void test('a frame packs in the order the room decides in', () => {
  const packed = encodeAttentionFrame(
    1_234,
    // The revisit happened on this frame; the crossing was filed after the
    // previous one, which is why it carries an instant of its own.
    [
      { kind: 'revisit', trackId: 't-3', at: 1_234 },
      { kind: 'crossing', trackId: 't-7', at: 1_192 },
    ],
    [{ id: 't-3', dwellSeconds: 41, stillFor: 13 }],
  );
  assert.deepEqual([...packed], [
    1_234, 2, 1,
    EVIDENCE.revisit, 3, 1_234,
    EVIDENCE.crossing, 7, 1_192,
    3, 41, 13,
  ]);
  assert.equal(packed.length, HEADER_FIELDS + 2 * FILING_STRIDE + PRESENCE_STRIDE);
});

void test('an empty gallery is a header and nothing else', () => {
  assert.deepEqual([...encodeAttentionFrame(0, [], [])], [0, 0, 0]);
});

/**
 * Ids cross as numbers because the engine mints them as integers. A caller
 * mixing two id spaces is a defect, and a defect that silently encoded `NaN`
 * would make the room attend to nobody for the rest of the exhibition.
 */
void test('an id this engine did not mint is refused rather than encoded as nonsense', () => {
  for (const id of ['g-1a2b3c', 't-', 't-x', '3', '', 't-3 ']) {
    assert.throws(
      () => encodeAttentionFrame(0, [], [{ id, dwellSeconds: 0, stillFor: 0 }]),
      AttentionFrameError,
      `"${id}" should not encode`,
    );
  }
});

void test('a decided frame reads back as a track and a weight', () => {
  const decided = decodeAttentionFrame(Float64Array.from([1, 9, 0.5, 2, 3]));
  assert.deepEqual(decided, { trackId: 't-9', weight: 0.5, tracked: 2, filings: 3 });
  assert.equal(depositScale(decided, 't-9'), 1 + ATTENDED_DEPOSIT_GAIN * 0.5);
  assert.equal(depositScale(decided, 't-4'), 1, 'exactly one for everybody else');
});

void test('an unattended room reads back as nobody, not as track zero', () => {
  const decided = decodeAttentionFrame(Float64Array.from([0, NO_TRACK, 0, 0, 0]));
  assert.equal(decided.trackId, null);
  assert.equal(decided.weight, 0);
  assert.equal(depositScale(decided, 't-0'), 1);
});

/**
 * The failure this validation exists for is not a hostile producer — the buffer
 * comes from our own WASM. It is the two halves of the layout drifting apart,
 * which produces a *plausible* answer at the wrong offsets and then quietly
 * attends to the wrong person, which nothing on the wall would show.
 */
void test('a buffer that does not describe a decision is refused rather than half-read', () => {
  for (const [why, frame] of [
    ['too short', [1, 9, 0.5, 2]],
    ['too long', [1, 9, 0.5, 2, 3, 0]],
    ['the flag is not a flag', [2, 9, 0.5, 0, 0]],
    ['attending nobody but naming a track', [0, 9, 0, 0, 0]],
    ['attending nobody but carrying a weight', [0, NO_TRACK, 0.5, 0, 0]],
    ['attending a fractional track', [1, 9.5, 0.5, 0, 0]],
    ['attending with no weight at all', [1, 9, 0, 0, 0]],
    ['attending with a weight above one', [1, 9, 1.5, 0, 0]],
    ['attending a track that is not a track', [1, -1, 0.5, 0, 0]],
  ] as [string, number[]][]) {
    assert.throws(
      () => decodeAttentionFrame(Float64Array.from(frame)),
      AttentionFrameError,
      why,
    );
  }
});

/**
 * The two sides of a boundary no type system spans.
 *
 * `attention_engine.rs` declares the layout and this file mirrors it. Reading
 * the Rust here is what turns "keep them in step" from a comment into a check:
 * a field added on one side alone fails this rather than shipping.
 */
void test('the layout this decodes is the layout the engine writes', () => {
  const engine = readFileSync(
    fileURLToPath(new URL('../crates/room-engine/src/attention_engine.rs', import.meta.url)),
    'utf8',
  );
  const numeric = (name: string) => {
    const match = new RegExp(`pub const ${name}: usize = (\\d+);`).exec(engine);
    assert.ok(match, `${name} is not declared in attention_engine.rs`);
    return Number(match[1]);
  };
  assert.equal(numeric('HEADER_FIELDS'), HEADER_FIELDS);
  assert.equal(numeric('FILING_STRIDE'), FILING_STRIDE);
  assert.equal(numeric('PRESENCE_STRIDE'), PRESENCE_STRIDE);
  assert.equal(numeric('OUTPUT_FIELDS'), OUTPUT_FIELDS);

  // Declared in Rust as `TRACKS_MAX + 4`, so both halves of that sum are read
  // rather than the literal being trusted to have stayed in step.
  const bounded = readFileSync(
    fileURLToPath(new URL('../crates/room-protocol/src/bounded.rs', import.meta.url)),
    'utf8',
  );
  const tracksMax = /pub const TRACKS_MAX: usize = (\d+);/.exec(bounded);
  assert.ok(tracksMax, 'TRACKS_MAX is not declared in bounded.rs');
  const headroom = /pub const MAX_FILINGS: usize = TRACKS_MAX \+ (\d+);/.exec(engine);
  assert.ok(headroom, 'MAX_FILINGS is not declared in attention_engine.rs');
  assert.equal(Number(tracksMax[1]) + Number(headroom[1]), MAX_FILINGS);

  const enumeration = /pub enum Field \{([^}]*)\}/.exec(engine);
  assert.ok(enumeration, 'the Field enum is not where this test looks for it');
  const fields = new Map<string, number>();
  for (const line of enumeration[1].matchAll(/(\w+) = (\d+),/g)) {
    fields.set(line[1][0].toLowerCase() + line[1].slice(1), Number(line[2]));
  }
  assert.deepEqual(Object.fromEntries(fields), { ...FIELD });

  const sentinel = /pub const NO_TRACK: f64 = (-?[\d.]+);/.exec(engine);
  assert.ok(sentinel, 'NO_TRACK is not declared in attention_engine.rs');
  assert.equal(Number(sentinel[1]), NO_TRACK);
});

void test('the evidence codes are the ones the engine reads', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../crates/room-engine/src/attention.rs', import.meta.url)),
    'utf8',
  );
  const table = /pub const fn code\(self\) -> f64 \{\s*match self \{([^}]*)\}/.exec(source);
  assert.ok(table, 'Evidence::code is not where this test looks for it');
  const codes = new Map<string, number>();
  for (const line of table[1].matchAll(/Self::(\w+) => ([\d.]+),/g)) {
    codes.set(line[1].toLowerCase(), Number(line[2]));
  }
  assert.deepEqual(Object.fromEntries(codes), { ...EVIDENCE });

  // The two the engine refuses. Stated here so that a caller reading only this
  // file still learns which kinds are the gate's, not theirs.
  assert.deepEqual([...FILEABLE], ['revisit', 'crossing']);
  for (const kind of FILEABLE) assert.ok(kind in EVIDENCE);

  const gain = /pub const ATTENDED_DEPOSIT_GAIN: f64 = ([\d.]+);/.exec(source);
  assert.ok(gain, 'ATTENDED_DEPOSIT_GAIN is not declared in attention.rs');
  assert.equal(Number(gain[1]), ATTENDED_DEPOSIT_GAIN);
});
