//! Anonymous tracking: turning a frame of detected regions into the room's
//! belief about who is standing in it.
//!
//! This is a port of `AnonymousTrackManager` from `lib/motion-tracker.ts`,
//! operation for operation, because every constant in it was set by a measured
//! failure in a real gallery rather than by taste. The comments that explain a
//! number are reproduced here for the same reason: a future reader who changes
//! `MIN_PERSON_SEPARATION` because it looks arbitrary is re-introducing the
//! session where 44 of 307 samples reported two people and there was one.
//!
//! **What is here and what is deliberately not.** The camera pipeline —
//! luminance, background model, thresholding, connected components, blob
//! merging — stays in TypeScript. It was measured at about 108 microseconds a
//! frame, and `ENGINEERING-STANDARDS.md` records that porting it would save a
//! fraction of a percent of one core in exchange for a marshalling boundary.
//! What crosses into Rust is the part that is *stateful and deterministic*:
//! association, confirmation, occlusion prediction, coalescing and expiry.
//! Those carry state between frames, which is exactly the code that is hard to
//! test in a browser and easy to test here.
//!
//! **Determinism.** No clock and no randomness. `now` arrives as an argument,
//! so a recorded session replays identically. Iteration order is insertion
//! order everywhere a JavaScript `Map` was insertion-ordered, because two of
//! the rules below — coalescing keeping the longer-standing identity, and the
//! order ended tracks are reported in — are decided by ties broken that way.

use crate::track_assignment::{self, ASSIGNMENT_CEILING};
use room_protocol::{Extent, Observation, Point, TRACK_PATH_MAX, TrackId, TrackPath, Vec2};

// ---------------------------------------------------------------------------
// Constants. Each mirrors the TypeScript export of the same name.
// ---------------------------------------------------------------------------

/// Sightings before a detection is treated as a person.
///
/// Without this, a one-frame fragment created a track instantly, and that track
/// then lingered for four seconds of occlusion prediction. A single visitor
/// produced a crowd of phantoms that took seconds to drain.
pub const TRACK_CONFIRM_SIGHTINGS: u32 = 2;

/// How long a confirmed person may be predicted through an occlusion.
pub const OCCLUSION_SECONDS: f64 = 4.0;

/// Two people cannot stand inside one body's width of each other.
///
/// Blob merging works on what a single frame detected. It cannot help when a
/// nearly-still visitor registers only in disconnected scraps — a hand here, a
/// shoulder there — that never touch. Those scraps become separate tracks, and
/// on a real session 44 of 307 samples reported two or more people at a median
/// coverage of 8%, which is one person barely moving. This is the backstop:
/// after association, tracks closer together than a body are the same body.
pub const MIN_PERSON_SEPARATION: f64 = 0.08;

/// Fraction of the wider detection two people must be apart by.
pub const SEPARATION_OF_BODY: f64 = 0.55;

/// Share of the smaller detection that may sit inside the larger one before the
/// two are judged to be the same body. Centroid distance alone misses this: a
/// scrap of movement can be well away from a body's centre while lying entirely
/// within its outline, which is what a moving hand looks like.
pub const SAME_BODY_OVERLAP: f64 = 0.3;

/// A detection at most this share of another's area may be a piece of it.
pub const FRAGMENT_AREA_RATIO: f64 = 0.35;

/// ...if it is also within this multiple of the larger region's longest side.
///
/// Frankly a heuristic about human proportions, not a principle. It holds
/// because a fragment is small and a person is not.
pub const FRAGMENT_REACH: f64 = 0.6;

/// Per-*second* retention while occluded.
///
/// These were per-frame constants, which makes a prediction behave completely
/// differently at 10 Hz and at 24 Hz: the same 0.84 confidence factor leaves
/// 17% after a second at the slower profile and 3% at the faster one. Occlusion
/// recovery must not depend on how fast the machine happens to be analysing.
pub const OCCLUDED_CONFIDENCE_RETENTION: f64 = 0.35;
/// Per-second velocity retention while occluded. See above.
pub const OCCLUDED_VELOCITY_RETENTION: f64 = 0.25;
/// Below this, a prediction is not worth holding on to.
pub const OCCLUDED_CONFIDENCE_FLOOR: f64 = 0.02;

/// How long a remembered outline stays evidence that a split is one body.
///
/// Fragment continuity delays distinguishing two people who separate out of a
/// merged silhouette by up to this long. That is the price of not reporting one
/// visitor as two every time their coat matches the wall.
pub const OUTLINE_MEMORY_MS: f64 = 750.0;

/// A piece must be this much smaller than the outline it is a piece of.
pub const OUTLINE_PIECE_AREA: f64 = 0.75;
/// ...and this much of it must lie inside that outline.
pub const OUTLINE_PIECE_CONTAINMENT: f64 = 0.9;
/// The pieces together must still span this share of the outline's area. A
/// small moving patch is not enough evidence to keep a whole body alive.
pub const OUTLINE_UNION_AREA: f64 = 0.5;

/// Association gate: the distance a blob may be from a track's predicted
/// position and still be that track, before any speed or occlusion allowance.
pub const ASSOCIATION_BASE_GATE: f64 = 0.13;
/// Extra reach granted in proportion to a track's smoothed speed, and its cap.
pub const ASSOCIATION_SPEED_REACH: f64 = 0.3;
/// Ceiling on the speed allowance, so a mis-measured velocity cannot let one
/// track claim the whole room.
pub const ASSOCIATION_SPEED_CAP: f64 = 0.14;
/// Extra reach per second of absence, for an occluded track only, and its cap.
pub const ASSOCIATION_OCCLUDED_REACH: f64 = 0.025;
/// Ceiling on the occlusion allowance.
pub const ASSOCIATION_OCCLUDED_CAP: f64 = 0.1;

/// Longest step a prediction may extrapolate over, in seconds.
///
/// Sensing runs between 10 and 24 Hz and occasionally stalls. Extrapolating a
/// velocity across a 3-second stall throws the prediction across the room; the
/// cap makes a stalled frame behave like a slow one rather than like a teleport.
const MAX_PREDICTION_STEP: f64 = 0.15;
/// The same cap on the occluded branch, which was a slightly different number
/// in the original and is kept different rather than quietly unified.
const MAX_OCCLUDED_STEP: f64 = 0.12;

/// Longest interval one observation may credit as dwell or stillness.
///
/// Numerically the same as [`MAX_PREDICTION_STEP`] and separate on purpose:
/// this one bounds how much *time in the room* a single frame can claim, so
/// that a stalled sensing loop cannot hand a visitor thirty seconds of standing
/// still they did not do. The two answer different questions and are free to
/// diverge.
const MAX_OBSERVED_INTERVAL: f64 = 0.15;

/// Floor on the interval used to differentiate position into a velocity.
/// Roughly one frame at 60 Hz; without it two observations in the same
/// millisecond produce an infinite speed.
const MIN_VELOCITY_INTERVAL: f64 = 0.016;

/// Smoothing on reported speed: this much of the previous estimate is kept.
const SPEED_SMOOTHING: f64 = 0.65;

/// Below this smoothed speed a visitor counts as standing still.
const STILLNESS_SPEED: f64 = 0.018;

/// Confidence a new track starts with, and what each sighting adds.
const INITIAL_CONFIDENCE: f64 = 0.65;
const CONFIDENCE_PER_SIGHTING: f64 = 0.16;

/// A path point is recorded when the visitor has moved this far, or when this
/// long has passed — so a person standing still still leaves a timestamped
/// path rather than a single point.
const PATH_POINT_DISTANCE: f64 = 0.008;
const PATH_POINT_INTERVAL_MS: f64 = 500.0;

const _: () = assert!(
    TRACK_PATH_MAX == 280,
    "the live path cap is part of the tracker's parity contract"
);

// ---------------------------------------------------------------------------
// Geometry shared with the sensing side.
// ---------------------------------------------------------------------------

/// An axis-aligned box in room coordinates, centred on `x`, `y`.
///
/// Both a detected region and a track's believed outline are one of these, and
/// the coalescing rules compare them to each other, so they need one type.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    #[must_use]
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    #[must_use]
    pub fn area(self) -> f64 {
        self.width * self.height
    }
}

impl From<Observation> for Rect {
    fn from(observation: Observation) -> Self {
        Self::new(
            observation.x,
            observation.y,
            observation.width,
            observation.height,
        )
    }
}

/// Share of the smaller box that lies inside the larger.
///
/// A positive overlap already proves both boxes have positive width and height:
/// `wide > 0` needs `min(right) > max(left)`, which a zero or negative width
/// makes impossible on either box. So neither area can be zero at the division,
/// and a guard for that would be a branch nothing can reach.
#[must_use]
pub fn box_overlap_ratio(first: Rect, second: Rect) -> f64 {
    let wide = (first.x + first.width / 2.0).min(second.x + second.width / 2.0)
        - (first.x - first.width / 2.0).max(second.x - second.width / 2.0);
    let tall = (first.y + first.height / 2.0).min(second.y + second.height / 2.0)
        - (first.y - first.height / 2.0).max(second.y - second.height / 2.0);
    if wide <= 0.0 || tall <= 0.0 {
        return 0.0;
    }
    (wide * tall) / first.area().min(second.area())
}

/// Is `small` plausibly a piece of `large` rather than someone else?
///
/// Overlap alone is not enough: a hand or a shoulder can register just outside
/// a torso's box while obviously belonging to the same body. Measured on a real
/// session, a single visitor at 13% coverage still produced three tracks this
/// way.
#[must_use]
pub fn is_fragment_of(small: Rect, large: Rect) -> bool {
    let small_area = small.area();
    let large_area = large.area();
    if large_area <= 0.0 || small_area > large_area * FRAGMENT_AREA_RATIO {
        return false;
    }
    let reach = large.width.max(large.height) * FRAGMENT_REACH;
    (small.x - large.x).hypot(small.y - large.y) <= reach
}

// ---------------------------------------------------------------------------
// A track.
// ---------------------------------------------------------------------------

/// One anonymous visitor, as the room currently believes them to be.
///
/// There is nothing identifying in here by construction: a position, a size, a
/// speed and a bounded path of where they have been in the last few minutes.
/// [`TrackId`] is not persistable, so none of this can become a durable fact
/// about a person — when they leave, the track ends and the id means nothing.
#[derive(Clone, Debug, PartialEq)]
pub struct Track {
    pub id: TrackId,
    pub born_at: f64,
    pub last_seen: f64,
    pub position: Point,
    pub previous: Point,
    pub velocity: Vec2,
    /// Smoothed, not instantaneous. See [`SPEED_SMOOTHING`].
    pub speed: f64,
    /// Seconds spent below [`STILLNESS_SPEED`], reset by any movement.
    pub still_for: f64,
    /// Seconds actually observed. Occluded time does not count: reacquisition
    /// must not bill an unseen interval as dwell.
    pub dwell_seconds: f64,
    pub path: TrackPath,
    /// Observed this frame.
    pub active: bool,
    /// Predicted rather than seen. Association state, not observed motion:
    /// occluded tracks are kept out of rendering and out of memory deposition.
    pub occluded: bool,
    pub confidence: f64,
    /// Frames this track has actually been seen. Below
    /// [`TRACK_CONFIRM_SIGHTINGS`] it is a candidate, not a person.
    pub sightings: u32,
    pub extent: Extent,
}

impl Track {
    /// The box this track currently believes it occupies.
    #[must_use]
    pub fn rect(&self) -> Rect {
        Rect::new(
            self.position.x,
            self.position.y,
            self.extent.width,
            self.extent.height,
        )
    }

    #[must_use]
    pub fn confirmed(&self) -> bool {
        self.sightings >= TRACK_CONFIRM_SIGHTINGS
    }

    fn new(id: TrackId, blob: Observation, now: f64) -> Self {
        let point = Point::new(blob.x, blob.y, now);
        let mut path = TrackPath::new();
        path.push(point);
        Self {
            id,
            born_at: now,
            last_seen: now,
            position: point,
            previous: point,
            velocity: Vec2::new(0.0, 0.0),
            speed: 0.0,
            still_for: 0.0,
            dwell_seconds: 0.0,
            path,
            active: true,
            occluded: false,
            confidence: INITIAL_CONFIDENCE,
            sightings: 1,
            extent: Extent {
                width: blob.width,
                height: blob.height,
            },
        }
    }

    /// Fold an observation into this track.
    ///
    /// The order matters and is load-bearing: `occluded` is read to decide
    /// whether this interval counts as dwell, and only then cleared. A track
    /// coming back from an occlusion is seen again at this instant; it was not
    /// *present* for the seconds it was missing.
    fn observe(&mut self, blob: Observation, now: f64) {
        let point = Point::new(blob.x, blob.y, now);
        let elapsed = ((now - self.last_seen) / 1000.0).max(MIN_VELOCITY_INTERVAL);
        let velocity = Vec2::new(
            (point.x - self.position.x) / elapsed,
            (point.y - self.position.y) / elapsed,
        );
        let instantaneous = velocity.length();
        let was_occluded = self.occluded;

        self.previous = self.position;
        self.position = point;
        self.velocity = velocity;
        self.speed = self.speed * SPEED_SMOOTHING + instantaneous * (1.0 - SPEED_SMOOTHING);

        let observed_elapsed = if was_occluded {
            0.0
        } else {
            elapsed.min(MAX_OBSERVED_INTERVAL)
        };
        self.still_for = if !was_occluded && self.speed < STILLNESS_SPEED {
            self.still_for + observed_elapsed
        } else {
            0.0
        };
        self.dwell_seconds += observed_elapsed;
        self.last_seen = now;
        self.active = true;
        self.occluded = false;
        self.confidence = (self.confidence + CONFIDENCE_PER_SIGHTING).min(1.0);
        self.sightings += 1;
        self.extent = Extent {
            width: blob.width,
            height: blob.height,
        };

        let record = match self.path.iter().next_back() {
            Some(last) => {
                (last.x - point.x).hypot(last.y - point.y) > PATH_POINT_DISTANCE
                    || now - last.t > PATH_POINT_INTERVAL_MS
            }
            // Unreachable: a track is born holding a point and `Bounded` never
            // empties itself. Recording rather than panicking is the behaviour
            // a gallery wants from an impossible case.
            None => true,
        };
        if record {
            self.path.push(point);
        }
    }

    /// Advance a confirmed but unseen track along its last known velocity.
    fn predict(&mut self, now: f64) {
        let step = ((now - self.position.t) / 1000.0).clamp(0.0, MAX_OCCLUDED_STEP);
        let velocity_decay = OCCLUDED_VELOCITY_RETENTION.powf(step);
        self.previous = self.position;
        self.position = Point::new(
            (self.position.x + self.velocity.x * step).clamp(0.0, 1.0),
            (self.position.y + self.velocity.y * step).clamp(0.0, 1.0),
            now,
        );
        self.velocity.x *= velocity_decay;
        self.velocity.y *= velocity_decay;
        self.speed *= velocity_decay;
        self.active = false;
        self.occluded = true;
        self.confidence *= OCCLUDED_CONFIDENCE_RETENTION.powf(step);
    }
}

// ---------------------------------------------------------------------------
// The manager.
// ---------------------------------------------------------------------------

/// What one frame of association did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TrackUpdate {
    /// Every track the room still holds, in the order it acquired them.
    pub active: Vec<Track>,
    /// Tracks that ended this frame, in the order they were acquired. A caller
    /// turns these into memories; nothing else may.
    pub ended: Vec<Track>,
}

/// A blob as it moves through one frame of association.
///
/// `raw` distinguishes a region the sensing side actually detected from the
/// union this code synthesises during fragment recovery. Only a real detection
/// may renew an outline; letting our own union do it would let the room hold a
/// body together out of its own memory of that body indefinitely.
#[derive(Clone, Copy, Debug)]
struct Candidate {
    blob: Observation,
    raw: bool,
}

/// What association claimed this frame.
struct Association {
    /// Ids observed, in the order they were matched.
    observed: Vec<TrackId>,
    /// One flag per candidate blob: did a track take it?
    claimed: Vec<bool>,
    /// Which candidate each observed or newly minted track received.
    ///
    /// Coalescing needs this evidence to distinguish two people who were both
    /// resolved this frame from one fragmented body plus an old prediction.
    /// Candidate indices stay inside this frame and are never persisted.
    blob_of_track: Vec<(TrackId, usize)>,
}

/// A recently observed silhouette, kept so that a body splitting into pieces
/// inside its own outline reads as one person rather than several.
#[derive(Clone, Copy, Debug)]
struct Outline {
    track: TrackId,
    blob: Observation,
    at: f64,
}

/// The room's belief about who is in it, advanced one frame at a time.
///
/// Holds no clock and no randomness: `update` is a pure function of its
/// arguments and the manager's own state, which is what makes an anonymous
/// recording replayable.
#[derive(Clone, Debug, Default)]
pub struct TrackManager {
    /// Insertion-ordered, standing in for the TypeScript `Map`. Coalescing ties
    /// and the order ended tracks are reported in both depend on this order.
    tracks: Vec<Track>,
    sequence: u32,
    fragment_recoveries: u64,
    outlines: Vec<Outline>,
}

impl TrackManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Cumulative count of times fragment continuity held a splitting body
    /// together. Reported to diagnostics as a number only: the outline geometry
    /// is never logged.
    #[must_use]
    pub const fn fragment_recoveries(&self) -> u64 {
        self.fragment_recoveries
    }

    #[must_use]
    pub fn tracks(&self) -> &[Track] {
        &self.tracks
    }

    /// Forget everyone. The id sequence deliberately keeps counting, so a track
    /// from before a reset can never be confused with one from after it.
    pub fn clear(&mut self) {
        self.fragment_recoveries = 0;
        self.tracks.clear();
        self.outlines.clear();
    }

    /// Advance the room's belief by one frame of detections.
    ///
    /// `now` is milliseconds on the shell's monotonic clock. The stages, in the
    /// order they must happen:
    ///
    /// 1. **Expire first.** A delayed frame must not revive an old identity; if
    ///    association ran first, a returning blob would bypass the four-second
    ///    expiry and the room would bill the unseen interval as dwell.
    /// 2. **Fragment continuity.** A split inside a recently observed outline
    ///    is initially evidence of the same body.
    /// 3. **Associate**, maximizing gated matches before minimizing distance.
    /// 4. **Mint** a track for every blob nobody claimed.
    /// 5. **Coalesce** tracks too close together to be different people.
    /// 6. **Predict or end** whatever was not seen.
    pub fn update(&mut self, blobs: &[Observation], now: f64) -> TrackUpdate {
        let mut ended = Vec::new();
        self.expire(now, &mut ended);
        let candidates = self.recover_fragments(blobs, now);
        self.bound_tracks(&mut ended);
        let Association {
            mut observed,
            claimed,
            mut blob_of_track,
        } = self.associate(&candidates, now);
        self.mint(&candidates, &claimed, now, &mut blob_of_track);
        self.coalesce(now, &mut observed, &blob_of_track);
        self.settle(now, &observed, &mut ended);
        TrackUpdate {
            active: self.tracks.clone(),
            ended,
        }
    }

    /// Stage 1. Anything unseen for longer than the occlusion budget is gone,
    /// whatever else this frame contains.
    fn expire(&mut self, now: f64, ended: &mut Vec<Track>) {
        let cutoff = OCCLUSION_SECONDS * 1000.0;
        let mut kept = Vec::with_capacity(self.tracks.len());
        for mut track in self.tracks.drain(..) {
            if now - track.last_seen > cutoff {
                track.active = false;
                ended.push(track);
            } else {
                kept.push(track);
            }
        }
        self.tracks = kept;
    }

    /// Keep association inside the same hard ceiling as the sensing input.
    ///
    /// Occlusion can retain confirmed tracks while new detections mint more,
    /// so a manager can momentarily hold more tracks than one frame can ever
    /// observe. The stalest are the least defensible beliefs; retire them in
    /// last-seen order, matching the TypeScript specification, rather than
    /// letting the assignment solver receive an out-of-contract matrix.
    fn bound_tracks(&mut self, ended: &mut Vec<Track>) {
        let excess = self.tracks.len().saturating_sub(ASSIGNMENT_CEILING);
        if excess == 0 {
            return;
        }
        let mut by_staleness: Vec<usize> = (0..self.tracks.len()).collect();
        by_staleness.sort_by(|&first, &second| {
            let left = self
                .tracks
                .get(first)
                .map_or(f64::INFINITY, |track| track.last_seen);
            let right = self
                .tracks
                .get(second)
                .map_or(f64::INFINITY, |track| track.last_seen);
            left.total_cmp(&right)
        });
        let dropped: Vec<usize> = by_staleness.into_iter().take(excess).collect();
        for &index in &dropped {
            if let Some(track) = self.tracks.get(index) {
                let mut retired = track.clone();
                retired.active = false;
                ended.push(retired);
            }
        }
        let mut index = 0_usize;
        self.tracks.retain(|_| {
            let keep = !dropped.contains(&index);
            index = index.saturating_add(1);
            keep
        });
    }

    /// Stage 2. Fragment continuity.
    ///
    /// For each remembered outline whose track is still here and still recent,
    /// find the detections that are small and lie almost entirely inside it. If
    /// there are at least two of them and together they still cover half the
    /// outline, replace them with their union: one body that split, not two
    /// people who appeared.
    fn recover_fragments(&mut self, blobs: &[Observation], now: f64) -> Vec<Candidate> {
        let mut candidates: Vec<Candidate> = blobs
            .iter()
            .map(|&blob| Candidate { blob, raw: true })
            .collect();

        let mut surviving = Vec::with_capacity(self.outlines.len());
        for outline in std::mem::take(&mut self.outlines) {
            let Some(track) = self.tracks.iter().find(|track| track.id == outline.track) else {
                continue;
            };
            if now - outline.at > OUTLINE_MEMORY_MS {
                continue;
            }
            surviving.push(outline);
            if !track.confirmed() {
                continue;
            }
            let anchor = Rect::from(outline.blob);
            let pieces: Vec<usize> = candidates
                .iter()
                .enumerate()
                .filter(|(_, candidate)| {
                    let piece = Rect::from(candidate.blob);
                    piece.area() < anchor.area() * OUTLINE_PIECE_AREA
                        && box_overlap_ratio(piece, anchor) >= OUTLINE_PIECE_CONTAINMENT
                })
                .map(|(index, _)| index)
                .collect();
            if pieces.len() < 2 {
                continue;
            }
            let Some(union) = union_of(&candidates, &pieces) else {
                continue;
            };
            if Rect::from(union).area() < anchor.area() * OUTLINE_UNION_AREA {
                continue;
            }
            candidates = candidates
                .iter()
                .enumerate()
                .filter(|(index, _)| !pieces.contains(index))
                .map(|(_, candidate)| *candidate)
                .chain(std::iter::once(Candidate {
                    blob: union,
                    raw: false,
                }))
                .collect();
            self.fragment_recoveries = self.fragment_recoveries.saturating_add(1);
        }
        self.outlines = surviving;
        candidates
    }

    /// Stage 3. Maximum-cardinality, minimum-distance gated association.
    ///
    /// Greedy nearest-first claiming can let a flexible track take the only
    /// blob available to another track, losing a visitor even though both can
    /// be matched. [`track_assignment::assign_tracks`] first maximizes the
    /// number of gated pairs, then minimizes their total distance, exactly as
    /// the TypeScript specification does.
    fn associate(&mut self, candidates: &[Candidate], now: f64) -> Association {
        let costs: Vec<Vec<f64>> = self
            .tracks
            .iter()
            .map(|track| {
                let elapsed = ((now - track.position.t) / 1000.0).clamp(0.0, MAX_PREDICTION_STEP);
                let missing_seconds = ((now - track.last_seen) / 1000.0).max(0.0);
                let predicted = Vec2::new(
                    track.position.x + track.velocity.x * elapsed,
                    track.position.y + track.velocity.y * elapsed,
                );
                let gate = ASSOCIATION_BASE_GATE
                    + (track.speed * ASSOCIATION_SPEED_REACH).min(ASSOCIATION_SPEED_CAP)
                    + if track.occluded {
                        (missing_seconds * ASSOCIATION_OCCLUDED_REACH).min(ASSOCIATION_OCCLUDED_CAP)
                    } else {
                        0.0
                    };
                candidates
                    .iter()
                    .map(|candidate| {
                        let distance =
                            (candidate.blob.x - predicted.x).hypot(candidate.blob.y - predicted.y);
                        if distance <= gate {
                            distance
                        } else {
                            f64::INFINITY
                        }
                    })
                    .collect()
            })
            .collect();
        let assignment = track_assignment::assign_tracks(&costs);

        let mut observed: Vec<TrackId> = Vec::new();
        let mut claimed = vec![false; candidates.len()];
        let mut blob_of_track = Vec::with_capacity(assignment.len());
        for matched in assignment {
            let (Some(track), Some(candidate)) = (
                self.tracks.get_mut(matched.track_index),
                candidates.get(matched.blob_index),
            ) else {
                continue;
            };
            if let Some(slot) = claimed.get_mut(matched.blob_index) {
                *slot = true;
            }
            track.observe(candidate.blob, now);
            let id = track.id;
            observed.push(id);
            blob_of_track.push((id, matched.blob_index));
            if candidate.raw {
                remember_outline(&mut self.outlines, id, candidate.blob, now);
            }
        }
        Association {
            observed,
            claimed,
            blob_of_track,
        }
    }

    /// Stage 4. Every blob nobody claimed is somebody the room has not met.
    fn mint(
        &mut self,
        candidates: &[Candidate],
        claimed: &[bool],
        now: f64,
        blob_of_track: &mut Vec<(TrackId, usize)>,
    ) {
        for (index, candidate) in candidates.iter().enumerate() {
            if claimed.get(index).copied().unwrap_or(true) {
                continue;
            }
            let id = TrackId(self.sequence);
            self.sequence = self.sequence.wrapping_add(1);
            if candidate.raw {
                remember_outline(&mut self.outlines, id, candidate.blob, now);
            }
            self.tracks.push(Track::new(id, candidate.blob, now));
            blob_of_track.push((id, index));
        }
    }

    /// Stage 5. Collapse tracks too close together to be different people.
    ///
    /// Newest first, so the survivor is the one with the longer history. Three
    /// tests, not one — centroid distance, box overlap and the fragment test —
    /// because a hand or shoulder can register just outside a torso's box while
    /// obviously belonging to it, and neither distance nor overlap catches that.
    fn coalesce(
        &mut self,
        now: f64,
        observed: &mut Vec<TrackId>,
        blob_of_track: &[(TrackId, usize)],
    ) {
        let mut by_age: Vec<usize> = (0..self.tracks.len()).collect();
        // Descending by birth, stable, so equally aged tracks keep acquisition
        // order and the survivor of a tie is deterministic.
        by_age.sort_by(|&first, &second| {
            let left = self
                .tracks
                .get(first)
                .map_or(f64::NAN, |track| track.born_at);
            let right = self
                .tracks
                .get(second)
                .map_or(f64::NAN, |track| track.born_at);
            right.total_cmp(&left)
        });
        let mut dropped = vec![false; self.tracks.len()];

        for &fresh in &by_age {
            if dropped.get(fresh).copied().unwrap_or(true) {
                continue;
            }
            for &established in &by_age {
                if established == fresh || dropped.get(established).copied().unwrap_or(true) {
                    continue;
                }
                let (Some(younger), Some(older)) =
                    (self.tracks.get(fresh), self.tracks.get(established))
                else {
                    continue;
                };
                if older.born_at > younger.born_at {
                    continue;
                }
                let younger_blob = blob_of_track
                    .iter()
                    .find_map(|(id, blob)| (*id == younger.id).then_some(*blob));
                let older_blob = blob_of_track
                    .iter()
                    .find_map(|(id, blob)| (*id == older.id).then_some(*blob));
                let both_freshly_distinct = younger_blob
                    .zip(older_blob)
                    .is_some_and(|(younger, older)| younger != older);
                let apart = (younger.position.x - older.position.x)
                    .hypot(younger.position.y - older.position.y);
                let bodies = younger.extent.width.max(older.extent.width);
                let too_close = !both_freshly_distinct
                    && apart <= MIN_PERSON_SEPARATION.max(bodies * SEPARATION_OF_BODY);
                let young_box = younger.rect();
                let old_box = older.rect();
                let inside = box_overlap_ratio(young_box, old_box) >= SAME_BODY_OVERLAP;
                let fragment =
                    is_fragment_of(young_box, old_box) || is_fragment_of(old_box, young_box);
                if !too_close && !inside && !fragment {
                    continue;
                }

                // Preserve today's observation when retaining yesterday's
                // identity. Otherwise a fresh body is discarded and the survivor
                // stays occluded — the September 14 defect where eleven samples
                // held blobs and showed no tracks.
                let transfer = younger.last_seen == now && older.last_seen != now;
                let carried = Observation {
                    x: younger.position.x,
                    y: younger.position.y,
                    width: younger.extent.width,
                    height: younger.extent.height,
                    energy: 1.0,
                };
                let sightings = younger.sightings;
                let confidence = younger.confidence;
                let Some(survivor) = self.tracks.get_mut(established) else {
                    continue;
                };
                if transfer {
                    survivor.observe(carried, now);
                    let id = survivor.id;
                    if !observed.contains(&id) {
                        observed.push(id);
                    }
                }
                survivor.sightings = survivor.sightings.max(sightings);
                survivor.confidence = survivor.confidence.max(confidence);
                if let Some(slot) = dropped.get_mut(fresh) {
                    *slot = true;
                }
                break;
            }
        }

        if dropped.iter().any(|&gone| gone) {
            let mut index = 0;
            self.tracks.retain(|_| {
                let keep = !dropped.get(index).copied().unwrap_or(false);
                index += 1;
                keep
            });
        }
    }

    /// Stage 6. Whatever was not observed is either predicted through an
    /// occlusion or declared gone.
    ///
    /// Only a confirmed person earns prediction. A candidate that vanishes was
    /// noise, and holding it for four seconds is what turned one visitor into a
    /// lingering crowd. A track born this instant is left alone: it has not had
    /// a chance to be seen twice yet.
    fn settle(&mut self, now: f64, observed: &[TrackId], ended: &mut Vec<Track>) {
        let mut kept = Vec::with_capacity(self.tracks.len());
        for mut track in self.tracks.drain(..) {
            if observed.contains(&track.id) || track.born_at == now {
                kept.push(track);
                continue;
            }
            let missing_seconds = (now - track.last_seen) / 1000.0;
            let worth_holding = track.confirmed()
                && missing_seconds <= OCCLUSION_SECONDS
                && track.confidence > OCCLUDED_CONFIDENCE_FLOOR;
            if worth_holding {
                track.predict(now);
                kept.push(track);
            } else {
                track.active = false;
                ended.push(track);
            }
        }
        self.tracks = kept;
    }
}

/// Insert or refresh an outline, keeping insertion order for an id already
/// present — the behaviour of `Map.prototype.set`, which the ordering of the
/// next frame's fragment recovery depends on.
fn remember_outline(outlines: &mut Vec<Outline>, track: TrackId, blob: Observation, at: f64) {
    if let Some(existing) = outlines.iter_mut().find(|outline| outline.track == track) {
        existing.blob = blob;
        existing.at = at;
    } else {
        outlines.push(Outline { track, blob, at });
    }
}

/// The bounding box of a set of pieces, with their energies summed and capped.
fn union_of(candidates: &[Candidate], pieces: &[usize]) -> Option<Observation> {
    let mut left = f64::INFINITY;
    let mut right = f64::NEG_INFINITY;
    let mut top = f64::INFINITY;
    let mut bottom = f64::NEG_INFINITY;
    let mut energy = 0.0;
    for &index in pieces {
        let blob = candidates.get(index)?.blob;
        left = left.min(blob.x - blob.width / 2.0);
        right = right.max(blob.x + blob.width / 2.0);
        top = top.min(blob.y - blob.height / 2.0);
        bottom = bottom.max(blob.y + blob.height / 2.0);
        energy += blob.energy;
    }
    Some(Observation {
        // `midpoint` rather than `(a + b) / 2.0`: identical for room
        // coordinates, and it stays identical if a future calibration ever puts
        // a coordinate near the end of the range.
        x: f64::midpoint(left, right),
        y: f64::midpoint(top, bottom),
        width: right - left,
        height: bottom - top,
        energy: energy.min(1.0),
    })
}

/// The tracks the artwork is allowed to see: confirmed people, currently
/// observed.
///
/// This is the single gate between sensing and the artwork. Occluded tracks are
/// association state and unconfirmed ones are candidates that may still turn
/// out to be noise; neither may reach the swarm, the memory field or the person
/// count.
#[must_use]
pub fn select_observed(tracks: &[Track]) -> Vec<&Track> {
    tracks
        .iter()
        .filter(|track| !track.occluded && track.confirmed())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        MIN_PERSON_SEPARATION, OCCLUSION_SECONDS, Rect, TRACK_CONFIRM_SIGHTINGS, Track,
        TrackManager, box_overlap_ratio, is_fragment_of, select_observed,
    };
    use room_protocol::{Observation, TRACK_PATH_MAX, TRACKS_MAX};

    /// A gallery-scale body: a narrow vertical column, as a standing person is.
    fn body(x: f64, y: f64) -> Observation {
        Observation {
            x,
            y,
            width: 0.09,
            height: 0.24,
            energy: 0.6,
        }
    }

    /// Walk a single visitor across the room at a fixed sensing rate.
    fn walk(
        manager: &mut TrackManager,
        from: f64,
        to: f64,
        frames: u32,
        hz: f64,
        start: f64,
    ) -> f64 {
        let interval = 1000.0 / hz;
        let mut now = start;
        for frame in 0..frames {
            let progress = f64::from(frame) / f64::from(frames.max(1));
            manager.update(&[body(from + (to - from) * progress, 0.5)], now);
            now += interval;
        }
        now
    }

    fn observed_count(manager: &TrackManager) -> usize {
        select_observed(manager.tracks()).len()
    }

    // -- association and confirmation ---------------------------------------

    #[test]
    fn one_visitor_walking_across_the_room_stays_one_person() {
        let mut manager = TrackManager::new();
        walk(&mut manager, 0.2, 0.8, 40, 20.0, 1000.0);
        assert_eq!(manager.tracks().len(), 1, "one body, one identity");
        assert_eq!(observed_count(&manager), 1);
        let track = &manager.tracks()[0];
        assert!(track.speed > 0.0, "a walk has a speed");
        assert!(
            track.dwell_seconds > 1.0,
            "and accumulates time in the room"
        );
        assert!(track.still_for == 0.0, "walking is not standing still");
    }

    /// Regression for the live parity failure found after optimal assignment
    /// was added: Rust still used the old greedy association and then treated
    /// pure proximity as proof that two freshly resolved bodies were one.
    #[test]
    fn two_freshly_resolved_visitors_survive_the_close_part_of_a_crossing() {
        let mut manager = TrackManager::new();
        for frame in 0..=121_u32 {
            let at = f64::from(frame);
            manager.update(
                &[
                    body((0.1 + at * 0.003).min(1.0), 0.5),
                    body((0.9 - at * 0.003).max(0.0), 0.52),
                ],
                at * 50.0,
            );
        }
        assert_eq!(
            manager.tracks().len(),
            2,
            "two distinct detections must not be coalesced by proximity alone"
        );
        assert_eq!(observed_count(&manager), 2);
    }

    #[test]
    fn a_detection_seen_once_is_a_candidate_and_not_a_person() {
        let mut manager = TrackManager::new();
        manager.update(&[body(0.3, 0.5)], 0.0);
        assert_eq!(manager.tracks().len(), 1, "the candidate is held");
        assert_eq!(
            observed_count(&manager),
            0,
            "but the artwork is not told about it"
        );
        manager.update(&[body(0.305, 0.5)], 50.0);
        assert_eq!(observed_count(&manager), 1, "twice seen is a person");
        assert!(manager.tracks()[0].sightings >= TRACK_CONFIRM_SIGHTINGS);
    }

    /// The defect this rule exists for: a one-frame fragment minted a track,
    /// which then earned four seconds of occlusion prediction, and one visitor
    /// became a lingering crowd.
    #[test]
    fn an_unconfirmed_candidate_that_vanishes_is_not_held_for_four_seconds() {
        let mut manager = TrackManager::new();
        manager.update(&[body(0.3, 0.5)], 0.0);
        let update = manager.update(&[], 50.0);
        assert!(manager.tracks().is_empty(), "noise is dropped immediately");
        assert_eq!(update.ended.len(), 1);
        assert!(!update.ended[0].active);
    }

    // -- occlusion ----------------------------------------------------------

    #[test]
    fn a_confirmed_visitor_is_predicted_through_an_occlusion_and_then_expires() {
        let mut manager = TrackManager::new();
        let mut now = walk(&mut manager, 0.3, 0.5, 12, 20.0, 0.0);
        assert_eq!(observed_count(&manager), 1);

        manager.update(&[], now + 50.0);
        assert_eq!(manager.tracks().len(), 1, "still believed in");
        assert!(manager.tracks()[0].occluded);
        assert_eq!(
            observed_count(&manager),
            0,
            "an occluded track is association state, not a visible person"
        );

        now += 50.0;
        let mut ended = Vec::new();
        for _ in 0..200 {
            now += 50.0;
            ended.extend(manager.update(&[], now).ended);
            if manager.tracks().is_empty() {
                break;
            }
        }
        assert!(manager.tracks().is_empty(), "the prediction does not last");
        assert_eq!(ended.len(), 1, "and the visitor is reported as ended once");
    }

    #[test]
    fn reacquisition_after_an_occlusion_does_not_bill_the_unseen_interval_as_dwell() {
        let mut manager = TrackManager::new();
        let now = walk(&mut manager, 0.4, 0.42, 10, 20.0, 0.0);
        let dwell_before = manager.tracks()[0].dwell_seconds;

        manager.update(&[], now + 50.0);
        manager.update(&[], now + 100.0);
        manager.update(&[body(0.425, 0.5)], now + 2_000.0);

        assert_eq!(manager.tracks().len(), 1, "the same person came back");
        let dwell_after = manager.tracks()[0].dwell_seconds;
        assert_eq!(
            dwell_after, dwell_before,
            "two seconds behind a pillar is not two seconds of dwell"
        );
    }

    /// A delayed frame must not revive an identity that has already expired.
    #[test]
    fn expiry_happens_before_association_so_a_stall_cannot_resurrect_anyone() {
        let mut manager = TrackManager::new();
        let now = walk(&mut manager, 0.4, 0.45, 10, 20.0, 0.0);
        let original = manager.tracks()[0].id;
        let update = manager.update(&[body(0.45, 0.5)], now + OCCLUSION_SECONDS * 1000.0 + 1.0);
        assert_eq!(update.ended.len(), 1);
        assert_eq!(update.ended[0].id, original);
        assert_eq!(manager.tracks().len(), 1);
        assert_ne!(
            manager.tracks()[0].id,
            original,
            "the returning blob is a new anonymous arrival, not the old one"
        );
    }

    // -- coalescing ---------------------------------------------------------

    #[test]
    fn two_scraps_of_one_still_visitor_do_not_become_two_people() {
        // Mirrors memory-engine.test.ts. Two separate scraps that are each
        // assigned a blob are left apart here on purpose (two real bodies can
        // stand within a body-width; see `coalesce`): blob merging upstream
        // joins scraps that close. What the tracker must catch is a scrap
        // lying within a body it already follows.
        let mut manager = TrackManager::new();
        let body = Observation {
            x: 0.5,
            y: 0.45,
            width: 0.16,
            height: 0.3,
            energy: 0.7,
        };
        let scrap = Observation {
            x: 0.55,
            y: 0.6,
            width: 0.05,
            height: 0.06,
            energy: 0.3,
        };
        for frame in 0..4 {
            manager.update(&[body], 1000.0 + f64::from(frame) * 50.0);
        }
        manager.update(&[body, scrap], 1250.0);
        manager.update(&[body, scrap], 1300.0);
        assert_eq!(
            manager.tracks().len(),
            1,
            "one person, however they fragment"
        );
    }

    #[test]
    fn two_people_standing_apart_stay_two_people() {
        let mut manager = TrackManager::new();
        for frame in 0..10 {
            let drift = f64::from(frame) * 0.002;
            manager.update(
                &[body(0.25 + drift, 0.5), body(0.72 - drift, 0.5)],
                f64::from(frame) * 50.0,
            );
        }
        assert_eq!(manager.tracks().len(), 2);
        assert_eq!(observed_count(&manager), 2);
    }

    /// The September 14 defect: coalescing discarded the fresh observation and
    /// left the surviving identity occluded, so blobs were present and no track
    /// was visible.
    #[test]
    fn a_merge_transfers_the_current_observation_to_the_surviving_identity() {
        let mut manager = TrackManager::new();
        // Establish an older identity, then stop feeding it.
        let mut now = walk(&mut manager, 0.5, 0.5, 6, 20.0, 0.0);
        let older = manager.tracks()[0].id;
        now += 1_500.0;
        manager.update(&[], now);
        assert!(
            manager.tracks()[0].occluded,
            "the older identity is coasting"
        );

        // A detection arrives just far enough away to mint its own track and
        // close enough to be the same body.
        now += 50.0;
        manager.update(&[body(0.5, 0.5)], now);
        assert_eq!(manager.tracks().len(), 1);
        let survivor = &manager.tracks()[0];
        assert_eq!(survivor.id, older, "the longer history survives");
        assert!(
            !survivor.occluded && survivor.active,
            "and it is holding today's observation, not yesterday's prediction"
        );
        assert_eq!(survivor.last_seen, now);
    }

    // -- fragment continuity ------------------------------------------------

    #[test]
    fn a_body_splitting_inside_its_own_outline_is_still_one_body() {
        let mut manager = TrackManager::new();
        let whole = Observation {
            x: 0.5,
            y: 0.5,
            width: 0.1,
            height: 0.3,
            energy: 0.7,
        };
        for frame in 0..4 {
            manager.update(&[whole], f64::from(frame) * 50.0);
        }
        assert_eq!(manager.tracks().len(), 1);
        let before = manager.fragment_recoveries();

        // Head and legs, both well inside the previous outline, torso lost to a
        // coat that matches the wall.
        let head = Observation {
            x: 0.5,
            y: 0.41,
            width: 0.07,
            height: 0.09,
            energy: 0.3,
        };
        let legs = Observation {
            x: 0.5,
            y: 0.59,
            width: 0.08,
            height: 0.1,
            energy: 0.3,
        };
        manager.update(&[head, legs], 200.0);
        assert_eq!(manager.tracks().len(), 1, "one person, split in two pieces");
        assert!(
            manager.fragment_recoveries() > before,
            "and the room says so, as a count and nothing else"
        );
    }

    #[test]
    fn fragment_continuity_expires_so_two_people_can_separate() {
        let mut manager = TrackManager::new();
        let whole = Observation {
            x: 0.5,
            y: 0.5,
            width: 0.22,
            height: 0.3,
            energy: 0.8,
        };
        for frame in 0..4 {
            manager.update(&[whole], f64::from(frame) * 50.0);
        }
        // They walk apart. Once outside the remembered outline, and once it has
        // aged out, they are two.
        let mut now = 200.0;
        for step in 0..40 {
            let apart = 0.06 + f64::from(step) * 0.01;
            manager.update(&[body(0.5 - apart, 0.5), body(0.5 + apart, 0.5)], now);
            now += 50.0;
        }
        assert_eq!(manager.tracks().len(), 2, "they did eventually separate");
    }

    // -- bounds -------------------------------------------------------------

    #[test]
    fn a_live_path_cannot_grow_without_limit() {
        let mut manager = TrackManager::new();
        let mut now = 0.0;
        for frame in 0..2_000 {
            let x = 0.2 + 0.6 * (f64::from(frame) * 0.05).sin().abs();
            manager.update(&[body(x, 0.5)], now);
            now += 50.0;
        }
        assert_eq!(manager.tracks().len(), 1);
        assert!(manager.tracks()[0].path.len() <= TRACK_PATH_MAX);
    }

    #[test]
    fn nothing_the_sensing_side_can_send_makes_the_room_hold_more_tracks_than_its_bound() {
        let mut manager = TrackManager::new();
        let mut now = 0.0;
        for frame in 0..500 {
            // A frame of well-separated bodies at the sensing side's own cap.
            let crowd: Vec<Observation> = (0..TRACKS_MAX)
                .map(|i| {
                    #[allow(clippy::cast_precision_loss)]
                    let lane = i as f64;
                    Observation {
                        x: 0.04 + lane * 0.08,
                        y: 0.2 + (f64::from(frame) * 0.1 + lane).sin() * 0.05,
                        width: 0.05,
                        height: 0.12,
                        energy: 0.5,
                    }
                })
                .collect();
            manager.update(&crowd, now);
            now += 50.0;
            assert!(
                manager.tracks().len() <= TRACKS_MAX,
                "held {} tracks",
                manager.tracks().len()
            );
        }
    }

    /// Twelve virtual hours of arrivals and departures, checking that nothing
    /// accumulates. This is the property the gallery actually depends on.
    #[test]
    fn a_twelve_hour_day_of_visitors_leaves_nothing_behind() {
        let mut manager = TrackManager::new();
        let mut now = 0.0;
        let mut ended = 0_u64;
        for minute in 0..720 {
            let busy = minute % 7 != 0;
            for frame in 0..120 {
                let crowd: Vec<Observation> = if busy {
                    (0..3)
                        .map(|i| {
                            body(
                                0.2 + f64::from(i) * 0.3
                                    + (f64::from(frame) * 0.02 + f64::from(i)).sin() * 0.05,
                                0.5,
                            )
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                ended += manager.update(&crowd, now).ended.len() as u64;
                now += 500.0;
            }
        }
        assert!(ended > 0, "visitors came and went");
        assert!(manager.tracks().len() <= TRACKS_MAX);
        manager.update(&[], now + OCCLUSION_SECONDS * 2_000.0);
        manager.update(&[], now + OCCLUSION_SECONDS * 4_000.0);
        assert!(manager.tracks().is_empty(), "the room empties out");
    }

    #[test]
    fn the_same_inputs_produce_the_same_room() {
        let script: Vec<Vec<Observation>> = (0..400)
            .map(|frame| {
                (0..2)
                    .map(|i| {
                        body(
                            0.25 + f64::from(i) * 0.4
                                + (f64::from(frame) * 0.03 + f64::from(i) * 2.0).sin() * 0.08,
                            0.4 + f64::from(i) * 0.1,
                        )
                    })
                    .collect()
            })
            .collect();
        let run = |script: &[Vec<Observation>]| {
            let mut manager = TrackManager::new();
            let mut log = Vec::new();
            for (frame, blobs) in script.iter().enumerate() {
                #[allow(clippy::cast_precision_loss)]
                let now = frame as f64 * 50.0;
                let update = manager.update(blobs, now);
                log.push((update.active, update.ended));
            }
            log
        };
        assert_eq!(run(&script), run(&script));
    }

    // -- geometry -----------------------------------------------------------

    #[test]
    fn overlap_is_measured_against_the_smaller_box() {
        let large = Rect::new(0.5, 0.5, 0.2, 0.4);
        let small = Rect::new(0.5, 0.5, 0.05, 0.05);
        // Full containment, to within the rounding of four coordinate
        // subtractions. The TypeScript original has the same residue, and every
        // caller compares the ratio against a threshold below one.
        assert!(
            (box_overlap_ratio(small, large) - 1.0).abs() < 1e-12,
            "a hand entirely inside a torso is entirely inside it"
        );
        assert_eq!(
            box_overlap_ratio(Rect::new(0.1, 0.1, 0.05, 0.05), large),
            0.0,
            "and boxes that miss do not overlap at all"
        );
    }

    #[test]
    fn a_fragment_is_small_and_near_and_a_person_is_neither() {
        let torso = Rect::new(0.5, 0.5, 0.12, 0.3);
        assert!(is_fragment_of(Rect::new(0.56, 0.45, 0.04, 0.05), torso));
        assert!(
            !is_fragment_of(Rect::new(0.9, 0.5, 0.04, 0.05), torso),
            "far away is somebody else's hand"
        );
        assert!(
            !is_fragment_of(Rect::new(0.55, 0.5, 0.11, 0.28), torso),
            "and a whole person is not a piece of one"
        );
    }

    #[test]
    fn clearing_the_room_keeps_ids_from_being_reused() {
        let mut manager = TrackManager::new();
        walk(&mut manager, 0.3, 0.4, 5, 20.0, 0.0);
        let first = manager.tracks()[0].id;
        manager.clear();
        assert!(manager.tracks().is_empty());
        assert_eq!(manager.fragment_recoveries(), 0);
        manager.update(&[body(0.3, 0.5)], 10_000.0);
        assert_ne!(
            manager.tracks()[0].id,
            first,
            "a track from before a reset can never be confused with one after"
        );
    }

    #[test]
    fn only_confirmed_and_currently_observed_tracks_reach_the_artwork() {
        let tracks: Vec<Track> = Vec::new();
        assert!(select_observed(&tracks).is_empty());

        let mut manager = TrackManager::new();
        manager.update(&[body(0.3, 0.5), body(0.7, 0.5)], 0.0);
        manager.update(&[body(0.3, 0.5)], 50.0);
        // One confirmed and seen, one unconfirmed and gone.
        assert_eq!(observed_count(&manager), 1);
    }

    #[test]
    fn a_visitor_standing_still_accumulates_stillness_and_a_walker_does_not() {
        let mut manager = TrackManager::new();
        let mut now = 0.0;
        for _ in 0..80 {
            manager.update(&[body(0.5, 0.5)], now);
            now += 50.0;
        }
        assert!(
            manager.tracks()[0].still_for > 2.0,
            "standing in one place is standing still"
        );
        assert!(manager.tracks()[0].dwell_seconds > 2.0);

        let mut walker = TrackManager::new();
        walk(&mut walker, 0.1, 0.9, 80, 20.0, 0.0);
        assert_eq!(walker.tracks()[0].still_for, 0.0);
    }

    #[test]
    fn two_bodies_closer_than_one_body_width_are_one_body() {
        let mut manager = TrackManager::new();
        let gap = MIN_PERSON_SEPARATION / 2.0;
        for frame in 0..8 {
            manager.update(
                &[body(0.5 - gap / 2.0, 0.5), body(0.5 + gap / 2.0, 0.5)],
                f64::from(frame) * 50.0,
            );
        }
        assert_eq!(manager.tracks().len(), 1);
    }
}
