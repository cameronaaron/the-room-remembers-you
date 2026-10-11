/**
 * The launcher's decisions, separated from the processes it spawns.
 *
 * `exhibit.mjs` is a top-level script: importing it starts a build, a server
 * and a browser. Everything it decides — whether a health response means the
 * page is alive, what Chrome is asked to be — lives here instead, where it can
 * be shown to be right without a gallery machine attached.
 */
import { parseHeartbeat, type Heartbeat } from '../lib/liveness.ts';

/** What the page's `/health` endpoint returns, as far as the launcher trusts it. */
export type HealthResponse = { beat?: unknown; ageMs?: unknown } | null;

/** A heartbeat and when it was actually observed, or null if there is no usable one. */
export type ObservedBeat = { beat: Heartbeat; receivedAt: number };

/**
 * Turn a health response into an observation, or into nothing.
 *
 * `ageMs` is how long ago the page recorded the beat, reported by the server
 * that holds it. The launcher must work back to a local timestamp rather than
 * treating the response's arrival as the beat's time: a beat the server has
 * been sitting on for two minutes is exactly the frozen page this exists to
 * catch, and reading it as fresh would make the watchdog agree the room is fine.
 *
 * A missing or non-numeric age is not an age of zero. Returning null hands the
 * watchdog its own no-heartbeat case, which already knows to wait out the
 * launch grace period rather than relaunching on a first bad reply.
 */
export function observeHealth(health: HealthResponse, now: number): ObservedBeat | null {
  if (!health || typeof health !== 'object') return null;
  const beat = parseHeartbeat(health.beat);
  if (!beat) return null;
  const { ageMs } = health;
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return null;
  return { beat, receivedAt: now - ageMs };
}

/**
 * How Chrome is asked to be the room.
 *
 * The profile directory is stable rather than temporary so camera and
 * microphone permissions, granted once by the operator, survive every
 * relaunch — a fresh profile per launch would put a permission prompt on the
 * gallery wall. The crash-restore flags matter for the same reason: a
 * relaunched Chrome must come up as the room and not as a bubble asking
 * somebody who is not there to click restore.
 */
export function chromeKioskArguments(origin: string, profileDir: string): string[] {
  return [
    '--kiosk',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    // The projector must not sleep, and the machine must not lock over the work.
    '--disable-features=CalculateNativeWinOcclusion',
    origin,
  ];
}
