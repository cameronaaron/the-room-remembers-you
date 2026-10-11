/**
 * What to do when the room throws.
 *
 * A render error unmounts the whole tree, and what a gallery visitor sees is a
 * blank wall. The heartbeat would eventually notice — a torn-down page stops
 * reporting and the launcher relaunches Chrome — but that costs twenty seconds
 * of silence, a browser restart, and the camera and microphone being
 * reacquired, for a fault a remount in place usually clears.
 *
 * So: remount, quickly, a bounded number of times. The bound is the point. An
 * error that recurs on every render would otherwise become an unbroken remount
 * loop, which on a projector reads as flashing, and flashing is worse than a
 * still wall because it looks deliberate.
 *
 * Room memory survives a remount either way: the field and the archive are in
 * IndexedDB, not in component state.
 */

/** Attempts inside `CRASH_WINDOW_MS` before the room stops remounting itself. */
export const MAX_REMOUNTS = 4;
export const CRASH_WINDOW_MS = 10 * 60_000;

/**
 * How long to wait before remounting.
 *
 * Long enough that a fault triggered by a specific frame of sensor data is not
 * met with the identical frame, short enough that a visitor reads it as a
 * flicker in the work rather than as a computer having a problem.
 */
export const REMOUNT_DELAY_MS = 900;

export type CrashDecision = {
  /** Whether to rebuild the room in place. */
  remount: boolean;
  /** Milliseconds to wait first. */
  delayMs: number;
  /** What the operator console should record. */
  reason: string;
};

/**
 * Decide what a crash means, given the ones before it.
 *
 * `history` holds the timestamps of previous crashes, oldest first; the caller
 * keeps it. Returns the decision and the pruned history to keep.
 */
export function decideCrashRecovery(
  history: readonly number[],
  now: number,
): { decision: CrashDecision; history: number[] } {
  const recent = history.filter((at) => now - at <= CRASH_WINDOW_MS);
  recent.push(now);
  if (recent.length > MAX_REMOUNTS) {
    return {
      history: recent,
      decision: {
        remount: false,
        delayMs: 0,
        reason:
          `the room failed ${recent.length} times in ${CRASH_WINDOW_MS / 60_000} minutes — remounting has stopped, and a repeating remount on a projector reads as flashing`,
      },
    };
  }
  return {
    history: recent,
    decision: {
      remount: true,
      delayMs: REMOUNT_DELAY_MS,
      reason: `the room failed and is rebuilding itself (attempt ${recent.length} of ${MAX_REMOUNTS})`,
    },
  };
}
