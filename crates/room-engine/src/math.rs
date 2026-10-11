//! The arithmetic the room's behaviour rests on.
//!
//! Small functions, ported operation for operation from `memory-engine.ts` so
//! that the parity harness can demand near-exact agreement rather than
//! "behaves similarly". Where a comment here explains a number, the number came
//! from the installation running in a room, not from taste.

/// Constrain to a range, with the TypeScript function's exact NaN behaviour.
///
/// `Math.max(min, Math.min(max, NaN))` is `NaN`, and Rust's `f64::clamp`
/// panics on a NaN bound while propagating a NaN value. Written out so the two
/// implementations agree on the pathological input rather than one of them
/// deciding it is an error.
#[must_use]
pub fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    if value.is_nan() || minimum.is_nan() || maximum.is_nan() {
        f64::NAN
    } else {
        minimum.max(maximum.min(value))
    }
}

/// Probability that a Poisson event with rate `per_second` fires during
/// `elapsed_seconds`.
///
/// Rare events used to be rolled once per analysis tick at a fixed per-tick
/// chance, which tied how often the room remembers anything to the hardware
/// profile: the same installation produced recalls 2.4x more often on FULL
/// (24 Hz) than on CHEAP (10 Hz). Rates belong in wall-clock time.
///
/// `elapsed_seconds` is capped at 60 for the same reason `dt` is clamped
/// elsewhere: a laptop lid closed for an hour must not, on reopening, roll a
/// single event with probability 1 and fire every rare thing at once.
///
/// A non-finite elapsed time is treated as zero. TypeScript would propagate the
/// NaN into the returned probability, where `roll < NaN` is false and the event
/// never fires; the observable behaviour is therefore the same, and saying so
/// in the arithmetic is better than relying on a comparison to swallow it.
#[must_use]
pub fn event_chance(per_second: f64, elapsed_seconds: f64) -> f64 {
    let rate = per_second.max(0.0);
    let elapsed = if elapsed_seconds.is_finite() {
        elapsed_seconds.clamp(0.0, 60.0)
    } else {
        0.0
    };
    1.0 - (-rate * elapsed).exp()
}

/// Base recall rate at `ghost_frequency` 1.
///
/// Tuned against gallery dwell rather than against a day: at the default
/// frequency a visitor should meet the room's memory within about a minute,
/// not within an hour.
pub const RECALL_RATE_PER_SECOND: f64 = 0.045;

/// Exponential decay of a memory's hold on the room.
#[must_use]
pub fn decay_strength(strength: f64, elapsed_seconds: f64, half_life_hours: f64) -> f64 {
    // `max(1, hours * 3600)`, not `max(1, hours) * 3600`: the floor is on the
    // half-life in seconds, so a half-life of zero decays over one second
    // rather than over one hour. Matching the TypeScript grouping exactly is
    // the difference between a memory that vanishes and one that lingers for
    // an evening.
    clamp(
        strength * (-elapsed_seconds / (half_life_hours * 3600.0).max(1.0)).exp2(),
        0.0,
        1.0,
    )
}

/// Reinforcement, asymptotic to 1: a memory recalled a hundred times is held
/// firmly and never held perfectly.
#[must_use]
pub fn reinforce_strength(strength: f64, amount: f64) -> f64 {
    clamp(
        strength + (1.0 - strength) * clamp(amount, 0.0, 1.0),
        0.0,
        1.0,
    )
}

#[cfg(test)]
mod tests {
    use super::{RECALL_RATE_PER_SECOND, clamp, decay_strength, event_chance, reinforce_strength};

    #[test]
    fn clamping_matches_the_javascript_composition_including_nan() {
        assert_eq!(clamp(5.0, 0.0, 1.0), 1.0);
        assert_eq!(clamp(-5.0, 0.0, 1.0), 0.0);
        assert_eq!(clamp(0.5, 0.0, 1.0), 0.5);
        assert!(
            clamp(f64::NAN, 0.0, 1.0).is_nan(),
            "NaN propagates rather than panicking"
        );
    }

    /// The defect this function was written to fix: the chance of a rare event
    /// must depend on elapsed time, not on how often the loop happens to run.
    #[test]
    fn a_rare_event_fires_at_the_same_rate_whatever_the_tick_rate() {
        let rate = RECALL_RATE_PER_SECOND;
        let over_a_minute = event_chance(rate, 60.0);

        // Independent trials at 10 Hz and at 24 Hz over the same minute.
        let compose = |hz: u32| {
            let step = 1.0 / f64::from(hz);
            let ticks = 60 * hz;
            let mut none_yet = 1.0;
            for _ in 0..ticks {
                none_yet *= 1.0 - event_chance(rate, step);
            }
            1.0 - none_yet
        };
        assert!((compose(10) - over_a_minute).abs() < 1e-12);
        assert!((compose(24) - over_a_minute).abs() < 1e-12);
    }

    /// A machine that stalled for an hour must not wake up and fire
    /// everything, which is exactly what an uncapped elapsed time does.
    #[test]
    fn a_long_stall_cannot_make_a_rare_event_certain() {
        assert!(event_chance(RECALL_RATE_PER_SECOND, 3_600.0) < 0.94);
        assert_eq!(
            event_chance(RECALL_RATE_PER_SECOND, 3_600.0),
            event_chance(RECALL_RATE_PER_SECOND, 60.0),
            "anything past a minute is treated as a minute"
        );
    }

    #[test]
    fn a_rate_of_zero_is_off_rather_than_rare() {
        assert_eq!(event_chance(0.0, 600.0), 0.0);
        assert_eq!(event_chance(-1.0, 600.0), 0.0);
    }

    #[test]
    fn a_memory_halves_over_its_half_life() {
        let held = decay_strength(1.0, 3_600.0 * 4.0, 4.0);
        assert!((held - 0.5).abs() < 1e-12, "{held}");
        assert!((decay_strength(1.0, 3_600.0 * 8.0, 4.0) - 0.25).abs() < 1e-12);
    }

    #[test]
    fn decay_never_leaves_the_unit_interval_however_strange_the_input() {
        assert_eq!(decay_strength(5.0, 0.0, 4.0), 1.0);
        assert_eq!(
            decay_strength(1.0, -100.0, 4.0),
            1.0,
            "negative elapsed cannot amplify"
        );
        assert!(
            decay_strength(1.0, 1e9, 0.0) >= 0.0,
            "a zero half-life is floored, not divided by"
        );
    }

    /// Asymptotic, not additive: repeated recall approaches certainty and never
    /// reaches it, which is what stops a frequently-replayed memory becoming
    /// permanent and crowding out everything else.
    #[test]
    fn reinforcement_approaches_one_without_reaching_it() {
        let mut strength = 0.1;
        for _ in 0..500 {
            strength = reinforce_strength(strength, 0.12);
            assert!(strength <= 1.0);
        }
        assert!(strength > 0.999);
        assert!(strength < 1.0);
    }

    #[test]
    fn reinforcement_ignores_an_out_of_range_amount() {
        assert_eq!(reinforce_strength(0.5, 5.0), 1.0);
        assert_eq!(reinforce_strength(0.5, -5.0), 0.5);
    }
}
