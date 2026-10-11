/**
 * Turning what a visitor is doing into occasional evidence.
 *
 * `RoomAttention` decides whether anything amounts to interest; this decides
 * when it is told. Evidence is an event, not a state, and the sensing loop runs
 * at up to twenty-four hertz: filing "they are still standing there" on every
 * tick crosses any threshold instantly and makes the room interested in the
 * first person who stops walking.
 */
import type { VisitorTrack } from './room-types.ts';

/**
 * How long a presence has to persist before it is worth the room's interest.
 *
 * A gallery visitor crosses a room in a few seconds. Half a minute in one place
 * is somebody who has decided to stay, which is the distinction the attention
 * system is built on: it attends to what people do, never to who they are.
 */
export const ATTENTION_DWELL_SECONDS = 30;
export const ATTENTION_STILL_SECONDS = 12;

/** The gap between two filings of the same kind, whoever they are about. */
export const EVIDENCE_GAP_MS = 20_000;

export type Evidence = { kind: 'dwell' | 'stillness'; trackId: string };

/**
 * One gate per kind, not per person: the room's interest is a single scarce
 * thing, and a crowd of people all standing still is one observation about the
 * room rather than eight about individuals.
 */
export class EvidenceGate {
  /** null means nothing of this kind has been filed, at any clock reading. */
  private lastDwell: number | null = null;
  private lastStill: number | null = null;

  observe(tracks: readonly VisitorTrack[], now: number): Evidence[] {
    const filed: Evidence[] = [];
    for (const track of tracks) {
      if (track.dwellSeconds >= ATTENTION_DWELL_SECONDS && this.due(this.lastDwell, now)) {
        this.lastDwell = now;
        filed.push({ kind: 'dwell', trackId: track.id });
      }
      if (track.stillFor >= ATTENTION_STILL_SECONDS && this.due(this.lastStill, now)) {
        this.lastStill = now;
        filed.push({ kind: 'stillness', trackId: track.id });
      }
    }
    return filed;
  }

  /**
   * A gate that has never fired does not suppress anything.
   *
   * Comparing an unset zero against the page clock made this a warmup as well
   * as a spacing rule: for the first twenty seconds of a session no evidence
   * could be filed at all, so the first visitor to stop in front of a room that
   * had just been opened was the one visitor it could not become interested in.
   * Zero is also a clock reading a test can pass, and `!last` cannot tell it
   * from an unset field — so the absence is held as null rather than inferred.
   */
  private due(last: number | null, now: number): boolean {
    return last === null || now - last > EVIDENCE_GAP_MS;
  }

  reset() {
    this.lastDwell = null;
    this.lastStill = null;
  }
}
