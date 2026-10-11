/**
 * What the room can notice people doing.
 *
 * Everything here is derived from anonymous motion: centroids, velocities, the
 * size of the detected region, and how those relate between people over time.
 * No pose model, no face, no identity. That constraint is not a limitation to
 * work around — it is the piece's privacy position, and it turns out to leave
 * most of the socially interesting behaviour on the table.
 *
 * What it does rule out is worth stating plainly, because it is not obvious:
 *
 *   - **Looking toward the camera** needs a face or gaze model. Motion cannot
 *     see where someone is pointed, only where they are.
 *   - **Walking backwards** needs orientation. Without knowing which way a body
 *     faces, retreating and reversing are the same signal. `revisit` and the
 *     existing `return` event cover the honest half of that idea.
 *
 * Detectors are deliberately conservative: each has a cooldown, a minimum
 * duration, and thresholds chosen so that ordinary milling about does not
 * trigger them. A behaviour the room announces wrongly is worse than one it
 * misses, because the whole effect depends on the visitor believing it.
 */

import type { VisitorTrack } from './room-types';

export type BehaviorKind =
  /** Standing still while the body's outline keeps changing: arms moving. */
  | 'wave'
  /** Two people closing the distance between them. */
  | 'approach'
  /** One person walking the path another walked moments earlier. */
  | 'follow'
  /** Two people who arrived within moments of each other. */
  | 'together'
  /** Returning to a spot they occupied earlier and then left. */
  | 'revisit'
  /** Two people apart, moving in step. */
  | 'mirror';

export type BehaviorEvent = {
  kind: BehaviorKind;
  /** Where to address it, in room coordinates. */
  at: { x: number; y: number };
  /** Tracks involved. Ephemeral ids, never identities. */
  subjects: string[];
};

/** Minimum gap between two reports of the same behaviour. */
const COOLDOWN_MS: Readonly<Record<BehaviorKind, number>> = {
  wave: 20_000,
  approach: 30_000,
  follow: 45_000,
  together: 60_000,
  revisit: 40_000,
  mirror: 45_000,
};

const WAVE_WINDOW_MS = 1_600;
const WAVE_MAX_DRIFT = 0.045;
const WAVE_MIN_SWING = 0.035;
const WAVE_MIN_REVERSALS = 2;

const APPROACH_WINDOW_MS = 2_000;
const APPROACH_START = 0.38;
const APPROACH_END = 0.22;

const FOLLOW_LAGS_MS = [1_000, 1_600, 2_400, 3_400];
const FOLLOW_TOLERANCE = 0.09;
const FOLLOW_MIN_TRAVEL = 0.25;

const TOGETHER_WINDOW_MS = 1_400;

/**
 * How close to the edge of the room a track must first appear to count as
 * someone arriving.
 *
 * A track being born is not the same event as a person arriving, and treating
 * them as one is a systematic false positive rather than an occasional one.
 * Every track in the room is born simultaneously when sensing starts, and a
 * track re-appearing in the middle of the room after an occlusion was never
 * away. On a real session this made the room tell a single visitor "two of you,
 * at once" within three seconds of starting.
 *
 * Someone who genuinely walked in was, a moment earlier, at the edge.
 */
const TOGETHER_EDGE = 0.18;

const REVISIT_MIN_AGE_MS = 20_000;
const REVISIT_RADIUS = 0.06;
const REVISIT_MIN_EXCURSION = 0.28;

/**
 * Samples one track may hold, whatever the window.
 *
 * The window is the real bound — at the 10–24 Hz the sensing pipeline runs at,
 * six seconds is 60 to 145 samples and twenty seconds is 480. This ceiling
 * exists because "bounded in practice" is not bounded (§12): a caller stepping
 * its clock in fractions of a millisecond would otherwise grow one record
 * without limit. Reaching it means the caller is not a sensing pipeline.
 *
 * It is also the figure `room_engine::behavior::SAMPLES_MAX` holds, so that the
 * two implementations agree by construction in a regime neither will ever meet
 * rather than approximately.
 */
const SAMPLES_MAX = 1_024;

const MIRROR_WINDOW_MS = 2_200;
const MIRROR_MIN_SEPARATION = 0.3;
const MIRROR_MIN_SPEED = 0.05;
const MIRROR_MIN_ALIGNMENT = 0.82;

type Sample = {
  t: number;
  x: number;
  y: number;
  width: number;
  vx: number;
  vy: number;
  speed: number;
};

/** Everything remembered about one track, created and discarded as a unit. */
type Watched = {
  samples: Sample[];
  /** When the track was first seen. */
  bornAt: number;
  /** Whether it was first seen near the edge of the frame — an arrival. */
  bornAtEdge: boolean;
};

/**
 * Holds the short history each detector needs. Behaviours are relationships
 * over time, so none of them can be decided from a single frame.
 *
 * One record per track rather than three maps keyed alike: the detectors then
 * read what `update` already established for this frame instead of looking it
 * up again behind guards for a track that is present but unknown — a state
 * this class cannot be in, so those guards were claims no test could make.
 */
export class BehaviorWatcher {
  private readonly watched = new Map<string, Watched>();
  private readonly lastReported = new Map<BehaviorKind, number>();
  private readonly windowMs: number;

  constructor(windowMs = 6_000) {
    this.windowMs = windowMs;
  }

  /** Feed the current frame and receive anything newly noticed. */
  /**
   * Feed the current frame.
   *
   * `stable` is whether sensing has settled. While it has not, history is still
   * recorded — the detectors need continuity across the boundary — but nothing
   * is reported. The seconds just after the background model warms up produce
   * detections good enough for the artwork to react to and nowhere near solid
   * enough to make claims about.
   */
  update(tracks: VisitorTrack[], now: number, stable = true): BehaviorEvent[] {
    const present = new Set<string>();
    for (const track of tracks) {
      present.add(track.id);
      const { x, y } = track.position;
      let record = this.watched.get(track.id);
      if (!record) {
        record = {
          samples: [],
          bornAt: now,
          bornAtEdge: Math.min(x, 1 - x) <= TOGETHER_EDGE || Math.min(y, 1 - y) <= TOGETHER_EDGE,
        };
        this.watched.set(track.id, record);
      }
      const { samples } = record;
      samples.push({
        t: now,
        x: track.position.x,
        y: track.position.y,
        width: track.extent.width,
        vx: track.velocity.x,
        vy: track.velocity.y,
        speed: track.speed,
      });
      while (samples.length && now - samples[0].t > this.windowMs) samples.shift();
      while (samples.length > SAMPLES_MAX) samples.shift();
    }
    const departed: string[] = [];
    for (const id of this.watched.keys()) if (!present.has(id)) departed.push(id);
    for (const id of departed) this.watched.delete(id);

    if (!stable) return [];

    const found: BehaviorEvent[] = [];
    const consider = (event: BehaviorEvent | null) => {
      if (!event) return;
      const last = this.lastReported.get(event.kind) ?? -Infinity;
      if (now - last < COOLDOWN_MS[event.kind]) return;
      this.lastReported.set(event.kind, now);
      found.push(event);
    };

    for (const track of tracks) {
      consider(this.detectWave(track, now));
      consider(this.detectRevisit(track, now));
    }
    for (let i = 0; i < tracks.length; i += 1) {
      for (let j = i + 1; j < tracks.length; j += 1) {
        consider(this.detectTogether(tracks[i], tracks[j], now));
        consider(this.detectApproach(tracks[i], tracks[j], now));
        consider(this.detectFollow(tracks[i], tracks[j]));
        consider(this.detectMirror(tracks[i], tracks[j], now));
      }
    }
    return found;
  }

  reset() {
    this.watched.clear();
    this.lastReported.clear();
  }

  /**
   * What is remembered about a track the caller just handed to `update`.
   *
   * Total by construction: every detector runs over the same frame's tracks,
   * and `update` records each of them before any detector is consulted.
   */
  private record(id: string): Watched {
    return this.watched.get(id)!;
  }

  private window(id: string, now: number, span: number): Sample[] {
    return this.record(id).samples.filter((sample) => now - sample.t <= span);
  }

  /**
   * A body that is not going anywhere while its outline keeps widening and
   * narrowing is moving its arms. Requires real reversals, so a single stretch
   * or a slow lean does not count.
   */
  private detectWave(track: VisitorTrack, now: number): BehaviorEvent | null {
    const samples = this.window(track.id, now, WAVE_WINDOW_MS);
    if (samples.length < 6) return null;
    const drift = Math.hypot(
      samples.at(-1)!.x - samples[0].x,
      samples.at(-1)!.y - samples[0].y,
    );
    if (drift > WAVE_MAX_DRIFT) return null;

    const widths = samples.map((sample) => sample.width);
    const swing = Math.max(...widths) - Math.min(...widths);
    if (swing < WAVE_MIN_SWING) return null;

    let reversals = 0;
    let direction = 0;
    for (let index = 1; index < widths.length; index += 1) {
      const delta = widths[index] - widths[index - 1];
      if (Math.abs(delta) < WAVE_MIN_SWING * 0.15) continue;
      const next = Math.sign(delta);
      if (direction !== 0 && next !== direction) reversals += 1;
      direction = next;
    }
    if (reversals < WAVE_MIN_REVERSALS) return null;
    return { kind: 'wave', at: { x: track.position.x, y: track.position.y }, subjects: [track.id] };
  }

  /** Two people who were apart and are now not. */
  private detectApproach(a: VisitorTrack, b: VisitorTrack, now: number): BehaviorEvent | null {
    const first = this.window(a.id, now, APPROACH_WINDOW_MS);
    const second = this.window(b.id, now, APPROACH_WINDOW_MS);
    if (first.length < 4 || second.length < 4) return null;
    const started = Math.hypot(first[0].x - second[0].x, first[0].y - second[0].y);
    const ended = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
    if (started < APPROACH_START || ended > APPROACH_END || ended >= started) return null;
    return {
      kind: 'approach',
      at: { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 },
      subjects: [a.id, b.id],
    };
  }

  /**
   * One person walking where another walked a moment ago. Tested at several
   * lags: the follower's recent positions should match the leader's earlier
   * ones, which is a different claim from simply being nearby.
   */
  private detectFollow(a: VisitorTrack, b: VisitorTrack): BehaviorEvent | null {
    for (const [leader, follower] of [[a, b], [b, a]] as const) {
      const leaderPath = this.record(leader.id).samples;
      const followerPath = this.record(follower.id).samples;
      if (leaderPath.length < 8 || followerPath.length < 8) continue;

      const travelled = Math.hypot(
        leaderPath.at(-1)!.x - leaderPath[0].x,
        leaderPath.at(-1)!.y - leaderPath[0].y,
      );
      if (travelled < FOLLOW_MIN_TRAVEL) continue;

      for (const lag of FOLLOW_LAGS_MS) {
        let total = 0;
        let count = 0;
        for (const sample of followerPath) {
          const target = sample.t - lag;
          if (target < leaderPath[0].t) continue;
          const nearest = leaderPath.reduce((best, candidate) =>
            Math.abs(candidate.t - target) < Math.abs(best.t - target) ? candidate : best,
          leaderPath[0]);
          if (Math.abs(nearest.t - target) > 400) continue;
          total += Math.hypot(sample.x - nearest.x, sample.y - nearest.y);
          count += 1;
        }
        if (count >= 5 && total / count <= FOLLOW_TOLERANCE) {
          return {
            kind: 'follow',
            at: { x: follower.position.x, y: follower.position.y },
            subjects: [follower.id, leader.id],
          };
        }
      }
    }
    return null;
  }

  /** Two people whose tracks began within moments of each other. */
  private detectTogether(a: VisitorTrack, b: VisitorTrack, now: number): BehaviorEvent | null {
    const one = this.record(a.id);
    const other = this.record(b.id);
    const first = one.bornAt;
    const second = other.bornAt;
    if (Math.abs(first - second) > TOGETHER_WINDOW_MS) return null;
    // Both must have come in from outside. Appearing at once in the middle of
    // the room is the tracker gaining two people, not two people arriving.
    if (!one.bornAtEdge || !other.bornAtEdge) return null;
    // Only worth saying while it is still happening.
    if (now - Math.max(first, second) > TOGETHER_WINDOW_MS * 3) return null;
    return {
      kind: 'together',
      at: { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 },
      subjects: [a.id, b.id],
    };
  }

  /**
   * Back to a spot they held earlier and left. Requires a genuine excursion in
   * between, so standing roughly still does not read as returning.
   */
  private detectRevisit(track: VisitorTrack, now: number): BehaviorEvent | null {
    const path = track.path;
    if (path.length < 12) return null;
    const here = track.position;
    for (let index = 0; index < path.length - 4; index += 1) {
      const point = path[index];
      if (now - point.t < REVISIT_MIN_AGE_MS) break;
      if (Math.hypot(point.x - here.x, point.y - here.y) > REVISIT_RADIUS) continue;
      let excursion = 0;
      for (let step = index + 1; step < path.length; step += 1) {
        excursion = Math.max(excursion, Math.hypot(path[step].x - point.x, path[step].y - point.y));
      }
      if (excursion < REVISIT_MIN_EXCURSION) continue;
      return { kind: 'revisit', at: { x: here.x, y: here.y }, subjects: [track.id] };
    }
    return null;
  }

  /** Two people well apart, moving the same way at the same time. */
  private detectMirror(a: VisitorTrack, b: VisitorTrack, now: number): BehaviorEvent | null {
    const separation = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
    if (separation < MIRROR_MIN_SEPARATION) return null;
    const first = this.window(a.id, now, MIRROR_WINDOW_MS);
    const second = this.window(b.id, now, MIRROR_WINDOW_MS);
    if (first.length < 6 || second.length < 6) return null;

    let aligned = 0;
    let compared = 0;
    const span = Math.min(first.length, second.length);
    for (let index = 0; index < span; index += 1) {
      const one = first[first.length - span + index];
      const other = second[second.length - span + index];
      if (one.speed < MIRROR_MIN_SPEED || other.speed < MIRROR_MIN_SPEED) continue;
      const dot = (one.vx * other.vx + one.vy * other.vy)
        / (Math.hypot(one.vx, one.vy) * Math.hypot(other.vx, other.vy) || 1);
      compared += 1;
      if (dot >= MIRROR_MIN_ALIGNMENT) aligned += 1;
    }
    if (compared < 5 || aligned / compared < 0.8) return null;
    return {
      kind: 'mirror',
      at: { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 },
      subjects: [a.id, b.id],
    };
  }
}
