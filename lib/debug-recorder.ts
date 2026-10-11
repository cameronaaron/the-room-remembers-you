/**
 * The anonymous event recording, and playing one back.
 *
 * Opt-in, aggregate, and the only thing the room writes that describes where
 * people were: seven numbers a second per visitor, no imagery, no identity that
 * outlives the session. It is what makes a sensing defect reproducible at a
 * desk rather than only in the gallery it happened in.
 *
 * It lived in the render component, which is why the two clock bugs below
 * survived: neither is visible without recording a session, restoring it, and
 * recording again.
 */
import { round } from './memory-records.ts';
import { DEBUG_EVENT_LIMIT } from './session-export.ts';
import type { AnonymousSensorEvent, MotionBlob, VisitorTrack } from './room-types.ts';

/** One sample a second. Enough to reconstruct a walk, small enough to keep. */
export const DEBUG_RECORD_INTERVAL_MS = 1_000;

/** A replayed body, shaped like the demo pointer rather than the original blob. */
const REPLAY_BODY = { width: 0.08, height: 0.18, energy: 0.7 } as const;

export class DebugRecorder {
  private events: AnonymousSensorEvent[] = [];
  /**
   * The clock position event `t: 0` refers to.
   *
   * Every caller must hand this class the *same* monotonic clock. The component
   * used to seed this from `Date.now()` when restoring a saved session and then
   * stamp new events with `performance.now()`, so the first event recorded after
   * a restore carried a `t` of about minus fifty years — which the exporter
   * faithfully wrote out and the replay cursor read as "already past", firing
   * every restored event on the first tick.
   */
  private origin: number | null = null;
  private lastRecordedAt: number | null = null;

  /** The recording so far. Held by reference for export; never mutated outside. */
  get all(): readonly AnonymousSensorEvent[] {
    return this.events;
  }

  get size(): number {
    return this.events.length;
  }

  /**
   * File a sample if one is due. Returns whether anything was recorded, so the
   * caller can leave the status line alone when nothing was.
   */
  record(tracks: readonly VisitorTrack[], now: number): boolean {
    if (!tracks.length) return false;
    if (this.lastRecordedAt !== null && now - this.lastRecordedAt < DEBUG_RECORD_INTERVAL_MS) return false;
    if (this.origin === null) this.origin = now;
    this.lastRecordedAt = now;
    this.events.push({
      t: Math.round(now - this.origin),
      people: tracks.map((track) => [
        track.id,
        round(track.position.x),
        round(track.position.y),
        round(track.velocity.x),
        round(track.velocity.y),
        round(track.speed),
        track.occluded ? 1 : 0,
      ]),
    });
    this.trim();
    return true;
  }

  /**
   * Take on a recording from storage or from a file, and place the clock so the
   * next sample continues it rather than restarting at zero.
   *
   * Trimmed to the same bound a live recording is held to. Restoring took the
   * last 36,000 events where recording caps at 3,600, so a room reopened after a
   * long day came back holding ten times the recording it is allowed to keep —
   * against a documented 2 MiB bound on serialized state.
   */
  adopt(events: readonly AnonymousSensorEvent[], now: number): number {
    this.events = events.slice(-DEBUG_EVENT_LIMIT);
    this.origin = now - (this.events.at(-1)?.t ?? 0);
    // Not `now`: a restored recording is a second old at most in its own terms,
    // and holding the cadence gate open lets the first live sample land
    // immediately rather than a second into a session that already began.
    this.lastRecordedAt = null;
    return this.events.length;
  }

  clear() {
    this.events = [];
    this.origin = null;
    this.lastRecordedAt = null;
  }

  private trim() {
    while (this.events.length > DEBUG_EVENT_LIMIT) this.events.shift();
  }
}

/**
 * Playing a recording back into the sensing loop.
 *
 * The cursor is the recording's own timeline compared against elapsed wall
 * time, so a replay runs at the speed it was captured at however fast the
 * machine replaying it is.
 */
export class DebugReplay {
  constructor(
    private readonly events: readonly AnonymousSensorEvent[],
    private readonly startedAt: number,
  ) {}

  /** Bodies at this moment, or null once the recording has run out. */
  at(now: number): MotionBlob[] | null {
    const elapsed = now - this.startedAt;
    const event = this.events.find((item) => item.t >= elapsed);
    if (!event) return null;
    return event.people.map((person) => ({ x: person[1], y: person[2], ...REPLAY_BODY }));
  }
}
