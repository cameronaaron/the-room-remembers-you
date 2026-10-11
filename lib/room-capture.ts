import { findConvergentGhost, simplifyPath } from './memory-engine.ts';
import { mapRoomPoint } from './room-projection.ts';
import { convergenceRecall, convergenceVoicePoint } from './room-emergence.ts';
import { GHOSTS_MAX, remember } from './room-upkeep.ts';
import type { ActiveGhost, Ghost, RoomConfig, VisitorTrack } from './room-types.ts';

/** Summarize an ended track using an explicit wall clock; never retain sensor input. */
export function captureGhost(
  track: VisitorTrack,
  ghosts: Ghost[],
  config: RoomConfig,
  day: number,
  now: number,
) {
  if (track.path.length < 5 || track.dwellSeconds < 1) return null;
  const path = simplifyPath(
    track.path.map((point) => mapRoomPoint(point, config)),
  );
  const convergence = findConvergentGhost(path, ghosts);
  const ghost: Ghost = {
    id: `ghost-${now.toString(36)}-${ghosts.length}`,
    createdAt: now,
    lastReplayedAt: 0,
    path,
    dwellSeconds: track.dwellSeconds,
    intensity: convergence ? Math.min(1, convergence.intensity + 0.18) : 0.35,
    strength: convergence ? 0.72 : 0.48,
    fidelity: 1,
    recallCount: 0,
    lineage: [track.id],
    falseMemory: false,
    day: day,
  };
  return { ghost, convergence };
}

/**
 * What the room does with a visitor who has left.
 *
 * A track ending is the moment a presence becomes a memory: the walk is
 * simplified into a path, kept if it is worth keeping, and — if it retraced
 * ground an older memory already holds — the two merge and the room says so.
 *
 * This lived in the render component, which meant that the one decision the
 * room makes about departure could only be reached by mounting React and
 * waiting for somebody to walk out of frame. It is four calls and a condition;
 * what it needed was somewhere a test could call it.
 */
export type Departure = {
  /** Where the room addresses the convergence, in projected coordinates. */
  at: { x: number; y: number };
  /** For the operator's event line. */
  event: string;
};

export type DepartureRoom = {
  ghosts: Ghost[];
  active: ActiveGhost[];
  config: RoomConfig;
  day: number;
  /** Wall clock, for what the memory records about itself. */
  wall: number;
  /** Animation clock, for presentation timing. */
  now: number;
  /** The room's stream. See `room-rng.ts`. */
  random?: () => number;
};

/**
 * Everyone who left this frame, and what the room has to say about them.
 *
 * Takes the whole set rather than one track because that is what the sensing
 * loop has, and because a caller looping over departures itself is a caller
 * holding three lines of the room's decision inside a render component again.
 */
export function rememberDepartures(
  ended: readonly VisitorTrack[],
  room: DepartureRoom,
): Departure[] {
  const said: Departure[] = [];
  for (const track of ended) {
    const merged = rememberDeparture(track, room);
    if (merged) said.push(merged);
  }
  return said;
}

export function rememberDeparture(track: VisitorTrack, room: DepartureRoom): Departure | null {
  const captured = captureGhost(track, room.ghosts, room.config, room.day, room.wall);
  if (!captured) return null;
  const { ghost, convergence } = captured;
  remember(room.ghosts, ghost, GHOSTS_MAX);
  if (!convergence) return null;
  // A convergence may find no slot — living visitors keep reserved bodies — and
  // the room still merged the paths. The line is the point, not the recall.
  const recall = convergenceRecall(ghost, room.ghosts, room.active, room.now, room.random);
  if (recall) room.active.push(recall);
  return { at: convergenceVoicePoint(ghost.path), event: 'convergence — repeated paths merged' };
}
