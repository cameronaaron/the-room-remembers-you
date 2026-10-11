//! The tracker's boundary: one call in, one flat buffer out.
//!
//! [`TrackManager`] is the room's belief about who is present; this module is
//! the only thing that knows how that belief is packed for a caller in another
//! language. Keeping the two apart means the association rules are testable as
//! Rust values and the marshalling is testable as bytes, rather than both being
//! testable only through a browser.
//!
//! # Shape of the boundary
//!
//! One coarse call per sensing frame, which at 10-24 Hz is between ten and
//! twenty-four crossings a second in total — not one per track, and certainly
//! not one per path point. Input and output are each a single `f64` array, so
//! the whole exchange is two copies and no object graph.
//!
//! # Ownership
//!
//! Neither side holds a view into the other's memory. The input slice is read
//! and finished with before this function returns; the output is a freshly
//! allocated `Vec<f64>` that becomes the caller's, which is what makes it safe
//! against WASM memory growth. A JavaScript caller that keeps a returned array
//! across later calls keeps a valid array, because it never aliased the WASM
//! heap in the first place. This costs a copy per frame and is measured in
//! `reports/v2/tracking-parity.json` rather than assumed to be free.
//!
//! # Input layout
//!
//! `blobs` is a flat array of [`BLOB_STRIDE`] values per detected region:
//!
//! | offset | meaning                              |
//! | ------ | ------------------------------------ |
//! | 0      | centroid x, 0..1 across the room      |
//! | 1      | centroid y, 0..1 down the room        |
//! | 2      | width in room units, 0..1             |
//! | 3      | height in room units, 0..1            |
//! | 4      | share of the region that changed, 0..1 |
//!
//! # Output layout
//!
//! ```text
//! [0] active track count
//! [1] ended track count
//! [2] cumulative fragment recoveries
//! then `active` records, then `ended` records
//! ```
//!
//! Each record is [`RECORD_FIELDS`] fixed values followed by `path length`
//! triples of `(x, y, t)`. The field order is given by [`Field`], which is the
//! single definition both sides read; the TypeScript decoder is generated from
//! the same table in `lib/track-bridge.ts`.

use room_protocol::{Observation, TRACKS_MAX};

use crate::tracking::{Track, TrackManager};

/// Values per detected region in the input array.
pub const BLOB_STRIDE: usize = 5;

/// Values in the output header, before the first record.
pub const HEADER_FIELDS: usize = 3;

/// Fixed values per track record, before its path.
pub const RECORD_FIELDS: usize = 21;

/// Field offsets within one track record.
///
/// An enum rather than a pile of constants so that adding a field is one edit
/// and a compiler error at every use site, instead of a silently shifted
/// offset that decodes a confidence as a dwell time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
pub enum Field {
    Id = 0,
    BornAt = 1,
    LastSeen = 2,
    X = 3,
    Y = 4,
    T = 5,
    PreviousX = 6,
    PreviousY = 7,
    PreviousT = 8,
    VelocityX = 9,
    VelocityY = 10,
    Speed = 11,
    StillFor = 12,
    DwellSeconds = 13,
    Active = 14,
    Occluded = 15,
    Confidence = 16,
    Sightings = 17,
    Width = 18,
    Height = 19,
    PathLength = 20,
}

const _: () = assert!(
    Field::PathLength as usize + 1 == RECORD_FIELDS,
    "RECORD_FIELDS must cover every field"
);

/// Why a frame of observations was refused.
///
/// Refusing is not defensiveness for its own sake. A frame arrives from the
/// browser's sensing pipeline, from a replayed recording, or from a simulation,
/// and the last two are files. "Anonymous" is not the same as "trusted".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The array length is not a whole number of regions, or there are more
    /// regions than the sensing side is ever allowed to report.
    Shape,
    /// A coordinate, size or energy was not a finite number in 0..1.
    Region,
    /// The timestamp was not a finite, non-negative millisecond count.
    Clock,
    /// Time went backwards.
    ///
    /// A deliberate divergence from the TypeScript tracker, which accepts this
    /// and produces nonsense: a negative interval is floored to one frame, so a
    /// clock that jumps back turns into an enormous velocity and an association
    /// gate wide enough to swallow the room. The shell passes a monotonic
    /// clock, so this can only mean a bug, and a named error is a better
    /// outcome than a room that briefly believes everyone teleported.
    Backwards,
}

impl FrameError {
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::Shape => "expected up to 12 regions of 5 values each",
            Self::Region => "each region must be finite and within the room",
            Self::Clock => "the frame clock must be a finite, non-negative millisecond count",
            Self::Backwards => "the frame clock went backwards",
        }
    }
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for FrameError {}

/// The tracker plus the clock guard and the wire format.
#[derive(Clone, Debug, Default)]
pub struct TrackEngine {
    manager: TrackManager,
    last_frame: Option<f64>,
    frames: u64,
}

impl TrackEngine {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Frames accepted since construction. The supervisor watches this to tell
    /// "the page is responsive" from "the sensing pipeline is advancing".
    #[must_use]
    pub const fn frames(&self) -> u64 {
        self.frames
    }

    #[must_use]
    pub fn manager(&self) -> &TrackManager {
        &self.manager
    }

    /// Forget everyone, and forget what time it was.
    pub fn clear(&mut self) {
        self.manager.clear();
        self.last_frame = None;
    }

    /// Advance by one frame of detected regions.
    ///
    /// The whole batch is validated before any of it is applied, so a bad last
    /// region cannot leave the first one half-applied — the same atomicity rule
    /// `FieldEngine` follows, and for the same reason: the shell retries on its
    /// fallback path and must not retry into a mutated engine.
    pub fn step(&mut self, blobs: &[f64], now: f64) -> Result<Vec<f64>, FrameError> {
        let observations = decode(blobs)?;
        if !now.is_finite() || now < 0.0 {
            return Err(FrameError::Clock);
        }
        if self.last_frame.is_some_and(|previous| now < previous) {
            return Err(FrameError::Backwards);
        }
        let update = self.manager.update(&observations, now);
        self.last_frame = Some(now);
        self.frames = self.frames.saturating_add(1);
        Ok(encode(
            &update.active,
            &update.ended,
            self.manager.fragment_recoveries(),
        ))
    }
}

fn decode(blobs: &[f64]) -> Result<Vec<Observation>, FrameError> {
    if !blobs.len().is_multiple_of(BLOB_STRIDE) || blobs.len() > TRACKS_MAX * BLOB_STRIDE {
        return Err(FrameError::Shape);
    }
    // The length check leaves no remainder, so `.0` is every region.
    let regions = blobs.as_chunks::<BLOB_STRIDE>().0;
    let mut observations = Vec::with_capacity(regions.len());
    for &[x, y, width, height, energy] in regions {
        let within = |value: f64| value.is_finite() && (0.0..=1.0).contains(&value);
        if !within(x) || !within(y) || !within(width) || !within(height) || !within(energy) {
            return Err(FrameError::Region);
        }
        observations.push(Observation {
            x,
            y,
            width,
            height,
            energy,
        });
    }
    Ok(observations)
}

fn encode(active: &[Track], ended: &[Track], recoveries: u64) -> Vec<f64> {
    let points: usize = active
        .iter()
        .chain(ended)
        .map(|track| track.path.len())
        .sum();
    let mut out = Vec::with_capacity(
        HEADER_FIELDS + (active.len() + ended.len()) * RECORD_FIELDS + points * 3,
    );
    #[allow(clippy::cast_precision_loss)]
    {
        out.push(active.len() as f64);
        out.push(ended.len() as f64);
        // Beyond 2^53 recoveries the count stops being exact. That is about
        // nine quadrillion splits; the alternative is a second return value for
        // a diagnostic counter.
        out.push(recoveries as f64);
    }
    for track in active.iter().chain(ended) {
        write_record(&mut out, track);
    }
    out
}

#[allow(clippy::cast_precision_loss)]
fn write_record(out: &mut Vec<f64>, track: &Track) {
    out.push(f64::from(track.id.0));
    out.push(track.born_at);
    out.push(track.last_seen);
    out.push(track.position.x);
    out.push(track.position.y);
    out.push(track.position.t);
    out.push(track.previous.x);
    out.push(track.previous.y);
    out.push(track.previous.t);
    out.push(track.velocity.x);
    out.push(track.velocity.y);
    out.push(track.speed);
    out.push(track.still_for);
    out.push(track.dwell_seconds);
    out.push(f64::from(u8::from(track.active)));
    out.push(f64::from(u8::from(track.occluded)));
    out.push(track.confidence);
    out.push(f64::from(track.sightings));
    out.push(track.extent.width);
    out.push(track.extent.height);
    out.push(track.path.len() as f64);
    for point in &track.path {
        out.push(point.x);
        out.push(point.y);
        out.push(point.t);
    }
}

#[cfg(test)]
mod tests {
    use super::{BLOB_STRIDE, Field, FrameError, HEADER_FIELDS, RECORD_FIELDS, TrackEngine};
    use room_protocol::TRACKS_MAX;

    fn body(x: f64) -> [f64; BLOB_STRIDE] {
        [x, 0.5, 0.09, 0.24, 0.6]
    }

    fn field(frame: &[f64], record: usize, field: Field) -> f64 {
        frame
            .get(HEADER_FIELDS + record * RECORD_FIELDS + field as usize)
            .copied()
            .unwrap_or(f64::NAN)
    }

    #[test]
    fn one_call_carries_a_whole_frame_and_its_answer() {
        let mut engine = TrackEngine::new();
        let first = engine.step(&body(0.3), 0.0).expect("a valid frame");
        assert_eq!(first.first().copied(), Some(1.0), "one track");
        assert_eq!(first.get(1).copied(), Some(0.0), "nobody left");
        assert_eq!(field(&first, 0, Field::X), 0.3);
        assert_eq!(field(&first, 0, Field::Sightings), 1.0);
        assert_eq!(field(&first, 0, Field::PathLength), 1.0);
        assert_eq!(engine.frames(), 1);

        let second = engine.step(&body(0.36), 50.0).expect("a valid frame");
        assert_eq!(field(&second, 0, Field::Sightings), 2.0);
        assert!(field(&second, 0, Field::Speed) > 0.0);
        assert_eq!(field(&second, 0, Field::PreviousX), 0.3);
    }

    #[test]
    fn a_record_is_exactly_as_long_as_its_path_says() {
        let mut engine = TrackEngine::new();
        let mut now = 0.0;
        let mut frame = Vec::new();
        for step in 0..20 {
            frame = engine
                .step(&body(0.2 + f64::from(step) * 0.02), now)
                .expect("a valid frame");
            now += 50.0;
        }
        let path = field(&frame, 0, Field::PathLength);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let expected = HEADER_FIELDS + RECORD_FIELDS + (path as usize) * 3;
        assert_eq!(frame.len(), expected);
    }

    #[test]
    fn a_frame_that_is_not_a_whole_number_of_regions_is_refused() {
        let mut engine = TrackEngine::new();
        assert_eq!(engine.step(&[0.5, 0.5, 0.1], 0.0), Err(FrameError::Shape));
        assert_eq!(
            engine.step(&vec![0.5; (TRACKS_MAX + 1) * BLOB_STRIDE], 0.0),
            Err(FrameError::Shape)
        );
        assert_eq!(engine.frames(), 0, "a refused frame is not a frame");
    }

    #[test]
    fn a_region_outside_the_room_is_refused_and_nothing_is_half_applied() {
        let mut engine = TrackEngine::new();
        engine.step(&body(0.3), 0.0).expect("a valid frame");
        let before = engine.manager().tracks().to_vec();
        let mut poisoned = body(0.35).to_vec();
        poisoned.extend_from_slice(&[f64::NAN, 0.5, 0.1, 0.2, 0.5]);
        assert_eq!(engine.step(&poisoned, 50.0), Err(FrameError::Region));
        assert_eq!(engine.manager().tracks(), before.as_slice());
        for bad in [-0.01, 1.01, f64::INFINITY] {
            assert_eq!(
                engine.step(&[bad, 0.5, 0.1, 0.2, 0.5], 50.0),
                Err(FrameError::Region)
            );
        }
    }

    #[test]
    fn a_clock_that_goes_backwards_is_named_rather_than_believed() {
        let mut engine = TrackEngine::new();
        engine.step(&body(0.3), 1_000.0).expect("a valid frame");
        assert_eq!(engine.step(&body(0.3), 999.0), Err(FrameError::Backwards));
        assert!(
            engine.step(&body(0.3), 1_000.0).is_ok(),
            "two frames stamped the same millisecond is a fast machine, not a fault"
        );
        for bad in [f64::NAN, -1.0, f64::INFINITY] {
            assert_eq!(engine.step(&body(0.3), bad), Err(FrameError::Clock));
        }
    }

    #[test]
    fn clearing_forgets_the_clock_as_well_as_the_room() {
        let mut engine = TrackEngine::new();
        engine.step(&body(0.3), 60_000.0).expect("a valid frame");
        engine.clear();
        engine
            .step(&body(0.3), 0.0)
            .expect("a restarted page starts its clock again");
        assert_eq!(engine.frames(), 2, "frames counted are frames accepted");
    }

    #[test]
    fn the_buffer_has_a_ceiling_no_input_can_exceed() {
        let mut engine = TrackEngine::new();
        let mut now = 0.0;
        let mut largest = 0;
        for frame in 0..600 {
            let crowd: Vec<f64> = (0..TRACKS_MAX)
                .flat_map(|lane| {
                    #[allow(clippy::cast_precision_loss)]
                    let lane = lane as f64;
                    [
                        0.04 + lane * 0.08,
                        0.2 + (f64::from(frame) * 0.1 + lane).sin() * 0.05,
                        0.05,
                        0.12,
                        0.5,
                    ]
                })
                .collect();
            largest = largest.max(engine.step(&crowd, now).expect("a valid frame").len());
            now += 50.0;
        }
        // Twelve live tracks and twelve ending in the same frame, each with a
        // full path. Nothing the sensing side can send exceeds it.
        let ceiling = HEADER_FIELDS + 2 * TRACKS_MAX * (RECORD_FIELDS + 280 * 3);
        assert!(largest <= ceiling, "{largest} values in one frame");
    }
}
