/**
 * Reading stored memories back, and choosing which one returns.
 *
 * Two jobs that both used to sit as private functions in the render component,
 * and both of which decide what a visitor sees.
 *
 * The first is normalisation. A room saved under an older build is missing
 * whatever fields that build did not have, and every one of those absences has
 * a correct default rather than a crash: `strength ?? 0.35` is the difference
 * between a restored ghost that fades properly and one whose strength is
 * `undefined`, which propagates as `NaN` through decay and reinforcement and
 * renders as nothing at all. Silent, and visible only as a room that forgets
 * everything it was holding when it reopened.
 *
 * The second is selection, which is an artistic decision wearing arithmetic:
 * which memory the room chooses to return governs whether the piece feels like
 * it remembers or like it loops.
 */

import { rememberGhost } from './memory-engine.ts';
import type { Ghost, WhisperMemory } from './room-types.ts';

/** Defaults for a ghost read back from a room saved by an older build. */
export function normalizeGhost(ghost: Ghost): Ghost {
  return {
    ...ghost,
    strength: ghost.strength ?? ghost.intensity ?? 0.35,
    fidelity: ghost.fidelity ?? 1,
    recallCount: ghost.recallCount ?? 0,
    lineage: ghost.lineage ?? [ghost.id],
    falseMemory: ghost.falseMemory ?? false,
    day: ghost.day ?? 1,
  };
}

/**
 * Whether a restored record is a memory at all.
 *
 * A ghost with no path cannot be drawn, cannot be crossed, and cannot be
 * combined into a false memory — `createFalseMemory` reads its first point and
 * throws on an empty one. Normalisation can supply a missing `strength`,
 * because a faded memory is still a memory; it cannot invent a path, so a
 * record without one is dropped at the door rather than defended against at
 * every point that indexes into it.
 */
export function isRememberable(ghost: Ghost): boolean {
  return Array.isArray(ghost.path) && ghost.path.length > 0;
}

/** The same, for a whisper. Its audio is never restored; only its texture is. */
export function normalizeWhisper(whisper: WhisperMemory): WhisperMemory {
  return {
    ...whisper,
    strength: whisper.strength ?? 0.35,
    fidelity: whisper.fidelity ?? 1,
    recallCount: whisper.recallCount ?? 0,
    lineage: whisper.lineage ?? [whisper.id],
    day: whisper.day ?? 1,
  };
}

/**
 * Recall a ghost and write the mutated version back over the original.
 *
 * Nothing recalled remains unchanged — that is a memory invariant, not a
 * flourish — so the collection must receive the mutation. Returning the new
 * ghost while leaving the old one in the array would give the room a memory
 * that degrades on screen and resets every time it is remembered.
 */
export function recallGhost(ghost: Ghost, collection: Ghost[], random?: () => number): Ghost {
  const remembered = rememberGhost(ghost, random);
  const index = collection.findIndex((candidate) => candidate.id === ghost.id);
  if (index >= 0) collection[index] = remembered;
  return remembered;
}

/**
 * Choose a ghost, favouring the ones the room has not shown lately.
 *
 * Weighted by minutes since it was created or last replayed, whichever is more
 * recent, with a floor of one so a just-recalled memory is unlikely rather than
 * impossible. Uniform choice would let a small collection replay the same two
 * ghosts all evening, which reads as a loop; weighting by neglect is what makes
 * a returning visitor meet something they have not already seen.
 */
export function chooseRareGhost(
  ghosts: readonly Ghost[],
  now: number = Date.now(),
  random: () => number = Math.random,
): Ghost {
  const weighted = ghosts.map((ghost) => ({
    ghost,
    weight: Math.max(1, (now - Math.max(ghost.createdAt, ghost.lastReplayedAt)) / 60_000),
  }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let target = random() * total;
  for (const item of weighted) {
    target -= item.weight;
    if (target <= 0) return item.ghost;
  }
  // A draw of exactly 1 leaves `target` at 0 after the last subtraction only
  // within floating-point luck; falling back to the first keeps this total.
  return ghosts[0];
}

/** Three decimals. Session logs and exports are read by people. */
export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
