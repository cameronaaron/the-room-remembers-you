/**
 * The room's voice.
 *
 * Borrowed mechanism, not borrowed tone. The Star Tours droid G2-4T convinces
 * a queue it is watching them with no sensing at all: a live image of you, a
 * loop of statements true of every human alive, and timing. Your brain does the
 * attribution.
 *
 * This room has the opposite problem. It genuinely detects stillness, return,
 * convergence and its own fabrications, and then says nothing a visitor can
 * attribute to themselves. So the sensing is real here and only the address is
 * missing — which means the honest version of the trick is available.
 *
 * Two rules hold the register:
 *
 *  1. Speech is the rarest thing the room does. Most visitors hear one line.
 *     Many hear none. A line that arrives often is a caption, and a caption
 *     explains the image instead of being part of it.
 *  2. **A line may claim only what the detector measured.** The wave detector
 *     knows a still centroid whose outline keeps changing; it does not know
 *     that the thing which moved was a hand. Naming the hand would be a
 *     confident assertion resting on an inference, and one wrong assertion
 *     costs a visitor's belief in every other thing the room says.
 *     `room-voice.test.ts` rejects lines that name body parts or acts of
 *     perception the sensing cannot support.
 *  3. **The room says "I" only when it is uncertain.** Observing is impersonal:
 *     "you stopped." Doubt is where it becomes a self: "i am no longer certain
 *     this happened." `room-voice.test.ts` enforces this.
 */

/** Occasions the room is willing to speak about. */
export type VoiceKind =
  | 'forgetting'
  | 'stillness'
  | 'return'
  | 'convergence'
  | 'false'
  | 'empty'
  | 'crowd'
  // Behaviours, from `behaviors.ts`. All observations, so none of them may
  // reach for the first person.
  | 'wave'
  | 'approach'
  | 'follow'
  | 'together'
  | 'revisit'
  | 'mirror';

/** The occasions on which the room is permitted to say "I". */
export const UNCERTAIN_KINDS: readonly VoiceKind[] = ['false', 'empty', 'crowd', 'forgetting'];

export const VOICE_LINES: Readonly<Record<VoiceKind, readonly string[]>> = {
  forgetting: ['i am no longer certain this happened.', 'i cannot remember where this ended.'],
  stillness: [
    'you stopped.',
    'you have been still a while.',
    'something else stood here.',
    'the room is holding your outline.',
  ],
  return: [
    'you have walked this before.',
    'you came back.',
    'this line is yours, twice.',
  ],
  convergence: [
    'someone walked this line before you.',
    'you are not the first here.',
    'this path already existed.',
  ],
  false: [
    'i am no longer certain this happened.',
    'someone was here. i may be wrong.',
    'i have put two people into one memory.',
  ],
  empty: [
    'i am remembering by myself.',
    'there is no one here. it continues.',
  ],
  crowd: [
    'i am losing track of you.',
    'there are more of you than i can hold.',
  ],
  wave: [
    'yes. that was seen.',
    'you moved without leaving.',
    'something moved back.',
  ],
  approach: [
    'the distance closed.',
    'you are nearer than you were.',
  ],
  follow: [
    'you are walking their line.',
    'someone went this way first.',
    'you took their path.',
  ],
  together: [
    'you arrived together.',
    'two of you, at once.',
  ],
  revisit: [
    'you stood here before.',
    'you have come back to it.',
    'this is the same place.',
  ],
  mirror: [
    'you are moving the same way.',
    'apart, and in step.',
  ],
};

export type Utterance = {
  readonly kind: VoiceKind;
  readonly text: string;
  /** Room coordinates to place the line at, so it lands next to its subject. */
  readonly x: number;
  readonly y: number;
  readonly spokenAt: number;
};

export type RoomVoiceOptions = {
  /** Floor on the gap between any two lines. */
  minGapMs?: number;
  /** Chance the room takes an eligible opportunity, so speech stays irregular. */
  speakChance?: number;
  random?: () => number;
  /**
   * The vocabulary to speak from. Defaults to `VOICE_LINES`.
   *
   * The room's repertoire is data, and the repeat-avoidance rule below has a
   * case — a kind down to its last line — that the shipped table cannot reach,
   * because every kind currently carries at least two. Without a seam that case
   * is a claim no test can make, and the room would answer it by speaking the
   * word `undefined`.
   */
  lines?: Readonly<Record<VoiceKind, readonly string[]>>;
};

export const DEFAULT_VOICE_OPTIONS = {
  minGapMs: 60_000,
  speakChance: 0.6,
} as const;

/**
 * The chance the room takes an occasion concerning somebody it has become
 * interested in. Still not certainty — a room that always speaks about its
 * chosen visitor has announced the choice.
 */
export const ATTENDED_SPEAK_CHANCE = 0.9;

/** How long a line stays on the wall once spoken. */
export const UTTERANCE_LIFETIME_MS = 7_000;

/**
 * Distance below the subject to place the line, in room units.
 *
 * Directly on top reads as a caption stamped over the image, and the bright
 * core of a vortex is the worst possible backing for pale text. Just underneath
 * keeps the line clearly attached to whoever caused it while leaving the thing
 * it is about unobscured.
 */
export const UTTERANCE_DROP = 0.11;

/**
 * Decides whether the room speaks, and what it says. Holds only the state
 * needed to stay rare and to avoid repeating itself.
 */
export class RoomVoice {
  private readonly minGapMs: number;
  private readonly speakChance: number;
  private readonly random: () => number;
  private readonly lines: Readonly<Record<VoiceKind, readonly string[]>>;
  private lastSpokeAt = 0;
  private readonly lastLineByKind = new Map<VoiceKind, string>();

  constructor(options: RoomVoiceOptions = {}) {
    this.minGapMs = options.minGapMs ?? DEFAULT_VOICE_OPTIONS.minGapMs;
    this.speakChance = options.speakChance ?? DEFAULT_VOICE_OPTIONS.speakChance;
    this.random = options.random ?? Math.random;
    this.lines = options.lines ?? VOICE_LINES;
  }

  /** Whether enough time has passed for the room to be willing to speak at all. */
  ready(now: number): boolean {
    return this.lastSpokeAt === 0 || now - this.lastSpokeAt >= this.minGapMs;
  }

  /**
   * Offer the room an occasion. Returns a line if it takes it, otherwise null.
   * Callers should offer freely; staying quiet is this object's job, not theirs.
   */
  offer(
    kind: VoiceKind,
    now: number,
    at: { x: number; y: number },
    /**
     * How interested the room is in the person this concerns, 0 to 1.
     *
     * Raises the chance an *already permitted* occasion is taken; it cannot
     * make the room speak sooner. `minGapMs` still binds absolutely, which is
     * what keeps speech the rarest thing the room does. A visitor the room has
     * taken an interest in is more likely to get the one line it says, not to
     * get more lines.
     */
    interest = 0,
  ): Utterance | null {
    const lines = this.lines[kind];
    if (!lines?.length) return null;
    if (!this.ready(now)) return null;
    const chance = this.speakChance
      + (ATTENDED_SPEAK_CHANCE - this.speakChance) * Math.max(0, Math.min(1, interest));
    if (this.random() > chance) return null;

    const previous = this.lastLineByKind.get(kind);
    const unrepeated = lines.filter((line) => line !== previous);
    const choices = unrepeated.length > 0 ? unrepeated : lines;
    const text = choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))];

    this.lastSpokeAt = now;
    this.lastLineByKind.set(kind, text);
    return {
      kind,
      text,
      x: Math.max(0.08, Math.min(0.92, at.x)),
      y: Math.max(0.1, Math.min(0.9, at.y + UTTERANCE_DROP)),
      spokenAt: now,
    };
  }

  reset() {
    this.lastSpokeAt = 0;
    this.lastLineByKind.clear();
  }
}

/** Whether a line uses the first person. */
export function usesFirstPerson(line: string): boolean {
  return /(^|[^a-z])i([^a-z]|$)/i.test(line) || /\bmy\b|\bme\b|\bmyself\b/i.test(line);
}
