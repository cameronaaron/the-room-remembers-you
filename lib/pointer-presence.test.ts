import assert from 'node:assert/strict';
import test from 'node:test';
import { PointerPresence } from './pointer-presence.ts';

void test('pointer presence expires on the analysis clock, including the exact boundary', () => {
  const pointer = new PointerPresence();
  assert.equal(pointer.sample(0), null);
  const blob = { x: 0.2, y: 0.3, width: 0.08, height: 0.18, energy: 0.7 };
  pointer.move(blob, 1000);
  blob.x = 0.9;
  assert.equal(pointer.sample(1179)?.x, 0.2);
  assert.equal(pointer.sample(1180), null);
  assert.equal(pointer.sample(1181), null);
});

void test('new movement extends presence and callers cannot mutate retained input', () => {
  const pointer = new PointerPresence();
  const blob = { x: 0.2, y: 0.3, width: 0.08, height: 0.18, energy: 0.7 };
  pointer.move(blob, 1000);
  pointer.move({ ...blob, x: 0.4 }, 1100);
  const sampled = pointer.sample(1180)!;
  assert.equal(sampled.x, 0.4);
  sampled.x = 1;
  assert.equal(pointer.sample(1279)?.x, 0.4);
  assert.equal(pointer.sample(1280), null);
});
