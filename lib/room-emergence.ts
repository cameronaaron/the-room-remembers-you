/**
 * What the room decides to remember, and when.
 *
 * Stillness, retrace, false memory, an ordinary recall, a path walking an empty
 * room alone, and somebody crossing ground an old memory lies on: six ways a
 * memory reaches the wall, in a fixed order, under one roll of the clock. It is
 * the centre of the piece and it was a two-hundred-line callback inside the
 * render component, reading ten refs and calling two closures — which meant the
 * order of the branches, the thing that decides what the room feels like, could
 * only be checked by standing in a gallery and waiting.
 *
 * Nothing here touches React, a canvas or a device. The caller passes the room
 * and receives what the room wants to say; the arrays it passes are mutated in
 * place, because the recalls being presented are the same objects the renderer
 * is drawing.
 */
import { type RoomInterest, preferMemoryNear } from './attention.ts';
import {
  MemoryCollisions,
  disturbanceFrame,
  memoryLoss,
} from './memory-disturbance.ts';
import {
  RECALL_RATE_PER_SECOND,
  RETURN_MIN_EXTENT,
  createFalseMemory,
  eventChance,
  pathExtent,
  rememberWhisper,
  simplifyPath,
  trajectoryDistance,
} from './memory-engine.ts';
import { chooseRareGhost, recallGhost } from './memory-records.ts';
import { EMPTY_ROOM_SECONDS } from './room-lifecycle.ts';
import { mapRoomPoint } from './room-projection.ts';
import { WHISPER_RIPENS_MS } from './whisper-recall.ts';
import { RECALL_PRESENTATION } from './swarm.ts';
import type { VoiceKind } from './room-voice.ts';
import type {
  ActiveGhost,
  Ghost,
  RoomConfig,
  RoomLifecycle,
  VisitorTrack,
  WhisperMemory,
} from './room-types.ts';

/**
 * The room's stream, or ambient randomness if a caller omitted one.
 *
 * One function rather than `room.random ?? Math.random` at each of the seven
 * sites that need it. Written out that many times it was a coin toss whether
 * the next decision added would remember to reach for the room's stream, and a
 * decision that quietly took `Math.random()` instead is invisible: it produces
 * a plausible room that no replay can reproduce.
 */
function rollOf(room: EmergenceRoom): () => number {
  return room.random ?? Math.random;
}

/**
 * How many memories the room may be replaying at once. One at a time made the
 * room feel like it had a single thought; a small crowd of its own past is the
 * point of the work.
 */
export const MAX_ACTIVE_RECALLS = 3;

/** Everyone still for this long, at most this often, is one occasion. */
export const STILLNESS_SECONDS = 15;
export const STILLNESS_REST_MS = 90_000;

/** A retrace needs a path long enough to have two comparable halves. */
export const RETRACE_MIN_POINTS = 22;
/** How closely the second half has to follow the first to read as a return. */
export const RETRACE_DISTANCE = 0.055;
/** The returning path appears slightly ahead of its visitor, not under them. */
export const RETURN_LEAD_MS = 800;

/** How near a disturbed memory a voice has to have been recorded to surface with it. */
export const DISTURBED_VOICE_RADIUS = 0.14;
/** Into the presentation before a disturbed memory may bring a voice with it. */
export const DISTURBED_VOICE_PROGRESS = 0.25;
/** Loss below which the room has nothing to admit to. */
export const ADMISSION_LOSS = 0.2;
/** How far before the end of a dissolution the room admits to it. */
export const ADMISSION_LEAD = 0.12;

/** False memories are rare against ordinary recall, deliberately. */
export const FALSE_MEMORY_SHARE = 0.08;
/** An empty room remembers more often, because there is nothing else happening. */
export const EMPTY_ROOM_GAIN = 3;

/** The sound side of a recall, as much of it as this decision needs. */
export type WhisperAudio = {
  hasRecording(id: string): boolean;
  replay(whisper: WhisperMemory, volume: number, loss?: number): void;
};

export type EmergenceUtterance = {
  kind: VoiceKind;
  at: { x: number; y: number };
  /** Whose occasion this is, when the room knows. Ephemeral, never an identity. */
  subject?: string;
};

export type EmergenceRoom = {
  /** Confirmed, observed tracks only. */
  tracks: readonly VisitorTrack[];
  ghosts: Ghost[];
  whispers: WhisperMemory[];
  /** Recalls currently on the wall. Appended to in place. */
  active: ActiveGhost[];
  config: RoomConfig;
  day: number;
  lifecycle: RoomLifecycle;
  emptySeconds: number;
  /** Animation clock, for presentation timing. */
  now: number;
  /** Wall clock, for anything a memory records about itself. */
  wall: number;
  attention: RoomInterest;
  collisions: MemoryCollisions;
  audio: WhisperAudio | null;
  /**
   * The room's random stream.
   *
   * Every probabilistic decision below draws from this one generator — whether
   * to remember, which memory, how far a recalled path mutates, which whisper
   * comes with it. `RoomRng` in `room-rng.ts` supplies it, seeded once per
   * session, so a gallery that reports something strange at half past seven can
   * have that half past seven replayed.
   *
   * Optional only so a test may omit it; the shell always passes one, and
   * `Math.random` is the fallback rather than the design. A decision that
   * reached for ambient randomness instead would be invisible in a replay and
   * would be exactly the thing nobody could reproduce.
   */
  random?: () => number;
};

export type Emergence = {
  /** Occasions to speak, in the order they arose. The voice may decline them all. */
  utterances: EmergenceUtterance[];
  /** The one line for the status display, when something happened. */
  event?: string;
};

/**
 * The roll clock and the stillness rest, which are the only state this decision
 * carries between ticks.
 */
export class RoomEmergence {
  private lastRollAt: number | null = null;
  /**
   * When the room last answered a held silence, or null if it never has.
   *
   * Never zero: compared against the page clock, an unset zero made the rest
   * period a warmup too, and a room opened in front of a group of people
   * standing still could not respond to them for its first ninety seconds.
   */
  private lastStillnessAt: number | null = null;

  /** Seconds banked since the previous roll. Advanced before any early return. */
  private advance(now: number): number {
    const since = this.lastRollAt === null ? 0 : (now - this.lastRollAt) / 1000;
    this.lastRollAt = now;
    return since;
  }

  reset() {
    this.lastRollAt = null;
    this.lastStillnessAt = null;
  }

  detect(room: EmergenceRoom): Emergence {
    // Advance the clock before any early return. Skipping it while recalls are
    // capped banks the elapsed time and fires a burst the moment a slot frees.
    const sinceLastRoll = this.advance(room.now);
    const utterances = progressDisturbances(room);
    if (room.active.length >= MAX_ACTIVE_RECALLS) return { utterances };
    if (room.lifecycle === 'opening' || room.lifecycle === 'closing') return { utterances };

    const stillness = this.stillness(room);
    if (stillness) return { utterances: [...utterances, ...stillness.utterances], event: stillness.event };

    const retrace = returnOfAPath(room);
    if (retrace) return { utterances: [...utterances, ...retrace.utterances], event: retrace.event };

    const roll = rollOf(room);
    const rate = RECALL_RATE_PER_SECOND * room.config.ghostFrequency;

    const fabricated = falseMemory(room, rate, sinceLastRoll, roll);
    if (fabricated) return { utterances: [...utterances, ...fabricated.utterances], event: fabricated.event };

    const recalled = ordinaryRecall(room, rate, sinceLastRoll, roll);
    if (recalled) return { utterances: [...utterances, ...recalled.utterances], event: recalled.event };

    // Last, so a crossing interrupts a quiet room rather than pre-empting the
    // room's own behaviours. Ahead of the other branches this returned first on
    // every eligible tick, and crowded periods — exactly when people cross
    // history most — lost stillness, retrace and false memory entirely.
    const crossed = crossing(room);
    return { utterances, event: crossed?.event };
  }

  /**
   * Everybody in the room standing still, at most once every ninety seconds.
   * The oldest trace surfaces: the room's answer to a held silence is the
   * furthest thing back it has.
   */
  private stillness(room: EmergenceRoom): Emergence | null {
    const allStill = room.tracks.length > 0
      && room.tracks.every((track) => track.stillFor >= STILLNESS_SECONDS);
    if (!allStill) return null;
    if (this.lastStillnessAt !== null && room.now - this.lastStillnessAt <= STILLNESS_REST_MS) {
      return null;
    }
    if (!room.ghosts.length) return null;
    const oldest = [...room.ghosts].sort((a, b) => a.createdAt - b.createdAt)[0];
    room.active.push({
      ghost: recallGhost(oldest, room.ghosts, rollOf(room)),
      startedAt: room.now,
      kind: 'stillness',
    });
    this.lastStillnessAt = room.now;
    // `allStill` is false for an empty room, so there is always somebody here.
    const subject = mapRoomPoint(room.tracks[0].position, room.config);
    return {
      utterances: [{ kind: 'stillness', at: subject }],
      event: 'stillness — an old trace surfaced',
    };
  }
}

/**
 * Memories being lost while they are shown.
 *
 * Two things happen inside a dissolution and neither is a new recall: a voice
 * recorded near the disturbed ground may surface with it, and near the end the
 * room may admit that it is losing the memory. Both are once-only, latched on
 * the disturbance itself.
 */
function progressDisturbances(room: EmergenceRoom): EmergenceUtterance[] {
  const utterances: EmergenceUtterance[] = [];
  for (const active of room.active) {
    const disturbance = active.disturbance;
    if (!disturbance) continue;
    const progress = (room.now - active.startedAt) / RECALL_PRESENTATION[active.kind].durationMs;
    const end = disturbanceFrame([], progress, disturbance.loss).end;
    const audio = room.audio;
    if (audio && progress >= DISTURBED_VOICE_PROGRESS && !disturbance.voicePlayed) {
      disturbance.voicePlayed = true;
      // Found by index, not by value and then looked up again: the whisper has
      // to be written back over the one the room is holding — nothing recalled
      // remains unchanged — and a second search for something already in hand
      // is a branch for "not found" that cannot happen.
      const index = room.whispers.findIndex((voice) => room.wall - voice.createdAt > WHISPER_RIPENS_MS
        && audio.hasRecording(voice.id)
        && Math.hypot(
          voice.position.x - disturbance.at.x,
          voice.position.y - disturbance.at.y,
        ) < DISTURBED_VOICE_RADIUS);
      if (index >= 0) {
        const remembered = rememberWhisper(room.whispers[index], rollOf(room));
        room.whispers[index] = remembered;
        audio.replay(remembered, room.config.masterVolume, disturbance.loss);
      }
    }
    if (disturbance.loss > ADMISSION_LOSS
      && progress >= end - ADMISSION_LEAD
      && !disturbance.admitted) {
      disturbance.admitted = true;
      utterances.push({ kind: 'forgetting', at: disturbance.at });
    }
  }
  return utterances;
}

/**
 * Somebody retracing their own steps, answered by their earlier half appearing
 * ahead of them.
 */
function returnOfAPath(room: EmergenceRoom): Emergence | null {
  for (const track of room.tracks) {
    if (track.path.length < RETRACE_MIN_POINTS) continue;
    // A stationary visitor accumulates path points at one spot, so the two
    // halves of their "path" match perfectly and read as a retrace. Require
    // that they actually went somewhere first.
    if (pathExtent(track.path) < RETURN_MIN_EXTENT) continue;
    const middle = Math.floor(track.path.length / 2);
    const first = track.path.slice(0, middle);
    if (trajectoryDistance(first, track.path.slice(middle)) >= RETRACE_DISTANCE) continue;
    room.active.push({
      ghost: {
        id: `return-${track.id}`,
        createdAt: room.wall,
        lastReplayedAt: 0,
        path: simplifyPath(first),
        dwellSeconds: 0,
        intensity: 0.6,
        strength: 0.5,
        fidelity: 0.92,
        recallCount: 1,
        lineage: [track.id],
        falseMemory: false,
        day: room.day,
      },
      startedAt: room.now + RETURN_LEAD_MS,
      kind: 'return',
    });
    return {
      // Likewise: the interesting place is the middle of the repeated stretch.
      // The index is always inside the path: a retrace needs at least
      // `RETRACE_MIN_POINTS`, so a quarter of the way along is a real point.
      utterances: [{
        kind: 'return',
        at: mapRoomPoint(track.path[Math.floor(middle / 2)], room.config),
      }],
      event: 'return — a path appeared ahead of its visitor',
    };
  }
  return null;
}

/** Two unrelated traces becoming one memory the room is sure of. */
function falseMemory(
  room: EmergenceRoom,
  rate: number,
  sinceLastRoll: number,
  roll: () => number,
): Emergence | null {
  if (room.ghosts.length < 2) return null;
  if (roll() >= eventChance(rate * FALSE_MEMORY_SHARE, sinceLastRoll)) return null;
  const first = chooseRareGhost(room.ghosts, room.wall, roll);
  const candidates = room.ghosts.filter((ghost) => ghost.id !== first.id);
  const whisper = room.whispers.length
    ? room.whispers[Math.floor(roll() * room.whispers.length)]
    : undefined;
  const fabricated = createFalseMemory(
    first,
    chooseRareGhost(candidates, room.wall, roll),
    room.wall,
    whisper,
  );
  room.ghosts.push(fabricated);
  room.active.push({ ghost: fabricated, startedAt: room.now, kind: 'false' });
  return {
    // Every memory in the room has a path — `isRememberable` drops the ones
    // restored without one — so the middle of this one is a real point.
    utterances: [{ kind: 'false', at: fabricated.path[Math.floor(fabricated.path.length / 2)] }],
    event: 'false memory — unrelated traces became one',
  };
}

/**
 * An old path resurfacing, more often when the room is empty.
 *
 * Rolls are against wall-clock time, not per analysis tick, so the room
 * remembers at the same pace on every hardware profile.
 */
function ordinaryRecall(
  room: EmergenceRoom,
  rate: number,
  sinceLastRoll: number,
  roll: () => number,
): Emergence | null {
  if (!room.ghosts.length) return null;
  const alone = room.emptySeconds > EMPTY_ROOM_SECONDS;
  if (roll() >= eventChance(rate * (alone ? EMPTY_ROOM_GAIN : 1), sinceLastRoll)) return null;
  // Which memory surfaces, never how often one does. When the room is
  // interested in somebody, its memories reach toward them rather than away —
  // and because this changes only the choice, every measured bound on the
  // room's pace stays exactly where it was measured.
  const ordinary = chooseRareGhost(room.ghosts, room.wall, roll);
  // What the room decided on the last sensing frame, not a curve sampled here.
  const focus = room.attention.decision();
  const attended = focus.trackId
    ? room.tracks.find((track) => track.id === focus.trackId)
    : undefined;
  const ghost = attended
    ? preferMemoryNear(
      room.ghosts,
      mapRoomPoint(attended.position, room.config),
      focus.weight,
      ordinary,
    )
    : ordinary;
  const remembered = recallGhost(ghost, room.ghosts, roll);
  room.active.push({
    ghost: remembered,
    startedAt: room.now,
    kind: alone ? 'empty' : 'ghost',
  });
  return {
    utterances: alone ? [{ kind: 'empty' as VoiceKind, at: remembered.path[0] }] : [],
    event: alone ? 'empty room — a path walked alone' : 'an old path resurfaced',
  };
}

/** Walking into ground an old memory lies on, which disturbs it as it shows it. */
function crossing(room: EmergenceRoom): { event: string } | null {
  const collision = room.collisions.find(
    room.tracks,
    room.ghosts,
    room.wall,
    (point) => mapRoomPoint(point, room.config),
  );
  if (!collision) return null;
  // Walking into ground an old memory lies on is a reason for the room to take
  // an interest, though a weaker one than anything the visitor chose to do: the
  // coincidence is the room's, not theirs.
  room.attention.observe('crossing', collision.trackId, room.now);
  const loss = memoryLoss(collision.ghost.createdAt, collision.ghost.fidelity, room.wall);
  const remembered = recallGhost(collision.ghost, room.ghosts, rollOf(room));
  const remainder = collision.ghost.path.slice(collision.index);
  room.active.push({
    ghost: { ...remembered, path: [{ ...collision.at, t: room.wall }, ...remainder] },
    startedAt: room.now,
    kind: 'ghost',
    disturbance: { loss, at: collision.at, voicePlayed: false, admitted: false },
  });
  return { event: 'a crossing disturbed an old path' };
}

/** Exported for the caller that has to decide whether a new recall fits. */
export function hasRecallRoom(active: readonly ActiveGhost[]): boolean {
  return active.length < MAX_ACTIVE_RECALLS;
}

/**
 * Where a convergence speaks from.
 *
 * Along the shared route, not at the track's last position. A track ends when
 * its visitor leaves, so that position sits at the edge of the room and the
 * line clamped itself into a corner — which read as the room addressing the
 * wall rather than the path two people had both walked.
 *
 * The centre of the room is the fallback for a path with no points, which a
 * captured trace cannot have; it is here so that this returns a place rather
 * than an absence the caller would have to handle at the moment it speaks.
 */
export function convergenceVoicePoint(
  path: readonly { x: number; y: number }[],
): { x: number; y: number } {
  return path[Math.floor(path.length / 2)] ?? { x: 0.5, y: 0.5 };
}

/** The memory a convergence surfaces, when there is a slot for it. */
export function convergenceRecall(
  ghost: Ghost,
  ghosts: Ghost[],
  active: readonly ActiveGhost[],
  now: number,
  random?: () => number,
): ActiveGhost | null {
  if (!hasRecallRoom(active)) return null;
  // The room's stream, like every other recall. A convergence is decided
  // outside `RoomEmergence` — it is the one branch a caller reaches directly —
  // which is exactly why it is the one most likely to be left drawing from
  // ambient randomness and never noticed.
  return { ghost: recallGhost(ghost, ghosts, random), startedAt: now, kind: 'convergence' };
}
