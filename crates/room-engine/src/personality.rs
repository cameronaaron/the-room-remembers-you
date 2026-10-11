//! What mood the room is in, given who is visibly here and how long it has
//! been alone.
//!
//! A port of `choosePersonality` in `lib/memory-engine.ts`, which remains
//! authoritative in the gallery until this agrees with it. Unlike recall,
//! this reaches no [`Rng`](crate::rng::Rng) and holds no state between calls:
//! given the same four inputs it always answers the same mood. That is also
//! why it takes `previous` as a plain argument rather than owning it — the
//! caller decides what "previous" meant, this only resolves the one tie that
//! needs it.

use room_protocol::Personality;

/// The room considers itself crowded once at least this many tracks are visible.
const CROWDED_TRACKS: usize = 4;
/// ...and overwhelmed once at least this many are.
const OVERWHELMED_TRACKS: usize = 8;
/// A track counts as standing still, for personality's purposes, once it has
/// held that stillness this long.
const STILL_THRESHOLD_SECONDS: f64 = 15.0;
/// Average speed above which a visible crowd reads as active rather than
/// merely present.
const ACTIVE_SPEED: f64 = 0.18;
/// The room stays empty this long before it starts forgetting outright.
const FORGETTING_SECONDS: f64 = 20.0 * 60.0;
/// The room stays empty this long before loneliness is even considered.
const LONELY_SECONDS: f64 = 2.0 * 60.0;
/// Memory-field density above which an empty room reads as lonely rather than
/// merely idle.
const LONELY_DENSITY: f64 = 0.004;
/// Memory-field density below which an idle room reads as dormant rather than
/// quietly remembering.
const DORMANT_DENSITY: f64 = 0.001;

/// The two fields `choose_personality` reads from a track. A distinct type
/// from [`crate::tracking::Track`] because this is all personality needs of
/// it, and `Track`'s constructor is private to that module — a caller with a
/// real `Track` maps `speed`/`still_for` across rather than this module
/// depending on tracking's internals.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackActivity {
    pub speed: f64,
    pub still_for: f64,
}

/// What the room's mood should become this frame.
///
/// `tracks` are who is visibly present right now; `empty_seconds` is how long
/// nobody has been, for whichever came more recently; `density` is the memory
/// field's mean value ([`crate::field`]); `previous` is the mood a moment ago,
/// consulted only to settle curious-versus-attentive.
#[must_use]
pub fn choose_personality(
    tracks: &[TrackActivity],
    empty_seconds: f64,
    density: f64,
    previous: Personality,
) -> Personality {
    if tracks.len() >= OVERWHELMED_TRACKS {
        return Personality::Overwhelmed;
    }
    if tracks.len() >= CROWDED_TRACKS {
        return Personality::Crowded;
    }
    if !tracks.is_empty() {
        let all_still = tracks
            .iter()
            .all(|track| track.still_for >= STILL_THRESHOLD_SECONDS);
        if all_still {
            return Personality::Remembering;
        }
        #[allow(clippy::cast_precision_loss)]
        let average_speed =
            tracks.iter().map(|track| track.speed).sum::<f64>() / tracks.len() as f64;
        if average_speed > ACTIVE_SPEED {
            return Personality::Attentive;
        }
        return if previous == Personality::Dormant {
            Personality::Curious
        } else {
            Personality::Attentive
        };
    }
    if empty_seconds > FORGETTING_SECONDS {
        return Personality::Forgetting;
    }
    if empty_seconds > LONELY_SECONDS && density > LONELY_DENSITY {
        return Personality::Lonely;
    }
    if density < DORMANT_DENSITY {
        Personality::Dormant
    } else {
        Personality::Remembering
    }
}

#[cfg(test)]
mod tests {
    use super::{TrackActivity, choose_personality};
    use room_protocol::Personality;

    fn track(speed: f64, still_for: f64) -> TrackActivity {
        TrackActivity { speed, still_for }
    }

    #[test]
    fn eight_tracks_overwhelm_the_room_regardless_of_anything_else() {
        let tracks = vec![track(0.0, 999.0); 8];
        assert_eq!(
            choose_personality(&tracks, 0.0, 0.0, Personality::Dormant),
            Personality::Overwhelmed
        );
    }

    #[test]
    fn seven_tracks_are_merely_crowded() {
        let tracks = vec![track(0.5, 0.0); 7];
        assert_eq!(
            choose_personality(&tracks, 0.0, 0.0, Personality::Dormant),
            Personality::Crowded
        );
    }

    #[test]
    fn four_tracks_are_the_crowded_threshold() {
        let tracks = vec![track(0.5, 0.0); 4];
        assert_eq!(
            choose_personality(&tracks, 0.0, 0.0, Personality::Dormant),
            Personality::Crowded
        );
    }

    #[test]
    fn three_tracks_all_holding_still_are_remembered() {
        let tracks = vec![track(0.0, 20.0); 3];
        assert_eq!(
            choose_personality(&tracks, 0.0, 0.0, Personality::Dormant),
            Personality::Remembering
        );
    }

    #[test]
    fn one_track_just_short_of_the_stillness_threshold_is_not_remembering() {
        let tracks = vec![track(0.0, 14.999)];
        assert_ne!(
            choose_personality(&tracks, 0.0, 0.0, Personality::Dormant),
            Personality::Remembering
        );
    }

    #[test]
    fn a_brisk_crowd_is_attentive() {
        let tracks = vec![track(0.5, 0.0), track(0.3, 0.0)];
        assert_eq!(
            choose_personality(&tracks, 0.0, 0.0, Personality::Dormant),
            Personality::Attentive
        );
    }

    #[test]
    fn exactly_the_active_speed_is_not_yet_attentive_on_speed_alone() {
        let tracks = vec![track(0.18, 0.0)];
        assert_eq!(
            choose_personality(&tracks, 0.0, 0.0, Personality::Dormant),
            Personality::Curious
        );
    }

    #[test]
    fn a_slow_visitor_reads_as_curious_when_the_room_was_dormant() {
        let tracks = vec![track(0.05, 0.0)];
        assert_eq!(
            choose_personality(&tracks, 0.0, 0.0, Personality::Dormant),
            Personality::Curious
        );
    }

    #[test]
    fn a_slow_visitor_reads_as_attentive_when_the_room_was_already_engaged() {
        let tracks = vec![track(0.05, 0.0)];
        assert_eq!(
            choose_personality(&tracks, 0.0, 0.0, Personality::Attentive),
            Personality::Attentive
        );
    }

    #[test]
    fn an_empty_room_past_twenty_minutes_is_forgetting() {
        assert_eq!(
            choose_personality(&[], 1200.001, 0.5, Personality::Lonely),
            Personality::Forgetting
        );
    }

    #[test]
    fn an_empty_room_at_exactly_twenty_minutes_is_not_yet_forgetting() {
        assert_ne!(
            choose_personality(&[], 1200.0, 0.5, Personality::Lonely),
            Personality::Forgetting
        );
    }

    #[test]
    fn an_empty_dense_room_past_two_minutes_is_lonely() {
        assert_eq!(
            choose_personality(&[], 120.001, 0.005, Personality::Dormant),
            Personality::Lonely
        );
    }

    #[test]
    fn an_empty_room_at_exactly_two_minutes_is_not_yet_lonely() {
        assert_ne!(
            choose_personality(&[], 120.0, 0.005, Personality::Dormant),
            Personality::Lonely
        );
    }

    #[test]
    fn an_empty_room_with_too_little_density_is_not_lonely_however_long() {
        assert_ne!(
            choose_personality(&[], 10_000.0, 0.004, Personality::Dormant),
            Personality::Lonely
        );
    }

    #[test]
    fn an_idle_room_with_almost_nothing_stored_is_dormant() {
        assert_eq!(
            choose_personality(&[], 0.0, 0.0, Personality::Remembering),
            Personality::Dormant
        );
    }

    #[test]
    fn an_idle_room_at_exactly_the_dormant_floor_is_not_dormant() {
        assert_ne!(
            choose_personality(&[], 0.0, 0.001, Personality::Attentive),
            Personality::Dormant
        );
    }

    #[test]
    fn an_idle_room_holding_some_density_is_quietly_remembering() {
        assert_eq!(
            choose_personality(&[], 0.0, 0.002, Personality::Dormant),
            Personality::Remembering
        );
    }
}
