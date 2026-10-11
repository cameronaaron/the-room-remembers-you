/**
 * Whether the room is still running, judged from outside the browser.
 *
 * `exhibit.mjs` restarts the static file server after a crash. The static file
 * server has no dependencies, holds no state, and serves eight file types; it
 * is the least likely component in the installation to fail. The renderer — a
 * Chrome process holding a camera, a microphone, an AudioContext, a GPGPU
 * simulation and twelve hours of accumulated room memory — was not watched at
 * all, and `kioskOpened` latched true so it was never reopened either.
 *
 * So the page reports a pulse and the launcher judges it. The judgement lives
 * here rather than in the launcher because "is the room alive" is exactly the
 * kind of question that should be answerable by a test rather than by standing
 * in the gallery at 2pm.
 *
 * What counts as alive is deliberately narrow. A page that is loaded, painting
 * and running its sensing loop is alive. A page that is loaded and frozen is
 * not, and it is the frozen one that motivates this: a crashed tab at least
 * shows Chrome's own error page, while a stalled render loop shows the last
 * frame it managed, forever, which in a dark gallery is indistinguishable from
 * a room that simply has nothing to remember.
 */

export type Heartbeat = {
  /** Page clock, epoch ms. Only ever compared against itself. */
  at: number;
  /** How long this page has been running. Resets on reload, which is the point. */
  uptimeMs: number;
  /** Frames actually presented per second, measured over the last interval. */
  fps: number;
  /** Sensing loop rate, which fails independently of the render loop. */
  sensingHz: number;
  /** Confirmed, observed people. Present only so the log is worth reading. */
  tracks: number;
  /** Whether a visitor has passed the threshold screen. */
  entered: boolean;
  /** Which engine is drawing, so an abandoned particle field is visible here. */
  engine: string;
};

/** How often the page reports. Four missed beats is the staleness bound below. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Silence tolerated before the page is presumed gone.
 *
 * Four intervals. A single missed beat is ordinary — a long GC pause, a
 * `setTimeout` starved by a heavy frame, a request that lost a race with a
 * rebuild. Relaunching Chrome on one missed beat would take the room away from
 * a visitor standing in front of it to fix a problem that did not exist.
 */
export const HEARTBEAT_STALE_MS = 4 * HEARTBEAT_INTERVAL_MS;

/**
 * Grace given to a launch before silence means failure.
 *
 * Chrome has to start, the page has to load, and on a cold machine the first
 * paint can be slow. Nothing is concluded until this has passed.
 */
export const LAUNCH_GRACE_MS = 90_000;

/**
 * Frame rate below which a page that claims to be running is not drawing.
 *
 * Not a performance target. The particle field is built to hold 60 fps and the
 * profile below it exists for weaker machines, so this is far beneath anything
 * the work is willing to look like; it is only asking whether frames are being
 * presented at all. Chrome throttles a fully occluded tab to about 1 Hz, which
 * sits below this and should: an occluded kiosk tab is a black projector.
 */
export const RENDER_FLOOR_FPS = 4;

/**
 * The shortest gap between two relaunches.
 *
 * A relaunch that does not fix the problem must not become a loop that reopens
 * Chrome every twenty seconds all day. If the second attempt has not taken, the
 * fault needs a person.
 */
export const RELAUNCH_BACKOFF_MS = 5 * 60_000;

export type LivenessState =
  /** Not long enough has passed to conclude anything. */
  | 'starting'
  /** Reporting, painting, sensing. */
  | 'ok'
  /** Reporting, but not painting frames. */
  | 'frozen'
  /** Not reporting at all. */
  | 'gone';

export type LivenessVerdict = {
  state: LivenessState;
  /** Plain sentence with the actual numbers in it, for the launcher's log. */
  reason: string;
  /** Whether the browser should be relaunched now. */
  relaunch: boolean;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Accept a heartbeat off the wire, or reject it whole.
 *
 * The launcher decides whether to take the room away from the gallery based on
 * this, so a half-parsed body that leaves `fps` undefined must not read as a
 * frozen page.
 */
export function parseHeartbeat(value: unknown): Heartbeat | null {
  if (typeof value !== 'object' || value === null) return null;
  const beat = value as Partial<Heartbeat>;
  if (!isFiniteNumber(beat.at) || !isFiniteNumber(beat.uptimeMs)) return null;
  if (!isFiniteNumber(beat.fps) || beat.fps < 0) return null;
  if (!isFiniteNumber(beat.sensingHz) || beat.sensingHz < 0) return null;
  if (!isFiniteNumber(beat.tracks) || beat.tracks < 0) return null;
  if (typeof beat.entered !== 'boolean') return null;
  if (typeof beat.engine !== 'string' || !beat.engine) return null;
  return {
    at: beat.at,
    uptimeMs: beat.uptimeMs,
    fps: beat.fps,
    sensingHz: beat.sensingHz,
    tracks: beat.tracks,
    entered: beat.entered,
    engine: beat.engine,
  };
}

/**
 * Decide what the launcher should do.
 *
 * `receivedAt` is the launcher's own clock at the moment the last beat arrived,
 * never the page's `at`. The two clocks belong to different processes and the
 * page's is the one that stops when the page does, so trusting it to measure
 * its own absence is circular.
 */
export function assessLiveness(
  last: { beat: Heartbeat; receivedAt: number } | null,
  now: number,
  launchedAt: number,
): LivenessVerdict {
  if (!last) {
    const waited = now - launchedAt;
    if (waited < LAUNCH_GRACE_MS) {
      return {
        state: 'starting',
        reason: `waiting for the first heartbeat (${Math.round(waited / 1000)}s of ${LAUNCH_GRACE_MS / 1000}s)`,
        relaunch: false,
      };
    }
    return {
      state: 'gone',
      reason: `no heartbeat in the ${Math.round(waited / 1000)}s since launch — the page never loaded`,
      relaunch: true,
    };
  }

  const silence = now - last.receivedAt;
  if (silence > HEARTBEAT_STALE_MS) {
    return {
      state: 'gone',
      reason: `last heartbeat ${Math.round(silence / 1000)}s ago, over the ${HEARTBEAT_STALE_MS / 1000}s bound — the renderer is not running`,
      relaunch: true,
    };
  }

  // Frame rate is only meaningful once a visitor has passed the threshold
  // screen: before that the room is a static page and is supposed to be.
  if (last.beat.entered && last.beat.fps < RENDER_FLOOR_FPS) {
    return {
      state: 'frozen',
      reason: `reporting but drawing ${last.beat.fps.toFixed(1)} fps, under the ${RENDER_FLOOR_FPS} fps floor — the projection is a still image`,
      relaunch: true,
    };
  }

  return {
    state: 'ok',
    reason: `${last.beat.fps.toFixed(0)} fps · ${last.beat.sensingHz.toFixed(1)} Hz sensing · ${last.beat.tracks} tracked · ${last.beat.engine}`,
    relaunch: false,
  };
}

/**
 * Holds the one piece of state a verdict cannot: when the browser was last
 * relaunched. Without it, a page that never comes back is relaunched on every
 * poll.
 */
export class RenderWatchdog {
  private lastRelaunchAt: number | null = null;
  private launchedAt: number;
  private relaunches = 0;

  constructor(launchedAt: number) {
    this.launchedAt = launchedAt;
  }

  /** Whether a relaunch should happen now, and why. */
  check(
    last: { beat: Heartbeat; receivedAt: number } | null,
    now: number,
  ): LivenessVerdict {
    const verdict = assessLiveness(last, now, this.launchedAt);
    if (!verdict.relaunch) return verdict;
    if (
      this.lastRelaunchAt !== null
      && now - this.lastRelaunchAt < RELAUNCH_BACKOFF_MS
    ) {
      return {
        ...verdict,
        relaunch: false,
        reason: `${verdict.reason}; already relaunched ${Math.round((now - this.lastRelaunchAt) / 1000)}s ago, waiting`,
      };
    }
    return verdict;
  }

  /**
   * Record that the browser was relaunched. The grace period restarts with it:
   * the new page has to load before its silence means anything.
   */
  relaunched(now: number) {
    this.lastRelaunchAt = now;
    this.launchedAt = now;
    this.relaunches += 1;
  }

  get count(): number {
    return this.relaunches;
  }
}
