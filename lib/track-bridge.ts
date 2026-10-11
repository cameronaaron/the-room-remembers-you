import type { Point, VisitorTrack } from './room-types';

/**
 * The JavaScript half of the tracker's WASM boundary.
 *
 * One flat `Float64Array` crosses per sensing frame, and this module is the
 * only thing on this side that knows how to read it. It deliberately does not
 * import the WASM module: `public/wasm/` is a build product, and a decoder that
 * needed it could only be tested by building it. The caller supplies the
 * buffer; this file supplies the meaning.
 *
 * The layout is defined once, in `crates/room-engine/src/track_engine.rs`. The
 * offsets below mirror the `Field` enum there, and `track-bridge.test.ts` pins
 * them against a buffer built by hand, so a field inserted on one side without
 * the other fails a test rather than silently decoding a confidence as a dwell
 * time.
 */

/** Values in the header, before the first track record. */
export const HEADER_FIELDS = 3;

/** Fixed values per track record, before its path. */
export const RECORD_FIELDS = 21;

/** Values per detected region in the input array. */
export const BLOB_STRIDE = 5;

/**
 * Offsets within one record. Mirrors `room_engine::track_engine::Field`.
 *
 * Frozen so a caller cannot reorder the contract at runtime, and exported
 * because the parity harness reads records without building whole tracks.
 */
export const FIELD = Object.freeze({
  id: 0,
  bornAt: 1,
  lastSeen: 2,
  x: 3,
  y: 4,
  t: 5,
  previousX: 6,
  previousY: 7,
  previousT: 8,
  velocityX: 9,
  velocityY: 10,
  speed: 11,
  stillFor: 12,
  dwellSeconds: 13,
  active: 14,
  occluded: 15,
  confidence: 16,
  sightings: 17,
  width: 18,
  height: 19,
  pathLength: 20,
});

export type TrackFrame = {
  active: VisitorTrack[];
  ended: VisitorTrack[];
  /**
   * Cumulative count of times fragment continuity held a splitting body
   * together. A count and nothing else: the outline geometry that produced it
   * is never exposed, because a silhouette is the one thing in this pipeline
   * that starts to look like a picture of somebody.
   */
  fragmentRecoveries: number;
};

/** A buffer that does not describe a frame. Never thrown past the caller. */
export class TrackFrameError extends Error {}

/**
 * Pack detected regions for the engine.
 *
 * Takes a caller-owned array and returns a caller-owned array: nothing here
 * aliases WASM memory, which is what keeps a returned frame valid after the
 * WASM heap grows.
 */
export function encodeBlobs(
  blobs: ReadonlyArray<{ x: number; y: number; width: number; height: number; energy: number }>,
): Float64Array {
  const out = new Float64Array(blobs.length * BLOB_STRIDE);
  for (let index = 0; index < blobs.length; index += 1) {
    const blob = blobs[index];
    const base = index * BLOB_STRIDE;
    out[base] = blob.x;
    out[base + 1] = blob.y;
    out[base + 2] = blob.width;
    out[base + 3] = blob.height;
    out[base + 4] = blob.energy;
  }
  return out;
}

/**
 * Read one engine frame.
 *
 * Validates as it goes rather than trusting the length. The buffer comes from
 * our own WASM today, so this is not about a hostile producer; it is about the
 * layout drifting between the two halves of a boundary that no type system
 * spans. A truncated record is a wrong answer that renders, which is the worst
 * kind of failure this installation has.
 */
export function decodeTrackFrame(frame: Float64Array): TrackFrame {
  if (frame.length < HEADER_FIELDS) throw new TrackFrameError('frame is shorter than its header');
  const activeCount = frame[0];
  const endedCount = frame[1];
  const fragmentRecoveries = frame[2];
  if (!Number.isInteger(activeCount) || !Number.isInteger(endedCount) || activeCount < 0 || endedCount < 0) {
    throw new TrackFrameError('frame header is not two counts');
  }
  let cursor = HEADER_FIELDS;
  const read = (count: number): VisitorTrack[] => {
    const tracks: VisitorTrack[] = [];
    for (let index = 0; index < count; index += 1) {
      const [track, next] = readRecord(frame, cursor);
      tracks.push(track);
      cursor = next;
    }
    return tracks;
  };
  const active = read(activeCount);
  const ended = read(endedCount);
  if (cursor !== frame.length) throw new TrackFrameError(`frame has ${frame.length - cursor} trailing values`);
  return { active, ended, fragmentRecoveries };
}

function readRecord(frame: Float64Array, base: number): [VisitorTrack, number] {
  if (base + RECORD_FIELDS > frame.length) throw new TrackFrameError('record is truncated');
  const at = (field: number) => frame[base + field];
  const pathLength = at(FIELD.pathLength);
  if (!Number.isInteger(pathLength) || pathLength < 1) {
    throw new TrackFrameError('a track must carry at least one path point');
  }
  const pathBase = base + RECORD_FIELDS;
  const end = pathBase + pathLength * 3;
  if (end > frame.length) throw new TrackFrameError('path is truncated');
  const path: Point[] = [];
  for (let point = 0; point < pathLength; point += 1) {
    const cursor = pathBase + point * 3;
    path.push({ x: frame[cursor], y: frame[cursor + 1], t: frame[cursor + 2] });
  }
  const track: VisitorTrack = {
    // The engine's own spelling of a track id, so a log line from either side
    // names the same visitor. Never persisted: a track id means nothing once
    // the person it refers to has left.
    id: `t-${at(FIELD.id)}`,
    bornAt: at(FIELD.bornAt),
    lastSeen: at(FIELD.lastSeen),
    position: { x: at(FIELD.x), y: at(FIELD.y), t: at(FIELD.t) },
    previous: { x: at(FIELD.previousX), y: at(FIELD.previousY), t: at(FIELD.previousT) },
    velocity: { x: at(FIELD.velocityX), y: at(FIELD.velocityY) },
    speed: at(FIELD.speed),
    stillFor: at(FIELD.stillFor),
    dwellSeconds: at(FIELD.dwellSeconds),
    path,
    active: at(FIELD.active) === 1,
    occluded: at(FIELD.occluded) === 1,
    confidence: at(FIELD.confidence),
    sightings: at(FIELD.sightings),
    extent: { width: at(FIELD.width), height: at(FIELD.height) },
  };
  return [track, end];
}

/**
 * The tracker's sequence number, out of whichever spelling of an id it minted.
 *
 * `motion-tracker.ts` spells a track `visitor-<birth in base 36>-<sequence>`
 * and `room_engine::track_engine` spells it `t-<sequence>`, which
 * `TrackingRuntime` rewrites into the first form. The trailing number is the
 * same in both and is unique for the life of a manager: `clear()` empties the
 * tracks and deliberately does not rewind the sequence, so a reset cannot make
 * two different visitors share an id.
 *
 * Both spellings, and nothing else. A trailing `-<digits>` alone would also
 * accept an id from some other space that happens to end in a number, and two
 * id spaces sharing a sequence is how a room ends up attending to, or
 * announcing something about, somebody who is not the person who earned it.
 * The middle segment is a float in base 36, so it can carry a point.
 *
 * It lives here because this module already owns the `t-<n>` spelling on the
 * way out, and every subsystem that sends ids across the boundary needs the
 * way back. Two copies of this rule is two places for the id spaces to drift.
 */
export function trackSequence(id: string): number | null {
  const match = /^(?:t-|visitor-[0-9a-z.]+-)(\d+)$/.exec(id);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}
