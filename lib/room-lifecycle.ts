/**
 * The gallery day: opening, active, closing, after-hours.
 *
 * These are the room's largest gestures — the surface nearly blank at opening,
 * the day surfacing at closing, a night's compression into long-term memory —
 * and each of them is a transition that happens once a day and takes between
 * twenty seconds and twelve hours to observe. Deciding them in the render
 * component meant the only way to check the closing ritual was to close a
 * gallery.
 */
import { chooseRareGhost, recallGhost } from './memory-records.ts';
import type { ActiveGhost, Ghost, RoomLifecycle } from './room-types.ts';

/** How long the room stays nearly blank after the doors open. */
export const OPENING_DURATION_MS = 20_000;

/** How long the day's traces surface before the night compresses them. */
export const CLOSING_DURATION_MS = 90_000;

/**
 * How long a room has to be empty before it counts as empty.
 *
 * Two minutes, everywhere: the lifecycle uses it to fall to after-hours, the
 * memory field uses it to forget faster, and recall uses it to decide that a
 * path walking alone is the piece rather than an interruption of it. One
 * constant because they are one judgement about the same room.
 */
export const EMPTY_ROOM_SECONDS = 120;

/** What survives of yesterday's light when the doors open. */
export const OPENING_FIELD_SCALE = 0.12;

/**
 * Opening. The day counter advances unless the room is already opening, so an
 * operator who presses it twice gets one day rather than two.
 */
export function openDay(lifecycle: RoomLifecycle, day: number) {
  const next = lifecycle === 'opening' ? day : day + 1;
  return {
    day: next,
    lifecycle: 'opening' as const,
    fieldScale: OPENING_FIELD_SCALE,
    event: `gallery day ${next} opening — surface nearly blank`,
  };
}

/**
 * Closing. One of today's traces surfaces to begin the ritual; a day with
 * nothing in it closes silently rather than replaying yesterday.
 */
export function closeDay(ghosts: Ghost[], day: number, now: number): ActiveGhost | null {
  const today = ghosts.filter((ghost) => ghost.day === day);
  if (!today.length) return null;
  return { ghost: recallGhost(chooseRareGhost(today), ghosts), startedAt: now, kind: 'ghost' };
}

/** How faint a memory may be and still be worth holding after a night. */
export const OVERNIGHT_FLOOR = 0.025;

/**
 * Whether a memory survives the night. Asked directly, for the same reason
 * `stillHeld` is: the compression curve cannot be made to land on the floor.
 */
export function survivesTheNight(strength: number): boolean {
  return strength >= OVERNIGHT_FLOOR;
}

/**
 * A night's compression.
 *
 * Today fades hardest — it is the day with the most in it, and a room that kept
 * every trace of every day equally would be a room that never forgot anything
 * and so remembered nothing in particular. Fidelity drops with strength, which
 * is what makes an old path drift when it is finally recalled.
 */
export function compressDay(ghosts: Ghost[], day: number): Ghost[] {
  return ghosts
    .map((ghost) => ({
      ...ghost,
      strength: ghost.strength * (ghost.day === day ? 0.66 : 0.92),
      fidelity: ghost.fidelity * 0.95,
    }))
    .filter((ghost) => survivesTheNight(ghost.strength));
}

/**
 * Whether an active room has been empty long enough to be called after-hours.
 *
 * Only from `active`: an opening room has not started yet, and a closing one is
 * mid-ritual and gets its full ninety seconds whether or not anyone is there to
 * watch it.
 */
export function fallsToAfterHours(
  lifecycle: RoomLifecycle,
  visiblePeople: number,
  emptySeconds: number,
): boolean {
  return lifecycle === 'active' && visiblePeople === 0 && emptySeconds > EMPTY_ROOM_SECONDS;
}
