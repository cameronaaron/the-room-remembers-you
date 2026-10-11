import type { Ghost, Point, VisitorTrack } from './room-types';

type XY = { x: number; y: number };
export function distanceToSegment(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function crossed(a: XY, b: XY, c: XY, d: XY): boolean {
  const side = (p: XY, q: XY, r: XY) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/**
 * How long the room waits before any crossing may disturb it again. Twelve
 * simulated hours against a churning 120-path archive produced one disturbance
 * every 20.8 s under the former 20 s wait — with an 11 s presentation that put
 * a corrupted memory on screen roughly half the time, which reads as a
 * metronome rather than as something the visitor accidentally caused.
 */
export const CROSSING_COOLDOWN_MS = 240_000;

/**
 * How long one memory rests before it may be disturbed again. Must stay above
 * CROSSING_COOLDOWN_MS: below it the global wait alone decides what wakes, and
 * this gate never binds, so a visitor can be shown the same path repeatedly.
 */
export const MEMORY_REST_MS = 900_000;

/** Younger than this a path is still the present, and recalling it is an echo. */
export const MEMORY_RIPENS_MS = 25_000;

/** A crossing, not merely standing near history. Coordinates must all be projected. */
export class MemoryCollisions {
  private nextAt = 0;
  private recalled = new Map<string, number>();
  private anchors = new Map<string, Point>();
  find(tracks: readonly VisitorTrack[], ghosts: Ghost[], now: number, project: (p: Point) => XY) {
    const live = new Set(tracks.filter(track => !track.occluded).map(track => track.id));
    for (const id of this.anchors.keys()) if (!live.has(id)) this.anchors.delete(id);
    const ids = new Set(ghosts.map((ghost) => ghost.id));
    for (const id of this.recalled.keys()) if (!ids.has(id)) this.recalled.delete(id);
    if (now < this.nextAt) return null;
    for (const track of tracks) {
      if (track.occluded || track.sightings < 2) continue;
      const anchor = this.anchors.get(track.id) ?? track.previous;
      const from = project(anchor), to = project(track.position);
      const radius = projectedBodyRadius(track, project);
      this.anchors.set(track.id, anchor);
      // Accumulate sub-threshold steps: a slower sensing loop must not make
      // the same walk more likely to count. The fraction rejects centroid jitter.
      const movement = Math.hypot(to.x - from.x, to.y - from.y);
      if (movement === 0 || movement < radius / 20) continue;
      this.anchors.delete(track.id);
      for (const ghost of ghosts) {
        if (now - ghost.createdAt < MEMORY_RIPENS_MS || now - (this.recalled.get(ghost.id) ?? -Infinity) < MEMORY_REST_MS) continue;
        for (let i = 1; i < ghost.path.length; i++) {
          const a = ghost.path[i - 1], b = ghost.path[i];
          const enters = distanceToSegment(from, a, b) > radius && distanceToSegment(to, a, b) <= radius;
          if (!enters && !crossed(from, to, a, b)) continue;
          this.nextAt = now + CROSSING_COOLDOWN_MS;
          this.recalled.set(ghost.id, now);
          // The track is reported so the room can count the crossing as a
          // reason to find that presence interesting. Ephemeral, never stored.
          return { ghost, at: to, index: i - 1, trackId: track.id };
        }
      }
    }
    return null;
  }
  /** Cooldowns held for memories still in the archive; bounded by it, never by time. */
  get tracked(): number { return this.recalled.size; }
  clear() { this.nextAt = 0; this.recalled.clear(); this.anchors.clear(); }
}

/** Local body footprint after calibration, including unequal axis scaling.
 * Without usable extent evidence only an actual segment crossing qualifies. */
export function projectedBodyRadius(track: VisitorTrack, project: (p: Point) => XY): number {
  const extent = track.extent;
  if (!extent || !Number.isFinite(extent.width) || !Number.isFinite(extent.height)
    || extent.width <= 0 || extent.height <= 0) return 0;
  const center = project(track.position);
  const edges = [
    { ...track.position, x: track.position.x + extent.width / 2 },
    { ...track.position, x: track.position.x - extent.width / 2 },
    { ...track.position, y: track.position.y + extent.height / 2 },
    { ...track.position, y: track.position.y - extent.height / 2 },
  ].map(project);
  const radius = Math.min(...edges.map(edge => Math.hypot(edge.x - center.x, edge.y - center.y)));
  return Number.isFinite(radius) ? radius : 0;
}

export function memoryLoss(createdAt: number, fidelity: number, now: number): number {
  const age = Math.max(0, now - createdAt - 5 * 60000) / (6 * 3600000);
  return Math.max(0, Math.min(1, Math.max(age, 1 - fidelity)));
}

/** Deterministic recall failure shared by both renderers; never alters the archive. */
export function disturbanceFrame(path: Point[], progress: number, loss: number) {
  const end = loss > 0.2 ? 1 - loss * 0.48 : 1;
  const fade = Math.max(0, Math.min(1, (end - progress) / 0.15));
  const drift = Math.max(0, (progress - 0.2) / 0.8) * loss * 0.2;
  return {
    end,
    fade,
    path: path.map((point, i) => ({
      ...point,
      x: Math.max(0, Math.min(1, point.x + Math.sin(i * 0.31) * drift)),
      y: Math.max(0, Math.min(1, point.y + Math.cos(i * 0.23) * drift)),
    })),
  };
}
