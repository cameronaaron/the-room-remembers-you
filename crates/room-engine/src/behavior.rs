//! What the room can notice people doing.
//!
//! A port of `lib/behaviors.ts`, which remains authoritative in the gallery
//! until this agrees with it. Everything here is derived from anonymous
//! motion: centroids, velocities, the size of the detected region, and how
//! those relate between people over time. No pose model, no face, no identity.
//! That constraint is the piece's privacy position rather than a limitation to
//! work around, and it is held structurally here as well as in the TypeScript:
//! no type in this module implements
//! [`Persistable`](room_protocol::privacy::Persistable), so nothing a detector
//! remembers can reach disk.
//!
//! What motion rules out is worth restating, because it is not obvious:
//!
//!   - **Looking toward the camera** needs a face or gaze model. Motion cannot
//!     see where someone is pointed, only where they are.
//!   - **Walking backwards** needs orientation. Without knowing which way a
//!     body faces, retreating and reversing are the same signal.
//!     [`Behavior::Revisit`] covers the honest half of that idea.
//!
//! Detectors are deliberately conservative: each has a cooldown, a minimum
//! duration, and thresholds chosen so ordinary milling about does not trigger
//! them. A behaviour the room announces wrongly is worse than one it misses,
//! because the whole effect depends on the visitor believing it.
//!
//! # Why the ordering is part of the contract
//!
//! Detectors run in a fixed order — every track's [`Behavior::Wave`] and
//! [`Behavior::Revisit`], then every pair's [`Behavior::Together`],
//! [`Behavior::Approach`], [`Behavior::Follow`] and [`Behavior::Mirror`] — and
//! the cooldown is stamped by the *first* report of a kind on a frame. Two
//! visitors who qualify for the same behaviour on the same frame therefore
//! produce one event, and which one it is follows from the caller's track
//! order. That is the TypeScript's behaviour, so it is this module's.
//!
//! # Cost
//!
//! [`Self::detect_follow`](BehaviorWatcher::detect_follow) dominates this
//! module and it is superlinear in both people and sensing rate: for every
//! ordered pair, at each of four lags, it scans the leader's whole window for
//! each of the follower's samples. With six visitors at 8 Hz that is 15 pairs
//! by 2 directions by 4 lags by roughly 48 samples squared, and it measures at
//! **167 microseconds a frame** against 13 for two visitors. The TypeScript
//! has the same shape and the same growth; V8 runs it about three times faster
//! than this `wasm32` build does, which is recorded in `docs/ARCHITECTURE.md`
//! rather than explained away.
//!
//! The growth is what would bite, so it was measured to its ceiling rather
//! than extrapolated. [`TRACKS_MAX`] is 12, which is 66 pairs and the most
//! this can ever be asked to do: **462 microseconds a frame**, against 156 for
//! the TypeScript. At the 24 Hz the sensing loop runs at that is 1.1% of wall
//! time, on a loop that is not the render path. So the superlinear term is
//! real and it is bounded by a bound the room already holds, which is why
//! there is no cleverer inner loop here. At gallery occupancy — one to three
//! people — it is 13 microseconds and beneath noticing.
//!
//! # Bounds
//!
//! [`BehaviorWatcher`] holds one record per track *present on the current
//! frame* — absent tracks are dropped before any detector runs — so it is
//! bounded by [`TRACKS_MAX`]. Each record holds samples inside a time window,
//! bounded again by [`SAMPLES_MAX`] so the ceiling survives a caller stepping
//! its clock faster than any sensing pipeline.

use room_protocol::{Bounded, Extent, Point, TRACKS_MAX, TrackId, Vec2};

/// Something the room noticed, derived from motion alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Behavior {
    /// Standing still while the body's outline keeps changing: arms moving.
    Wave,
    /// Two people closing the distance between them.
    Approach,
    /// One person walking the path another walked moments earlier.
    Follow,
    /// Two people who arrived within moments of each other.
    Together,
    /// Returning to a spot they occupied earlier and then left.
    Revisit,
    /// Two people apart, moving in step.
    Mirror,
}

/// Every behaviour, in the order the cooldown table and the wire codes use.
pub const BEHAVIORS: [Behavior; 6] = [
    Behavior::Wave,
    Behavior::Approach,
    Behavior::Follow,
    Behavior::Together,
    Behavior::Revisit,
    Behavior::Mirror,
];

impl Behavior {
    /// Minimum gap between two reports of the same behaviour.
    ///
    /// Every kind names its own figure even where two happen to agree: these
    /// are six independent judgements about how often a claim stays credible,
    /// and collapsing the arms that currently coincide would make the next
    /// change to one of them silently a change to the other.
    #[allow(clippy::match_same_arms)]
    #[must_use]
    pub const fn cooldown_ms(self) -> f64 {
        match self {
            Self::Wave => 20_000.0,
            Self::Approach => 30_000.0,
            Self::Follow => 45_000.0,
            Self::Together => 60_000.0,
            Self::Revisit => 40_000.0,
            Self::Mirror => 45_000.0,
        }
    }

    /// Position in [`BEHAVIORS`]. Also the cooldown table's index.
    #[must_use]
    pub const fn index(self) -> usize {
        match self {
            Self::Wave => 0,
            Self::Approach => 1,
            Self::Follow => 2,
            Self::Together => 3,
            Self::Revisit => 4,
            Self::Mirror => 5,
        }
    }

    /// The wire spelling, for the flat boundary in
    /// [`behavior_engine`](crate::behavior_engine). The index, as an `f64`.
    #[must_use]
    pub fn code(self) -> f64 {
        // `u32` rather than `usize` so the conversion is exact by type rather
        // than by a cast whose lossiness a reader has to reason about.
        u32::try_from(self.index()).map_or(f64::NAN, f64::from)
    }

    /// Read a wire code.
    ///
    /// Takes the `f64` the boundary array actually holds rather than a `u8` the
    /// caller would have had to cast it to first: a fraction, a negative, an
    /// unknown code and a `NaN` are all the same refusal, and an unreadable
    /// kind must fail rather than land as a wave.
    #[must_use]
    pub fn from_wire(code: f64) -> Option<Self> {
        BEHAVIORS.into_iter().find(|kind| kind.code() == code)
    }

    /// The lowercase name the shell's voice table is keyed by.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Wave => "wave",
            Self::Approach => "approach",
            Self::Follow => "follow",
            Self::Together => "together",
            Self::Revisit => "revisit",
            Self::Mirror => "mirror",
        }
    }
}

/// One thing the room noticed, and where to address it.
///
/// `subjects` are ephemeral track handles, never identities: the second is
/// present only for the behaviours that are about a relationship between two
/// people, and for [`Behavior::Follow`] the first is the follower.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Event {
    pub kind: Behavior,
    /// Where to address it, in room coordinates.
    pub at: Vec2,
    pub subjects: (TrackId, Option<TrackId>),
}

/// How long a detector may look back. The caller's window, defaulted.
pub const DEFAULT_WINDOW_MS: f64 = 6_000.0;

/// Samples one track may hold, whatever the window.
///
/// The window is the real bound — at the 10-24 Hz the sensing pipeline runs at,
/// six seconds is 60 to 145 samples and twenty seconds is 480. This ceiling
/// exists because "bounded in practice" is not bounded: a caller stepping its
/// clock in fractions of a millisecond would otherwise grow a record without
/// limit. Reaching it means the caller is not a sensing pipeline.
pub const SAMPLES_MAX: usize = 1_024;

const WAVE_WINDOW_MS: f64 = 1_600.0;
const WAVE_MAX_DRIFT: f64 = 0.045;
const WAVE_MIN_SWING: f64 = 0.035;
const WAVE_MIN_SAMPLES: usize = 6;
const WAVE_MIN_REVERSALS: u32 = 2;

const APPROACH_WINDOW_MS: f64 = 2_000.0;
const APPROACH_MIN_SAMPLES: usize = 4;
const APPROACH_START: f64 = 0.38;
const APPROACH_END: f64 = 0.22;

const FOLLOW_LAGS_MS: [f64; 4] = [1_000.0, 1_600.0, 2_400.0, 3_400.0];
const FOLLOW_TOLERANCE: f64 = 0.09;
const FOLLOW_MIN_TRAVEL: f64 = 0.25;
const FOLLOW_MIN_SAMPLES: usize = 8;
const FOLLOW_MIN_MATCHES: usize = 5;
/// How far a follower's sample may sit from the leader's nearest recorded
/// instant before it is not evidence about that lag at all.
const FOLLOW_MAX_SKEW_MS: f64 = 400.0;

const TOGETHER_WINDOW_MS: f64 = 1_400.0;

/// How close to the edge of the room a track must first appear to count as
/// someone arriving.
///
/// A track being born is not the same event as a person arriving, and treating
/// them as one is a systematic false positive rather than an occasional one.
/// Every track in the room is born simultaneously when sensing starts, and a
/// track re-appearing in the middle of the room after an occlusion was never
/// away. On a real session this made the room tell a single visitor "two of
/// you, at once" within three seconds of starting.
///
/// Someone who genuinely walked in was, a moment earlier, at the edge.
const TOGETHER_EDGE: f64 = 0.18;

const REVISIT_MIN_AGE_MS: f64 = 20_000.0;
const REVISIT_RADIUS: f64 = 0.06;
const REVISIT_MIN_EXCURSION: f64 = 0.28;
/// Path points reserved at the end, so "here" is not compared against the
/// stretch the visitor is standing on.
const REVISIT_PATH_TAIL: usize = 4;
/// Shortest path that can describe leaving somewhere and coming back.
const REVISIT_MIN_PATH: usize = 12;

const MIRROR_WINDOW_MS: f64 = 2_200.0;
const MIRROR_MIN_SEPARATION: f64 = 0.3;
const MIRROR_MIN_SPEED: f64 = 0.05;
const MIRROR_MIN_ALIGNMENT: f64 = 0.82;
const MIRROR_MIN_SAMPLES: usize = 6;
const MIRROR_MIN_COMPARED: usize = 5;
const MIRROR_MIN_SHARE: f64 = 0.8;

/// One frame's view of a track: what every detector reads, and nothing more.
///
/// `path` is the tracker's own record of where this visitor has walked, which
/// outlives the watcher's sample window and survives an occlusion. The watcher
/// does not maintain it, because the rule for when a point is worth keeping is
/// the tracker's and a second copy of that rule is a second thing to keep in
/// step.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Observed<'a> {
    pub id: TrackId,
    pub position: Point,
    pub extent: Extent,
    pub velocity: Vec2,
    pub speed: f64,
    pub path: &'a [Point],
}

/// One instant of one track, as the detectors read it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Sample {
    t: f64,
    x: f64,
    y: f64,
    width: f64,
    velocity: Vec2,
    speed: f64,
}

/// Everything remembered about one track, created and discarded as a unit.
#[derive(Clone, Debug, PartialEq)]
struct Watched {
    id: TrackId,
    samples: Bounded<Sample, SAMPLES_MAX>,
    /// When the track was first seen — by the watcher, not by the tracker. A
    /// track that vanishes and returns is born again here, which is what makes
    /// [`TOGETHER_EDGE`] necessary rather than decorative.
    born_at: f64,
    /// Whether it was first seen near the edge of the room — an arrival.
    born_at_edge: bool,
    /// Whether the caller offered this track on the current frame.
    present: bool,
}

/// A contiguous stretch of one track's history, borrowed rather than copied.
///
/// Every detector reads either the whole of a track's samples or the suffix
/// inside a time window, so a view over a start index is all any of them needs.
/// It exists because the alternative — collecting a filtered `Vec` per detector
/// per pair per frame — is the only allocation in this module's hot path and it
/// scales with the square of the number of people in the room.
#[derive(Clone, Copy, Debug)]
struct Window<'a> {
    record: &'a Watched,
    start: usize,
}

impl<'a> Window<'a> {
    /// Every sample a track holds.
    const fn whole(record: &'a Watched) -> Self {
        Self { record, start: 0 }
    }

    fn len(self) -> usize {
        self.record.samples.len().saturating_sub(self.start)
    }

    /// The `index`-th sample of the window, oldest first.
    fn get(self, index: usize) -> Option<&'a Sample> {
        self.record.samples.get(self.start.checked_add(index)?)
    }

    fn first(self) -> Option<&'a Sample> {
        self.get(0)
    }

    fn last(self) -> Option<&'a Sample> {
        self.get(self.len().checked_sub(1)?)
    }

    fn iter(self) -> impl Iterator<Item = &'a Sample> {
        self.record.samples.iter().skip(self.start)
    }
}

/// Holds the short history each detector needs.
///
/// Behaviours are relationships over time, so none of them can be decided from
/// a single frame. One record per track rather than three maps keyed alike:
/// the detectors then read what [`BehaviorWatcher::update`] already established
/// for this frame instead of looking it up again behind guards for a track that
/// is present but unknown — a state this type cannot be in.
#[derive(Clone, Debug, PartialEq)]
pub struct BehaviorWatcher {
    /// Bounded by [`TRACKS_MAX`]: absent tracks are dropped every frame, so
    /// this holds exactly the tracks the caller offered.
    watched: Vec<Watched>,
    /// Indexed by [`Behavior::index`]. An array rather than a map because the
    /// set of behaviours is closed, so a missing entry should be impossible at
    /// compile time rather than a runtime `None` that reads as "never
    /// reported".
    last_reported: [Option<f64>; BEHAVIORS.len()],
    window_ms: f64,
}

impl Default for BehaviorWatcher {
    fn default() -> Self {
        Self::new(DEFAULT_WINDOW_MS)
    }
}

impl BehaviorWatcher {
    #[must_use]
    pub fn new(window_ms: f64) -> Self {
        Self {
            watched: Vec::new(),
            last_reported: [None; BEHAVIORS.len()],
            window_ms,
        }
    }

    /// Feed the current frame and receive anything newly noticed.
    ///
    /// `stable` is whether sensing has settled. While it has not, history is
    /// still recorded — the detectors need continuity across the boundary —
    /// but nothing is reported. The seconds just after the background model
    /// warms up produce detections good enough for the artwork to react to and
    /// nowhere near solid enough to make claims about.
    ///
    /// `now` must not go backwards. The caller's clock is monotonic and the
    /// sample window is trimmed from the front on that assumption.
    pub fn update(&mut self, tracks: &[Observed<'_>], now: f64, stable: bool) -> Vec<Event> {
        self.record(tracks, now);
        if !stable {
            return Vec::new();
        }

        let mut found = Vec::with_capacity(BEHAVIORS.len());
        for track in tracks {
            let wave = self.detect_wave(track, now);
            self.consider(wave, now, &mut found);
            let revisit = Self::detect_revisit(track, now);
            self.consider(revisit, now, &mut found);
        }
        for (index, first) in tracks.iter().enumerate() {
            for second in tracks.iter().skip(index + 1) {
                let together = self.detect_together(first, second, now);
                self.consider(together, now, &mut found);
                let approach = self.detect_approach(first, second, now);
                self.consider(approach, now, &mut found);
                let follow = self.detect_follow(first, second);
                self.consider(follow, now, &mut found);
                let mirror = self.detect_mirror(first, second, now);
                self.consider(mirror, now, &mut found);
            }
        }
        found
    }

    /// Take the frame's samples, and forget whoever is no longer here.
    ///
    /// Absent tracks go before any detector runs, which is what keeps the
    /// watcher bounded by the people in front of the camera rather than by the
    /// people it has ever seen.
    fn record(&mut self, tracks: &[Observed<'_>], now: f64) {
        for record in &mut self.watched {
            record.present = false;
        }
        for track in tracks {
            let existing = self.watched.iter().position(|held| held.id == track.id);
            let slot = if let Some(slot) = existing {
                slot
            } else {
                let (x, y) = (track.position.x, track.position.y);
                self.watched.push(Watched {
                    id: track.id,
                    samples: Bounded::new(),
                    born_at: now,
                    born_at_edge: x.min(1.0 - x) <= TOGETHER_EDGE
                        || y.min(1.0 - y) <= TOGETHER_EDGE,
                    present: false,
                });
                self.watched.len().saturating_sub(1)
            };
            let window = self.window_ms;
            // Unreachable as `None`: `slot` was just produced from this vector.
            let Some(record) = self.watched.get_mut(slot) else {
                continue;
            };
            record.present = true;
            record.samples.push(Sample {
                t: now,
                x: track.position.x,
                y: track.position.y,
                width: track.extent.width,
                velocity: track.velocity,
                speed: track.speed,
            });
            // Equivalent to shifting from the front while the oldest sample is
            // outside the window, because `now` never goes backwards and
            // timestamps are therefore non-decreasing.
            record.samples.retain(|sample| now - sample.t <= window);
        }
        self.watched.retain(|record| record.present);
    }

    /// Accept an event unless the same kind was reported too recently.
    ///
    /// The cooldown is stamped on acceptance, so two visitors qualifying for
    /// the same behaviour on the same frame yield one event between them.
    fn consider(&mut self, event: Option<Event>, now: f64, found: &mut Vec<Event>) {
        let Some(event) = event else { return };
        let slot = event.kind.index();
        if let Some(Some(last)) = self.last_reported.get(slot)
            && now - last < event.kind.cooldown_ms()
        {
            return;
        }
        if let Some(entry) = self.last_reported.get_mut(slot) {
            *entry = Some(now);
        }
        found.push(event);
    }

    /// Forget everyone, and every cooldown. Used by the operator's reset.
    pub fn reset(&mut self) {
        self.watched.clear();
        self.last_reported = [None; BEHAVIORS.len()];
    }

    /// Tracks currently held. Bounded by [`TRACKS_MAX`]; a diagnostic.
    #[must_use]
    pub fn tracked(&self) -> usize {
        self.watched.len()
    }

    /// What is remembered about a track the caller just offered.
    ///
    /// Total for a track in the current frame: [`Self::record`] runs over the
    /// same frame's tracks before any detector is consulted.
    fn held(&self, id: TrackId) -> Option<&Watched> {
        self.watched.iter().find(|record| record.id == id)
    }

    /// The samples inside `span` of `now`, as a range into a track's history.
    ///
    /// A range rather than a filtered copy. Timestamps are non-decreasing —
    /// [`Self::record`] appends at `now` and `now` never goes backwards — so
    /// the samples inside a window are always a suffix, and returning where it
    /// starts costs nothing. The copy this replaces allocated four to six
    /// vectors of a hundred-odd samples for every pair of visitors on every
    /// sensing frame, which is a sixth of the room's people-squared work done
    /// purely to look at data it already had.
    fn window(&self, id: TrackId, now: f64, span: f64) -> Option<Window<'_>> {
        let record = self.held(id)?;
        let mut start = record.samples.len();
        for (index, sample) in record.samples.iter().enumerate() {
            if now - sample.t <= span {
                start = index;
                break;
            }
        }
        Some(Window { record, start })
    }

    /// A body that is not going anywhere while its outline keeps widening and
    /// narrowing is moving its arms.
    ///
    /// Requires real reversals, so a single stretch or a slow lean does not
    /// count. It also knows only that: a coat opening or a broad stretch
    /// produces the same signal, which is why nothing downstream may name a
    /// hand.
    fn detect_wave(&self, track: &Observed<'_>, now: f64) -> Option<Event> {
        let samples = self.window(track.id, now, WAVE_WINDOW_MS)?;
        if samples.len() < WAVE_MIN_SAMPLES {
            return None;
        }
        let first = samples.first()?;
        let last = samples.last()?;
        if (last.x - first.x).hypot(last.y - first.y) > WAVE_MAX_DRIFT {
            return None;
        }

        let mut widest = f64::NEG_INFINITY;
        let mut narrowest = f64::INFINITY;
        for sample in samples.iter() {
            widest = widest.max(sample.width);
            narrowest = narrowest.min(sample.width);
        }
        if widest - narrowest < WAVE_MIN_SWING {
            return None;
        }

        let mut reversals = 0_u32;
        let mut direction = 0.0_f64;
        for index in 1..samples.len() {
            let delta = samples.get(index)?.width - samples.get(index.saturating_sub(1))?.width;
            if delta.abs() < WAVE_MIN_SWING * 0.15 {
                continue;
            }
            let next = delta.signum();
            if direction != 0.0 && next != direction {
                reversals = reversals.saturating_add(1);
            }
            direction = next;
        }
        if reversals < WAVE_MIN_REVERSALS {
            return None;
        }
        Some(Event {
            kind: Behavior::Wave,
            at: Vec2::new(track.position.x, track.position.y),
            subjects: (track.id, None),
        })
    }

    /// Two people who were apart and are now not.
    fn detect_approach(&self, a: &Observed<'_>, b: &Observed<'_>, now: f64) -> Option<Event> {
        let first = self.window(a.id, now, APPROACH_WINDOW_MS)?;
        let second = self.window(b.id, now, APPROACH_WINDOW_MS)?;
        if first.len() < APPROACH_MIN_SAMPLES || second.len() < APPROACH_MIN_SAMPLES {
            return None;
        }
        let (one, other) = (first.first()?, second.first()?);
        let started = (one.x - other.x).hypot(one.y - other.y);
        let ended = (a.position.x - b.position.x).hypot(a.position.y - b.position.y);
        if started < APPROACH_START || ended > APPROACH_END || ended >= started {
            return None;
        }
        Some(Event {
            kind: Behavior::Approach,
            at: midpoint(a, b),
            subjects: (a.id, Some(b.id)),
        })
    }

    /// One person walking where another walked a moment ago.
    ///
    /// Tested at several lags: the follower's recent positions should match the
    /// leader's earlier ones, which is a different claim from simply being
    /// nearby.
    fn detect_follow(&self, a: &Observed<'_>, b: &Observed<'_>) -> Option<Event> {
        for (leader, follower) in [(a, b), (b, a)] {
            let (Some(led), Some(following)) = (self.held(leader.id), self.held(follower.id))
            else {
                continue;
            };
            let leader_path = Window::whole(led);
            let follower_path = Window::whole(following);
            if leader_path.len() < FOLLOW_MIN_SAMPLES || follower_path.len() < FOLLOW_MIN_SAMPLES {
                continue;
            }
            let (start, end) = (leader_path.first()?, leader_path.last()?);
            if (end.x - start.x).hypot(end.y - start.y) < FOLLOW_MIN_TRAVEL {
                continue;
            }

            for lag in FOLLOW_LAGS_MS {
                let mut total = 0.0;
                let mut count = 0_usize;
                for sample in follower_path.iter() {
                    let target = sample.t - lag;
                    if target < start.t {
                        continue;
                    }
                    // The earliest sample wins a tie, matching the TypeScript's
                    // `reduce` with a strict `<`: which of two equidistant
                    // instants is chosen decides what this lag scores.
                    let mut nearest = start;
                    for candidate in leader_path.iter() {
                        if (candidate.t - target).abs() < (nearest.t - target).abs() {
                            nearest = candidate;
                        }
                    }
                    if (nearest.t - target).abs() > FOLLOW_MAX_SKEW_MS {
                        continue;
                    }
                    total += (sample.x - nearest.x).hypot(sample.y - nearest.y);
                    count = count.saturating_add(1);
                }
                if count < FOLLOW_MIN_MATCHES {
                    continue;
                }
                let matches = u32::try_from(count).map_or(f64::INFINITY, f64::from);
                if total / matches <= FOLLOW_TOLERANCE {
                    return Some(Event {
                        kind: Behavior::Follow,
                        at: Vec2::new(follower.position.x, follower.position.y),
                        subjects: (follower.id, Some(leader.id)),
                    });
                }
            }
        }
        None
    }

    /// Two people whose tracks began within moments of each other.
    fn detect_together(&self, a: &Observed<'_>, b: &Observed<'_>, now: f64) -> Option<Event> {
        let one = self.held(a.id)?;
        let other = self.held(b.id)?;
        if (one.born_at - other.born_at).abs() > TOGETHER_WINDOW_MS {
            return None;
        }
        // Both must have come in from outside. Appearing at once in the middle
        // of the room is the tracker gaining two people, not two people
        // arriving.
        if !one.born_at_edge || !other.born_at_edge {
            return None;
        }
        // Only worth saying while it is still happening.
        if now - one.born_at.max(other.born_at) > TOGETHER_WINDOW_MS * 3.0 {
            return None;
        }
        Some(Event {
            kind: Behavior::Together,
            at: midpoint(a, b),
            subjects: (a.id, Some(b.id)),
        })
    }

    /// Back to a spot they held earlier and left.
    ///
    /// Requires a genuine excursion in between, so standing roughly still does
    /// not read as returning. Reads the tracker's path rather than the
    /// watcher's samples, because coming back is a claim about minutes and the
    /// sample window is seconds.
    fn detect_revisit(track: &Observed<'_>, now: f64) -> Option<Event> {
        if track.path.len() < REVISIT_MIN_PATH {
            return None;
        }
        let here = track.position;
        let anchors = track.path.len().saturating_sub(REVISIT_PATH_TAIL);
        for index in 0..anchors {
            let point = track.path.get(index)?;
            if now - point.t < REVISIT_MIN_AGE_MS {
                break;
            }
            if (point.x - here.x).hypot(point.y - here.y) > REVISIT_RADIUS {
                continue;
            }
            let mut excursion = 0.0_f64;
            for step in track.path.get(index.saturating_add(1)..)? {
                excursion = excursion.max((step.x - point.x).hypot(step.y - point.y));
            }
            if excursion < REVISIT_MIN_EXCURSION {
                continue;
            }
            return Some(Event {
                kind: Behavior::Revisit,
                at: Vec2::new(here.x, here.y),
                subjects: (track.id, None),
            });
        }
        None
    }

    /// Two people well apart, moving the same way at the same time.
    fn detect_mirror(&self, a: &Observed<'_>, b: &Observed<'_>, now: f64) -> Option<Event> {
        let separation = (a.position.x - b.position.x).hypot(a.position.y - b.position.y);
        if separation < MIRROR_MIN_SEPARATION {
            return None;
        }
        let first = self.window(a.id, now, MIRROR_WINDOW_MS)?;
        let second = self.window(b.id, now, MIRROR_WINDOW_MS)?;
        if first.len() < MIRROR_MIN_SAMPLES || second.len() < MIRROR_MIN_SAMPLES {
            return None;
        }

        let mut aligned = 0_usize;
        let mut compared = 0_usize;
        // Aligned at the newest sample: the two windows may hold different
        // counts, and comparing them from the front would pair an instant with
        // one several frames away from it.
        let span = first.len().min(second.len());
        for index in 0..span {
            let one = first.get(first.len().saturating_sub(span).saturating_add(index))?;
            let other = second.get(second.len().saturating_sub(span).saturating_add(index))?;
            if one.speed < MIRROR_MIN_SPEED || other.speed < MIRROR_MIN_SPEED {
                continue;
            }
            let magnitudes = one.velocity.length() * other.velocity.length();
            // A zero magnitude would divide a zero numerator by zero; the
            // TypeScript's `|| 1` falls back to the raw dot product, which is
            // then zero and fails the alignment test. Same outcome, stated.
            let scale = if magnitudes == 0.0 || magnitudes.is_nan() {
                1.0
            } else {
                magnitudes
            };
            // Written as a separate multiply and add rather than `mul_add`:
            // the fused form rounds once where JavaScript rounds twice, and a
            // dot product that differs in the last place is a divergence the
            // parity harness would have to explain.
            let dot =
                (one.velocity.x * other.velocity.x + one.velocity.y * other.velocity.y) / scale;
            compared = compared.saturating_add(1);
            if dot >= MIRROR_MIN_ALIGNMENT {
                aligned = aligned.saturating_add(1);
            }
        }
        if compared < MIRROR_MIN_COMPARED {
            return None;
        }
        let agreed = u32::try_from(aligned).map_or(0.0, f64::from);
        let total = u32::try_from(compared).map_or(f64::INFINITY, f64::from);
        if agreed / total < MIRROR_MIN_SHARE {
            return None;
        }
        Some(Event {
            kind: Behavior::Mirror,
            at: midpoint(a, b),
            subjects: (a.id, Some(b.id)),
        })
    }
}

/// Where to address something two people did together.
fn midpoint(a: &Observed<'_>, b: &Observed<'_>) -> Vec2 {
    // `f64::midpoint` rather than `(a + b) / 2`: both round exactly once and
    // agree bit for bit on room coordinates, and this one says what it means.
    Vec2::new(
        f64::midpoint(a.position.x, b.position.x),
        f64::midpoint(a.position.y, b.position.y),
    )
}

/// The watcher never holds more tracks than the room admits, because it drops
/// absent ones every frame and the caller is bounded by the same figure.
const _: () = assert!(TRACKS_MAX == 12);

#[cfg(test)]
mod tests {
    use super::*;

    /// A track as the detectors see it. Owned, because [`Observed`] borrows
    /// the tracker's path and a test wants to build both in one place.
    #[derive(Clone, Debug)]
    struct Walker {
        id: u32,
        x: f64,
        y: f64,
        width: f64,
        velocity: Vec2,
        speed: f64,
    }

    fn walker(id: u32, x: f64, y: f64) -> Walker {
        Walker {
            id,
            x,
            y,
            width: 0.12,
            velocity: Vec2::new(0.0, 0.0),
            speed: 0.0,
        }
    }

    fn view<'a>(walker: &Walker, now: f64, path: &'a [Point]) -> Observed<'a> {
        Observed {
            id: TrackId(walker.id),
            position: Point::new(walker.x, walker.y, now),
            extent: Extent {
                width: walker.width,
                height: 0.3,
            },
            velocity: walker.velocity,
            speed: walker.speed,
            path,
        }
    }

    fn kinds(events: &[Event]) -> Vec<Behavior> {
        events.iter().map(|event| event.kind).collect()
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
    fn every_behaviour_has_a_distinct_wire_code_and_a_cooldown() {
        for (index, kind) in BEHAVIORS.into_iter().enumerate() {
            assert_eq!(Behavior::from_wire(kind.code()), Some(kind));
            assert_eq!(kind.index(), index);
            assert!(kind.cooldown_ms() > 0.0, "{} has no cooldown", kind.name());
            assert!(!kind.name().is_empty());
        }
        for bad in [-1.0, 6.0, 0.5, f64::NAN, f64::INFINITY] {
            assert_eq!(Behavior::from_wire(bad), None);
        }
    }

    /// A still body whose outline keeps changing is moving its arms.
    #[test]
    fn a_changing_outline_over_a_still_centroid_is_a_wave() {
        let mut watcher = BehaviorWatcher::default();
        let mut seen = Vec::new();
        for frame in 0..10 {
            let now = f64::from(frame) * 150.0;
            let mut person = walker(1, 0.5, 0.5);
            person.width = if frame % 2 == 0 { 0.10 } else { 0.16 };
            seen.extend(kinds(&watcher.update(
                &[view(&person, now, &[])],
                now,
                true,
            )));
        }
        assert!(seen.contains(&Behavior::Wave), "{seen:?}");
    }

    /// The negative: standing still is not waving.
    #[test]
    fn a_still_body_with_a_steady_outline_is_not_a_wave() {
        let mut watcher = BehaviorWatcher::default();
        for frame in 0..10 {
            let now = f64::from(frame) * 150.0;
            let events = watcher.update(&[view(&walker(1, 0.5, 0.5), now, &[])], now, true);
            assert!(!kinds(&events).contains(&Behavior::Wave));
        }
    }

    /// Nothing is reported while sensing has not settled, but history is kept
    /// across the boundary so the first stable frame is not starting cold.
    #[test]
    fn an_unsettled_pipeline_records_history_and_reports_nothing() {
        let mut watcher = BehaviorWatcher::default();
        for frame in 0..9 {
            let now = f64::from(frame) * 150.0;
            let mut person = walker(1, 0.5, 0.5);
            person.width = if frame % 2 == 0 { 0.10 } else { 0.16 };
            assert!(
                watcher
                    .update(&[view(&person, now, &[])], now, false)
                    .is_empty()
            );
        }
        let now = 9.0 * 150.0;
        let mut person = walker(1, 0.5, 0.5);
        person.width = 0.16;
        let events = watcher.update(&[view(&person, now, &[])], now, true);
        assert!(kinds(&events).contains(&Behavior::Wave), "{events:?}");
    }

    /// Two people closing the distance, and the negative: people already
    /// together are not approaching.
    #[test]
    fn closing_the_distance_is_an_approach_and_standing_together_is_not() {
        let mut watcher = BehaviorWatcher::default();
        let mut seen = Vec::new();
        for frame in 0..8 {
            let now = f64::from(frame) * 250.0;
            let gap = 0.45 - f64::from(frame) * 0.04;
            seen.extend(kinds(&watcher.update(
                &[
                    view(&walker(1, 0.5 - gap / 2.0, 0.5), now, &[]),
                    view(&walker(2, 0.5 + gap / 2.0, 0.5), now, &[]),
                ],
                now,
                true,
            )));
        }
        assert!(seen.contains(&Behavior::Approach), "{seen:?}");

        let mut steady = BehaviorWatcher::default();
        for frame in 0..8 {
            let now = f64::from(frame) * 250.0;
            let events = steady.update(
                &[
                    view(&walker(1, 0.48, 0.5), now, &[]),
                    view(&walker(2, 0.52, 0.5), now, &[]),
                ],
                now,
                true,
            );
            assert!(!kinds(&events).contains(&Behavior::Approach));
        }
    }

    /// One report per kind, and then its cooldown.
    #[test]
    fn a_kind_is_reported_once_and_then_held_for_its_cooldown() {
        let mut watcher = BehaviorWatcher::default();
        let path = round_trip();
        let start = path.first().copied().unwrap();
        let now = 60_000.0;
        let here = walker(1, start.x, start.y);
        let events = watcher.update(&[view(&here, now, &path)], now, true);
        assert_eq!(kinds(&events), vec![Behavior::Revisit]);
        assert_eq!(events[0].subjects, (TrackId(1), None));

        let later = now + 1_000.0;
        assert!(
            watcher
                .update(&[view(&here, later, &path)], later, true)
                .is_empty(),
            "the cooldown must hold"
        );
        let after = now + Behavior::Revisit.cooldown_ms();
        assert_eq!(
            kinds(&watcher.update(&[view(&here, after, &path)], after, true)),
            vec![Behavior::Revisit]
        );
    }

    /// The negative for revisit: never having left is not coming back.
    #[test]
    fn standing_in_one_place_for_a_long_time_is_not_a_revisit() {
        let mut watcher = BehaviorWatcher::default();
        let path: Vec<Point> = (0..16)
            .map(|step| Point::new(0.5, 0.5, f64::from(step) * 3_000.0))
            .collect();
        let now = 60_000.0;
        let events = watcher.update(&[view(&walker(1, 0.5, 0.5), now, &path)], now, true);
        assert!(!kinds(&events).contains(&Behavior::Revisit));
    }

    /// Arriving together requires both to have come in from the edge.
    #[test]
    fn two_people_appearing_mid_room_at_once_did_not_arrive_together() {
        let mut middle = BehaviorWatcher::default();
        let events = middle.update(
            &[
                view(&walker(1, 0.5, 0.5), 0.0, &[]),
                view(&walker(2, 0.6, 0.5), 0.0, &[]),
            ],
            0.0,
            true,
        );
        assert!(!kinds(&events).contains(&Behavior::Together));

        let mut edge = BehaviorWatcher::default();
        let events = edge.update(
            &[
                view(&walker(1, 0.02, 0.5), 0.0, &[]),
                view(&walker(2, 0.06, 0.5), 0.0, &[]),
            ],
            0.0,
            true,
        );
        assert!(kinds(&events).contains(&Behavior::Together));
    }

    /// Opposite headings are not mirroring, and matched ones are.
    #[test]
    fn moving_in_step_is_mirroring_and_moving_apart_is_not() {
        for (heading, expected) in [(1.0_f64, true), (-1.0_f64, false)] {
            let mut watcher = BehaviorWatcher::default();
            let mut seen = Vec::new();
            for frame in 0..10 {
                let now = f64::from(frame) * 150.0;
                let travel = f64::from(frame) * 0.02;
                let mut one = walker(1, 0.15 + travel, 0.4);
                one.velocity = Vec2::new(0.13, 0.0);
                one.speed = 0.13;
                let mut other = walker(2, 0.75 + travel * heading, 0.6);
                other.velocity = Vec2::new(0.13 * heading, 0.0);
                other.speed = 0.13;
                seen.extend(kinds(&watcher.update(
                    &[view(&one, now, &[]), view(&other, now, &[])],
                    now,
                    true,
                )));
            }
            assert_eq!(seen.contains(&Behavior::Mirror), expected, "{seen:?}");
        }
    }

    /// Walking where someone walked is following; walking beside them is not.
    #[test]
    fn walking_a_path_moments_later_is_following_and_walking_beside_is_not() {
        for (lag_frames, expected) in [(8_u32, true), (0_u32, false)] {
            let mut watcher = BehaviorWatcher::default();
            let mut seen = Vec::new();
            let step = 0.02_f64;
            for frame in 0..40_u32 {
                let now = f64::from(frame) * 125.0;
                let behind = f64::from(frame.saturating_sub(lag_frames));
                let leader = walker(1, 0.1 + f64::from(frame) * step, 0.5);
                let follower = if lag_frames == 0 {
                    // Beside, not behind: the same progress, a different line.
                    walker(2, 0.1 + f64::from(frame) * step, 0.75)
                } else {
                    walker(2, 0.1 + behind * step, 0.5)
                };
                seen.extend(kinds(&watcher.update(
                    &[view(&leader, now, &[]), view(&follower, now, &[])],
                    now,
                    true,
                )));
            }
            assert_eq!(seen.contains(&Behavior::Follow), expected, "{seen:?}");
        }
    }

    /// §12: a track that leaves is forgotten, so the watcher is bounded by the
    /// people in front of the camera and not by the people it has ever seen.
    #[test]
    fn a_long_session_of_strangers_does_not_grow_the_watcher() {
        let mut watcher = BehaviorWatcher::default();
        for visitor in 0..5_000_u32 {
            for frame in 0..4 {
                let now = f64::from(visitor) * 1_000.0 + f64::from(frame) * 100.0;
                watcher.update(&[view(&walker(visitor, 0.5, 0.5), now, &[])], now, true);
                assert!(watcher.tracked() <= TRACKS_MAX);
            }
        }
        assert_eq!(watcher.tracked(), 1, "only the last visitor is still here");
        watcher.reset();
        assert_eq!(watcher.tracked(), 0);
    }

    /// §12 on the other axis: a caller stepping its clock far faster than any
    /// sensing pipeline must not grow one track's history without limit. The
    /// window is the real bound; this is the ceiling under it.
    #[test]
    fn a_pathological_clock_cannot_grow_one_track_past_its_ceiling() {
        let mut watcher = BehaviorWatcher::new(f64::INFINITY);
        for frame in 0..u32::try_from(SAMPLES_MAX * 3).unwrap() {
            let now = f64::from(frame) * 1e-6;
            watcher.update(&[view(&walker(1, 0.5, 0.5), now, &[])], now, true);
        }
        assert_eq!(
            watcher.held(TrackId(1)).map(|record| record.samples.len()),
            Some(SAMPLES_MAX)
        );
    }
}
