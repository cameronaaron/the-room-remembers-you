/**
 * A measured rate over a bounded window.
 *
 * Both loops in the installation report how fast they are running, and both
 * used to do it with an ad-hoc array and their own arithmetic. The render loop
 * averaged instantaneous reciprocals — the mean of `1000 / elapsed` — which the
 * September 14 log follow-up already records as the wrong way to report a rate:
 * one 200 ms stall among sixty good frames barely moves the mean of
 * reciprocals, while it is exactly the stall a gallery notices.
 *
 * Counting samples and dividing by the time they actually took is the same
 * number when frames are even and an honest one when they are not.
 */
export class RateMeter {
  private readonly intervals: number[] = [];

  /**
   * @param capacity How many intervals the window holds. Long enough to be
   * steady, short enough that recovering from a stall is visible while the
   * operator is still looking at the instrument.
   */
  constructor(private readonly capacity: number) {}

  /** Record the gap between this event and the previous one, in milliseconds. */
  add(intervalMs: number) {
    // A zero or backwards gap is a clock artefact, not a sample: admitting one
    // would divide by an elapsed time smaller than the work it is measuring.
    if (!(intervalMs > 0)) return;
    this.intervals.push(intervalMs);
    if (this.intervals.length > this.capacity) this.intervals.shift();
  }

  /**
   * Events per second over the window, or 0 before there is anything to divide.
   *
   * No guard on the divisor: `add` admits only positive intervals, so a
   * non-empty window has a positive elapsed time by construction. A second
   * check here would be a branch no input can reach and no test can retire.
   */
  get hz(): number {
    if (!this.intervals.length) return 0;
    return (1000 * this.intervals.length) / this.intervals.reduce((sum, value) => sum + value, 0);
  }

  /** How many intervals the window currently holds. */
  get size(): number {
    return this.intervals.length;
  }

  reset() {
    this.intervals.length = 0;
  }
}

/**
 * Rate of a loop watched from outside it, counted rather than sampled.
 *
 * The heartbeat cannot ask the render loop how fast it is going, because a loop
 * that has stopped leaves its last healthy answer sitting there to be reported
 * forever — and a stalled render loop is the one failure the heartbeat exists
 * to catch. Counting presented frames and dividing by this watcher's own
 * elapsed time makes a dead loop read as zero.
 */
export class CountedRate {
  private lastCount = 0;
  private lastAt = 0;

  constructor(count = 0, at = 0) {
    this.lastCount = count;
    this.lastAt = at;
  }

  /** Rate since the previous call, given a monotonic clock. */
  sample(count: number, at: number): number {
    const elapsed = at - this.lastAt;
    // Two beats at the same instant is the only way this divides by nothing,
    // and it is a real case: a beat sent on mount and another on the first
    // interval can land on the same clock reading.
    const rate = elapsed > 0 ? ((count - this.lastCount) * 1000) / elapsed : 0;
    this.lastCount = count;
    this.lastAt = at;
    return rate;
  }
}

/** One frame's share of a 60 Hz budget. Everything slower is over 100%. */
export const FRAME_BUDGET_MS = 16.67;

/**
 * How much of the frame budget the room is spending on itself.
 *
 * A smoothed percentage rather than an instantaneous one: a single expensive
 * frame — a memory field repaint, a resize — is not a machine that cannot keep
 * up, and an operator watching the instrument needs to be able to tell those
 * apart. The smoothing is what makes the number stable enough to act on.
 */
export class RenderLoad {
  private load = 0;

  /** Record the cost of one frame and return the smoothed percentage. */
  add(elapsedMs: number): number {
    this.load = this.load * 0.9 + (elapsedMs / FRAME_BUDGET_MS) * 10;
    return this.percent;
  }

  /** Capped: past a full budget the number stops being a measurement anyway. */
  get percent(): number {
    return Math.min(100, this.load);
  }
}
