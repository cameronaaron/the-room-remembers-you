import { selectObservedTracks } from './motion-tracker.ts';
import type {
  Ghost,
  Point,
  RoomPersonality,
  VisitorTrack,
} from './room-types';

export const FIELD_WIDTH = 64;
export const FIELD_HEIGHT = 36;

export function createMemoryField(values?: ArrayLike<number>) {
  const field = new Float32Array(FIELD_WIDTH * FIELD_HEIGHT);
  if (values) field.set(Array.from(values).slice(0, field.length));
  return field;
}

/** One deposit the room owes a visitor: where, how much, how wide. */
export type FieldDeposit = {
  point: Pick<Point, 'x' | 'y'>;
  amount: number;
  radius: number;
};

/**
 * What the observed visitors deposit this frame, as values.
 *
 * Separated from applying it because there are two consumers — the field
 * itself, and `FieldRuntime`, which has to send the same records across the
 * WASM boundary. Two copies of "a still visitor deposits 0.0018 over a radius
 * of 3.4" is two copies that can drift, and the drift would show up as a parity
 * failure blamed on Rust.
 *
 * Only confirmed observations may leave a deposit; prediction and noise cannot.
 */
export function observedDeposits(
  tracks: VisitorTrack[],
  project: (point: Point) => Pick<Point, 'x' | 'y'>,
  /**
   * Per-visitor weight, for the rare stretch when the room is interested in
   * somebody: their trace lingers a little longer than anyone else's. Defaults
   * to 1, which is what the room does for everybody the rest of the time.
   */
  scale: (track: VisitorTrack) => number = () => 1,
): FieldDeposit[] {
  return selectObservedTracks(tracks).map((track) => {
    const still = track.speed < 0.025;
    const weight = Math.max(0, scale(track));
    return {
      point: project(track.position),
      amount: (still ? 0.0018 : 0.0008) * weight,
      radius: still ? 3.4 : 1.8,
    };
  });
}

export function depositObservedMemory(
  field: Float32Array,
  tracks: VisitorTrack[],
  project: (point: Point) => Pick<Point, 'x' | 'y'>,
  scale: (track: VisitorTrack) => number = () => 1,
) {
  for (const { point, amount, radius } of observedDeposits(tracks, project, scale)) {
    depositMemory(field, point, amount, radius);
  }
}

export function depositMemory(
  field: Float32Array,
  point: Pick<Point, 'x' | 'y'>,
  amount: number,
  radius = 2,
) {
  const cx = Math.round(clamp(point.x, 0, 1) * (FIELD_WIDTH - 1));
  const cy = Math.round(clamp(point.y, 0, 1) * (FIELD_HEIGHT - 1));
  const reach = Math.max(1, Math.ceil(radius * 2));
  for (let y = Math.max(0, cy - reach); y <= Math.min(FIELD_HEIGHT - 1, cy + reach); y += 1) {
    for (let x = Math.max(0, cx - reach); x <= Math.min(FIELD_WIDTH - 1, cx + reach); x += 1) {
      const distanceSquared = (x - cx) ** 2 + (y - cy) ** 2;
      const weight = Math.exp(-distanceSquared / (2 * radius * radius));
      const index = y * FIELD_WIDTH + x;
      field[index] = clamp(field[index] + amount * weight, 0, 1);
    }
  }
}

export function decayMemory(
  field: Float32Array,
  elapsedSeconds: number,
  halfLifeMinutes: number,
  emptyMultiplier = 1,
) {
  const halfLife = Math.max(60, halfLifeMinutes * 60);
  const decay = 2 ** (-(elapsedSeconds * emptyMultiplier) / halfLife);
  for (let index = 0; index < field.length; index += 1) {
    field[index] *= decay;
    if (field[index] < 0.0001) field[index] = 0;
  }
}

export function memoryDensity(field: Float32Array) {
  if (!field.length) return 0;
  let total = 0;
  for (const value of field) total += value;
  return total / field.length;
}

export function simplifyPath(path: Point[], maxPoints = 72): Point[] {
  if (path.length <= maxPoints) return path.map((point) => ({ ...point }));
  const result: Point[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const source = Math.round((index / (maxPoints - 1)) * (path.length - 1));
    result.push({ ...path[source] });
  }
  return result;
}

export function normalizePath(path: Point[], samples = 16): Point[] {
  if (!path.length) return [];
  if (path.length === 1) return Array.from({ length: samples }, () => ({ ...path[0] }));
  const result: Point[] = [];
  for (let index = 0; index < samples; index += 1) {
    const position = (index / (samples - 1)) * (path.length - 1);
    const low = Math.floor(position);
    const high = Math.min(path.length - 1, Math.ceil(position));
    const mix = position - low;
    result.push({
      x: path[low].x + (path[high].x - path[low].x) * mix,
      y: path[low].y + (path[high].y - path[low].y) * mix,
      t: path[low].t + (path[high].t - path[low].t) * mix,
    });
  }
  return result;
}

/**
 * How far a path actually reaches, as the diagonal of its bounding box.
 *
 * Needed because `trajectoryDistance` between the two halves of a path is near
 * zero for someone standing still — their "path" is a cloud of points at one
 * spot, and its first half matches its second half perfectly. Without a
 * requirement that the path went somewhere, a visitor who simply sat down was
 * told "you have walked this before" about eleven seconds after arriving.
 */
export function pathExtent(path: Point[]): number {
  if (path.length < 2) return 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of path) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

/** A path must reach at least this far before "you came back" means anything. */
export const RETURN_MIN_EXTENT = 0.28;

export function trajectoryDistance(first: Point[], second: Point[]) {
  if (first.length < 2 || second.length < 2) return Number.POSITIVE_INFINITY;
  const a = normalizePath(first);
  const b = normalizePath(second);
  let forward = 0;
  let reverse = 0;
  for (let index = 0; index < a.length; index += 1) {
    forward += Math.hypot(a[index].x - b[index].x, a[index].y - b[index].y);
    const other = b[b.length - index - 1];
    reverse += Math.hypot(a[index].x - other.x, a[index].y - other.y);
  }
  return Math.min(forward, reverse) / a.length;
}

export function findConvergentGhost(path: Point[], ghosts: Ghost[], threshold = 0.07) {
  let match: Ghost | null = null;
  let best = threshold;
  for (const ghost of ghosts) {
    const distance = trajectoryDistance(path, ghost.path);
    if (distance < best) {
      best = distance;
      match = ghost;
    }
  }
  return match;
}

export function decayStrength(strength: number, elapsedSeconds: number, halfLifeHours: number) {
  return clamp(strength * 2 ** (-elapsedSeconds / Math.max(1, halfLifeHours * 3600)), 0, 1);
}

export function reinforceStrength(strength: number, amount: number) {
  return clamp(strength + (1 - strength) * clamp(amount, 0, 1), 0, 1);
}

export function rememberGhost(ghost: Ghost, random: () => number = Math.random): Ghost {
  const recallCount = ghost.recallCount + 1;
  const fidelity = clamp(ghost.fidelity * (0.93 - random() * 0.025), 0.04, 1);
  const source = normalizePath(ghost.path, Math.min(72, Math.max(12, ghost.path.length)));
  const mutation = (1 - fidelity) * 0.035;
  const path = source.map((point, index) => {
    const before = source[Math.max(0, index - 1)];
    const after = source[Math.min(source.length - 1, index + 1)];
    const smoothedX = before.x * 0.2 + point.x * 0.6 + after.x * 0.2;
    const smoothedY = before.y * 0.2 + point.y * 0.6 + after.y * 0.2;
    return {
      x: clamp(smoothedX + (random() - 0.5) * mutation, 0, 1),
      y: clamp(smoothedY + (random() - 0.5) * mutation, 0, 1),
      t: point.t,
    };
  });
  return {
    ...ghost,
    path,
    lastReplayedAt: Date.now(),
    recallCount,
    fidelity,
    strength: reinforceStrength(ghost.strength, 0.12),
    intensity: clamp(ghost.intensity * 0.96 + 0.025, 0, 1),
  };
}

export function rememberWhisper<T extends { envelope: number[]; fidelity: number; strength: number; recallCount: number; lastReplayedAt: number }>(
  whisper: T,
  random: () => number = Math.random,
): T {
  const fidelity = clamp(whisper.fidelity * (0.88 - random() * 0.04), 0.03, 1);
  const envelope = whisper.envelope
    .filter((_, index) => index % Math.max(1, Math.floor(1 / Math.max(0.08, fidelity))) === 0)
    .map((value, index, values) => {
      // Index 0 reads itself, so the first point smooths against nothing; every
      // other index is in range by construction and needed no fallback.
      const neighbor = values[Math.max(0, index - 1)];
      return clamp((value * 0.68 + neighbor * 0.32) * (0.9 + random() * 0.08), 0, 1);
    });
  return {
    ...whisper,
    envelope: envelope.length >= 3 ? envelope : whisper.envelope.slice(0, 3),
    fidelity,
    strength: reinforceStrength(whisper.strength, 0.08),
    recallCount: whisper.recallCount + 1,
    lastReplayedAt: Date.now(),
  };
}

/**
 * Longest id the room will mint or store.
 *
 * Mirrors `room_protocol::MEMORY_ID_MAX`, and it is a cap rather than a
 * description: a composite id used to embed both of its parents' ids, and a
 * false memory made from two false memories embeds *theirs*, so the length
 * roughly 2.6x'd per generation. Measured, not feared — eight generations
 * reached 38,312 characters, and every one of them was written to disk on
 * every save. The Rust could not represent it at all, which is how it was
 * found.
 */
export const MEMORY_ID_MAX = 64;

/**
 * Source memories a composite may name.
 *
 * Mirrors `room_protocol::LINEAGE_MAX`. Lineage is where provenance belongs —
 * the standards require a composite to retain the ids of its sources — and it
 * grows by two per generation, so it needs a ceiling for the same reason the
 * id did. The most recent entries are kept, which are the immediate parents:
 * the useful end of a chain when it has to be cut.
 */
export const LINEAGE_MAX = 64;

/**
 * A 32-bit FNV-1a hash, as base 36.
 *
 * Used to name a composite after its parents without embedding them. FNV-1a
 * because it is four lines and expressible exactly in both languages —
 * `Math.imul` here, a wrapping multiply in Rust — which is the same reason
 * `room-rng.ts` uses sfc32. It is not cryptographic and does not need to be;
 * it distinguishes one composite from another inside a single millisecond.
 */
export function idHash(...parts: string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash = Math.imul(hash ^ part.charCodeAt(index), 0x01000193) >>> 0;
    }
    // A separator inside the hash, so `("ab", "c")` and `("a", "bc")` differ.
    hash = Math.imul(hash ^ 0x1f, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function createFalseMemory(
  first: Ghost,
  second: Ghost,
  now = Date.now(),
  whisper?: { id: string; envelope: number[] },
): Ghost {
  const a = normalizePath(first.path, 24);
  const b = normalizePath(second.path, 24);
  const seam = 12;
  const offsetX = a[seam - 1].x - b[seam].x;
  const offsetY = a[seam - 1].y - b[seam].y;
  const joined = [
    ...a.slice(0, seam),
    ...b.slice(seam).map((point) => ({
      ...point,
      x: clamp(point.x + offsetX, 0, 1),
      y: clamp(point.y + offsetY, 0, 1),
    })),
  ];
  const path = whisper?.envelope.length
    ? joined.map((point, index) => ({
        ...point,
        y: clamp(point.y + (whisper.envelope[index % whisper.envelope.length] - 0.5) * 0.025, 0, 1),
      }))
    : joined;
  return {
    // Named *after* its parents rather than *from* them. The parents are in
    // `lineage`, which is where the provenance rule says they belong and which
    // is bounded; an id that carried them grew without limit.
    id: `false-${now.toString(36)}-${idHash(first.id, second.id)}`,
    createdAt: now,
    lastReplayedAt: 0,
    path,
    dwellSeconds: (first.dwellSeconds + second.dwellSeconds) / 2,
    intensity: 0.28,
    strength: 0.24,
    fidelity: Math.min(first.fidelity, second.fidelity) * 0.72,
    recallCount: 0,
    // The most recent entries when it overflows, which are the immediate
    // parents: the useful end of a chain when it has to be cut.
    lineage: [...new Set([
      ...first.lineage, first.id, ...second.lineage, second.id,
      ...(whisper ? [whisper.id] : []),
    ])].slice(-LINEAGE_MAX),
    falseMemory: true,
    day: Math.max(first.day, second.day),
  };
}

export function choosePersonality(
  tracks: VisitorTrack[],
  emptySeconds: number,
  density: number,
  previous: RoomPersonality,
): RoomPersonality {
  if (tracks.length >= 8) return 'overwhelmed';
  if (tracks.length >= 4) return 'crowded';
  if (tracks.length > 0) {
    const still = tracks.every((track) => track.stillFor >= 15);
    if (still) return 'remembering';
    const averageSpeed = tracks.reduce((sum, track) => sum + track.speed, 0) / tracks.length;
    if (averageSpeed > 0.18) return 'attentive';
    return previous === 'dormant' ? 'curious' : 'attentive';
  }
  if (emptySeconds > 20 * 60) return 'forgetting';
  if (emptySeconds > 2 * 60 && density > 0.004) return 'lonely';
  return density < 0.001 ? 'dormant' : 'remembering';
}

export function trimExpired<T extends { createdAt: number }>(
  items: T[],
  now: number,
  retentionDays: number,
) {
  const cutoff = now - Math.max(1, retentionDays) * 86_400_000;
  return items.filter((item) => item.createdAt >= cutoff);
}

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Probability that a Poisson event with rate `ratePerSecond` fires during
 * `elapsedSeconds`.
 *
 * Rare events used to be rolled once per analysis tick at a fixed per-tick
 * chance, which tied how often the room remembers anything to the hardware
 * profile: the same installation produced recalls 2.4x more often on FULL
 * (24 Hz) than on CHEAP (10 Hz). Rates belong in wall-clock time.
 */
export function eventChance(ratePerSecond: number, elapsedSeconds: number) {
  const rate = Math.max(0, ratePerSecond);
  const elapsed = Math.max(0, Math.min(60, elapsedSeconds));
  return 1 - Math.exp(-rate * elapsed);
}

/**
 * Base recall rate at `ghostFrequency` 1. Tuned against gallery dwell rather
 * than against a day: at the default frequency a visitor should meet the room's
 * memory within about a minute, not within an hour.
 */
export const RECALL_RATE_PER_SECOND = 0.045;
