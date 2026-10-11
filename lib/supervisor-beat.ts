/**
 * The compact progress report the native supervisor reads.
 *
 * Separate from `liveness.ts`'s heartbeat, which reports *rates* to the Node
 * launcher. This reports *counters*, and the difference is the whole point:
 *
 * > A frozen visual frame with a responsive browser is still a failure.
 *
 * A rate can be reported by a loop that has stopped, if whoever computes it is
 * not the loop. A counter that has not moved cannot pretend. `roomd` holds the
 * arrival time itself and watches three counters separately, so it can tell
 * four different failures apart:
 *
 * | what stopped | what the supervisor does |
 * | --- | --- |
 * | the process | notices the child exited |
 * | the page | no heartbeat arrives at all |
 * | the engine or the renderer | restarts the browser |
 * | the sensors | says so, and does **not** restart |
 *
 * That last row is why sensing is counted separately. A camera that has been
 * unplugged is a degraded artwork, not a broken one, and a supervisor that
 * restarts the browser over it produces a restart loop in front of visitors.
 *
 * ## What may be in it
 *
 * Four counters and one flag. Nothing else, ever. `roomd` parses this with
 * `deny_unknown_fields`, so a field added here without being added there stops
 * the supervisor seeing the room at all — which is the strictest possible
 * version of the sensing telemetry's allowlist, enforced by a different
 * language.
 */

/** Mirrors `roomd::Progress`. The names are the wire format. */
export type SupervisorBeat = {
  /** Whether a visitor has opened the room. Nothing advances before that. */
  entered: boolean;
  /** World-model steps: memory, recalls, attention, behaviour. */
  engineTick: number;
  /** Frames actually presented. */
  renderFrame: number;
  /** Camera frames actually analysed. Zero while the camera is gone. */
  sensorFrame: number;
};

/** Where `roomd` listens. The Node launcher's `/heartbeat` is a different path. */
export const SUPERVISOR_BEAT_PATH = '/supervisor/heartbeat';

/**
 * Whether this page is being supervised at all.
 *
 * The exhibition runtime is a static export served on loopback. A published
 * copy has no supervisor, and posting to it would send a request to a CDN edge
 * for no reason — `ENGINEERING-STANDARDS.md` already records that the existing
 * heartbeat is the one respect in which the hosted copy is not offline, and
 * there is no reason to add a second.
 */
export function isSupervised(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

/**
 * Build a beat from raw counters.
 *
 * Counters are floored to whole non-negative numbers because the supervisor
 * parses them as unsigned integers: a fractional or negative value is not a
 * smaller number over there, it is a parse failure, and a parse failure is a
 * room the supervisor cannot see.
 */
export function supervisorBeat(
  entered: boolean,
  engineTick: number,
  renderFrame: number,
  sensorFrame: number,
): SupervisorBeat {
  const counter = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
  return {
    entered,
    engineTick: counter(engineTick),
    renderFrame: counter(renderFrame),
    sensorFrame: counter(sensorFrame),
  };
}

/** How a beat is sent. Injected so the decision is testable without a network. */
export type BeatPost = (path: string, body: string) => void;

/**
 * The browser boundary, and only the browser boundary.
 *
 * `keepalive` so a beat in flight survives the page being torn down — which is
 * exactly the moment the supervisor most wants to hear from it. The rejection
 * is swallowed here rather than by the caller so that everything above this
 * line is a decision and everything below it is a network.
 */
export const browserBeatPost: BeatPost = (path, body) => {
  void fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
};

/**
 * Send a beat, if anything is listening.
 *
 * Failure is swallowed on purpose. The exhibit runs perfectly well with no
 * supervisor at all — `npm run dev`, a laptop, a gallery machine someone
 * started by hand — and a heartbeat that throws into the room's console every
 * five seconds is noise that hides the messages that matter.
 */
export function sendSupervisorBeat(hostname: string, beat: SupervisorBeat, post: BeatPost): boolean {
  if (!isSupervised(hostname)) return false;
  post(SUPERVISOR_BEAT_PATH, JSON.stringify(beat));
  return true;
}
