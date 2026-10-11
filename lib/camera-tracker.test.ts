import assert from 'node:assert/strict';
import test from 'node:test';
import { MotionTracker } from './motion-tracker.ts';
import { chooseHardwareProfile, probeMachine } from './hardware-profile.ts';
import { FakeVideo, installDomGlobals } from './test-doubles/browser.ts';

/**
 * The camera end of sensing, and what the room decides about the machine.
 *
 * `MotionTracker` is the only part of the pipeline that touches a canvas: it
 * pulls a frame, mirrors it if asked, reduces it to luminance and hands it on.
 * Nothing tested it, so the mirror — which decides whether a visitor's trace
 * appears on the side of the room they are actually standing on — was verified
 * only by an operator looking at a wall.
 *
 * `probeMachine` likewise runs once at startup and picks the profile the whole
 * installation is tuned by. On a machine it cannot read it must return the
 * conservative answer rather than throwing before anything is drawn.
 */

/** A bright figure on a dark wall, at a fraction across the frame. */
function figureAt(position: number) {
  return (x: number) => (Math.abs(x - position) < 0.06 ? 210 : 60);
}

void test('the tracker reduces a camera frame to motion, seeing nothing in a still room', () => {
  const dom = installDomGlobals();
  try {
    const tracker = new MotionTracker();
    const video = new FakeVideo() as unknown as HTMLVideoElement;
    // Long enough to clear the two-second settle window: until it does, the
    // room is still learning the background and says so rather than claiming
    // to be tracking.
    for (let frame = 0; frame < 70; frame += 1) {
      tracker.analyze(video, 24, false, 0.85, frame * 42);
    }
    const diagnostics = tracker.getDiagnostics();
    assert.equal(diagnostics.activeCells, 0, 'an empty room has nothing moving in it');
    assert.equal(diagnostics.state, 'tracking');
  } finally {
    dom.restore();
  }
});

void test('a camera that is not ready yet yields nothing rather than a frame of noise', () => {
  // The video element exists before the stream arrives. Analysing it would
  // learn a blank frame as the room and then report the whole gallery as
  // motion the moment the camera opened.
  const dom = installDomGlobals();
  try {
    const tracker = new MotionTracker();
    const video = new FakeVideo();
    video.readyState = 1;
    assert.deepEqual(tracker.analyze(video as unknown as HTMLVideoElement, 24, false), []);
    video.readyState = 4;
    video.videoWidth = 0;
    assert.deepEqual(tracker.analyze(video as unknown as HTMLVideoElement, 24, false), []);
  } finally {
    dom.restore();
  }
});

void test('mirroring moves a visitor to the other side of the room', () => {
  // The one property an operator cannot check without standing in front of the
  // wall, and the one that makes the room feel wrong when it is inverted: a
  // trace appearing opposite the person who made it.
  const dom = installDomGlobals();
  try {
    const seen = (mirrored: boolean) => {
      const tracker = new MotionTracker();
      const video = new FakeVideo();
      for (let frame = 0; frame < 14; frame += 1) {
        tracker.analyze(video as unknown as HTMLVideoElement, 24, mirrored, 0.85, frame * 42);
      }
      // Somebody walks in, on the left of the camera's view.
      let last: ReturnType<MotionTracker['analyze']> = [];
      for (let frame = 14; frame < 30; frame += 1) {
        video.scene = figureAt(0.2 + (frame % 2) * 0.01);
        last = tracker.analyze(video as unknown as HTMLVideoElement, 24, mirrored, 0.85, frame * 42);
      }
      return last;
    };

    const direct = seen(false);
    const mirrored = seen(true);
    assert.ok(direct.length >= 1 && mirrored.length >= 1, 'the visitor must be seen either way');
    assert.ok(direct[0].x < 0.4, `unmirrored, the figure stays on the left: ${direct[0].x}`);
    assert.ok(mirrored[0].x > 0.6, `mirrored, it must move to the right: ${mirrored[0].x}`);
  } finally {
    dom.restore();
  }
});

void test('a machine with no 2D canvas is refused at construction, not at the first frame', () => {
  // Failing here is reported as "camera unavailable" before the room opens.
  // Failing on the first frame would be a throw inside the sensing loop.
  const dom = installDomGlobals({ canvas2d: false });
  try {
    assert.throws(() => new MotionTracker(), /unavailable/);
  } finally {
    dom.restore();
  }
});

void test('relearning the empty room discards what the tracker had learned', () => {
  const dom = installDomGlobals();
  try {
    const tracker = new MotionTracker();
    const video = new FakeVideo();
    for (let frame = 0; frame < 70; frame += 1) {
      tracker.analyze(video as unknown as HTMLVideoElement, 24, false, 0.85, frame * 42);
    }
    assert.equal(tracker.getDiagnostics().state, 'tracking');
    tracker.reset();
    assert.equal(tracker.getDiagnostics().state, 'idle', 'a reset tracker knows nothing');
    assert.equal(tracker.getDiagnostics().cellsPerBody, null, 'including how large a body is');
  } finally {
    dom.restore();
  }
});

void test('the machine is read rather than guessed at', () => {
  const dom = installDomGlobals({ cores: 12, webgl: { floatTargets: true, renderer: 'Apple M3 Max' } });
  try {
    const capability = probeMachine();
    assert.equal(capability.cores, 12);
    assert.equal(capability.floatTargets, true);
    assert.match(capability.renderer, /Apple M3 Max/);
    assert.equal(chooseHardwareProfile(capability), 'FULL');
    assert.ok(dom.lostContexts >= 1, 'the throwaway context must be released');
  } finally {
    dom.restore();
  }
});

void test('a machine without float render targets cannot run the particle field', () => {
  const dom = installDomGlobals({ cores: 16, webgl: { floatTargets: false, renderer: 'Some GPU' } });
  try {
    assert.equal(probeMachine().floatTargets, false);
    assert.equal(chooseHardwareProfile(probeMachine()), 'CHEAP');
  } finally {
    dom.restore();
  }
});

void test('a machine with no WebGL2 at all gets the conservative profile', () => {
  const dom = installDomGlobals({ cores: 16, webgl: null });
  try {
    const capability = probeMachine();
    assert.equal(capability.floatTargets, false);
    assert.equal(capability.renderer, '', 'nothing is claimed about a GPU that is not there');
    assert.equal(chooseHardwareProfile(capability), 'CHEAP');
  } finally {
    dom.restore();
  }
});

void test('a machine that hides its renderer still reports one', () => {
  // WEBGL_debug_renderer_info is absent in hardened browsers. Falling back to
  // the masked string keeps the profile decision on evidence rather than on a
  // blank, which chooseHardwareProfile would read as an unknown GPU.
  const dom = installDomGlobals({
    cores: 12,
    webgl: { floatTargets: true, renderer: 'WebKit WebGL', debugInfo: false },
  });
  try {
    assert.equal(probeMachine().renderer, 'WebKit WebGL');
  } finally {
    dom.restore();
  }
});

void test('a machine that cannot be probed at all is not a crash', () => {
  const dom = installDomGlobals({ throwOnCreate: true, cores: 4 });
  try {
    const capability = probeMachine();
    assert.equal(capability.floatTargets, false);
    assert.equal(capability.cores, 4, 'what could be read is still reported');
    assert.equal(chooseHardwareProfile(capability), 'CHEAP');
  } finally {
    dom.restore();
  }
});

void test('probing a server has no document to ask and says so quietly', () => {
  const scope = globalThis as Record<string, unknown>;
  const previousDocument = scope.document;
  const previousNavigator = scope.navigator;
  delete scope.document;
  delete scope.navigator;
  try {
    const capability = probeMachine();
    assert.deepEqual(capability, { cores: 0, renderer: '', floatTargets: false });
  } finally {
    if (previousDocument === undefined) delete scope.document;
    else scope.document = previousDocument;
    if (previousNavigator === undefined) delete scope.navigator;
    else scope.navigator = previousNavigator;
  }
});
