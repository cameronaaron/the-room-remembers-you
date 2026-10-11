import assert from 'node:assert/strict';
import test from 'node:test';
import { pointerBlob, roomCommand, toggleMute, type KeyStroke } from './room-keys.ts';

const stroke = (overrides: Partial<KeyStroke> = {}): KeyStroke => ({
  key: 'o', code: 'KeyO', altKey: false, shiftKey: false, ...overrides,
});

void test('every shortcut the wall card promises resolves to its command', () => {
  const printed: Array<[string, string]> = [
    ['o', 'operator'],
    ['d', 'diagnostics'],
    ['t', 'tracking-overlay'],
    ['f', 'fullscreen'],
    ['b', 'blackout'],
    ['m', 'mute'],
  ];
  for (const [key, command] of printed) {
    assert.equal(roomCommand(stroke({ key }), false)?.command, command, key);
    // Caps lock is not a different instruction; an operator in a dark room
    // cannot see which one is on.
    assert.equal(roomCommand(stroke({ key: key.toUpperCase() }), false)?.command, command);
  }
});

void test('a key the room does not use is left to the browser', () => {
  for (const key of ['a', 'q', 'z', '1', 'Enter', 'ArrowLeft']) {
    assert.equal(roomCommand(stroke({ key, code: `Key${key}` }), false), null, key);
  }
});

void test('erasing the room needs the whole chord', () => {
  // Every near miss. A reset one modifier away from a bare letter is a reset
  // that eventually happens by accident, and it cannot be undone.
  assert.equal(roomCommand(stroke({ key: 'r', code: 'KeyR' }), false), null);
  assert.equal(roomCommand(stroke({ key: 'r', code: 'KeyR', altKey: true }), false), null);
  assert.equal(roomCommand(stroke({ key: 'R', code: 'KeyR', shiftKey: true }), false), null);
  assert.equal(
    roomCommand(stroke({ key: 'R', code: 'KeyR', altKey: true, shiftKey: true }), false)?.command,
    'reset',
  );
});

void test('space captures a calibration point only while calibrating', () => {
  const idle = roomCommand(stroke({ key: ' ', code: 'Space' }), false);
  assert.equal(idle, null, 'space outside calibration is how a visitor scrolls');
  const capturing = roomCommand(stroke({ key: ' ', code: 'Space' }), true);
  assert.equal(capturing?.command, 'capture-calibration');
  // Without this the page scrolls the projection surface out from under the
  // markers as the operator captures them.
  assert.equal(capturing?.preventDefault, true);
});

void test('nothing but calibration capture suppresses the browser default', () => {
  for (const key of ['o', 'd', 't', 'f', 'b', 'm', 'Escape']) {
    assert.equal(roomCommand(stroke({ key, code: `Key${key}` }), true)?.preventDefault, false, key);
  }
  assert.equal(
    roomCommand(stroke({ key: 'R', code: 'KeyR', altKey: true, shiftKey: true }), true)?.preventDefault,
    false,
  );
});

void test('escape cancels calibration whether or not one is running', () => {
  assert.equal(roomCommand(stroke({ key: 'Escape', code: 'Escape' }), true)?.command, 'cancel-calibration');
  assert.equal(roomCommand(stroke({ key: 'Escape', code: 'Escape' }), false)?.command, 'cancel-calibration');
});

void test('unmuting returns the level the operator set by ear', () => {
  // The only way that number is ever arrived at is somebody standing in the
  // room listening, so muting must not overwrite it with a default.
  const muted = toggleMute(0.37, 0.32);
  assert.equal(muted.masterVolume, 0);
  assert.equal(muted.held, 0.37);
  const restored = toggleMute(muted.masterVolume, muted.held);
  assert.equal(restored.masterVolume, 0.37);
});

void test('muting an already silent room does not lose what it was holding', () => {
  // Two presses of M in a row must not leave the room permanently silent.
  const first = toggleMute(0, 0.4);
  assert.equal(first.masterVolume, 0.4);
  assert.equal(first.held, 0.4);
});

void test('a pointer becomes a body the size of a person, in room units', () => {
  const body = pointerBlob(480, 270, 960, 540);
  assert.equal(body.x, 0.5);
  assert.equal(body.y, 0.5);
  // Not a dot: demo mode has to exercise the same extent and plausibility
  // bounds a camera blob does, or it proves nothing about the tracker.
  assert.ok(body.height > body.width);
  assert.ok(body.energy > 0);
});
