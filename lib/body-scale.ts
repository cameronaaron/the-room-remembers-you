/**
 * How large a body is, in this camera's view.
 *
 * `maxPlausibleBodies` bounds the number of people by how much of the room is
 * moving: three bodies cannot move less than one. The arithmetic is sound and
 * the constant it used was not. `CELLS_PER_PERSON = 55` was measured on a
 * desk-range webcam, where a single visitor filled 39 to 546 cells of the
 * 40x23 grid. With the camera mounted high and looking across a gallery — the
 * geometry the installation actually prescribes — one body covers about 7.
 *
 * Measured on synthetic gallery frames, that discrepancy is not a rounding
 * error, it is a factor of eight: eight people produced 83 active cells and
 * were bounded to "at most one person", and twenty-five people produced 199
 * cells and were bounded to three. The room did not go blind, report a fault,
 * or look any different. It simply saw an opening-night crowd as a few people.
 *
 * A bound expressed in absolute cells is a bound that encodes one camera
 * distance. The quantity it needs is how many cells *this* installation's
 * bodies occupy, which is observable rather than assumable: it is the size of
 * the regions the detector is already finding.
 *
 * The estimate is a median over a long window, for the same reason
 * `medianDifference` is: a minority of samples must not move it. A body that
 * briefly fragments contributes several small samples; two visitors who touch
 * contribute one large one. Neither can drag a median that a hundred ordinary
 * observations are holding in place.
 */

/**
 * How long observations count for.
 *
 * Long enough that a passing fragmentation episode is a minority of the
 * window, short enough to follow a camera that is re-aimed mid-exhibition.
 */
export const SCALE_WINDOW_MS = 30_000;

/** Samples retained. A bound on memory, not on the window. */
export const MAX_SCALE_SAMPLES = 600;

/**
 * Observations required before the estimate is trusted.
 *
 * Until then the bound is not applied at all. This is deliberate and it is the
 * asymmetry that matters: a bound with the wrong scale silently deletes people
 * who are standing in the room, while no bound merely permits an over-count —
 * and over-counting is what fragment continuity, column merging and box-overlap
 * coalescing were all built to catch. Failing toward the mechanisms that have
 * evidence behind them is better than failing toward a constant that does not.
 */
export const MIN_SCALE_SAMPLES = 24;

/**
 * Floor on the estimate.
 *
 * A body cannot be smaller than the detector's own minimum region, so an
 * estimate below this is measuring noise. It also stops a division by zero
 * becoming an unbounded person count.
 */
export const MIN_BODY_CELLS = 3;

export class BodyScale {
  private samples: Array<{ at: number; cells: number }> = [];

  /**
   * Record the sizes of the regions found in one frame, after merging. Each is
   * the detector's best current guess at one body, which is exactly the
   * quantity being estimated.
   */
  observe(cellCounts: readonly number[], now: number) {
    for (const cells of cellCounts) {
      if (cells >= MIN_BODY_CELLS) this.samples.push({ at: now, cells });
    }
    this.prune(now);
  }

  /** Whether enough has been seen for the bound to be worth applying. */
  get calibrated(): boolean {
    return this.samples.length >= MIN_SCALE_SAMPLES;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /**
   * Cells one body occupies here, or null while the estimate has no evidence.
   * Callers must not substitute a constant for null: that is the defect.
   */
  cellsPerBody(): number | null {
    if (!this.calibrated) return null;
    const sorted = this.samples.map((sample) => sample.cells).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
    return Math.max(MIN_BODY_CELLS, median);
  }

  reset() {
    this.samples = [];
  }

  private prune(now: number) {
    if (this.samples.length) {
      let first = 0;
      while (first < this.samples.length && now - this.samples[first].at > SCALE_WINDOW_MS) {
        first += 1;
      }
      if (first) this.samples = this.samples.slice(first);
    }
    const excess = this.samples.length - MAX_SCALE_SAMPLES;
    if (excess > 0) this.samples = this.samples.slice(excess);
  }
}
