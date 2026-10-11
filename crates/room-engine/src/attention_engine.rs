//! The interest subsystem's boundary: one call in, one small array out.
//!
//! [`RoomAttention`] and [`EvidenceGate`] are the room's preference; this
//! module is the only thing that knows how a frame of it is packed for a caller
//! in another language. Same split, and same reason, as
//! [`track_engine`](crate::track_engine): the rules are testable as Rust values
//! and the marshalling is testable as numbers, rather than both being testable
//! only through a browser.
//!
//! # Shape of the boundary
//!
//! One coarse call per sensing frame — ten to twenty-four a second in total,
//! not one per visitor and not one per filing. The output is five numbers, so
//! the whole exchange is one small copy each way and no object graph.
//!
//! # Ownership
//!
//! Neither side holds a view into the other's memory. The input slice is read
//! and finished with before [`AttentionEngine::step`] returns; the output is a
//! freshly allocated `Vec<f64>` that becomes the caller's, which is what keeps
//! it valid across WASM memory growth.
//!
//! # Order within a frame
//!
//! Filings arrive first, then the gate reads the present tracks, then the room
//! decides. That is the order the React shell already runs in — `behaviors.ts`
//! files a revisit, `attention-evidence.ts` files dwell and stillness, then
//! `RoomAttention.update` — and it is part of the contract because insertion
//! order settles a tie between two visitors who qualify on the same frame.
//!
//! A crossing is filed by `room-emergence.ts` *after* that update, so it lands
//! in the following frame. A caller that buffers filings between steps gets
//! that for free; a caller that reorders them is changing what the room does.
//!
//! # Why a filing carries its own clock reading
//!
//! Because the shell's do not all happen at the frame instant. A revisit and
//! the gate's own dwell are filed immediately before the step, but a crossing
//! is filed *after* it, and the next step is a sensing frame later — so a
//! boundary that timestamped every filing `now` would age that crossing's
//! evidence one frame late against the TypeScript it has to match. Ninety
//! seconds of window makes that difference invisible almost always, and
//! "almost always" is the shape of a divergence that retires the WASM engine
//! in a gallery and cannot be reproduced afterwards. The caller records when
//! each filing actually happened and this reads it.
//!
//! `at` must be finite, at or before `now`, and no older than the evidence
//! window: a filing from the future is a caller mixing clocks, and one from
//! before the window is already dead and says the caller's buffer is not being
//! drained.
//!
//! # Input layout
//!
//! ```text
//! [0] now, milliseconds on the shell's monotonic clock
//! [1] filing count F
//! [2] present count P
//! then F triples of (kind, track id, filed at)
//! then P triples of (track id, dwell seconds, still-for seconds)
//! ```
//!
//! Kinds are [`Evidence::code`]. Only `Revisit` and `Crossing` belong in the
//! filings — `Dwell` and `Stillness` are the gate's to decide and are refused
//! here, because a caller that files them directly has bypassed the rate limit
//! that stops the room attending to the first person who stops walking.
//!
//! # Output layout
//!
//! ```text
//! [0] 1 when the room is attending to someone, else 0
//! [1] the attended track id, or -1
//! [2] interest weight, 0..1
//! [3] tracks currently holding evidence
//! [4] filings accepted this frame, the gate's and the caller's together
//! ```
//!
//! The weight is everything downstream needs: a deposit scale is
//! `1 + ATTENDED_DEPOSIT_GAIN * weight` for that one track and exactly 1 for
//! everyone else, and the voice's preference is the weight itself.

use room_protocol::{TRACKS_MAX, TrackId};

use crate::attention::{EVIDENCE_WINDOW_MS, Evidence, EvidenceGate, Presence, RoomAttention};

/// Values in the input header, before the first filing.
pub const HEADER_FIELDS: usize = 3;
/// Values per externally-sourced filing: kind, track id, and when it happened.
pub const FILING_STRIDE: usize = 3;
/// Values per present track.
pub const PRESENCE_STRIDE: usize = 3;
/// Values in the output.
pub const OUTPUT_FIELDS: usize = 5;

/// Filings one frame may carry.
///
/// A revisit names its subjects and a crossing names one track, so the sources
/// are already bounded by the number of people the room admits. The four is
/// headroom for a frame in which every visitor revisits and a crossing lands in
/// the same buffer; beyond that the frame is not describing a gallery.
pub const MAX_FILINGS: usize = TRACKS_MAX + 4;

/// Field offsets in the output.
///
/// An enum rather than loose constants so that adding a field is one edit and a
/// compiler error at every use site, instead of a silently shifted offset that
/// decodes a weight as a track id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(usize)]
pub enum Field {
    Attending = 0,
    Track = 1,
    Weight = 2,
    Tracked = 3,
    Filings = 4,
}

const _: () = assert!(
    Field::Filings as usize + 1 == OUTPUT_FIELDS,
    "OUTPUT_FIELDS must cover every field"
);

/// The track id reported when the room is attending to nobody.
///
/// A sentinel rather than a `NaN`, because `NaN` propagates silently through
/// arithmetic on the far side and `-1` does not survive a comparison against a
/// real id, which are always non-negative integers.
pub const NO_TRACK: f64 = -1.0;

/// Why a frame was refused.
///
/// Refusing is not defensiveness for its own sake. A frame arrives from the
/// browser, from a replayed recording, or from a simulation, and the last two
/// are files. "Anonymous" is not the same as "trusted".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The array is shorter than its header, its counts do not match its
    /// length, or it carries more filings or tracks than the room admits.
    Shape,
    /// A kind code that is not evidence, or one the gate owns.
    Kind,
    /// A track id that is not a non-negative integer, or a dwell or stillness
    /// that is not a finite non-negative number of seconds.
    Presence,
    /// The timestamp was not a finite, non-negative millisecond count.
    Clock,
    /// A filing was timestamped after the frame it arrived in, or before the
    /// evidence window that frame can still see. Either says the caller is
    /// mixing clocks or is not draining its buffer, and both are defects in
    /// the caller rather than something a visitor did.
    Filed,
    /// Time went backwards.
    ///
    /// The same rule the tracker holds, for the same reason: the shell passes a
    /// monotonic clock, so a step backwards can only be a bug, and here it
    /// would resurrect expired evidence and read a finished spell as full
    /// interest. A refused frame is a better outcome than a room that becomes
    /// interested because a clock jumped.
    Backwards,
}

impl FrameError {
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::Shape => "attention frame does not match its header",
            Self::Kind => "a filing named a kind the caller may not file",
            Self::Presence => "a present track was not describable",
            Self::Clock => "attention frame has no usable timestamp",
            Self::Filed => "a filing is not timestamped inside the frame's window",
            Self::Backwards => "attention frame is older than the last one",
        }
    }
}

/// The room's interest, one sensing frame per call.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AttentionEngine {
    room: RoomAttention,
    gate: EvidenceGate,
    /// The last accepted timestamp, so the clock rule is the engine's and not
    /// something each caller has to remember.
    last: Option<f64>,
    frames: u64,
}

impl AttentionEngine {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Advance one frame. See the module docs for both layouts.
    ///
    /// The whole frame is validated before anything is mutated: a bad last
    /// filing must not leave the first one applied when the shell retries on
    /// its TypeScript fallback.
    pub fn step(&mut self, frame: &[f64]) -> Result<Vec<f64>, FrameError> {
        let Frame {
            now,
            filings,
            present,
        } = Self::parse(frame)?;
        if let Some(last) = self.last
            && now < last
        {
            return Err(FrameError::Backwards);
        }

        // Order is the contract: the caller's filings first, in the order they
        // were offered, then the gate's own. It settles a tie between two
        // visitors who qualify on the same frame, so it is not an arbitrary
        // choice about how to merge two lists.
        let mut gated: Vec<(Evidence, TrackId)> = Vec::with_capacity(MAX_FILINGS);
        self.gate.observe(&present, now, &mut gated);
        let accepted = filings.len().saturating_add(gated.len());
        for filing in filings {
            self.room.observe(filing.kind, filing.track, filing.at);
        }
        // The gate reads this frame's tracks, so its filings are of this frame
        // by construction and have no timestamp of their own to carry.
        for (kind, track) in gated {
            self.room.observe(kind, track, now);
        }

        let here: Vec<TrackId> = present.iter().map(|entry| entry.track).collect();
        self.room.update(&here, now);
        self.last = Some(now);
        self.frames = self.frames.saturating_add(1);

        let (attending, track, weight) = match self.room.focus(now) {
            Some(focus) => (1.0, f64::from(focus.track.0), focus.weight),
            None => (0.0, NO_TRACK, 0.0),
        };
        // Both counts are bounded by `MAX_FILINGS`, so these conversions are
        // exact. They are written as fallible ones anyway because a saturating
        // count is a wrong diagnostic, and a wrong diagnostic sends an operator
        // to the wrong subsystem at two in the morning.
        let tracked = u32::try_from(self.room.tracked()).map_or(f64::from(u32::MAX), f64::from);
        let filings = u32::try_from(accepted).map_or(f64::from(u32::MAX), f64::from);
        // Positional, in `Field` order, and annotated with the length: a field
        // added to `Field` and not here is a type error rather than a zero the
        // decoder reads as "the room is attending to nobody".
        let out: [f64; OUTPUT_FIELDS] = [attending, track, weight, tracked, filings];
        Ok(out.to_vec())
    }

    /// Read a frame without touching any state. Split out so that the atomicity
    /// above is structural rather than a comment asking the reader to check.
    fn parse(frame: &[f64]) -> Result<Frame, FrameError> {
        let header = frame.get(..HEADER_FIELDS).ok_or(FrameError::Shape)?;
        let now = *header.first().ok_or(FrameError::Shape)?;
        if !now.is_finite() || now < 0.0 {
            return Err(FrameError::Clock);
        }
        let filing_count = count(*header.get(1).ok_or(FrameError::Shape)?, MAX_FILINGS)?;
        let present_count = count(*header.get(2).ok_or(FrameError::Shape)?, TRACKS_MAX)?;
        let expected = HEADER_FIELDS
            .checked_add(
                filing_count
                    .checked_mul(FILING_STRIDE)
                    .ok_or(FrameError::Shape)?,
            )
            .and_then(|so_far| so_far.checked_add(present_count.checked_mul(PRESENCE_STRIDE)?))
            .ok_or(FrameError::Shape)?;
        if frame.len() != expected {
            return Err(FrameError::Shape);
        }

        let mut filings = Vec::with_capacity(filing_count);
        let mut cursor = HEADER_FIELDS;
        for _ in 0..filing_count {
            let record = frame
                .get(cursor..cursor + FILING_STRIDE)
                .ok_or(FrameError::Shape)?;
            let kind = Evidence::from_wire(*record.first().ok_or(FrameError::Shape)?)
                .ok_or(FrameError::Kind)?;
            // The gate owns these two. A caller filing them directly has
            // bypassed the rate limit, which is the whole of that gate's job.
            if matches!(kind, Evidence::Dwell | Evidence::Stillness) {
                return Err(FrameError::Kind);
            }
            let track = track_id(*record.get(1).ok_or(FrameError::Shape)?)?;
            let at = filed_at(*record.get(2).ok_or(FrameError::Shape)?, now)?;
            filings.push(Filing { kind, track, at });
            cursor += FILING_STRIDE;
        }

        let mut present = Vec::with_capacity(present_count);
        for _ in 0..present_count {
            let record = frame
                .get(cursor..cursor + PRESENCE_STRIDE)
                .ok_or(FrameError::Shape)?;
            let track = track_id(*record.first().ok_or(FrameError::Shape)?)?;
            let dwell_seconds = seconds(*record.get(1).ok_or(FrameError::Shape)?)?;
            let still_for = seconds(*record.get(2).ok_or(FrameError::Shape)?)?;
            present.push(Presence {
                track,
                dwell_seconds,
                still_for,
            });
            cursor += PRESENCE_STRIDE;
        }
        Ok(Frame {
            now,
            filings,
            present,
        })
    }

    /// Forget everyone, and stop resting. Used by the operator's reset.
    ///
    /// The clock is deliberately *not* cleared: a reset does not make an older
    /// frame acceptable, and the tracker's rule is worth nothing if a second
    /// subsystem next to it will take one.
    pub fn clear(&mut self) {
        self.room.reset();
        self.gate.reset();
    }

    /// Frames accepted. Forward progress, for the supervisor's heartbeat.
    #[must_use]
    pub const fn frames(&self) -> u64 {
        self.frames
    }

    /// The room itself, for native tests and the parity harness.
    #[must_use]
    pub const fn room(&self) -> &RoomAttention {
        &self.room
    }
}

/// A frame, read and validated, before any of it has been applied.
#[derive(Debug)]
struct Frame {
    now: f64,
    filings: Vec<Filing>,
    present: Vec<Presence>,
}

/// One externally-sourced filing, with the instant the caller recorded it.
#[derive(Clone, Copy, Debug)]
struct Filing {
    kind: Evidence,
    track: TrackId,
    at: f64,
}

/// A count in the header: a non-negative integer no larger than its bound.
fn count(value: f64, max: usize) -> Result<usize, FrameError> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 {
        return Err(FrameError::Shape);
    }
    // Checked finite, non-negative and integral above, and `max` is a handful,
    // so the conversion is exact. The range test comes after it rather than
    // before so that a value too large to be a count is one refusal, not two.
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
        return Err(FrameError::Presence);
    }
    // Checked finite, non-negative, integral and within `u32` above; every
    // `u32` is exactly representable as an `f64`, so nothing is lost here.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok(TrackId(value as u32))
}

/// When a filing happened, against the frame that carries it.
///
/// A filing from the future is a caller mixing clocks; one from before the
/// evidence window is already expired on arrival, which means the caller's
/// buffer is not being drained and the room is deciding on a stale view. Both
/// are refusals rather than silent acceptance, because both are the caller's
/// defect and neither is visible on the wall.
fn filed_at(value: f64, now: f64) -> Result<f64, FrameError> {
    if !value.is_finite() || value < 0.0 || value > now || now - value > EVIDENCE_WINDOW_MS {
        return Err(FrameError::Filed);
    }
    Ok(value)
}

/// A duration in seconds. A day is far past anything a gallery produces and is
/// there to catch a millisecond value arriving where seconds were meant.
fn seconds(value: f64) -> Result<f64, FrameError> {
    if !value.is_finite() || !(0.0..=86_400.0).contains(&value) {
        return Err(FrameError::Presence);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attention::{ATTENDED_DEPOSIT_GAIN, INTEREST_ATTACK_MS};

    /// Build a frame the way a caller would, with every filing of this frame.
    fn frame(now: f64, filings: &[(Evidence, u32)], present: &[(u32, f64, f64)]) -> Vec<f64> {
        let timed: Vec<(Evidence, u32, f64)> = filings
            .iter()
            .map(|(kind, track)| (*kind, *track, now))
            .collect();
        timed_frame(now, &timed, present)
    }

    /// The same, where a filing carries an instant of its own. The shell's
    /// crossings do: they are filed after the step and arrive in the next one.
    fn timed_frame(
        now: f64,
        filings: &[(Evidence, u32, f64)],
        present: &[(u32, f64, f64)],
    ) -> Vec<f64> {
        #[allow(clippy::cast_precision_loss)]
        let mut out = vec![now, filings.len() as f64, present.len() as f64];
        for (kind, track, at) in filings {
            out.push(kind.code());
            out.push(f64::from(*track));
            out.push(*at);
        }
        for (track, dwell, still) in present {
            out.push(f64::from(*track));
            out.push(*dwell);
            out.push(*still);
        }
        out
    }

    #[test]
    fn a_frame_round_trips_through_the_layout() {
        let mut engine = AttentionEngine::new();
        let out = engine
            .step(&frame(0.0, &[(Evidence::Revisit, 7)], &[(7, 40.0, 20.0)]))
            .expect("a well formed frame");
        assert_eq!(out.len(), OUTPUT_FIELDS);
        // Revisit 0.5, dwell 0.34, stillness 0.22: 1.06, over the threshold —
        // but interest arrives rather than switching on, so the frame that
        // begins a spell still reports nobody. That is not a rounding artefact
        // and the shell must not treat it as one.
        assert_eq!(out[Field::Attending as usize], 0.0);
        assert_eq!(out[Field::Track as usize], NO_TRACK);
        assert_eq!(out[Field::Filings as usize], 3.0);
        // Evidence was spent on becoming interested.
        assert_eq!(out[Field::Tracked as usize], 0.0);

        let later = engine
            .step(&frame(INTEREST_ATTACK_MS, &[], &[(7, 44.0, 24.0)]))
            .expect("a later frame");
        assert_eq!(later[Field::Attending as usize], 1.0);
        assert_eq!(later[Field::Track as usize], 7.0);
        assert_eq!(later[Field::Weight as usize], 1.0);
        assert_eq!(
            engine.room().deposit_scale(TrackId(7), INTEREST_ATTACK_MS),
            1.0 + ATTENDED_DEPOSIT_GAIN
        );
    }

    /// The reason a filing carries a clock reading of its own.
    ///
    /// A crossing is filed after the step and arrives in the next one, so it is
    /// already a sensing frame old when the engine sees it. Its evidence has to
    /// age from when the visitor walked into the memory, not from when the
    /// buffer was drained — otherwise this engine holds evidence the
    /// TypeScript it has to match has already dropped, and the two disagree on
    /// whichever frame the window happens to close on.
    #[test]
    fn a_filing_ages_from_when_it_happened_and_not_from_its_delivery() {
        let mut engine = AttentionEngine::new();
        // Walked into an old path at 0; the shell notices and files it after
        // that frame's step, so it reaches the engine one frame later.
        let out = engine
            .step(&timed_frame(
                50.0,
                &[(Evidence::Crossing, 1, 0.0)],
                &[(1, 0.0, 0.0)],
            ))
            .expect("a filing from the previous frame");
        assert_eq!(out[Field::Tracked as usize], 1.0);

        // The window is inclusive, measured from when it happened.
        let edge = engine
            .step(&frame(EVIDENCE_WINDOW_MS, &[], &[(1, 0.0, 0.0)]))
            .expect("a frame on the window's edge");
        assert_eq!(edge[Field::Tracked as usize], 1.0);

        // One millisecond past it the evidence is gone. Stamped on delivery it
        // would still be held here, which is the divergence this field exists
        // to prevent.
        let past = engine
            .step(&frame(EVIDENCE_WINDOW_MS + 1.0, &[], &[(1, 0.0, 0.0)]))
            .expect("a frame past the window");
        assert_eq!(past[Field::Tracked as usize], 0.0);
    }

    #[test]
    fn an_empty_room_reports_no_track_rather_than_track_zero() {
        let mut engine = AttentionEngine::new();
        let out = engine.step(&frame(0.0, &[], &[])).expect("an empty frame");
        assert_eq!(out[Field::Attending as usize], 0.0);
        assert_eq!(out[Field::Track as usize], NO_TRACK);
        assert_eq!(out[Field::Weight as usize], 0.0);
    }

    #[test]
    fn a_refused_frame_leaves_the_room_exactly_as_it_was() {
        let mut engine = AttentionEngine::new();
        engine
            .step(&frame(1_000.0, &[(Evidence::Revisit, 1)], &[(1, 0.0, 0.0)]))
            .expect("a good frame first");
        let before = engine.clone();

        let mut short = frame(2_000.0, &[(Evidence::Crossing, 1)], &[(1, 0.0, 0.0)]);
        short.pop();
        for (bad, why) in [
            (short, FrameError::Shape),
            (vec![2_000.0, 0.0], FrameError::Shape),
            (frame(f64::NAN, &[], &[]), FrameError::Clock),
            (frame(-1.0, &[], &[]), FrameError::Clock),
            (frame(500.0, &[], &[]), FrameError::Backwards),
            // The gate's own kinds, and a code that is not evidence at all.
            (
                frame(2_000.0, &[(Evidence::Dwell, 1)], &[]),
                FrameError::Kind,
            ),
            (
                frame(2_000.0, &[(Evidence::Stillness, 1)], &[]),
                FrameError::Kind,
            ),
            (vec![2_000.0, 1.0, 0.0, 9.0, 1.0, 2_000.0], FrameError::Kind),
            (
                vec![2_000.0, 1.0, 0.0, f64::NAN, 1.0, 2_000.0],
                FrameError::Kind,
            ),
            (
                vec![2_000.0, 1.0, 0.0, 2.0, -1.0, 2_000.0],
                FrameError::Presence,
            ),
            // A filing timestamped after the frame that carries it, before the
            // window that frame can see, or not a clock reading at all.
            (
                timed_frame(2_000.0, &[(Evidence::Crossing, 1, 2_000.1)], &[]),
                FrameError::Filed,
            ),
            (
                timed_frame(
                    2_000.0,
                    &[(Evidence::Crossing, 1, 2_000.0 - EVIDENCE_WINDOW_MS - 1.0)],
                    &[],
                ),
                FrameError::Filed,
            ),
            (
                timed_frame(2_000.0, &[(Evidence::Crossing, 1, f64::NAN)], &[]),
                FrameError::Filed,
            ),
            (
                timed_frame(2_000.0, &[(Evidence::Crossing, 1, -1.0)], &[]),
                FrameError::Filed,
            ),
            (vec![2_000.0, 0.0, 1.0, 1.5, 0.0, 0.0], FrameError::Presence),
            (
                vec![2_000.0, 0.0, 1.0, 1.0, f64::INFINITY, 0.0],
                FrameError::Presence,
            ),
            (
                vec![2_000.0, 0.0, 1.0, 1.0, 0.0, -0.5],
                FrameError::Presence,
            ),
            // More people than the room admits, and a fractional count.
            (
                frame(
                    2_000.0,
                    &[],
                    &(0..=room_protocol::bounded::TRACKS_MAX_COUNT)
                        .map(|t| (t, 0.0, 0.0))
                        .collect::<Vec<_>>(),
                ),
                FrameError::Shape,
            ),
            (vec![2_000.0, 0.5, 0.0], FrameError::Shape),
            (vec![2_000.0, -1.0, 0.0], FrameError::Shape),
        ] {
            assert_eq!(engine.step(&bad), Err(why), "{bad:?} should be {why:?}");
            assert_eq!(engine, before, "{bad:?} mutated the room");
        }
    }

    /// The clock rule, and the reason a reset does not relax it.
    #[test]
    fn clearing_the_room_does_not_make_an_old_frame_acceptable() {
        let mut engine = AttentionEngine::new();
        engine.step(&frame(10_000.0, &[], &[])).expect("a frame");
        engine.clear();
        assert_eq!(
            engine.step(&frame(9_000.0, &[], &[])),
            Err(FrameError::Backwards)
        );
        assert_eq!(engine.frames(), 1, "a refusal is not forward progress");
        engine
            .step(&frame(10_000.0, &[], &[]))
            .expect("the same instant is fine");
        assert_eq!(engine.frames(), 2);
    }

    /// §12 over the boundary as well as inside it: a long session must not grow
    /// the engine.
    #[test]
    fn a_twelve_hour_day_across_the_boundary_stays_bounded() {
        let mut engine = AttentionEngine::new();
        // 12 h at 24 Hz, six visitors, a crossing every thirty seconds.
        for tick in 0..1_036_800_u32 {
            let now = f64::from(tick) * 41.666_666_666_666_664;
            let visitor = tick % 6;
            let present: Vec<(u32, f64, f64)> = (0..6)
                .map(|person| (person, f64::from(tick % 1_800) / 24.0, 0.0))
                .collect();
            let filings: Vec<(Evidence, u32)> = if tick % 720 == 0 {
                vec![(Evidence::Crossing, visitor)]
            } else {
                Vec::new()
            };
            let out = engine
                .step(&frame(now, &filings, &present))
                .expect("every frame of a gallery day");
            assert!(
                out[Field::Tracked as usize] <= f64::from(room_protocol::bounded::TRACKS_MAX_COUNT)
            );
        }
        assert_eq!(engine.frames(), 1_036_800);
        assert!(engine.room().tracked() <= TRACKS_MAX);
    }
}
