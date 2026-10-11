/**
 * The JavaScript half of the interest subsystem's WASM boundary.
 *
 * One flat `Float64Array` crosses in per sensing frame and five numbers come
 * back, and this module is the only thing on this side that knows either
 * layout. Like `track-bridge.ts` it deliberately does not import the WASM
 * module: `public/wasm/` is a build product, and an encoder that needed it
 * could only be tested by building it. The caller supplies the buffer; this
 * file supplies the meaning.
 *
 * The layout is defined once, in
 * `crates/room-engine/src/attention_engine.rs`. The constants below mirror it
 * and `attention-bridge.test.ts` parses that source to compare the two tables,
 * so a field added on one side without the other fails a test rather than
 * silently decoding an interest weight as a track id.
 *
 * # Order within a frame is part of the contract
 *
 * Filings first, then the present tracks. That is the order the shell already
 * runs in — `behaviors.ts` files a revisit, `attention-evidence.ts` files dwell
 * and stillness, then attention updates — and it matters because insertion
 * order settles a tie between two visitors who qualify on the same frame. A
 * crossing is filed after that update and so belongs in the *next* frame's
 * filings, which is what a caller that simply buffers between steps gets.
 */

/** Values in the input header, before the first filing. */
export const HEADER_FIELDS = 3;

/** Values per externally-sourced filing: kind, track id, and when it happened. */
export const FILING_STRIDE = 3;

/** Values per present track. */
export const PRESENCE_STRIDE = 3;

/** Values in the output. */
export const OUTPUT_FIELDS = 5;

/**
 * Filings one frame may carry. Mirrors `room_engine::attention_engine`.
 *
 * `TRACKS_MAX` plus headroom for a frame in which every visitor revisits and a
 * crossing lands in the same buffer. A caller that reaches it is not describing
 * a gallery, and the engine refuses the frame rather than reading past it.
 */
export const MAX_FILINGS = 16;

/**
 * Wire codes for the kinds of evidence. Mirrors `room_engine::attention::Evidence`.
 *
 * `dwell` and `stillness` appear here because the enum has four variants and a
 * table with a hole in it is worse than one without, but the engine refuses a
 * frame that files either: those two are the rate-limited gate's to decide, and
 * a caller filing them directly has bypassed the limit that stops the room
 * becoming interested in the first person who stops walking. `FILEABLE` is the
 * set a caller may actually send.
 */
export const EVIDENCE = Object.freeze({
  dwell: 0,
  revisit: 1,
  crossing: 2,
  stillness: 3,
});

/** The kinds a caller may file. See `EVIDENCE`. */
export const FILEABLE = Object.freeze(['revisit', 'crossing'] as const);

// Declared with the rules rather than at the boundary: which kinds are the
// gate's is a property of the room's interest, not of how it is packed. The
// annotation is what makes the two tables above and the type one thing — a
// kind added to `FILEABLE` alone is a type error here.
import type { FileableEvidence } from './attention';

export type { FileableEvidence };

// The annotation is what makes the two tables above and the type one thing: a
// kind added to `FILEABLE` alone is a type error here.
const FILEABLE_ARE_THE_ROOM_S: readonly FileableEvidence[] = FILEABLE;
void FILEABLE_ARE_THE_ROOM_S;

/** Offsets within the output. Mirrors `room_engine::attention_engine::Field`. */
export const FIELD = Object.freeze({
  attending: 0,
  track: 1,
  weight: 2,
  tracked: 3,
  filings: 4,
});

/**
 * The track id reported when the room is attending to nobody.
 *
 * A sentinel rather than a `NaN`, because `NaN` propagates silently through
 * arithmetic on this side and `-1` does not survive a comparison against a real
 * id, which are always non-negative integers.
 */
export const NO_TRACK = -1;

/**
 * A filing the caller has accumulated since the last frame.
 *
 * `at` is when it happened on the same monotonic clock as the frame's `now`.
 * It must be at or before `now` and no older than the evidence window, or the
 * engine refuses the frame: a filing from the future means two clocks are in
 * play, and one from before the window means the buffer is not being drained.
 */
export type Filing = { kind: FileableEvidence; trackId: string; at: number };

/** What the gate reads from a present track. Two numbers, and nothing else. */
export type Presence = { id: string; dwellSeconds: number; stillFor: number };

/** What the room decided this frame. */
export type AttentionFrame = {
  /**
   * Who the room is attending to, in the shell's own spelling of a track id, or
   * null. Interest that is rising from nothing reports null until its weight
   * leaves zero, which is the engine's rule and not a rounding artefact.
   */
  trackId: string | null;
  /** 0 to 1: rising, held, then fading. 0 when nobody is attended. */
  weight: number;
  /** Tracks currently holding evidence. Bounded; a diagnostic. */
  tracked: number;
  /** Filings accepted this frame, the gate's and the caller's together. */
  filings: number;
};

/** A buffer that does not describe a frame. Never thrown past the caller. */
export class AttentionFrameError extends Error {}

/**
 * The tracker's spelling of an id, in reverse.
 *
 * Ids cross this boundary as numbers because the engine mints them as `u32`,
 * and `track-bridge.ts` spells them `t-<n>` on the way out. Anything else is a
 * caller mixing two id spaces, which is a defect rather than a bad visitor.
 */
function trackNumber(id: string): number {
  const match = /^t-(\d+)$/.exec(id);
  if (!match) throw new AttentionFrameError(`"${id}" is not a track id this engine minted`);
  return Number(match[1]);
}

/**
 * Pack one sensing frame for the engine.
 *
 * Takes caller-owned values and returns a caller-owned array: nothing here
 * aliases WASM memory, which is what keeps a returned frame valid after the
 * WASM heap grows.
 */
export function encodeAttentionFrame(
  now: number,
  filings: readonly Filing[],
  present: readonly Presence[],
): Float64Array {
  const out = new Float64Array(
    HEADER_FIELDS + filings.length * FILING_STRIDE + present.length * PRESENCE_STRIDE,
  );
  out[0] = now;
  out[1] = filings.length;
  out[2] = present.length;
  let cursor = HEADER_FIELDS;
  for (const filing of filings) {
    out[cursor] = EVIDENCE[filing.kind];
    out[cursor + 1] = trackNumber(filing.trackId);
    out[cursor + 2] = filing.at;
    cursor += FILING_STRIDE;
  }
  for (const track of present) {
    out[cursor] = trackNumber(track.id);
    out[cursor + 1] = track.dwellSeconds;
    out[cursor + 2] = track.stillFor;
    cursor += PRESENCE_STRIDE;
  }
  return out;
}

/**
 * Read what the room decided.
 *
 * Validates rather than trusting the length. The buffer comes from our own WASM
 * today, so this is not about a hostile producer; it is about the layout
 * drifting between two halves of a boundary that no type system spans. A
 * misread here is a room that quietly attends to the wrong person, which is
 * invisible on the wall and is exactly the class of failure this installation
 * cannot debug after the fact.
 */
export function decodeAttentionFrame(frame: Float64Array): AttentionFrame {
  if (frame.length !== OUTPUT_FIELDS) {
    throw new AttentionFrameError(`expected ${OUTPUT_FIELDS} values, got ${frame.length}`);
  }
  const attending = frame[FIELD.attending];
  const track = frame[FIELD.track];
  const weight = frame[FIELD.weight];
  if (attending !== 0 && attending !== 1) {
    throw new AttentionFrameError('the attending flag is neither 0 nor 1');
  }
  if (attending === 0) {
    if (track !== NO_TRACK || weight !== 0) {
      throw new AttentionFrameError('an unattended room reported a track or a weight');
    }
  } else if (!Number.isInteger(track) || track < 0 || !(weight > 0 && weight <= 1)) {
    throw new AttentionFrameError('an attended room reported no usable track or weight');
  }
  return {
    trackId: attending === 1 ? `t-${track}` : null,
    weight,
    tracked: frame[FIELD.tracked],
    filings: frame[FIELD.filings],
  };
}

/**
 * How much more memory this visitor's presence deposits. 1 for everybody else.
 *
 * Mirrors `RoomAttention.depositScale`, and is here rather than in the engine's
 * output because it is one multiply the renderer's caller wants per track and
 * the weight is the only thing the engine actually decided.
 */
export const ATTENDED_DEPOSIT_GAIN = 0.45;

export function depositScale(decided: AttentionFrame, trackId: string): number {
  return decided.trackId === trackId ? 1 + ATTENDED_DEPOSIT_GAIN * decided.weight : 1;
}
