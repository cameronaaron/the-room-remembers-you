import assert from 'node:assert/strict';
import test from 'node:test';
import { MotionFrameAnalyzer } from './motion-tracker.ts';

/**
 * Sensing at the geometry the installation actually prescribes.
 *
 * Every detection constant in this project was tuned against desk-range
 * sessions, because that is where the logs came from. The README asks for the
 * opposite: a camera mounted high, looking across a gallery, where a body
 * covers about 7 cells of the 40x23 grid instead of several hundred. Nothing
 * tested that case, and at that scale the plausibility bound — dividing active
 * cells by a hardcoded 55 — reported two visitors 61 px apart as one person and
 * an eight-person group as one. Silently: no rejected frames, no fault, no
 * visible difference on the wall.
 *
 * These frames are synthetic. They cannot speak to lighting, lenses, clothing
 * or a real gallery's background, and they are not a substitute for validating
 * with the actual hardware. What they can do is hold the geometry fixed, which
 * is enough to keep a constant measured at one camera distance from being
 * applied at another.
 */

const WIDTH = 160;
const HEIGHT = 90;

/** A gallery wall: mostly uniform, with enough structure not to be degenerate. */
function emptyRoom(): Float32Array {
  const frame = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      frame[y * WIDTH + x] = 80 + Math.sin(x * 0.21) * 3 + Math.cos(y * 0.17) * 2;
    }
  }
  return frame;
}

/** One body across a gallery: about 9 x 24 px, which is roughly 7 grid cells. */
function addBody(frame: Float32Array, cx: number, cy: number, halfWidth = 4, halfHeight = 12) {
  for (let y = Math.max(0, Math.floor(cy - halfHeight)); y < Math.min(HEIGHT, cy + halfHeight); y += 1) {
    for (let x = Math.max(0, Math.floor(cx - halfWidth)); x < Math.min(WIDTH, cx + halfWidth + 1); x += 1) {
      frame[y * WIDTH + x] = 135 + Math.sin(x * 1.7 + y) * 6;
    }
  }
}

/** Run the analyzer over a scene and report the mean number of bodies found. */
function observe(
  scene: (frame: Float32Array, step: number) => void,
  frames = 160,
  measureAfter = 110,
) {
  const analyzer = new MotionFrameAnalyzer();
  for (let step = 0; step < 12; step += 1) analyzer.analyze(emptyRoom(), 24, 0.85, step * 42);
  let total = 0;
  let counted = 0;
  for (let step = 0; step < frames; step += 1) {
    const frame = emptyRoom();
    scene(frame, step);
    const blobs = analyzer.analyze(frame, 24, 0.85, (12 + step) * 42);
    if (step >= measureAfter) {
      total += blobs.length;
      counted += 1;
    }
  }
  return { mean: total / counted, diagnostics: analyzer.getDiagnostics() };
}

/**
 * Visitors stand in two ranks rather than one line, which is both what a room
 * of people looks like and what a single camera can separate: bodies in one
 * line at this scale are shoulder to shoulder, and shoulder-to-shoulder people
 * genuinely are one silhouette to a motion detector.
 */
function ranks(count: number) {
  return (frame: Float32Array, step: number) => {
    for (let index = 0; index < count; index += 1) {
      const rank = index % 2;
      const place = Math.floor(index / 2);
      addBody(
        frame,
        12 + place * 26 + rank * 13 + Math.sin(step * 0.4 + index) * 5,
        (rank ? 64 : 30) + Math.cos(step * 0.3 + index) * 3,
        4,
        11,
      );
    }
  };
}

void test('two visitors across a gallery are two people', () => {
  // The plainest possible case, and it failed: at 70 px apart, with the desk
  // -range constant, the room reported one person. Every two-person behaviour
  // the work has — approach, together, mirror, follow — needs two tracks, so
  // half the room's repertoire was unreachable at its own prescribed geometry.
  //
  // The pair move as people in a gallery move. A body holding nearly still at
  // this scale drops below the detector's minimum region from frame to frame,
  // which is a real property of the work rather than a defect of this fix.
  const { mean } = observe((frame, step) => {
    addBody(frame, 45 + Math.sin(step * 0.4) * 6, 45);
    addBody(frame, 115 + Math.cos(step * 0.3) * 6, 45);
  });
  assert.ok(mean >= 1.9, `two visitors were seen as ${mean.toFixed(1)} people`);
});

void test('a group is not collapsed into a handful', () => {
  // Eight visitors, clearly separated. Before the scale was measured rather
  // than assumed, eight along a wall reported 1.8.
  const { mean } = observe(ranks(8));
  assert.ok(mean >= 7, `eight visitors were seen as ${mean.toFixed(1)} people`);
});

void test('the room can hold more people than one profile is willing to draw', () => {
  // Twelve, matching the FULL profile and the twelve body slots the swarm
  // shader declares. The detector capped at eight, so the profile's advertised
  // twelve was unreachable and the documentation described a limit the code
  // could not deliver.
  const { mean } = observe(ranks(12));
  assert.ok(mean >= 11, `twelve visitors were seen as ${mean.toFixed(1)} people`);
  assert.ok(mean <= 12, 'the detector must not exceed its declared ceiling');
});

void test('a crowd is not mistaken for a lighting change', () => {
  // The guard tests spatial coverage, and a crowd was the obvious way to reach
  // 85% of the grid without the lights having changed. Measured, it does not
  // come close — a full room of twenty-five sits near 27% — and this records
  // the margin so a future change to the guard has to face it.
  const { diagnostics } = observe((frame, step) => {
    for (let index = 0; index < 25; index += 1) {
      addBody(frame, ((index * 37 + step * 3) % 150) + 5, 30 + ((index * 53) % 45));
    }
  });
  assert.ok(
    diagnostics.coveragePercent < 60,
    `a full room reached ${diagnostics.coveragePercent.toFixed(0)}% coverage, close to the 85% guard`,
  );
  assert.equal(diagnostics.rejectedFraction, 0, 'no frame of a crowded room may be discarded');
});

void test('one nearly-still visitor is still not three people', () => {
  // The failure the bound was built for, which the fix must not reintroduce.
  // A desk-range visitor barely moving arrives as disconnected scraps; before
  // the bound existed, 44 of 307 samples reported two or more people at a
  // median 8% coverage. The scale is learned from the same scene, so it stays
  // large here and the bound stays tight.
  const { mean } = observe((frame, step) => {
    // One large body, filling much of the frame, as at desk range.
    addBody(frame, 80, 45, 34, 40);
    // Which, while nearly still, breaks into scraps for a stretch.
    if (step > 120 && step % 3 === 0) {
      for (let y = 20; y < 70; y += 6) {
        for (let x = 50; x < 110; x += 9) frame[y * WIDTH + x] = 80;
      }
    }
  });
  assert.ok(mean <= 1.5, `one nearly-still visitor was seen as ${mean.toFixed(1)} people`);
});

void test('an empty gallery stays empty', () => {
  const { mean, diagnostics } = observe(() => {});
  assert.equal(mean, 0);
  assert.equal(diagnostics.activeCells, 0);
});
