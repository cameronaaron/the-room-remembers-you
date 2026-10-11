import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAMERA_PICTURE,
  DEVICE_RETRY_MS,
  MICROPHONE_CAPTURE,
  cameraConstraints,
  cameraFailure,
  videoInputs,
} from './media-devices.ts';

void test('a chosen camera is demanded, never merely preferred', () => {
  // `ideal` silently falls back to the built-in webcam. The picture looks
  // plausible, the tracker runs, and the room quietly senses the ceiling.
  const chosen = cameraConstraints('usb-camera-1');
  assert.deepEqual(chosen.video.deviceId, { exact: 'usb-camera-1' });
});

void test('no chosen camera asks for no particular device', () => {
  const any = cameraConstraints('');
  assert.ok(!('deviceId' in any.video), 'an empty id must not become a device request');
  assert.deepEqual({ ...any.video }, { ...CAMERA_PICTURE });
});

void test('the camera is asked for a picture the cheapest machine can analyse', () => {
  const { video } = cameraConstraints('');
  assert.equal(video.width.ideal, 640);
  assert.equal(video.height.ideal, 360);
  // A camera delivering 60 fps costs analysis the room cannot spend and buys
  // nothing: the sensing loop tops out at 24 Hz.
  assert.ok(video.frameRate.max <= 30);
  assert.equal(cameraConstraints('').audio, false, 'the camera request must never open a microphone');
});

void test('nothing is allowed to rewrite the level the detector measures against', () => {
  // Automatic gain rides over quiet speech and makes the whisper threshold —
  // a number an operator tunes in the actual room — meaningless.
  assert.equal(MICROPHONE_CAPTURE.audio.autoGainControl, false);
  assert.equal(MICROPHONE_CAPTURE.video, false);
});

void test('only cameras are offered, and an unnamed one is still choosable', () => {
  const listed = videoInputs([
    { deviceId: 'a', kind: 'videoinput', label: 'Room camera' },
    { deviceId: 'b', kind: 'audioinput', label: 'Microphone' },
    { deviceId: 'c', kind: 'videoinput', label: '' },
    { deviceId: 'd', kind: 'audiooutput', label: 'Speakers' },
  ]);
  assert.deepEqual(listed.map((device) => device.deviceId), ['a', 'c']);
  // Labels are empty until permission is granted; a blank row is unpickable.
  // Numbered the way a person counts, from one, and by position in the list
  // the operator is looking at rather than by position among all devices.
  assert.equal(listed[1].label, 'Camera 2');
  assert.notEqual(listed[0].label, listed[1].label);
});

void test('the two camera failures do not read as the same problem', () => {
  // No camera at all still leaves demo motion running; a named camera that
  // will not open means the room is sensing nothing and the fix is one list away.
  const none = cameraFailure('');
  const named = cameraFailure('usb-camera-1');
  assert.notEqual(none.lastEvent, named.lastEvent);
  assert.match(named.lastEvent, /choose another/);
  assert.match(none.lastEvent, /demo motion/);
  // Both point at the keys that answer the question.
  assert.match(none.prompt, /Press D/);
  assert.equal(none.prompt, named.prompt);
});

void test('a dropped device is retried, but not in a tight loop', () => {
  assert.ok(DEVICE_RETRY_MS >= 1_000, 'retrying faster than this hammers a device that is gone');
  assert.ok(DEVICE_RETRY_MS <= 5_000, 'a camera that came back must not stay dark for long');
});
