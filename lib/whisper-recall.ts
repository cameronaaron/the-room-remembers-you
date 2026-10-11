/**
 * Whether the room surfaces a remembered whisper right now, and if not, why.
 *
 * This lived inside the render component as four early returns, which made the
 * one question an operator actually asks — "there are whispers in there, I can
 * play them from the console, so why does the room never say one?" —
 * unanswerable without a debugger and a gallery. It is the same reasoning that
 * put `assessLiveness` in `liveness.ts` rather than in the launcher.
 *
 * Every refusal is named. A room that declines to speak looks exactly like a
 * room with nothing to say, and exactly like a room that has been switched off,
 * so the difference has to be a value something can read rather than an absence
 * something has to notice. `frequency is zero` in particular is a real setting
 * an operator can leave behind: the console's slider bottoms out at off, the
 * audition button ignores the rate and keeps working, and the result is
 * recordings that exist, play on demand, and never once surface on their own.
 */

import { eventChance, RECALL_RATE_PER_SECOND } from './memory-engine.ts';
import type { WhisperRefusal } from './room-types.ts';

export type { WhisperRefusal };

export type WhisperRecall<T> = { whisper: T; because: null } | { whisper: null; because: WhisperRefusal };

/**
 * A whisper must be held this long before it can come back.
 *
 * Long enough that it returns as something the room remembers rather than as an
 * echo of what you just said. Was a full minute, which combined with a rare
 * roll meant a visitor could easily never hear one.
 */
export const WHISPER_RIPENS_MS = 25_000;

/**
 * The rate is damped slightly below the ghost rate at the same setting, so the
 * two kinds of memory do not arrive together at the default.
 */
export const WHISPER_RATE_DAMPING = 0.9;

export function whisperRecallRate(frequency: number): number {
  return RECALL_RATE_PER_SECOND * Math.max(0, frequency) * WHISPER_RATE_DAMPING;
}

export function chooseWhisperRecall<T extends { id: string; createdAt: number }>(input: {
  /** Everything the room is holding, in no particular order. */
  held: readonly T[];
  /** Seconds since this roll was last made. Rates are wall-clock, not per-tick. */
  sinceLastRollSeconds: number;
  /** `whisperFrequency`, 0 to 1. Zero is off. */
  frequency: number;
  /** Whether this session still holds playable audio for an id. */
  hasRecording: (id: string) => boolean;
  /** Wall clock now, against which ripeness is measured. */
  now: number;
  random?: () => number;
}): WhisperRecall<T> {
  const { held, sinceLastRollSeconds, frequency, hasRecording, now, random = Math.random } = input;
  if (!held.length) return { whisper: null, because: 'nothing held' };

  const rate = whisperRecallRate(frequency);
  // Checked before the roll rather than left to arithmetic. At a rate of zero
  // the roll can never come up, and reporting that as 'not this time' would be
  // true of every tick forever — the least useful true statement available.
  if (rate <= 0) return { whisper: null, because: 'frequency is zero' };
  if (random() >= eventChance(rate, sinceLastRollSeconds)) return { whisper: null, because: 'not this time' };

  // Old enough to come back as memory, and still audible in this session: the
  // PCM never leaves RAM, so a whisper restored from storage has a texture and
  // no voice.
  const ripe = held.filter((whisper) => hasRecording(whisper.id) && now - whisper.createdAt > WHISPER_RIPENS_MS);
  if (!ripe.length) return { whisper: null, because: 'nothing ripe yet' };
  return { whisper: ripe[Math.floor(random() * ripe.length)], because: null };
}
