//! The behaviour subsystem's boundary: one call in, a short list out.
//!
//! [`BehaviorWatcher`] is what the room can notice people doing; this module is
//! the only thing that knows how a frame of it is packed for a caller in
//! another language. Same split, and same reason, as
//! [`track_engine`](crate::track_engine) and
//! [`attention_engine`](crate::attention_engine): the detectors are testable as
//! Rust values and the marshalling is testable as numbers, rather than both
//! being testable only through a browser.
//!
//! # Shape of the boundary
//!
//! One coarse call per sensing frame — ten to twenty-four a second in total,
//! not one per visitor and not one per detector. The output is at most six
//! events of five numbers, because a cooldown is stamped on the first report
//! of a kind on a frame and there are six kinds.
//!
//! # Why the whole path crosses every frame
//!
//! [`Behavior::Revisit`](crate::behavior::Behavior::Revisit) is a claim about
//! minutes: it looks for somewhere this visitor stood at least twenty seconds
//! ago and has been a long way from since, so it needs the tracker's whole
//! path, not a window of it. Two designs were considered:
//!
//! * **Mirror the path here**, fed one appended point per frame. Cheaper on
//!   the wire, and wrong: the path belongs to the tracker, which appends only
//!   when a visitor has moved far enough or long enough, and a mirror of
//!   somebody else's state desynchronises silently. A revisit detector running
//!   on a path that has drifted reports nothing and looks exactly like a room
//!   with no returning visitors.
//! * **Copy it**, which is what this does. [`TRACK_PATH_MAX`] points for each
//!   of at most [`TRACKS_MAX`] tracks is 10,080 `f64` at the absolute ceiling
//!   and a few hundred in a real gallery, once per sensing frame, in a single
//!   memcpy.
//!
//! The rule the spec actually states is that the boundary must not be chatty.
//! One copy per frame is not chatty; a mirror that can be wrong is not cheap.
//!
//! # What the copy actually costs
//!
//! Measured rather than assumed, on this machine, per `step` call:
//!
//! | frame | microseconds |
//! | --- | --- |
//! | empty room | 0.36 |
//! | one track, no path | 0.54 |
//! | one track, a full 280-point path | 7.2 |
//!
//! So the boundary itself is a third of a microsecond and the path copy is
//! about 8 ns a point. Neither is what dominates a real frame: see
//! [`behavior`](crate::behavior) for the detector that does.
//!
//! # Ownership
//!
//! Neither side holds a view into the other's memory. The input slice is read
//! and finished with before [`BehaviorEngine::step`] returns; the output is a
//! freshly allocated `Vec<f64>` that becomes the caller's, which is what keeps
//! it valid across WASM memory growth.
//!
//! # Input layout
//!
//! ```text
//! [0] now, milliseconds on the shell's monotonic clock
//! [1] 1 when sensing has settled, else 0
//! [2] track count T
//! then T records of:
//!     [0] track id
//!     [1] x, room coordinates
//!     [2] y
//!     [3] width of the detected region, room units
//!     [4] velocity x, room units per second
//!     [5] velocity y
//!     [6] smoothed speed
//!     [7] path point count P
//!     then P triples of (x, y, t)
//! ```
//!
//! Heights are not sent. The wave detector reads width alone, and a field
//! nothing reads is a field that drifts.
//!
//! # Output layout
//!
//! ```text
//! [0] event count E
//! [1] tracks the watcher is holding
//! then E records of (kind, at x, at y, first subject, second subject)
//! ```
//!
//! Kinds are [`Behavior::code`](crate::behavior::Behavior::code). The second
//! subject is [`NO_TRACK`] for the behaviours about one person. For
//! [`Behavior::Follow`](crate::behavior::Behavior::Follow) the first subject is
//! the follower, which is the one the room addresses.

use room_protocol::{Extent, Point, TRACK_PATH_MAX, TRACKS_MAX, TrackId, Vec2};

use crate::behavior::{BEHAVIORS, BehaviorWatcher, DEFAULT_WINDOW_MS, Observed};

/// Values in the input header, before the first track.
pub const HEADER_FIELDS: usize = 3;
/// Fixed values per track record, before its path.
pub const RECORD_FIELDS: usize = 8;
/// Values per path point.
pub const PATH_STRIDE: usize = 3;
/// Values in the output header, before the first event.
pub const OUTPUT_HEADER_FIELDS: usize = 2;
/// Values per reported event.
pub const EVENT_STRIDE: usize = 5;

/// Events one frame can produce.
///
/// A cooldown is stamped on the first accepted report of a kind, so a frame
/// yields at most one of each. This is therefore the number of behaviours, not
/// a guess with headroom, and the const assertion below keeps it that way.
pub const MAX_EVENTS: usize = BEHAVIORS.len();

/// Field offsets within one track record.
///
/// An enum rather than loose constants so that adding a field is one edit and a
/// compiler error at every use site, instead of a silently shifted offset that
/// decodes a velocity as a width.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
pub enum Field {
    Id = 0,
    X = 1,
    Y = 2,
    Width = 3,
    VelocityX = 4,
    VelocityY = 5,
    Speed = 6,
    PathLength = 7,
}

const _: () = assert!(
    Field::PathLength as usize + 1 == RECORD_FIELDS,
    "RECORD_FIELDS must cover every field"
);

/// Field offsets within one reported event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
pub enum EventField {
    Kind = 0,
    X = 1,
    Y = 2,
    Subject = 3,
    Other = 4,
}

const _: () = assert!(
    EventField::Other as usize + 1 == EVENT_STRIDE,
    "EVENT_STRIDE must cover every field"
);

const _: () = assert!(
    MAX_EVENTS == 6,
    "one cooldown per kind means one event per kind per frame"
);

/// The second subject of a behaviour about one person.
///
/// A sentinel rather than a `NaN`, because `NaN` propagates silently through
/// arithmetic on the far side and `-1` does not survive a comparison against a
/// real id, which are always non-negative integers.
pub const NO_TRACK: f64 = -1.0;

/// How far outside the unit square a coordinate may land.
///
/// Room space is the unit square, but positions arrive through a four-point
/// homography an operator calibrated by eye, so a body at the edge of the
/// camera's view can sit slightly outside it. A generous margin accepts that
/// and still refuses a coordinate that is a pixel index, a millisecond value
/// or an uninitialised buffer.
pub const COORDINATE_LIMIT: f64 = 8.0;

/// Fastest a body may be reported as moving, in room widths per second.
///
/// Crossing the room eight times a second is not a person; it is a tracker
/// that has just associated two different visitors, or a caller whose clock
/// disagrees with its positions.
pub const SPEED_LIMIT: f64 = 8.0;

/// Why a frame was refused.
///
/// Refusing is not defensiveness for its own sake. A frame arrives from the
/// browser, from a replayed recording, or from a simulation, and the last two
/// are files. "Anonymous" is not the same as "trusted".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The array is shorter than its header, its counts do not match its
    /// length, or it carries more tracks or path points than the room admits.
    Shape,
    /// A coordinate, size, velocity or speed was not a finite number inside
    /// the range a room produces.
    Track,
    /// A track id that is not a non-negative integer, or two records naming
    /// the same track — which would give one visitor two histories and let a
    /// pair detector compare somebody with themselves.
    Identity,
    /// The timestamp was not a finite, non-negative millisecond count, or the
    /// settled flag was neither 0 nor 1.
    Clock,
    /// Time went backwards.
    ///
    /// The same rule the tracker and the interest engine hold, for the same
    /// reason: the shell passes a monotonic clock, so a step backwards can only
    /// be a bug, and here it would leave samples outside the window in place
    /// and lift every cooldown at once. A refused frame is a better outcome
    /// than a room that announces six things it has already said.
    Backwards,
}

impl FrameError {
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::Shape => "behaviour frame does not match its header",
            Self::Track => "a track was not describable",
            Self::Identity => "a track id was missing, malformed or repeated",
            Self::Clock => "behaviour frame has no usable timestamp",
            Self::Backwards => "behaviour frame is older than the last one",
        }
    }
}

/// What the room noticed, one sensing frame per call.
#[derive(Clone, Debug, PartialEq)]
pub struct BehaviorEngine {
    watcher: BehaviorWatcher,
    /// The last accepted timestamp, so the clock rule is the engine's and not
    /// something each caller has to remember.
    last: Option<f64>,
    frames: u64,
}

impl Default for BehaviorEngine {
    fn default() -> Self {
        Self::new(DEFAULT_WINDOW_MS)
    }
}

impl BehaviorEngine {
    #[must_use]
    pub fn new(window_ms: f64) -> Self {
        Self {
            watcher: BehaviorWatcher::new(window_ms),
            last: None,
            frames: 0,
        }
    }

    /// Advance one frame. See the module docs for both layouts.
    ///
    /// The whole frame is validated before anything is mutated: a bad last
    /// track must not leave the first one recorded when the shell retries on
    /// its TypeScript fallback.
    pub fn step(&mut self, frame: &[f64]) -> Result<Vec<f64>, FrameError> {
        let Frame {
            now,
            stable,
            tracks,
        } = Self::parse(frame)?;
        if let Some(last) = self.last
            && now < last
        {
            return Err(FrameError::Backwards);
        }

        let observed: Vec<Observed<'_>> = tracks
            .iter()
            .map(|track| Observed {
                id: track.id,
                position: track.position,
                extent: track.extent,
                velocity: track.velocity,
                speed: track.speed,
                path: &track.path,
            })
            .collect();
        let events = self.watcher.update(&observed, now, stable);
        self.last = Some(now);
        self.frames = self.frames.saturating_add(1);

        // Bounded by `MAX_EVENTS` and `TRACKS_MAX`, so these conversions are
        // exact. They are written as fallible ones anyway because a saturating
        // count is a wrong diagnostic, and a wrong diagnostic sends an operator
        // to the wrong subsystem at two in the morning.
        let reported = u32::try_from(events.len()).map_or(f64::from(u32::MAX), f64::from);
        let tracked = u32::try_from(self.watcher.tracked()).map_or(f64::from(u32::MAX), f64::from);
        let mut out = Vec::with_capacity(
            OUTPUT_HEADER_FIELDS.saturating_add(events.len().saturating_mul(EVENT_STRIDE)),
        );
        out.push(reported);
        out.push(tracked);
        for event in events {
            // Positional, in `EventField` order.
            out.push(event.kind.code());
            out.push(event.at.x);
            out.push(event.at.y);
            out.push(f64::from(event.subjects.0.0));
            out.push(event.subjects.1.map_or(NO_TRACK, |id| f64::from(id.0)));
        }
        Ok(out)
    }

    /// Read a frame without touching any state. Split out so that the
    /// atomicity above is structural rather than a comment asking the reader
    /// to check.
    fn parse(frame: &[f64]) -> Result<Frame, FrameError> {
        let header = frame.get(..HEADER_FIELDS).ok_or(FrameError::Shape)?;
        let now = *header.first().ok_or(FrameError::Shape)?;
        if !now.is_finite() || now < 0.0 {
            return Err(FrameError::Clock);
        }
        let stable = match *header.get(1).ok_or(FrameError::Shape)? {
            0.0 => false,
            1.0 => true,
            _ => return Err(FrameError::Clock),
        };
        let count = whole(*header.get(2).ok_or(FrameError::Shape)?, TRACKS_MAX)?;

        let mut tracks: Vec<Track> = Vec::with_capacity(count);
        let mut cursor = HEADER_FIELDS;
        for _ in 0..count {
            let record = frame
                .get(cursor..cursor.checked_add(RECORD_FIELDS).ok_or(FrameError::Shape)?)
                .ok_or(FrameError::Shape)?;
            let id = track_id(*record.first().ok_or(FrameError::Shape)?)?;
            if tracks.iter().any(|held| held.id == id) {
                return Err(FrameError::Identity);
            }
            let x = coordinate(*record.get(Field::X as usize).ok_or(FrameError::Shape)?)?;
            let y = coordinate(*record.get(Field::Y as usize).ok_or(FrameError::Shape)?)?;
            let width = extent(*record.get(Field::Width as usize).ok_or(FrameError::Shape)?)?;
            let velocity = Vec2::new(
                rate(
                    *record
                        .get(Field::VelocityX as usize)
                        .ok_or(FrameError::Shape)?,
                )?,
                rate(
                    *record
                        .get(Field::VelocityY as usize)
                        .ok_or(FrameError::Shape)?,
                )?,
            );
            let speed = *record.get(Field::Speed as usize).ok_or(FrameError::Shape)?;
            if !speed.is_finite() || !(0.0..=SPEED_LIMIT).contains(&speed) {
                return Err(FrameError::Track);
            }
            let points = whole(
                *record
                    .get(Field::PathLength as usize)
                    .ok_or(FrameError::Shape)?,
                TRACK_PATH_MAX,
            )?;
            cursor = cursor.checked_add(RECORD_FIELDS).ok_or(FrameError::Shape)?;

            let mut path = Vec::with_capacity(points);
            for _ in 0..points {
                let point = frame
                    .get(cursor..cursor.checked_add(PATH_STRIDE).ok_or(FrameError::Shape)?)
                    .ok_or(FrameError::Shape)?;
                let at = *point.get(2).ok_or(FrameError::Shape)?;
                if !at.is_finite() || at < 0.0 {
                    return Err(FrameError::Clock);
                }
                path.push(Point::new(
                    coordinate(*point.first().ok_or(FrameError::Shape)?)?,
                    coordinate(*point.get(1).ok_or(FrameError::Shape)?)?,
                    at,
                ));
                cursor = cursor.checked_add(PATH_STRIDE).ok_or(FrameError::Shape)?;
            }

            tracks.push(Track {
                id,
                position: Point::new(x, y, now),
                extent: Extent {
                    width,
                    // Never sent, never read: the wave detector works from
                    // width alone. Carried as zero rather than as a guess.
                    height: 0.0,
                },
                velocity,
                speed,
                path,
            });
        }
        if cursor != frame.len() {
            return Err(FrameError::Shape);
        }
        Ok(Frame {
            now,
            stable,
            tracks,
        })
    }

    /// Forget everyone, and every cooldown. Used by the operator's reset.
    ///
    /// The clock is deliberately *not* cleared: a reset does not make an older
    /// frame acceptable, and the rule the tracker and the interest engine both
    /// hold is worth nothing if a third subsystem next to them will take one.
    pub fn clear(&mut self) {
        self.watcher.reset();
    }

    /// Frames accepted. Forward progress, for the supervisor's heartbeat.
    #[must_use]
    pub const fn frames(&self) -> u64 {
        self.frames
    }

    /// The watcher itself, for native tests and the parity harness.
    #[must_use]
    pub const fn watcher(&self) -> &BehaviorWatcher {
        &self.watcher
    }
}

/// A frame, read and validated, before any of it has been applied.
#[derive(Debug)]
struct Frame {
    now: f64,
    stable: bool,
    tracks: Vec<Track>,
}

/// One track, owning its path so the borrow in [`Observed`] can be taken after
/// the whole frame has been accepted.
#[derive(Debug)]
struct Track {
    id: TrackId,
    position: Point,
    extent: Extent,
    velocity: Vec2,
    speed: f64,
    path: Vec<Point>,
}

/// A count in a header: a non-negative integer no larger than its bound.
fn whole(value: f64, max: usize) -> Result<usize, FrameError> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 {
        return Err(FrameError::Shape);
    }
    // Checked finite, non-negative and integral above, and `max` is at most a
    // few hundred, so the conversion is exact. The range test comes after it
    // rather than before so that a value too large to be a count is one
    // refusal, not two.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let as_usize = value as usize;
    if as_usize > max {
        return Err(FrameError::Shape);
    }
    Ok(as_usize)
}

/// A track id: the tracker mints them as consecutive non-negative integers.
fn track_id(value: f64) -> Result<TrackId, FrameError> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > f64::from(u32::MAX) {
        return Err(FrameError::Identity);
    }
    // Checked finite, non-negative, integral and within `u32` above; every
    // `u32` is exactly representable as an `f64`, so nothing is lost here.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok(TrackId(value as u32))
}

/// A position in room space, with margin for an eye-calibrated homography.
fn coordinate(value: f64) -> Result<f64, FrameError> {
    if !value.is_finite() || value.abs() > COORDINATE_LIMIT {
        return Err(FrameError::Track);
    }
    Ok(value)
}

/// The size of a detected region: non-negative, and no wider than the room.
fn extent(value: f64) -> Result<f64, FrameError> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err(FrameError::Track);
    }
    Ok(value)
}

/// A velocity component, in room widths per second.
fn rate(value: f64) -> Result<f64, FrameError> {
    if !value.is_finite() || value.abs() > SPEED_LIMIT {
        return Err(FrameError::Track);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::behavior::Behavior;

    /// One track, as a caller packs it.
    #[derive(Clone, Debug)]
    struct Packed {
        id: u32,
        x: f64,
        y: f64,
        width: f64,
        velocity: (f64, f64),
        speed: f64,
        path: Vec<Point>,
    }

    fn packed(id: u32, x: f64, y: f64) -> Packed {
        Packed {
            id,
            x,
            y,
            width: 0.12,
            velocity: (0.0, 0.0),
            speed: 0.0,
            path: Vec::new(),
        }
    }

    fn frame(now: f64, stable: bool, tracks: &[Packed]) -> Vec<f64> {
        let mut out = vec![
            now,
            if stable { 1.0 } else { 0.0 },
            f64::from(u32::try_from(tracks.len()).unwrap()),
        ];
        for track in tracks {
            out.push(f64::from(track.id));
            out.push(track.x);
            out.push(track.y);
            out.push(track.width);
            out.push(track.velocity.0);
            out.push(track.velocity.1);
            out.push(track.speed);
            out.push(f64::from(u32::try_from(track.path.len()).unwrap()));
            for point in &track.path {
                out.push(point.x);
                out.push(point.y);
                out.push(point.t);
            }
        }
        out
    }

    /// A loop out and back, old enough for the revisit detector to consider.
    fn round_trip() -> Vec<Point> {
        (0..16)
            .map(|step| {
                let angle = f64::from(step) / 15.0 * std::f64::consts::TAU;
                Point::new(
                    0.5 + 0.2 * angle.cos(),
                    0.5 + 0.2 * angle.sin(),
                    f64::from(step) * 3_000.0,
                )
            })
            .collect()
    }

    #[test]
    fn an_event_round_trips_through_the_layout() {
        let mut engine = BehaviorEngine::default();
        let path = round_trip();
        let start = path.first().copied().unwrap();
        let mut track = packed(7, start.x, start.y);
        track.path = path;

        let out = engine
            .step(&frame(60_000.0, true, &[track]))
            .expect("a well formed frame");
        assert_eq!(out.len(), OUTPUT_HEADER_FIELDS + EVENT_STRIDE);
        assert_eq!(out[0], 1.0);
        assert_eq!(out[1], 1.0, "one track held");
        let event = &out[OUTPUT_HEADER_FIELDS..];
        assert_eq!(
            Behavior::from_wire(event[EventField::Kind as usize]),
            Some(Behavior::Revisit)
        );
        assert_eq!(event[EventField::X as usize], start.x);
        assert_eq!(event[EventField::Y as usize], start.y);
        assert_eq!(event[EventField::Subject as usize], 7.0);
        assert_eq!(
            event[EventField::Other as usize],
            NO_TRACK,
            "a revisit has one subject"
        );
    }

    #[test]
    fn a_pair_behaviour_names_both_subjects() {
        let mut engine = BehaviorEngine::default();
        let out = engine
            .step(&frame(
                0.0,
                true,
                &[packed(1, 0.02, 0.5), packed(2, 0.06, 0.5)],
            ))
            .expect("two people arriving at the edge");
        assert_eq!(out[0], 1.0);
        let event = &out[OUTPUT_HEADER_FIELDS..];
        assert_eq!(
            Behavior::from_wire(event[EventField::Kind as usize]),
            Some(Behavior::Together)
        );
        assert_eq!(event[EventField::Subject as usize], 1.0);
        assert_eq!(event[EventField::Other as usize], 2.0);
    }

    #[test]
    fn an_empty_room_reports_nothing_and_holds_nobody() {
        let mut engine = BehaviorEngine::default();
        let out = engine.step(&frame(0.0, true, &[])).expect("an empty frame");
        assert_eq!(out, vec![0.0, 0.0]);
        assert_eq!(engine.frames(), 1);
    }

    #[test]
    fn a_refused_frame_leaves_the_watcher_exactly_as_it_was() {
        let mut engine = BehaviorEngine::default();
        engine
            .step(&frame(1_000.0, true, &[packed(1, 0.5, 0.5)]))
            .expect("a good frame first");
        let before = engine.clone();

        let mut short = frame(2_000.0, true, &[packed(1, 0.5, 0.5)]);
        short.pop();
        let mut long = frame(2_000.0, true, &[packed(1, 0.5, 0.5)]);
        long.push(0.0);
        let mut bad_speed = packed(1, 0.5, 0.5);
        bad_speed.speed = SPEED_LIMIT + 1.0;
        let mut bad_width = packed(1, 0.5, 0.5);
        bad_width.width = 1.5;
        let mut bad_velocity = packed(1, 0.5, 0.5);
        bad_velocity.velocity = (f64::NAN, 0.0);
        let mut off_room = packed(1, 0.5, 0.5);
        off_room.x = COORDINATE_LIMIT + 0.5;
        let mut bad_point = packed(1, 0.5, 0.5);
        bad_point.path = vec![Point::new(0.5, 0.5, -1.0)];
        let mut long_path = packed(1, 0.5, 0.5);
        long_path.path = vec![Point::new(0.5, 0.5, 0.0); TRACK_PATH_MAX + 1];

        for (bad, why) in [
            (short, FrameError::Shape),
            (long, FrameError::Shape),
            (vec![2_000.0, 1.0], FrameError::Shape),
            (frame(f64::NAN, true, &[]), FrameError::Clock),
            (frame(-1.0, true, &[]), FrameError::Clock),
            (vec![2_000.0, 0.5, 0.0], FrameError::Clock),
            (frame(500.0, true, &[]), FrameError::Backwards),
            (frame(2_000.0, true, &[bad_speed]), FrameError::Track),
            (frame(2_000.0, true, &[bad_width]), FrameError::Track),
            (frame(2_000.0, true, &[bad_velocity]), FrameError::Track),
            (frame(2_000.0, true, &[off_room]), FrameError::Track),
            (frame(2_000.0, true, &[bad_point]), FrameError::Clock),
            (frame(2_000.0, true, &[long_path]), FrameError::Shape),
            // The same visitor twice would give one person two histories and
            // let a pair detector compare somebody with themselves.
            (
                frame(2_000.0, true, &[packed(1, 0.5, 0.5), packed(1, 0.6, 0.5)]),
                FrameError::Identity,
            ),
            (
                frame(2_000.0, true, &[packed(1, 0.5, 0.5)])
                    .into_iter()
                    .enumerate()
                    .map(|(index, value)| if index == HEADER_FIELDS { -1.0 } else { value })
                    .collect(),
                FrameError::Identity,
            ),
            // More people than the room admits, and a fractional count.
            (
                frame(
                    2_000.0,
                    true,
                    &(0..=u32::try_from(TRACKS_MAX).unwrap())
                        .map(|id| packed(id, 0.5, 0.5))
                        .collect::<Vec<_>>(),
                ),
                FrameError::Shape,
            ),
            (vec![2_000.0, 1.0, 0.5], FrameError::Shape),
            (vec![2_000.0, 1.0, -1.0], FrameError::Shape),
        ] {
            assert_eq!(engine.step(&bad), Err(why), "{bad:?} should be {why:?}");
            assert_eq!(engine, before, "{bad:?} mutated the watcher");
        }
    }

    /// The clock rule, and the reason a reset does not relax it.
    #[test]
    fn clearing_the_watcher_does_not_make_an_old_frame_acceptable() {
        let mut engine = BehaviorEngine::default();
        engine.step(&frame(10_000.0, true, &[])).expect("a frame");
        engine.clear();
        assert_eq!(
            engine.step(&frame(9_000.0, true, &[])),
            Err(FrameError::Backwards)
        );
        assert_eq!(engine.frames(), 1, "a refusal is not forward progress");
        engine
            .step(&frame(10_000.0, true, &[]))
            .expect("the same instant is fine");
        assert_eq!(engine.frames(), 2);
    }

    /// Nothing is reported while sensing has not settled.
    #[test]
    fn an_unsettled_frame_produces_no_events() {
        let mut engine = BehaviorEngine::default();
        let path = round_trip();
        let start = path.first().copied().unwrap();
        let mut track = packed(7, start.x, start.y);
        track.path = path;
        let out = engine
            .step(&frame(60_000.0, false, &[track]))
            .expect("an unsettled frame is still a frame");
        assert_eq!(out[0], 0.0);
        assert_eq!(out[1], 1.0, "history is still recorded");
    }

    /// §12 over the boundary as well as inside it: a long session must not
    /// grow the engine, and no frame may ever return more than six events.
    #[test]
    fn a_twelve_hour_day_across_the_boundary_stays_bounded() {
        let mut engine = BehaviorEngine::default();
        let path = round_trip();
        // 12 h at 24 Hz, six visitors, each carrying a full path.
        for tick in 0..1_036_800_u32 {
            let now = f64::from(tick) * 41.666_666_666_666_664;
            let tracks: Vec<Packed> = (0..6)
                .map(|person| {
                    let mut track = packed(person, 0.2 + f64::from(person) * 0.1, 0.5);
                    track.path.clone_from(&path);
                    track
                })
                .collect();
            let out = engine
                .step(&frame(now, true, &tracks))
                .expect("every frame of a gallery day");
            // The count in the header and the length of the buffer are two
            // statements of the same fact, and the decoder trusts the first.
            let reported = (out.len() - OUTPUT_HEADER_FIELDS) / EVENT_STRIDE;
            assert_eq!((out.len() - OUTPUT_HEADER_FIELDS) % EVENT_STRIDE, 0);
            assert_eq!(out[0], f64::from(u32::try_from(reported).unwrap()));
            assert!(reported <= MAX_EVENTS);
            assert!(engine.watcher().tracked() <= TRACKS_MAX);
        }
        assert_eq!(engine.frames(), 1_036_800);
    }
}
