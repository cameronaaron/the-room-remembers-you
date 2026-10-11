/**
 * The room takes an interest in someone.
 *
 * Everything the room does is currently uniform across whoever is present. It
 * has personality, which is a property of the whole space, and memory, which is
 * a property of the floor. It has no preference. A room that treats nine
 * minutes of someone's presence exactly as it treats the first nine seconds is
 * legible as a system; a room that occasionally becomes disproportionately
 * interested in one person is legible as something with a mind, and preference
 * is one of the few remaining signs of apparent agency the piece does not have.
 *
 * Four rules hold it back from becoming a follow-cam:
 *
 *  1. **Interest is earned by behaviour, never assigned.** It accumulates from
 *     things the room already detects — dwelling, returning, crossing old
 *     paths, stopping. A visitor who walks through is never chosen.
 *  2. **Interest is anonymous and dies with the track.** The track id is a
 *     handle for as long as that track lives and nothing else. When the person
 *     leaves, the interest ends; it is never stored, never carried to a later
 *     visit, and never transferred to whoever is nearest. Anything else would
 *     be identity persistence, which this installation does not do.
 *  3. **Interest is rare and then spent.** After it fades the room will not
 *     take an interest in anybody for several minutes. Without that it would
 *     move from person to person continuously, which is attention in the sense
 *     a security camera has attention.
 *  4. **Interest is slight.** It biases; it does not announce. Their traces
 *     linger a little longer, the room's memories reach toward them rather than
 *     away, and if it says its one line it is more likely to be about them.
 *     Nothing on the wall says any of this is happening, and there is no
 *     operator display of who was chosen — a visitor should feel watched, not
 *     be told they were.
 */

/** Things the room already detects, that make a presence worth attending to. */
export type AttentionEvidence =
  /** Stayed considerably longer than a visitor passing through. */
  | 'dwell'
  /** Came back to somewhere they had left. */
  | 'revisit'
  /** Walked into ground an old memory lies on. */
  | 'crossing'
  /** Stopped, and stayed stopped. */
  | 'stillness';

/**
 * The kinds a caller may file.
 *
 * `dwell` and `stillness` are `EvidenceGate`'s to decide, not a caller's: the
 * sensing loop runs at up to twenty-four hertz, and filing "they are still
 * standing there" on every tick makes the room interested in the first person
 * who stops walking, which is the measured failure that gate was added for.
 * Stated as a type here, in the rules, rather than only at the boundary that
 * refuses them.
 */
export type FileableEvidence = Extract<AttentionEvidence, 'revisit' | 'crossing'>;

/**
 * What each kind of evidence is worth.
 *
 * Returning is weighted highest because it is the one that cannot be done
 * accidentally: crossing a memory is the room's coincidence rather than the
 * visitor's act, and standing still happens to anyone reading a wall label.
 */
export const EVIDENCE_WEIGHT: Readonly<Record<AttentionEvidence, number>> = {
  dwell: 0.34,
  revisit: 0.5,
  crossing: 0.42,
  stillness: 0.22,
};

/** Evidence needed before the room attends to anyone. Two strong acts, or three weak ones. */
export const INTEREST_THRESHOLD = 1;

/**
 * How long evidence counts for.
 *
 * Beyond this a visitor has simply been present for a long time, which is not
 * the same as having done anything. Without the window, everybody standing in a
 * gallery eventually crosses the threshold by accumulation alone.
 */
export const EVIDENCE_WINDOW_MS = 90_000;

/** Interest arrives rather than switching on, in the same spirit as every ramped gain. */
export const INTEREST_ATTACK_MS = 4_000;
export const INTEREST_HOLD_MS = 45_000;
export const INTEREST_FADE_MS = 15_000;

/**
 * How long the room stays uninterested afterwards.
 *
 * The refractory period is what makes this preference rather than tracking.
 * Without it the room would take an interest in whoever met the threshold next,
 * continuously, which is the behaviour of a security camera and reads as one —
 * measured, a visitor who stays holds the room's interest for 96.8% of a
 * gallery day with this set to zero.
 *
 * The value follows from the bound rather than the other way round. A spell
 * lasts attack + hold + fade = 64 s, so the most of a day the room can possibly
 * spend interested in a visitor who never leaves is 64 / (64 + rest). At six
 * minutes that is 0.151, which sits *above* the 0.15 share the burn-in holds it
 * to — it passed only on the rounding of accumulated seconds, which is not
 * passing. Eight minutes gives 0.118 and a gate with real margin.
 */
export const INTEREST_REST_MS = 8 * 60_000;

/**
 * Extra memory an attended visitor deposits, at full interest.
 *
 * Deliberately small. The field is what the swarm follows, and the deposit
 * rates were already measured and deliberately left alone: reducing them by a
 * third collapsed the mean field gradient from 0.163 to 0.069. This is a
 * fraction more from one person for under a minute, not a change of regime —
 * their trace lingers a little, and nothing about the room's overall structure
 * moves.
 */
export const ATTENDED_DEPOSIT_GAIN = 0.45;

type Evidence = { at: number; weight: number };

export type AttentionFocus = {
  /** The attended track. Ephemeral, never an identity. */
  trackId: string;
  /** 0 to 1: rising, held, then fading. */
  weight: number;
};

export class RoomAttention {
  private evidence = new Map<string, Evidence[]>();
  private trackId: string | null = null;
  private startedAt = 0;
  private restUntil = 0;

  /**
   * Record a reason to find someone interesting. Callers offer freely; whether
   * it amounts to anything is this object's decision, not theirs.
   */
  observe(kind: AttentionEvidence, trackId: string, now: number) {
    if (!trackId) return;
    const entries = this.evidence.get(trackId) ?? [];
    entries.push({ at: now, weight: EVIDENCE_WEIGHT[kind] });
    this.evidence.set(trackId, entries);
  }

  /**
   * Advance. `present` is the confirmed, currently observed tracks — the same
   * gate everything else downstream of sensing uses.
   *
   * Interest ends the moment its subject is no longer present. A hidden track
   * held for occlusion recovery does not count: the room may briefly not see
   * someone it is interested in, and resuming when they reappear would require
   * holding the interest across an absence it cannot distinguish from leaving.
   */
  update(present: readonly string[], now: number) {
    const here = new Set(present);

    // Evidence belongs to a track, and a track that has gone takes it along.
    // Deleting the current key while iterating a Map is defined behaviour, and
    // re-setting an existing one does not reorder it or revisit it.
    for (const id of this.evidence.keys()) {
      if (!here.has(id)) {
        this.evidence.delete(id);
        continue;
      }
      const recent = this.evidence.get(id)!.filter((entry) => now - entry.at <= EVIDENCE_WINDOW_MS);
      if (recent.length) this.evidence.set(id, recent);
      else this.evidence.delete(id);
    }

    if (this.trackId !== null) {
      const elapsed = now - this.startedAt;
      const finished = elapsed >= INTEREST_ATTACK_MS + INTEREST_HOLD_MS + INTEREST_FADE_MS;
      if (!here.has(this.trackId) || finished) {
        this.release(now);
      }
      return;
    }

    if (now < this.restUntil) return;

    let best: string | null = null;
    let bestTotal = 0;
    for (const [id, entries] of this.evidence) {
      const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
      if (total >= INTEREST_THRESHOLD && total > bestTotal) {
        best = id;
        bestTotal = total;
      }
    }
    if (!best) return;
    this.trackId = best;
    this.startedAt = now;
    // Spent on becoming interested: their accumulated reasons do not also
    // qualify them again the moment the room is willing to look at anyone.
    this.evidence.delete(best);
  }

  /** Who the room is attending to and how strongly, or null. */
  focus(now: number): AttentionFocus | null {
    if (this.trackId === null) return null;
    const weight = this.curve(now - this.startedAt);
    if (weight <= 0) return null;
    return { trackId: this.trackId, weight };
  }

  /** How much more memory this visitor's presence deposits. 1 for everybody else. */
  depositScale(trackId: string, now: number): number {
    const focus = this.focus(now);
    if (!focus || focus.trackId !== trackId) return 1;
    return 1 + ATTENDED_DEPOSIT_GAIN * focus.weight;
  }

  /**
   * Whether the room would rather address its line to this visitor. Never a
   * guarantee: rarity is still RoomVoice's decision and its minimum gap binds
   * absolutely.
   */
  favours(trackId: string | undefined, now: number): number {
    if (!trackId) return 0;
    const focus = this.focus(now);
    return focus && focus.trackId === trackId ? focus.weight : 0;
  }

  /** Cleared with the rest of the room's state. Nothing here is ever persisted. */
  reset() {
    this.evidence.clear();
    this.trackId = null;
    this.startedAt = 0;
    this.restUntil = 0;
  }

  private release(now: number) {
    this.trackId = null;
    this.startedAt = 0;
    this.restUntil = now + INTEREST_REST_MS;
  }

  /** Rise, hold, fall. Never a step: interest that switches on reads as a trigger. */
  private curve(elapsed: number): number {
    if (elapsed < 0) return 0;
    if (elapsed < INTEREST_ATTACK_MS) return elapsed / INTEREST_ATTACK_MS;
    const held = elapsed - INTEREST_ATTACK_MS;
    if (held < INTEREST_HOLD_MS) return 1;
    const fading = held - INTEREST_HOLD_MS;
    if (fading >= INTEREST_FADE_MS) return 0;
    return 1 - fading / INTEREST_FADE_MS;
  }
}

/**
 * What the room decided on the last sensing frame.
 *
 * `trackId` is ephemeral and is never an identity. A weight of zero and a null
 * track are the same state: a spell that has just begun is attending to nobody
 * until its weight leaves zero, which is the rule above rather than a rounding
 * artefact, and a caller that latched on "someone is attended" would turn the
 * ramp into the trigger the ramp exists to avoid.
 */
export type Decision = { trackId: string | null; weight: number };

/**
 * What everything downstream of the room's interest reads.
 *
 * Deliberately clockless on the read side. `RoomAttention.focus` recomputes the
 * curve at whatever instant a caller passes, which cannot be made to agree with
 * an engine on the other side of a language boundary that decides once per
 * frame — the two would be comparing different instants and calling it a
 * divergence. Interest is decided on a sensing frame and read back; see
 * `attention-runtime.ts` for the size of that change, which is measured.
 */
export interface RoomInterest {
  /** Offer a reason to find someone interesting, at the instant it happened. */
  observe(kind: FileableEvidence, trackId: string, now: number): void;
  /** Who the room is attending to, as of the last frame. */
  decision(): Decision;
  /** How much more memory this visitor's presence deposits. 1 for everyone else. */
  depositScale(trackId: string): number;
  /** Whether the room would rather address its line to this visitor. */
  favours(trackId: string | undefined): number;
}

/**
 * Pick a memory that reaches toward the attended visitor.
 *
 * This biases *which* memory surfaces, never how often one does. Every measured
 * bound on the room's pace — the recall rate, the crossing cooldown, the
 * disturbed-occupancy share the burn-in gate holds below 10% — is a statement
 * about frequency, and this deliberately leaves all of them untouched.
 *
 * Falls back to `fallback` when there is nothing near enough to be worth
 * choosing, so an attended visitor standing in an unused corner does not drag
 * the room's whole archive over to them.
 */
export function preferMemoryNear<T extends { path: readonly { x: number; y: number }[] }>(
  candidates: readonly T[],
  at: { x: number; y: number },
  weight: number,
  fallback: T,
  reach = 0.22,
): T {
  if (weight <= 0 || candidates.length === 0) return fallback;
  let best: T | null = null;
  let bestDistance = reach;
  for (const candidate of candidates) {
    for (const point of candidate.path) {
      const distance = Math.hypot(point.x - at.x, point.y - at.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }
  return best ?? fallback;
}
