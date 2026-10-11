//! Whether a visitor's body is physically crossing a stored memory's path —
//! not merely standing near it — and what a memory disturbed that way looks
//! like as it decays.
//!
//! A port of `lib/memory-disturbance.ts`, which remains authoritative in the
//! gallery until this agrees with it. Nothing here draws: everything is
//! geometry and decay arithmetic, deterministic given tracks, ghosts and the
//! clock.
//!
//! # Coordinates
//!
//! [`MemoryCollisions::find`] takes a projection closure exactly as the
//! TypeScript does, rather than baking in a particular calibration: a stored
//! ghost's path is already in room space (it was captured there when the
//! ghost was made), but a live track's position is camera space and has to be
//! mapped before it can be compared. The caller supplies that mapping; this
//! module does not know it exists.
//!
//! # Why `HashMap` here, unlike `attention.rs`
//!
//! `attention.rs` avoids `HashMap` because it keeps an eviction order a tie
//! depends on. Nothing here does: `anchors` and `recalled` are read only by
//! keyed lookup, and the only time either is walked is to prune entries whose
//! track or memory no longer exists, which is a set difference — the order
//! visited cannot change which entries survive it. A `HashMap`'s
//! unspecified iteration order is therefore not a determinism risk here.

use std::collections::HashMap;

use room_protocol::{Ghost, MemoryId, Point, TrackId, Vec2};

use crate::tracking::Track;

/// How long the room waits before any crossing may disturb it again. Twelve
/// simulated hours against a churning 120-path archive produced one
/// disturbance every 20.8s under a former 20s wait — with an 11s
/// presentation that put a corrupted memory on screen roughly half the time,
/// which reads as a metronome rather than as something the visitor
/// accidentally caused.
pub const CROSSING_COOLDOWN_MS: f64 = 240_000.0;

/// How long one memory rests before it may be disturbed again. Kept above
/// [`CROSSING_COOLDOWN_MS`]: below it the global wait alone decides what
/// wakes, and this gate never binds, so a visitor could be shown the same
/// path repeatedly.
pub const MEMORY_REST_MS: f64 = 900_000.0;

/// Younger than this a path is still the present, and recalling it is an echo.
pub const MEMORY_RIPENS_MS: f64 = 25_000.0;

const _: () = assert!(MEMORY_REST_MS > CROSSING_COOLDOWN_MS);

/// Point-to-segment distance, clamped to the segment.
fn distance_to_segment(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let denom = dx * dx + dy * dy;
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / if denom == 0.0 { 1.0 } else { denom })
        .clamp(0.0, 1.0);
    (p.x - a.x - t * dx).hypot(p.y - a.y - t * dy)
}

/// Whether segment `a`-`b` actually crosses segment `c`-`d`.
fn crossed(a: Vec2, b: Vec2, c: Vec2, d: Vec2) -> bool {
    let side = |p: Vec2, q: Vec2, r: Vec2| (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    side(a, b, c) * side(a, b, d) < 0.0 && side(c, d, a) * side(c, d, b) < 0.0
}

/// A live crossing: which ghost, where it was struck, at which path segment,
/// and by which track. The ghost is named by its index into the caller's
/// slice rather than cloned, matching [`crate::memory::choose_rare`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Collision {
    pub ghost_index: usize,
    pub at: Vec2,
    pub segment_index: usize,
    pub track_id: TrackId,
}

/// A crossing, not merely standing near history. Coordinates handed to
/// [`MemoryCollisions::find`] are camera space; its `project` argument lands
/// them in the room space stored ghost paths already live in.
#[derive(Debug, Default)]
pub struct MemoryCollisions {
    next_at: f64,
    recalled: HashMap<MemoryId, f64>,
    anchors: HashMap<TrackId, Point>,
}

impl MemoryCollisions {
    #[must_use]
    pub fn find(
        &mut self,
        tracks: &[Track],
        ghosts: &[Ghost],
        now: f64,
        project: impl Fn(Point) -> Vec2,
    ) -> Option<Collision> {
        let live: std::collections::HashSet<TrackId> = tracks
            .iter()
            .filter(|track| !track.occluded)
            .map(|track| track.id)
            .collect();
        self.anchors.retain(|id, _| live.contains(id));
        let archived: std::collections::HashSet<&MemoryId> =
            ghosts.iter().map(|ghost| &ghost.id).collect();
        self.recalled.retain(|id, _| archived.contains(id));

        if now < self.next_at {
            return None;
        }

        for track in tracks {
            if track.occluded || track.sightings < 2 {
                continue;
            }
            let anchor = self
                .anchors
                .get(&track.id)
                .copied()
                .unwrap_or(track.previous);
            let from = project(anchor);
            let to = project(track.position);
            let radius = projected_body_radius(track, &project);
            self.anchors.insert(track.id, anchor);

            // Accumulate sub-threshold steps: a slower sensing loop must not
            // make the same walk more likely to count. The fraction rejects
            // centroid jitter.
            let movement = (to.x - from.x).hypot(to.y - from.y);
            if movement == 0.0 || movement < radius / 20.0 {
                continue;
            }
            self.anchors.remove(&track.id);

            for (ghost_index, ghost) in ghosts.iter().enumerate() {
                if now - ghost.created_at < MEMORY_RIPENS_MS {
                    continue;
                }
                let last = self
                    .recalled
                    .get(&ghost.id)
                    .copied()
                    .unwrap_or(f64::NEG_INFINITY);
                if now - last < MEMORY_REST_MS {
                    continue;
                }
                let segments = ghost.path.iter().zip(ghost.path.iter().skip(1)).enumerate();
                for (segment_index, (a, b)) in segments {
                    let a = Vec2::new(a.x, a.y);
                    let b = Vec2::new(b.x, b.y);
                    let enters = distance_to_segment(from, a, b) > radius
                        && distance_to_segment(to, a, b) <= radius;
                    if !enters && !crossed(from, to, a, b) {
                        continue;
                    }
                    self.next_at = now + CROSSING_COOLDOWN_MS;
                    self.recalled.insert(ghost.id.clone(), now);
                    return Some(Collision {
                        ghost_index,
                        at: to,
                        segment_index,
                        track_id: track.id,
                    });
                }
            }
        }
        None
    }

    /// Cooldowns held for memories still in the archive; bounded by it, never
    /// by time.
    #[must_use]
    pub fn tracked(&self) -> usize {
        self.recalled.len()
    }

    pub fn clear(&mut self) {
        self.next_at = 0.0;
        self.recalled.clear();
        self.anchors.clear();
    }
}

/// Local body footprint after projection, including unequal axis scaling.
/// Without usable extent evidence only an actual segment crossing qualifies.
#[must_use]
pub fn projected_body_radius(track: &Track, project: impl Fn(Point) -> Vec2) -> f64 {
    let extent = track.extent;
    if !extent.width.is_finite()
        || !extent.height.is_finite()
        || extent.width <= 0.0
        || extent.height <= 0.0
    {
        return 0.0;
    }
    let center = project(track.position);
    let edges = [
        Point::new(
            track.position.x + extent.width / 2.0,
            track.position.y,
            track.position.t,
        ),
        Point::new(
            track.position.x - extent.width / 2.0,
            track.position.y,
            track.position.t,
        ),
        Point::new(
            track.position.x,
            track.position.y + extent.height / 2.0,
            track.position.t,
        ),
        Point::new(
            track.position.x,
            track.position.y - extent.height / 2.0,
            track.position.t,
        ),
    ]
    .map(project);
    let radius = edges
        .iter()
        .map(|edge| (edge.x - center.x).hypot(edge.y - center.y))
        .fold(f64::INFINITY, f64::min);
    if radius.is_finite() { radius } else { 0.0 }
}

#[must_use]
pub fn memory_loss(created_at: f64, fidelity: f64, now: f64) -> f64 {
    let age = (now - created_at - 5.0 * 60_000.0).max(0.0) / (6.0 * 3_600_000.0);
    age.max(1.0 - fidelity).clamp(0.0, 1.0)
}

/// What a disturbed recall looks like this frame. Shared by both renderers;
/// never alters the archive.
#[derive(Clone, Debug, PartialEq)]
pub struct DisturbanceFrame {
    pub end: f64,
    pub fade: f64,
    pub path: Vec<Point>,
}

#[must_use]
pub fn disturbance_frame(path: &[Point], progress: f64, loss: f64) -> DisturbanceFrame {
    let end = if loss > 0.2 { 1.0 - loss * 0.48 } else { 1.0 };
    let fade = ((end - progress) / 0.15).clamp(0.0, 1.0);
    let drift = ((progress - 0.2) / 0.8).max(0.0) * loss * 0.2;
    let jittered = path
        .iter()
        .enumerate()
        .map(|(i, point)| {
            #[allow(clippy::cast_precision_loss)]
            let i = i as f64;
            Point::new(
                (point.x + (i * 0.31).sin() * drift).clamp(0.0, 1.0),
                (point.y + (i * 0.23).cos() * drift).clamp(0.0, 1.0),
                point.t,
            )
        })
        .collect();
    DisturbanceFrame {
        end,
        fade,
        path: jittered,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CROSSING_COOLDOWN_MS, Collision, MEMORY_REST_MS, MEMORY_RIPENS_MS, MemoryCollisions,
        disturbance_frame, memory_loss, projected_body_radius,
    };
    use room_protocol::{
        Extent, Ghost, Lineage, MemoryId, PathPoints, Point, TrackId, TrackPath, Vec2,
    };

    use crate::tracking::Track;

    fn ghost_at(id: &str, created_at: f64, points: &[(f64, f64)]) -> Ghost {
        let mut path = PathPoints::new();
        for (i, &(x, y)) in points.iter().enumerate() {
            #[allow(clippy::cast_precision_loss)]
            path.push(Point::new(x, y, i as f64 * 100.0));
        }
        Ghost {
            id: MemoryId::new(id).expect("test id fits"),
            created_at,
            last_replayed_at: 0.0,
            path,
            dwell_seconds: 4.0,
            intensity: 0.5,
            strength: 0.5,
            fidelity: 1.0,
            recall_count: 0,
            lineage: Lineage::new(),
            false_memory: false,
            day: 1,
        }
    }

    /// A confirmed, unoccluded track that just moved from `from` to `to`,
    /// with a body wide enough for `projected_body_radius` to return
    /// something nonzero. Built directly rather than driven through
    /// `TrackManager`: `MemoryCollisions` consumes track *state*, and its
    /// tests should not also depend on association tuning that belongs to a
    /// different module's tests.
    fn track_at(from: (f64, f64), to: (f64, f64), now: f64) -> Track {
        Track {
            id: TrackId(1),
            born_at: 0.0,
            last_seen: now,
            position: Point::new(to.0, to.1, now),
            previous: Point::new(from.0, from.1, now - 200.0),
            velocity: Vec2::new(0.0, 0.0),
            speed: 0.0,
            still_for: 0.0,
            dwell_seconds: 0.0,
            path: TrackPath::new(),
            active: true,
            occluded: false,
            confidence: 1.0,
            sightings: 5,
            extent: Extent {
                width: 0.1,
                height: 0.24,
            },
        }
    }

    /// Identity projection: room space equals camera space. Enough to test
    /// the geometry without depending on unported calibration.
    fn identity(point: Point) -> Vec2 {
        Vec2::new(point.x, point.y)
    }

    #[test]
    fn a_straight_walk_through_a_stored_path_is_a_crossing() {
        let ghosts = vec![ghost_at("g-1", 0.0, &[(0.5, 0.0), (0.5, 1.0)])];
        let now = MEMORY_RIPENS_MS * 4.0;
        let tracks = vec![track_at((0.4, 0.5), (0.6, 0.5), now)];
        let mut collisions = MemoryCollisions::default();
        let hit = collisions.find(&tracks, &ghosts, now, identity);
        assert!(matches!(hit, Some(Collision { ghost_index: 0, .. })));
    }

    #[test]
    fn a_walk_nowhere_near_any_path_does_not_cross() {
        let ghosts = vec![ghost_at("g-1", 0.0, &[(0.9, 0.9), (0.95, 0.95)])];
        let now = MEMORY_RIPENS_MS * 4.0;
        let tracks = vec![track_at((0.0, 0.1), (0.1, 0.1), now)];
        let mut collisions = MemoryCollisions::default();
        assert!(collisions.find(&tracks, &ghosts, now, identity).is_none());
    }

    #[test]
    fn a_second_crossing_is_blocked_by_the_global_cooldown() {
        let ghosts = vec![
            ghost_at("g-1", 0.0, &[(0.5, 0.0), (0.5, 1.0)]),
            ghost_at("g-2", 0.0, &[(0.0, 0.5), (1.0, 0.5)]),
        ];
        let now = MEMORY_RIPENS_MS * 4.0;
        // Diagonal, not horizontal: a horizontal walk would lie exactly along
        // g-2's own path rather than crossing it transversally.
        let tracks = vec![track_at((0.4, 0.4), (0.6, 0.6), now)];
        let mut collisions = MemoryCollisions::default();
        let first = collisions.find(&tracks, &ghosts, now, identity);
        assert!(first.is_some());
        // Immediately after, well inside the cooldown: nothing fires, even
        // though the same track is still crossing g-2's path too.
        let second = collisions.find(&tracks, &ghosts, now + 1.0, identity);
        assert!(second.is_none());
        // Once the cooldown has elapsed, a crossing can fire again.
        let third = collisions.find(&tracks, &ghosts, now + CROSSING_COOLDOWN_MS + 1.0, identity);
        assert!(third.is_some());
    }

    #[test]
    fn a_memory_still_resting_is_not_crossed_even_once_the_global_cooldown_clears() {
        let ghosts = vec![ghost_at("g-1", 0.0, &[(0.5, 0.0), (0.5, 1.0)])];
        let now = MEMORY_RIPENS_MS * 4.0;
        let tracks = vec![track_at((0.4, 0.5), (0.6, 0.5), now)];
        let mut collisions = MemoryCollisions::default();
        assert!(collisions.find(&tracks, &ghosts, now, identity).is_some());
        // Past the global cooldown, short of the memory's own rest.
        let retry = now + CROSSING_COOLDOWN_MS + 1.0;
        assert!(retry - now < MEMORY_REST_MS);
        assert!(collisions.find(&tracks, &ghosts, retry, identity).is_none());
    }

    #[test]
    fn a_memory_younger_than_it_can_ripen_is_never_crossed() {
        let ghosts = vec![ghost_at("g-1", 1_000.0, &[(0.5, 0.0), (0.5, 1.0)])];
        let now = 1_000.0 + MEMORY_RIPENS_MS - 1.0;
        let tracks = vec![track_at((0.4, 0.5), (0.6, 0.5), now)];
        let mut collisions = MemoryCollisions::default();
        assert!(collisions.find(&tracks, &ghosts, now, identity).is_none());
    }

    #[test]
    fn an_occluded_or_unconfirmed_track_cannot_cross_anything() {
        let ghosts = vec![ghost_at("g-1", 0.0, &[(0.5, 0.0), (0.5, 1.0)])];
        let now = MEMORY_RIPENS_MS * 4.0;
        let mut occluded = track_at((0.4, 0.5), (0.6, 0.5), now);
        occluded.occluded = true;
        let mut unconfirmed = track_at((0.4, 0.5), (0.6, 0.5), now);
        unconfirmed.id = TrackId(2);
        unconfirmed.sightings = 1;
        let tracks = vec![occluded, unconfirmed];
        let mut collisions = MemoryCollisions::default();
        assert!(collisions.find(&tracks, &ghosts, now, identity).is_none());
    }

    #[test]
    fn clearing_forgets_every_cooldown_and_anchor() {
        let ghosts = vec![ghost_at("g-1", 0.0, &[(0.5, 0.0), (0.5, 1.0)])];
        let now = MEMORY_RIPENS_MS * 4.0;
        let tracks = vec![track_at((0.4, 0.5), (0.6, 0.5), now)];
        let mut collisions = MemoryCollisions::default();
        assert!(collisions.find(&tracks, &ghosts, now, identity).is_some());
        assert_eq!(collisions.tracked(), 1);
        collisions.clear();
        assert_eq!(collisions.tracked(), 0);
        // With every cooldown gone, the same crossing can fire immediately.
        assert!(collisions.find(&tracks, &ghosts, now, identity).is_some());
    }

    #[test]
    fn a_cooldown_is_pruned_once_its_memory_leaves_the_archive() {
        let ghosts = vec![ghost_at("g-1", 0.0, &[(0.5, 0.0), (0.5, 1.0)])];
        let now = MEMORY_RIPENS_MS * 4.0;
        let tracks = vec![track_at((0.4, 0.5), (0.6, 0.5), now)];
        let mut collisions = MemoryCollisions::default();
        assert!(collisions.find(&tracks, &ghosts, now, identity).is_some());
        assert_eq!(collisions.tracked(), 1);
        // The archive no longer holds g-1; its cooldown is pruned on the next call.
        assert!(collisions.find(&tracks, &[], now + 1.0, identity).is_none());
        assert_eq!(collisions.tracked(), 0);
    }

    #[test]
    fn a_track_with_no_usable_extent_has_zero_radius() {
        let mut track = track_at((0.4, 0.5), (0.6, 0.5), 200.0);
        track.extent = Extent {
            width: 0.0,
            height: 0.0,
        };
        assert_eq!(projected_body_radius(&track, identity), 0.0);
    }

    #[test]
    fn memory_loss_ramps_over_six_hours_after_a_five_minute_grace_period() {
        let created_at = 0.0;
        let fidelity = 1.0;
        assert_eq!(memory_loss(created_at, fidelity, 4.0 * 60_000.0), 0.0);
        let at_ramp_end = 5.0 * 60_000.0 + 6.0 * 3_600_000.0;
        assert!((memory_loss(created_at, fidelity, at_ramp_end) - 1.0).abs() < 1e-9);
        let low_fidelity_from_the_start = memory_loss(0.0, 0.1, 0.0);
        assert!((low_fidelity_from_the_start - 0.9).abs() < 1e-9);
    }

    #[test]
    fn a_fresh_memory_holds_its_shape_and_an_old_one_drifts() {
        let path = vec![
            Point::new(0.2, 0.2, 0.0),
            Point::new(0.5, 0.5, 100.0),
            Point::new(0.8, 0.2, 200.0),
        ];
        let fresh = disturbance_frame(&path, 0.5, 0.0);
        assert_eq!(fresh.path, path);
        let old = disturbance_frame(&path, 0.5, 0.9);
        assert_ne!(old.path, path);
        assert!(old.fade <= 1.0 && old.fade >= 0.0);
    }
}
