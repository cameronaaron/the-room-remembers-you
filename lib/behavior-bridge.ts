/**
 * The JavaScript half of the behaviour subsystem's WASM boundary.
 *
 * One flat `Float64Array` crosses in per sensing frame and a short list of
 * events comes back, and this module is the only thing on this side that knows
 * either layout. Like `track-bridge.ts` and `attention-bridge.ts` it
 * deliberately does not import the WASM module: `public/wasm/` is a build
 * product, and an encoder that needed it could only be tested by building it.
 * The caller supplies the buffer; this file supplies the meaning.
 *
 * The layout is defined once, in
 * `crates/room-engine/src/behavior_engine.rs`. The constants below mirror it
 * and `behavior-bridge.test.ts` parses that source to compare the two tables,
 * so a field added on one side without the other fails a test rather than
 * silently decoding a velocity as a width.
 *
 * # What crosses, and what does not
 *
 * Positions, region widths, velocities and the tracker's recorded path. No
 * pixels, no outline geometry, no heights — the wave detector reads width
 * alone, and a field nothing reads is a field that drifts. Everything here is
 * anonymous motion in room coordinates, which is the same thing the detectors
 * were already allowed to see.
 *
 * # The path crosses whole, every frame
 *
 * `revisit` is a claim about minutes: somewhere this visitor stood at least
 * twenty seconds ago and has been a long way from since. It needs the whole
 * path, and the path belongs to the tracker. Mirroring it on the far side
 * would be cheaper on the wire and would desynchronise silently, which in a
 * revisit detector looks exactly like a room with no returning visitors. One
 * copy per frame is not a chatty boundary; a mirror that can be wrong is not
 * cheap.
 */

/** Values in the input header, before the first track. */
export const HEADER_FIELDS = 3;

/** Fixed values per track record, before its path. */
export const RECORD_FIELDS = 8;

/** Values per path point. */
export const PATH_STRIDE = 3;

/** Values in the output header, before the first event. */
export const OUTPUT_HEADER_FIELDS = 2;

/** Values per reported event. */
export const EVENT_STRIDE = 5;

/**
 * Events one frame can produce.
 *
 * A cooldown is stamped on the first accepted report of a kind, so a frame
 * yields at most one of each. This is the number of behaviours, not a guess
 * with headroom.
 */
export const MAX_EVENTS = 6;

/**
 * Wire codes for the behaviours. Mirrors `room_engine::behavior::Behavior`.
 *
 * The order is the order the detectors run in, which is also the order the
 * cooldown table is indexed by.
 */
export const BEHAVIOR = Object.freeze({
  wave: 0,
  approach: 1,
  follow: 2,
  together: 3,
  revisit: 4,
  mirror: 5,
});

// Declared with the detectors rather than at the boundary: which behaviours
// exist is a property of what the room can notice, not of how it is packed.
// The annotation is what makes the table above and the type one thing — a kind
// added to `BehaviorKind` alone is a type error here.
import type { BehaviorEvent, BehaviorKind } from './behaviors.ts';

export type { BehaviorEvent, BehaviorKind };

const CODES_ARE_THE_ROOM_S: Readonly<Record<BehaviorKind, number>> = BEHAVIOR;
void CODES_ARE_THE_ROOM_S;

/** Offsets within one track record. Mirrors `room_engine::behavior_engine::Field`. */
export const FIELD = Object.freeze({
  id: 0,
  x: 1,
  y: 2,
  width: 3,
  velocityX: 4,
  velocityY: 5,
  speed: 6,
  pathLength: 7,
});

/** Offsets within one reported event. Mirrors `EventField`. */
export const EVENT_FIELD = Object.freeze({
  kind: 0,
  x: 1,
  y: 2,
  subject: 3,
  other: 4,
});

/**
 * The second subject of a behaviour about one person.
 *
 * A sentinel rather than a `NaN`, because `NaN` propagates silently through
 * arithmetic on this side and `-1` does not survive a comparison against a real
 * id, which are always non-negative integers.
 */
export const NO_TRACK = -1;

/** A point on a remembered path: where, and when. */
export type PathPoint = { x: number; y: number; t: number };

/** What the detectors read from one track. Nothing else crosses. */
export type ObservedTrack = {
  /** The tracker's id, in the engine's `t-<n>` spelling. */
  id: string;
  x: number;
  y: number;
  /** Width of the detected region, in room units. */
  width: number;
  velocityX: number;
  velocityY: number;
  speed: number;
  /** The tracker's own record of where this visitor has walked. */
  path: readonly PathPoint[];
};

/** What the room noticed this frame. */
export type BehaviorFrame = {
  events: BehaviorEvent[];
  /** Tracks the watcher is holding. Bounded; a diagnostic. */
  tracked: number;
};

/** A buffer that does not describe a frame. Never thrown past the caller. */
export class BehaviorFrameError extends Error {}

/** The behaviours, indexed by wire code, for decoding. */
const KINDS: readonly BehaviorKind[] = Object.freeze(
  (Object.keys(BEHAVIOR) as BehaviorKind[]).sort((a, b) => BEHAVIOR[a] - BEHAVIOR[b]),
);

/**
 * The tracker's spelling of an id, in reverse.
 *
 * Ids cross this boundary as numbers because the engine mints them as `u32`.
 * Anything else is a caller mixing two id spaces, which is a defect rather than
 * a bad visitor.
 */
function trackNumber(id: string): number {
  const match = /^t-(\d+)$/.exec(id);
  if (!match) throw new BehaviorFrameError(`"${id}" is not a track id this engine minted`);
  return Number(match[1]);
}

/**
 * Pack one sensing frame for the engine.
 *
 * Takes caller-owned values and returns a caller-owned array: nothing here
 * aliases WASM memory, which is what keeps a returned frame valid after the
 * WASM heap grows.
 */
export function encodeBehaviorFrame(
  now: number,
  stable: boolean,
  tracks: readonly ObservedTrack[],
): Float64Array {
  let length = HEADER_FIELDS;
  for (const track of tracks) length += RECORD_FIELDS + track.path.length * PATH_STRIDE;
  const out = new Float64Array(length);
  out[0] = now;
  out[1] = stable ? 1 : 0;
  out[2] = tracks.length;
  let cursor = HEADER_FIELDS;
  for (const track of tracks) {
    out[cursor + FIELD.id] = trackNumber(track.id);
    out[cursor + FIELD.x] = track.x;
    out[cursor + FIELD.y] = track.y;
    out[cursor + FIELD.width] = track.width;
    out[cursor + FIELD.velocityX] = track.velocityX;
    out[cursor + FIELD.velocityY] = track.velocityY;
    out[cursor + FIELD.speed] = track.speed;
    out[cursor + FIELD.pathLength] = track.path.length;
    cursor += RECORD_FIELDS;
    for (const point of track.path) {
      out[cursor] = point.x;
      out[cursor + 1] = point.y;
      out[cursor + 2] = point.t;
      cursor += PATH_STRIDE;
    }
  }
  return out;
}

/**
 * Read what the room noticed.
 *
 * Validates rather than trusting the length. The buffer comes from our own WASM
 * today, so this is not about a hostile producer; it is about the layout
 * drifting between two halves of a boundary that no type system spans. A misread
 * here is a room announcing the wrong thing about the wrong person, which is the
 * one failure this installation cannot take back.
 */
export function decodeBehaviorFrame(frame: Float64Array): BehaviorFrame {
  if (frame.length < OUTPUT_HEADER_FIELDS) {
    throw new BehaviorFrameError(`expected at least ${OUTPUT_HEADER_FIELDS} values`);
  }
  const count = frame[0];
  const tracked = frame[1];
  if (!Number.isInteger(count) || count < 0 || count > MAX_EVENTS) {
    throw new BehaviorFrameError(`${count} is not a possible number of events`);
  }
  if (frame.length !== OUTPUT_HEADER_FIELDS + count * EVENT_STRIDE) {
    throw new BehaviorFrameError(`${count} events do not fit in ${frame.length} values`);
  }
  if (!Number.isInteger(tracked) || tracked < 0) {
    throw new BehaviorFrameError('the held-track count is not a count');
  }
  const events: BehaviorEvent[] = [];
  const seen = new Set<BehaviorKind>();
  for (let index = 0; index < count; index += 1) {
    const at = OUTPUT_HEADER_FIELDS + index * EVENT_STRIDE;
    const kind = KINDS[frame[at + EVENT_FIELD.kind]];
    if (!kind) throw new BehaviorFrameError('an event named a behaviour that does not exist');
    // One cooldown per kind means one report per kind per frame. A repeat is
    // the engine and this decoder disagreeing about the stride, which would
    // otherwise read as the room noticing the same thing twice.
    if (seen.has(kind)) throw new BehaviorFrameError(`${kind} was reported twice in one frame`);
    seen.add(kind);
    const x = frame[at + EVENT_FIELD.x];
    const y = frame[at + EVENT_FIELD.y];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new BehaviorFrameError('an event has nowhere to be addressed');
    }
    const subject = frame[at + EVENT_FIELD.subject];
    const other = frame[at + EVENT_FIELD.other];
    if (!Number.isInteger(subject) || subject < 0) {
      throw new BehaviorFrameError('an event named no subject');
    }
    if (other !== NO_TRACK && (!Number.isInteger(other) || other < 0)) {
      throw new BehaviorFrameError('an event named a second subject that is not a track');
    }
    if (other === subject) {
      throw new BehaviorFrameError('an event named the same person twice');
    }
    events.push({
      kind,
      at: { x, y },
      subjects: other === NO_TRACK ? [`t-${subject}`] : [`t-${subject}`, `t-${other}`],
    });
  }
  return { events, tracked };
}
