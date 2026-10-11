/**
 * Walking an operator around the four calibration markers.
 *
 * Small, and worth having on its own anyway, because every way it can go wrong
 * goes wrong quietly. A step that advances when nothing was captured leaves the
 * quad one corner short and pairs the remaining three against the wrong
 * targets; a marker numbered from zero sends somebody to stand on the wrong
 * spot; a flow that finishes early builds a homography from a partial quad,
 * which does not fail — it produces a mapping that is subtly wrong everywhere
 * and can only be seen by watching a visitor's outline sit beside them.
 *
 * So the decision is a value the caller applies, rather than four early returns
 * tangled with React state.
 */

import { CALIBRATION_TARGETS } from './room-projection.ts';

/** Four markers, one per corner of the projected quad. */
export const CALIBRATION_MARKERS = CALIBRATION_TARGETS.length;

export type CalibrationAction =
  /** Nobody is standing on the marker. The step does not advance. */
  | { kind: 'needs-body'; message: string }
  /** Captured, and there are markers left to visit. */
  | { kind: 'advance'; step: number; message: string }
  /** Captured the last corner; the quad is complete. */
  | { kind: 'complete'; message: string };

/**
 * What pressing capture should do.
 *
 * `null` when no calibration is running, so the caller has one case for "not
 * calibrating" rather than inferring it from a step that might be zero — which
 * is a real step, and the bug that phrasing invites.
 */
export function advanceCalibration(step: number | null, hasVisibleBody: boolean): CalibrationAction | null {
  if (step === null) return null;
  if (!hasVisibleBody) {
    return { kind: 'needs-body', message: 'calibration needs one visible body on the marker' };
  }
  if (step < CALIBRATION_MARKERS - 1) {
    const next = step + 1;
    // Markers are numbered from one on the wall, because that is how they are
    // described to the person standing on them.
    return { kind: 'advance', step: next, message: `spatial calibration waiting at marker ${next + 1}` };
  }
  return { kind: 'complete', message: 'camera and projector coordinates aligned' };
}

/**
 * Whether a captured quad is one a homography can be fitted to.
 *
 * Four corners, and four *distinct* corners: an operator who presses capture
 * four times without moving hands over a degenerate quad, and the solver
 * answers with a mapping rather than an error.
 */
export function isUsableQuad(source: ReadonlyArray<{ x: number; y: number }>): boolean {
  if (source.length !== CALIBRATION_MARKERS) return false;
  if (!source.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) return false;
  const seen = new Set(source.map((point) => `${point.x},${point.y}`));
  return seen.size === CALIBRATION_MARKERS;
}
