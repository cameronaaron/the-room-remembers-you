import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATTENTION_DWELL_SECONDS,
  ATTENTION_STILL_SECONDS,
  EVIDENCE_GAP_MS,
  EvidenceGate,
} from './attention-evidence.ts';
import { track } from './test-doubles/room.ts';

void test('standing still does not file evidence on every sensing tick', () => {
  // The defect the gate exists for: FULL senses twenty-four times a second, so
  // an ungated observation crosses any interest threshold within a second of
  // somebody stopping — and the room's one preference is meant to be scarce.
  const gate = new EvidenceGate();
  const standing = track({ stillFor: 60, dwellSeconds: 60 });
  let filed = 0;
  for (let tick = 0; tick < 24; tick += 1) filed += gate.observe([standing], tick * 42).length;
  assert.equal(filed, 2, 'one dwell and one stillness in the first second, and nothing more');
});

void test('evidence is filed again once the gap has passed', () => {
  const gate = new EvidenceGate();
  const standing = track({ stillFor: 60, dwellSeconds: 60 });
  assert.equal(gate.observe([standing], 1_000).length, 2);
  assert.equal(gate.observe([standing], 1_000 + EVIDENCE_GAP_MS).length, 0, 'the boundary is exclusive');
  assert.equal(gate.observe([standing], 1_000 + EVIDENCE_GAP_MS + 1).length, 2);
});

void test('a crowd standing still is one observation about the room', () => {
  // One gate per kind, not per person. Eight people stopping at once is not
  // eight reasons to be interested in any of them.
  const gate = new EvidenceGate();
  const crowd = Array.from({ length: 8 }, (_unused, index) =>
    track({ id: `visitor-${index}`, stillFor: 60, dwellSeconds: 60 }));
  const filed = gate.observe(crowd, 5_000);
  assert.equal(filed.length, 2);
  assert.deepEqual(filed.map((item) => item.trackId), ['visitor-0', 'visitor-0']);
});

void test('a visitor passing through is not evidence of anything', () => {
  const gate = new EvidenceGate();
  const passing = track({
    stillFor: ATTENTION_STILL_SECONDS - 0.1,
    dwellSeconds: ATTENTION_DWELL_SECONDS - 0.1,
  });
  assert.deepEqual(gate.observe([passing], 1_000), []);
});

void test('dwelling and stopping are separate reasons', () => {
  // Someone who has been in the room half a minute while still walking is
  // dwelling, not still; the two must not be filed as one another.
  const gate = new EvidenceGate();
  const wandering = track({ dwellSeconds: ATTENTION_DWELL_SECONDS, stillFor: 0 });
  assert.deepEqual(gate.observe([wandering], 1_000).map((item) => item.kind), ['dwell']);
  const stopped = track({ id: 'other', dwellSeconds: 0, stillFor: ATTENTION_STILL_SECONDS });
  assert.deepEqual(gate.observe([stopped], 2_000).map((item) => item.kind), ['stillness']);
});

void test('a reset room is not still holding the last visitor as a reason', () => {
  const gate = new EvidenceGate();
  const standing = track({ stillFor: 60, dwellSeconds: 60 });
  gate.observe([standing], 1_000);
  gate.reset();
  assert.equal(gate.observe([standing], 1_100).length, 2);
});
