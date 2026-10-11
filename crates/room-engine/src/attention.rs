//! The room takes an interest in someone.
//!
//! A port of `lib/attention.ts` and `lib/attention-evidence.ts`, which remain
//! authoritative in the gallery. The four rules they encode are the whole
//! design and none of them is an implementation detail:
//!
//!  1. **Interest is earned by behaviour, never assigned.** It accumulates only
//!     from things the room already detects — dwelling, returning, crossing an
//!     old path, stopping. A visitor who walks through is never chosen.
//!  2. **Interest is anonymous and dies with the track.** [`TrackId`] is a
//!     handle for as long as that track lives and nothing else. Nothing here is
//!     persisted, which is enforced rather than promised: no type in this
//!     module implements [`Persistable`](room_protocol::privacy::Persistable),
//!     and `TrackId` itself is excluded from it.
//!  3. **Interest is rare and then spent.** [`INTEREST_REST_MS`] afterwards,
//!     the room will not attend to anybody.
//!  4. **Interest is slight.** It biases deposits and which memory surfaces; it
//!     never announces itself.
//!
//! # Why the ordering is part of the contract
//!
//! Evidence is held in insertion order, and the candidate search takes the
//! first track to reach the highest total. That is not incidental: the
//! TypeScript holds evidence in a `Map`, whose iteration order is insertion
//! order, and re-`set`ting an existing key does not move it. A `HashMap` here
//! would pass every test that has one candidate and disagree with the gallery
//! the first time two visitors cross the threshold on the same frame.

use room_protocol::{Bounded, Ghost, TRACKS_MAX, TrackId, Vec2};

/// Things the room already detects, that make a presence worth attending to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Evidence {
    /// Stayed considerably longer than a visitor passing through.
    Dwell,
    /// Came back to somewhere they had left.
    Revisit,
    /// Walked into ground an old memory lies on.
    Crossing,
    /// Stopped, and stayed stopped.
    Stillness,
}

impl Evidence {
    /// What each kind of evidence is worth.
    ///
    /// Returning is weighted highest because it is the one that cannot be done
    /// accidentally: crossing a memory is the room's coincidence rather than
    /// the visitor's act, and standing still happens to anyone reading a wall
    /// label.
    #[must_use]
    pub const fn weight(self) -> f64 {
        match self {
            Self::Dwell => 0.34,
            Self::Revisit => 0.5,
            Self::Crossing => 0.42,
            Self::Stillness => 0.22,
        }
    }

    /// The wire spelling, for the flat boundary in
    /// [`attention_engine`](crate::attention_engine).
    #[must_use]
    pub const fn code(self) -> f64 {
        match self {
            Self::Dwell => 0.0,
            Self::Revisit => 1.0,
            Self::Crossing => 2.0,
            Self::Stillness => 3.0,
        }
    }

    /// Read a wire code.
    ///
    /// Takes the `f64` the boundary array actually holds, rather than a `u8`
    /// the caller would have had to cast it to first: there are exactly four
    /// legal values, and a fraction, a negative, an unknown code and a `NaN`
    /// are all the same refusal. A filing whose kind could not be read must
    /// fail its frame rather than land as a `Dwell`.
    #[must_use]
    pub fn from_wire(code: f64) -> Option<Self> {
        match code {
            c if c == Self::Dwell.code() => Some(Self::Dwell),
            c if c == Self::Revisit.code() => Some(Self::Revisit),
            c if c == Self::Crossing.code() => Some(Self::Crossing),
            c if c == Self::Stillness.code() => Some(Self::Stillness),
            _ => None,
        }
    }
}

/// Evidence needed before the room attends to anyone. Two strong acts, or three
/// weak ones.
pub const INTEREST_THRESHOLD: f64 = 1.0;

/// How long evidence counts for.
///
/// Beyond this a visitor has simply been present for a long time, which is not
/// the same as having done anything. Without the window, everybody standing in
/// a gallery eventually crosses the threshold by accumulation alone.
pub const EVIDENCE_WINDOW_MS: f64 = 90_000.0;

/// Interest arrives rather than switching on, in the same spirit as every
/// ramped gain in the piece.
pub const INTEREST_ATTACK_MS: f64 = 4_000.0;
pub const INTEREST_HOLD_MS: f64 = 45_000.0;
pub const INTEREST_FADE_MS: f64 = 15_000.0;

/// How long the room stays uninterested afterwards.
///
/// The refractory period is what makes this preference rather than tracking.
/// The value follows from the bound rather than the other way round: a spell
/// lasts attack + hold + fade = 64 s, so the most of a day the room can spend
/// interested in a visitor who never leaves is 64 / (64 + rest). At six minutes
/// that is 0.151, *above* the 0.15 share the burn-in holds it to — it passed
/// only on the rounding of accumulated seconds, which is not passing. Eight
/// minutes gives 0.118 and a gate with real margin.
pub const INTEREST_REST_MS: f64 = 8.0 * 60_000.0;

/// Extra memory an attended visitor deposits, at full interest.
///
/// Deliberately small. The deposit rates were measured and deliberately left
/// alone — reducing them by a third collapsed the mean field gradient from
/// 0.163 to 0.069. This is a fraction more from one person for under a minute,
/// not a change of regime.
pub const ATTENDED_DEPOSIT_GAIN: f64 = 0.45;

/// How long a presence has to persist before it is worth the room's interest.
///
/// A gallery visitor crosses a room in a few seconds. Half a minute in one
/// place is somebody who has decided to stay.
pub const ATTENTION_DWELL_SECONDS: f64 = 30.0;
pub const ATTENTION_STILL_SECONDS: f64 = 12.0;

/// The gap between two filings of the same kind, whoever they are about.
pub const EVIDENCE_GAP_MS: f64 = 20_000.0;

/// Filings one track may hold at once.
///
/// The TypeScript is bounded by construction rather than by a cap — evidence
/// outside [`EVIDENCE_WINDOW_MS`] is swept every update and evidence for a
/// departed track is dropped whole — and the sources are gated besides: the
/// dwell and stillness gates below admit one filing each per
/// [`EVIDENCE_GAP_MS`], `behaviors.ts` cools a revisit for 40 s, and a crossing
/// is the room's own occasional coincidence. Inside a 90 s window that is at
/// most five, five and three, so a real track cannot reach half of this.
///
/// It is still a cap, because §12 of the specification is that an accumulating
/// structure carries its ceiling in its type rather than in an argument about
/// its callers. Overflow drops the *oldest* filing, which can only lower a
/// total and so can only delay interest — never manufacture it. A test pins
/// that the gates keep it out of reach, so the bound never changes behaviour.
pub const FILINGS_PER_TRACK_MAX: usize = 32;

/// One reason, and when it was offered.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Filing {
    at: f64,
    weight: f64,
}

/// Who the room is attending to and how strongly.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Focus {
    /// The attended track. Ephemeral, never an identity.
    pub track: TrackId,
    /// 0 to 1: rising, held, then fading.
    pub weight: f64,
}

/// The current spell of interest.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Spell {
    track: TrackId,
    started_at: f64,
}

/// The room's preference. Holds no clock of its own; every method is told the
/// time, which is what makes a gallery day replayable in a second.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoomAttention {
    /// Insertion-ordered, and deliberately not a map. See the module docs.
    evidence: Vec<(TrackId, Bounded<Filing, FILINGS_PER_TRACK_MAX>)>,
    spell: Option<Spell>,
    rest_until: f64,
}

impl RoomAttention {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a reason to find someone interesting.
    ///
    /// Callers offer freely; whether it amounts to anything is this object's
    /// decision, not theirs. Returns `false` when the offer was dropped because
    /// the room is already holding evidence about [`TRACKS_MAX`] tracks, which
    /// the sensing side does not allow but a replayed or simulated session
    /// could.
    pub fn observe(&mut self, kind: Evidence, track: TrackId, now: f64) -> bool {
        let filing = Filing {
            at: now,
            weight: kind.weight(),
        };
        if let Some(entry) = self.evidence.iter_mut().find(|(id, _)| *id == track) {
            entry.1.push(filing);
            return true;
        }
        if self.evidence.len() >= TRACKS_MAX {
            return false;
        }
        let mut filings = Bounded::new();
        filings.push(filing);
        self.evidence.push((track, filings));
        true
    }

    /// Advance. `present` is the confirmed, currently observed tracks — the
    /// same gate everything else downstream of sensing uses.
    ///
    /// Interest ends the moment its subject is no longer present. A hidden
    /// track held for occlusion recovery does not count: the room may briefly
    /// not see someone it is interested in, and resuming when they reappear
    /// would require holding the interest across an absence it cannot
    /// distinguish from leaving.
    pub fn update(&mut self, present: &[TrackId], now: f64) {
        // Evidence belongs to a track, and a track that has gone takes it
        // along. Retaining in place is what preserves insertion order.
        self.evidence.retain_mut(|(track, filings)| {
            if !present.contains(track) {
                return false;
            }
            filings.retain(|filing| now - filing.at <= EVIDENCE_WINDOW_MS);
            !filings.is_empty()
        });

        if let Some(spell) = self.spell {
            let elapsed = now - spell.started_at;
            let finished = elapsed >= INTEREST_ATTACK_MS + INTEREST_HOLD_MS + INTEREST_FADE_MS;
            if !present.contains(&spell.track) || finished {
                self.release(now);
            }
            return;
        }

        if now < self.rest_until {
            return;
        }

        let mut best: Option<(TrackId, f64)> = None;
        for (track, filings) in &self.evidence {
            let total = filings.iter().fold(0.0, |sum, filing| sum + filing.weight);
            // Strictly greater, so the *first* track to reach the highest total
            // wins a tie. Two visitors can cross the threshold on one frame.
            if total >= INTEREST_THRESHOLD && best.is_none_or(|(_, top)| total > top) {
                best = Some((*track, total));
            }
        }
        let Some((chosen, _)) = best else { return };
        self.spell = Some(Spell {
            track: chosen,
            started_at: now,
        });
        // Spent on becoming interested: their accumulated reasons do not also
        // qualify them again the moment the room is willing to look at anyone.
        self.evidence.retain(|(track, _)| *track != chosen);
    }

    /// Who the room is attending to and how strongly, or `None`.
    #[must_use]
    pub fn focus(&self, now: f64) -> Option<Focus> {
        let spell = self.spell?;
        let weight = curve(now - spell.started_at);
        if weight <= 0.0 {
            return None;
        }
        Some(Focus {
            track: spell.track,
            weight,
        })
    }

    /// How much more memory this visitor's presence deposits. 1 for everybody
    /// else, which is the case that has to stay exactly 1.
    #[must_use]
    pub fn deposit_scale(&self, track: TrackId, now: f64) -> f64 {
        match self.focus(now) {
            Some(focus) if focus.track == track => 1.0 + ATTENDED_DEPOSIT_GAIN * focus.weight,
            _ => 1.0,
        }
    }

    /// Whether the room would rather address its line to this visitor. Never a
    /// guarantee: rarity is still the voice's decision and its minimum gap
    /// binds absolutely.
    #[must_use]
    pub fn favours(&self, track: TrackId, now: f64) -> f64 {
        match self.focus(now) {
            Some(focus) if focus.track == track => focus.weight,
            _ => 0.0,
        }
    }

    /// Tracks currently holding evidence. A diagnostic, and the number the
    /// bound in [`TRACKS_MAX`] applies to.
    #[must_use]
    pub fn tracked(&self) -> usize {
        self.evidence.len()
    }

    /// Cleared with the rest of the room's state. Nothing here is ever
    /// persisted, so this is the only way it goes away other than leaving.
    pub fn reset(&mut self) {
        self.evidence.clear();
        self.spell = None;
        self.rest_until = 0.0;
    }

    fn release(&mut self, now: f64) {
        self.spell = None;
        self.rest_until = now + INTEREST_REST_MS;
    }
}

/// Rise, hold, fall. Never a step: interest that switches on reads as a
/// trigger, which is the one thing this is not.
fn curve(elapsed: f64) -> f64 {
    // NaN is checked explicitly rather than left to fall through: a clock that
    // produces one would otherwise reach the hold branch below and read as full
    // interest in whoever the spell happened to name.
    if elapsed.is_nan() || elapsed < 0.0 {
        return 0.0;
    }
    if elapsed < INTEREST_ATTACK_MS {
        return elapsed / INTEREST_ATTACK_MS;
    }
    let held = elapsed - INTEREST_ATTACK_MS;
    if held < INTEREST_HOLD_MS {
        return 1.0;
    }
    let fading = held - INTEREST_HOLD_MS;
    if fading >= INTEREST_FADE_MS {
        return 0.0;
    }
    1.0 - fading / INTEREST_FADE_MS
}

/// What a present track looks like to the gate below. The two numbers it reads,
/// and nothing else: the gate has no business with a position or a path.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Presence {
    pub track: TrackId,
    pub dwell_seconds: f64,
    pub still_for: f64,
}

/// Turning what a visitor is doing into occasional evidence.
///
/// [`RoomAttention`] decides whether anything amounts to interest; this decides
/// when it is told. Evidence is an event, not a state, and the sensing loop
/// runs at up to twenty-four hertz: filing "they are still standing there" on
/// every tick crosses any threshold instantly and makes the room interested in
/// the first person who stops walking.
///
/// One gate per kind, not per person: the room's interest is a single scarce
/// thing, and a crowd of people all standing still is one observation about the
/// room rather than eight about individuals.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EvidenceGate {
    /// `None` means nothing of this kind has been filed, at any clock reading.
    ///
    /// Comparing an unset zero against the page clock made this a warmup as
    /// well as a spacing rule: for the first twenty seconds of a session no
    /// evidence could be filed at all, so the first visitor to stop in front of
    /// a room that had just been opened was the one visitor it could not become
    /// interested in. Zero is also a clock reading a test can pass, and a
    /// falsy check cannot tell it from an unset field.
    last_dwell: Option<f64>,
    last_still: Option<f64>,
}

impl EvidenceGate {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            last_dwell: None,
            last_still: None,
        }
    }

    /// File what this frame's tracks have earned, in track order.
    ///
    /// Writes into `out` rather than allocating, because this runs at the
    /// sensing rate for the life of the exhibition.
    pub fn observe(&mut self, present: &[Presence], now: f64, out: &mut Vec<(Evidence, TrackId)>) {
        for entry in present {
            if entry.dwell_seconds >= ATTENTION_DWELL_SECONDS && due(self.last_dwell, now) {
                self.last_dwell = Some(now);
                out.push((Evidence::Dwell, entry.track));
            }
            if entry.still_for >= ATTENTION_STILL_SECONDS && due(self.last_still, now) {
                self.last_still = Some(now);
                out.push((Evidence::Stillness, entry.track));
            }
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }
}

/// A gate that has never fired does not suppress anything.
fn due(last: Option<f64>, now: f64) -> bool {
    match last {
        None => true,
        Some(at) => now - at > EVIDENCE_GAP_MS,
    }
}

/// Default reach for [`prefer_memory_near`], ported from `preferMemoryNear`'s
/// TypeScript default parameter.
pub const PREFER_MEMORY_REACH: f64 = 0.22;

/// Pick a memory that reaches toward the attended visitor.
///
/// This biases *which* memory surfaces, never how often one does. Every
/// measured bound on the room's pace — the recall rate, the crossing
/// cooldown, the disturbed-occupancy share the burn-in gate holds below 10% —
/// is a statement about frequency, and this deliberately leaves all of them
/// untouched.
///
/// Falls back to `fallback` when there is nothing near enough to be worth
/// choosing, so an attended visitor standing in an unused corner does not
/// drag the room's whole archive over to them. Returns an index into
/// `candidates` rather than a [`Ghost`], matching
/// [`crate::memory::choose_rare`]'s convention — the caller already has an
/// index it would fall back to, and needs one back regardless of which memory
/// wins.
#[must_use]
pub fn prefer_memory_near(
    candidates: &[Ghost],
    at: Vec2,
    weight: f64,
    fallback: usize,
    reach: f64,
) -> usize {
    if weight <= 0.0 || candidates.is_empty() {
        return fallback;
    }
    let mut best: Option<usize> = None;
    let mut best_distance = reach;
    for (index, candidate) in candidates.iter().enumerate() {
        for point in &candidate.path {
            let distance = (point.x - at.x).hypot(point.y - at.y);
            if distance < best_distance {
                best_distance = distance;
                best = Some(index);
            }
        }
    }
    best.unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: TrackId = TrackId(1);
    const B: TrackId = TrackId(2);

    /// Walking through is never enough. The rule the whole design rests on.
    #[test]
    fn a_visitor_who_only_passes_through_is_never_chosen() {
        let mut room = RoomAttention::new();
        for frame in 0..600 {
            room.update(&[A], f64::from(frame) * 50.0);
        }
        assert_eq!(room.focus(30_000.0), None);
        assert_eq!(room.deposit_scale(A, 30_000.0), 1.0);
    }

    /// Two strong acts, and the room looks. One is not enough — and a revisit
    /// plus a crossing is 0.92, which is deliberately *not* enough either.
    #[test]
    fn interest_is_earned_and_then_rises_holds_and_falls() {
        let mut room = RoomAttention::new();
        room.observe(Evidence::Revisit, A, 0.0);
        room.update(&[A], 0.0);
        assert_eq!(room.focus(0.0), None, "0.5 is below the threshold");

        room.observe(Evidence::Crossing, A, 1_000.0);
        room.update(&[A], 1_000.0);
        assert_eq!(room.focus(1_000.0), None, "0.92 is still below it");

        let started = 2_000.0;
        room.observe(Evidence::Revisit, A, started);
        room.update(&[A], started);
        assert_eq!(
            room.focus(started),
            None,
            "interest arrives rather than switching on, so the first instant is still nothing"
        );

        assert_eq!(room.favours(A, started + INTEREST_ATTACK_MS / 2.0), 0.5);
        assert_eq!(room.favours(A, started + INTEREST_ATTACK_MS), 1.0);
        assert_eq!(
            room.favours(A, started + INTEREST_ATTACK_MS + INTEREST_HOLD_MS),
            1.0
        );
        let half_faded = started + INTEREST_ATTACK_MS + INTEREST_HOLD_MS + INTEREST_FADE_MS / 2.0;
        assert_eq!(room.favours(A, half_faded), 0.5);
        assert_eq!(room.favours(B, half_faded), 0.0, "never transferred");
        assert_eq!(
            room.focus(half_faded).map(|f| f.track),
            Some(A),
            "and it is still the same person the whole way down"
        );
    }

    /// Rule 3. Without this the room moves from person to person continuously,
    /// which is the behaviour of a security camera and reads as one.
    #[test]
    fn interest_is_spent_and_the_room_then_rests() {
        let mut room = RoomAttention::new();
        room.observe(Evidence::Revisit, A, 0.0);
        room.observe(Evidence::Revisit, A, 0.0);
        room.update(&[A], 0.0);
        assert_eq!(room.favours(A, 1_000.0), 0.25, "the spell has begun");

        let spell = INTEREST_ATTACK_MS + INTEREST_HOLD_MS + INTEREST_FADE_MS;
        room.update(&[A, B], spell);
        assert_eq!(room.focus(spell), None);

        // B has every reason in the world and cannot be looked at yet.
        for step in 0..40 {
            let now = spell + f64::from(step) * 5_000.0;
            room.observe(Evidence::Revisit, B, now);
            room.observe(Evidence::Crossing, B, now);
            room.update(&[A, B], now);
            if now < spell + INTEREST_REST_MS {
                assert_eq!(room.focus(now + 1.0), None, "the room is resting at {now}");
            }
        }
        let after = spell + INTEREST_REST_MS + 5_000.0;
        room.observe(Evidence::Revisit, B, after);
        room.observe(Evidence::Revisit, B, after);
        room.update(&[A, B], after);
        assert_eq!(room.focus(after + 1_000.0).map(|f| f.track), Some(B));
    }

    /// Rule 2. The one that is a privacy claim rather than an artistic one.
    #[test]
    fn interest_dies_with_the_track_and_is_never_transferred() {
        let mut room = RoomAttention::new();
        room.observe(Evidence::Revisit, A, 0.0);
        room.observe(Evidence::Revisit, A, 0.0);
        room.update(&[A, B], 0.0);
        assert_eq!(room.focus(10_000.0).map(|f| f.track), Some(A));

        room.update(&[B], 11_000.0);
        assert_eq!(room.focus(11_000.0), None, "their track ended");
        assert_eq!(
            room.favours(B, 11_000.0),
            0.0,
            "not handed to whoever is near"
        );

        // And the departure starts the rest, so B is not chosen next frame.
        room.observe(Evidence::Revisit, B, 12_000.0);
        room.observe(Evidence::Revisit, B, 12_000.0);
        room.update(&[B], 12_000.0);
        assert_eq!(room.focus(13_000.0), None);
    }

    /// Without the window everybody eventually qualifies by accumulation.
    #[test]
    fn evidence_older_than_the_window_stops_counting() {
        let mut room = RoomAttention::new();
        room.observe(Evidence::Revisit, A, 0.0);
        room.update(&[A], 0.0);
        room.observe(Evidence::Revisit, A, EVIDENCE_WINDOW_MS + 1.0);
        room.update(&[A], EVIDENCE_WINDOW_MS + 1.0);
        assert_eq!(
            room.focus(EVIDENCE_WINDOW_MS + 2_000.0),
            None,
            "the first filing expired, so the total is 0.5"
        );
    }

    /// Insertion order decides a tie. See the module docs: a `HashMap` here
    /// would pass every single-candidate test and disagree with the gallery.
    #[test]
    fn a_tie_goes_to_whoever_offered_evidence_first() {
        let mut room = RoomAttention::new();
        room.observe(Evidence::Revisit, B, 0.0);
        room.observe(Evidence::Revisit, A, 0.0);
        room.observe(Evidence::Revisit, B, 1.0);
        room.observe(Evidence::Revisit, A, 1.0);
        room.update(&[A, B], 1.0);
        assert_eq!(room.focus(1_001.0).map(|f| f.track), Some(B));
    }

    #[test]
    fn a_higher_total_wins_regardless_of_order() {
        let mut room = RoomAttention::new();
        room.observe(Evidence::Revisit, A, 0.0);
        room.observe(Evidence::Revisit, A, 0.0);
        room.observe(Evidence::Revisit, B, 0.0);
        room.observe(Evidence::Revisit, B, 0.0);
        room.observe(Evidence::Revisit, B, 0.0);
        room.update(&[A, B], 0.0);
        assert_eq!(room.focus(1_000.0).map(|f| f.track), Some(B));
    }

    #[test]
    fn deposit_scale_is_exactly_one_for_everybody_else() {
        let mut room = RoomAttention::new();
        room.observe(Evidence::Revisit, A, 0.0);
        room.observe(Evidence::Revisit, A, 0.0);
        room.update(&[A, B], 0.0);
        let held = INTEREST_ATTACK_MS + 1_000.0;
        assert_eq!(room.deposit_scale(A, held), 1.0 + ATTENDED_DEPOSIT_GAIN);
        assert_eq!(room.deposit_scale(B, held), 1.0);
    }

    /// The gate is why the room does not become interested in the first person
    /// who stops walking.
    #[test]
    fn the_gate_files_once_per_kind_per_gap_not_once_per_frame() {
        let mut gate = EvidenceGate::new();
        let mut filed = Vec::new();
        let standing = [Presence {
            track: A,
            dwell_seconds: 60.0,
            still_for: 40.0,
        }];
        // Twenty-four hertz for two minutes.
        for frame in 0..2_880 {
            gate.observe(&standing, f64::from(frame) * 41.67, &mut filed);
        }
        let dwell = filed.iter().filter(|(k, _)| *k == Evidence::Dwell).count();
        let still = filed
            .iter()
            .filter(|(k, _)| *k == Evidence::Stillness)
            .count();
        assert_eq!(dwell, 6, "120 s / 20 s gap, plus the ungated first");
        assert_eq!(still, 6);
    }

    #[test]
    fn a_gate_that_has_never_fired_does_not_suppress_the_first_visitor() {
        let mut gate = EvidenceGate::new();
        let mut filed = Vec::new();
        gate.observe(
            &[Presence {
                track: A,
                dwell_seconds: 31.0,
                still_for: 0.0,
            }],
            0.0,
            &mut filed,
        );
        assert_eq!(filed, vec![(Evidence::Dwell, A)]);
    }

    /// The bound exists; the gates keep it out of reach.
    ///
    /// The derivation, source by source, inside one 90 s window: dwell and
    /// stillness are one each per [`EVIDENCE_GAP_MS`], so five each; a revisit
    /// is cooled 40 s by `behaviors.ts`, so three; and a crossing is cooled
    /// 240 s by `memory-disturbance.ts`, so one. Fourteen, against a bound of
    /// thirty-two. This drives every source at exactly that rate and measures
    /// what actually accumulates. If it ever fails, the cap has started
    /// changing behaviour and that is the finding, not the assertion.
    #[test]
    fn the_real_gates_cannot_fill_a_track_to_its_filing_bound() {
        const DERIVED_CEILING: usize = 5 + 5 + 3 + 1;
        let mut gate = EvidenceGate::new();
        let mut room = RoomAttention::new();
        let mut filed = Vec::new();
        let present = [Presence {
            track: A,
            dwell_seconds: 600.0,
            still_for: 600.0,
        }];
        let mut peak = 0;
        // Ten minutes at 24 Hz, each source at its own cooldown.
        for frame in 0..14_400 {
            let now = f64::from(frame) * 41.67;
            filed.clear();
            gate.observe(&present, now, &mut filed);
            if frame % 960 == 0 {
                filed.push((Evidence::Revisit, A));
            }
            if frame % 5_760 == 0 {
                filed.push((Evidence::Crossing, A));
            }
            for (kind, track) in filed.drain(..) {
                room.observe(kind, track, now);
            }
            // Never let it become interested, so evidence is never spent and
            // this measures the window's ceiling rather than the spell's.
            room.rest_until = f64::MAX;
            room.update(&present.map(|p| p.track), now);
            peak = peak.max(room.evidence.first().map_or(0, |(_, f)| f.len()));
        }
        assert!(
            peak <= DERIVED_CEILING,
            "the window held {peak} filings, above the derived ceiling of {DERIVED_CEILING}"
        );
        const {
            assert!(
                DERIVED_CEILING * 2 <= FILINGS_PER_TRACK_MAX,
                "the bound should be at least twice what the gates can produce"
            );
        }
    }

    /// §12: bounded over indefinite operation. A gallery day of arrivals and
    /// departures must not leave anything behind.
    #[test]
    fn a_gallery_day_of_visitors_leaves_nothing_accumulated() {
        let mut room = RoomAttention::new();
        for visitor in 0..2_000_u32 {
            let track = TrackId(visitor);
            let arrived = f64::from(visitor) * 20_000.0;
            room.observe(Evidence::Revisit, track, arrived);
            room.observe(Evidence::Revisit, track, arrived + 1_000.0);
            room.update(&[track], arrived + 1_000.0);
            room.update(&[], arrived + 15_000.0);
            assert!(room.tracked() <= TRACKS_MAX);
        }
        assert_eq!(room.tracked(), 0);
        assert_eq!(room.focus(40_000_000.0), None);
    }

    /// The sensing side never reports more than this, but a replayed or
    /// simulated session is a file and files are not trusted.
    #[test]
    fn evidence_about_more_tracks_than_the_room_allows_is_refused_not_grown() {
        let mut room = RoomAttention::new();
        for candidate in 0..u32::try_from(TRACKS_MAX).unwrap_or(u32::MAX) {
            assert!(room.observe(Evidence::Dwell, TrackId(candidate), 0.0));
        }
        assert!(!room.observe(Evidence::Dwell, TrackId(9_999), 0.0));
        assert_eq!(room.tracked(), TRACKS_MAX);
        // A track already known still accepts more, which is the case that
        // must not be refused: refusing it would silently stop the room ever
        // becoming interested in a full gallery.
        assert!(room.observe(Evidence::Dwell, TrackId(0), 0.0));
    }

    #[test]
    fn reset_clears_the_spell_and_the_rest_together() {
        let mut room = RoomAttention::new();
        room.observe(Evidence::Revisit, A, 0.0);
        room.observe(Evidence::Revisit, A, 0.0);
        room.update(&[A], 0.0);
        room.reset();
        assert_eq!(room, RoomAttention::new());
    }

    /// A clock that jumps must not read as full interest in whoever the spell
    /// happens to name.
    #[test]
    fn a_curve_asked_about_nonsense_returns_no_interest() {
        assert_eq!(curve(f64::NAN), 0.0);
        assert_eq!(curve(-1.0), 0.0);
        assert_eq!(curve(f64::INFINITY), 0.0);
    }

    fn ghost_with_path(points: &[(f64, f64)]) -> Ghost {
        let mut path = room_protocol::PathPoints::new();
        for &(x, y) in points {
            path.push(room_protocol::Point::new(x, y, 0.0));
        }
        Ghost {
            id: room_protocol::MemoryId::new("g").expect("test id fits"),
            created_at: 0.0,
            last_replayed_at: 0.0,
            path,
            dwell_seconds: 0.0,
            intensity: 0.5,
            strength: 0.5,
            fidelity: 1.0,
            recall_count: 0,
            lineage: room_protocol::Lineage::new(),
            false_memory: false,
            day: 1,
        }
    }

    #[test]
    fn memories_reach_toward_the_attended_visitor_without_changing_how_often_they_surface() {
        let far = ghost_with_path(&[(0.05, 0.9)]);
        let near = ghost_with_path(&[(0.5, 0.5), (0.52, 0.5)]);
        let candidates = [far, near];
        let fallback = 0; // far
        assert_eq!(
            prefer_memory_near(
                &candidates,
                Vec2::new(0.5, 0.52),
                1.0,
                fallback,
                PREFER_MEMORY_REACH
            ),
            1, // near
        );
        // No interest: the room's ordinary choice stands.
        assert_eq!(
            prefer_memory_near(
                &candidates,
                Vec2::new(0.5, 0.52),
                0.0,
                fallback,
                PREFER_MEMORY_REACH
            ),
            fallback,
        );
    }

    #[test]
    fn an_attended_visitor_in_an_unused_corner_does_not_drag_the_archive_over() {
        let elsewhere = ghost_with_path(&[(0.9, 0.1)]);
        let fallback_ghost = ghost_with_path(&[(0.2, 0.2)]);
        let candidates = [elsewhere, fallback_ghost];
        let fallback = 1; // fallback_ghost
        assert_eq!(
            prefer_memory_near(
                &candidates,
                Vec2::new(0.1, 0.9),
                1.0,
                fallback,
                PREFER_MEMORY_REACH
            ),
            fallback,
            "nothing is near enough to be worth choosing",
        );
    }
}
