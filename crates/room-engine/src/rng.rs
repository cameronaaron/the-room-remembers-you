//! The room's randomness, made reproducible.
//!
//! The existing installation calls `Math.random()` from about a dozen places:
//! whether to surface a memory, which memory, how much a recalled path mutates,
//! where a whisper sits on the wall. That is fine for an artwork and fatal for
//! debugging one. A gallery reports that "it did something strange at about
//! half past seven" and there is no way to make it happen again.
//!
//! So randomness here is a value, not an ambient capability. One [`Rng`] per
//! engine, seeded explicitly, and its draw count saved with the room, so a
//! restarted installation continues its stream instead of restarting it.
//!
//! # The algorithm, and why this one
//!
//! `sfc32` — Small Fast Counting, 32-bit, four words of state — seeded through
//! `splitmix32`. It is chosen for a property most generators do not have and
//! that this project needs above speed or statistical pedigree: **it is
//! exactly reproducible in JavaScript.** Every operation is a 32-bit add,
//! xor, shift or rotate, all of which JavaScript expresses precisely with
//! `>>> 0` and `Math.imul`. A 64-bit generator such as PCG64 or xoshiro256
//! would need `BigInt` on the TypeScript side, and a floating-point generator
//! would not agree bit for bit at all.
//!
//! That matters because the migration runs both engines against the same
//! inputs and compares. If the two cannot be given the same random stream, the
//! parity report can only ever say "these look similar", which is not a claim
//! anything can be built on. `lib/room-rng.ts` is the same generator, and
//! `tests/vectors/rng.json` is the shared evidence that they agree: generated
//! from this crate, read by both suites, so neither half can drift without a
//! test going red. Regenerate it with
//! `cargo run -p room-engine --example rng-vectors > tests/vectors/rng.json`
//! and expect an empty diff — a non-empty one means every saved room resumes
//! into a stream that no longer exists.
//!
//! It is not cryptographic and does not need to be. Nothing here protects
//! anything; it decides whether a room remembers you.

/// A deterministic 32-bit generator. Clone to fork a stream for a subsystem
/// without disturbing the main one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rng {
    a: u32,
    b: u32,
    c: u32,
    d: u32,
    /// Values drawn so far. Saved with the room so a restart resumes.
    draws: u64,
    seed: u64,
}

impl Rng {
    /// Create a generator from a seed.
    ///
    /// Seed 0 is permitted and is not a special case: `splitmix32` mixes the
    /// counter before it mixes the seed, so an all-zero seed still produces a
    /// well-distributed state rather than the all-zero state that would make
    /// `sfc32` emit a constant.
    #[must_use]
    pub fn new(seed: u64) -> Self {
        let low = (seed & 0xFFFF_FFFF) as u32;
        let high = (seed >> 32) as u32;
        let mut mixer = SplitMix32 { state: low };
        let a = mixer.next();
        let b = mixer.next() ^ high;
        let c = mixer.next();
        let d = mixer.next();
        let mut rng = Self {
            a,
            b,
            c,
            d,
            draws: 0,
            seed,
        };
        // sfc32's authors specify 12 discarded outputs after seeding, before
        // which the low bits of the state are still visible in the output.
        for _ in 0..12 {
            rng.next_u32();
        }
        rng.draws = 0;
        rng
    }

    /// Restore a generator to an exact position in its stream.
    ///
    /// Replays the discarded draws rather than storing the four state words.
    /// Storing the words would be faster and would also make the saved room
    /// depend on the generator's internals, so a change of algorithm would
    /// resume a room into a stream that no longer exists. Seed plus position
    /// is the smaller, more durable claim.
    ///
    /// Restoring is O(`draws`), and `draws` grows by a handful per engine step.
    /// A fortnight of gallery days is a few million draws, which replays in
    /// well under a second — measured, not assumed; see
    /// `restoring_a_fortnight_of_draws_is_fast_enough_to_do_at_startup`.
    #[must_use]
    pub fn restore(seed: u64, draws: u64) -> Self {
        let mut rng = Self::new(seed);
        for _ in 0..draws {
            rng.next_u32();
        }
        rng
    }

    /// The seed this stream came from.
    #[must_use]
    pub const fn seed(&self) -> u64 {
        self.seed
    }

    /// How far into the stream this generator is.
    #[must_use]
    pub const fn draws(&self) -> u64 {
        self.draws
    }

    /// The next raw 32-bit value.
    pub fn next_u32(&mut self) -> u32 {
        let t = self.a.wrapping_add(self.b).wrapping_add(self.d);
        self.d = self.d.wrapping_add(1);
        self.a = self.b ^ (self.b >> 9);
        self.b = self.c.wrapping_add(self.c << 3);
        self.c = self.c.rotate_left(21).wrapping_add(t);
        self.draws = self.draws.wrapping_add(1);
        t
    }

    /// The next value in `[0, 1)`, matching what `Math.random()` returns.
    ///
    /// Divided by 2^32 rather than scaled by a reciprocal, so the TypeScript
    /// side can write `value / 4294967296` and get the identical double.
    pub fn next_f64(&mut self) -> f64 {
        f64::from(self.next_u32()) / 4_294_967_296.0
    }

    /// A value in `[low, high)`.
    pub fn range(&mut self, low: f64, high: f64) -> f64 {
        low + self.next_f64() * (high - low)
    }

    /// Whether an event with probability `chance` fires.
    ///
    /// `chance <= 0` never fires and `chance >= 1` always does, and **both
    /// still draw**. A conditional draw would make the stream depend on the
    /// settings, so turning recall off in the operator console would silently
    /// change every unrelated random decision the room makes afterwards.
    pub fn chance(&mut self, chance: f64) -> bool {
        let roll = self.next_f64();
        chance > 0.0 && roll < chance
    }

    /// Pick an index in `0..len`, or `None` for an empty collection.
    ///
    /// Draws either way, for the same reason [`Self::chance`] does.
    pub fn index(&mut self, len: usize) -> Option<usize> {
        let roll = self.next_f64();
        if len == 0 {
            return None;
        }
        // `roll` is strictly below 1, so the product is strictly below `len`
        // and the truncation cannot reach it. The `min` is belt and braces
        // against a future change to `next_f64`'s range.
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let index = (roll * len as f64) as usize;
        Some(index.min(len - 1))
    }
}

/// Seeding mixer. Spreads a small or structured seed across all 32 bits before
/// it reaches the generator state.
struct SplitMix32 {
    state: u32,
}

impl SplitMix32 {
    fn next(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x9E37_79B9);
        let mut z = self.state;
        z = (z ^ (z >> 16)).wrapping_mul(0x21F0_AAAD);
        z = (z ^ (z >> 15)).wrapping_mul(0x735A_2D97);
        z ^ (z >> 15)
    }
}

#[cfg(test)]
mod tests {
    use super::Rng;

    /// The shared vectors, as the checked-in file holds them.
    ///
    /// This test reads the same file `lib/room-rng.test.ts` reads. Generating
    /// the file from this crate and then *checking* it from this crate is not
    /// circular: the file is committed, so a change to the generator makes this
    /// fail against the recorded stream, and a regenerated file makes the
    /// TypeScript fail against the new one. Either way somebody has to look at
    /// a red test before every saved room resumes into a different stream.
    fn vectors() -> serde_json::Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/vectors/rng.json");
        let bytes = std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("{path}: {error}; regenerate with `cargo run -p room-engine --example rng-vectors > tests/vectors/rng.json`"));
        serde_json::from_str(&bytes).expect("the vectors are JSON")
    }

    /// The generator still produces the stream that was recorded.
    ///
    /// Not a tautology against the example that wrote the file: the file is
    /// committed, so this compares today's code against the stream the gallery
    /// has been running on.
    #[test]
    fn the_recorded_stream_is_the_one_this_build_produces() {
        let recorded = vectors();
        let samples = usize::try_from(recorded["samples"].as_u64().expect("a sample count"))
            .expect("a sample count that fits a pointer");
        let streams = recorded["streams"].as_array().expect("some streams");
        assert!(streams.len() >= 6, "too few seeds to catch a port error");

        for stream in streams {
            let seed = stream["seed"].as_u64().expect("a seed");
            let mut rng = Rng::new(seed);
            let words: Vec<u64> = (0..samples).map(|_| u64::from(rng.next_u32())).collect();
            let expected: Vec<u64> = stream["words"]
                .as_array()
                .expect("words")
                .iter()
                .map(|value| value.as_u64().expect("a word"))
                .collect();
            assert_eq!(words, expected, "raw words moved for seed {seed}");

            // The unit interval is checked against the recorded *words*, not
            // against the recorded decimals. `serde_json` 1.0.151 does not
            // parse every seventeen-digit decimal to the nearest `f64` —
            // `0.11602121056057513` comes back one unit in the last place low
            // — so re-reading its own output here would fail on the instrument
            // rather than on the generator. V8's parser is correctly rounded,
            // which is why `lib/room-rng.test.ts` *can* compare the decimals,
            // and that asymmetry is the same one `docs/ARCHITECTURE.md`
            // records for the parity scenarios.
            //
            // Dividing the word is not a weaker check: it is the definition of
            // `next_f64`, so this asserts the identity exactly.
            let mut unit = Rng::new(seed);
            for word in &expected {
                #[allow(clippy::cast_possible_truncation)]
                let from_word = *word as u32;
                assert_eq!(
                    unit.next_f64(),
                    f64::from(from_word) / 4_294_967_296.0,
                    "the unit interval moved for seed {seed}"
                );
            }

            let mut rolled = Rng::new(seed);
            let chances: Vec<bool> = (0..samples).map(|_| rolled.chance(0.08)).collect();
            let expected_chances: Vec<bool> = stream["chances"]
                .as_array()
                .expect("chances")
                .iter()
                .map(|value| value.as_bool().expect("a roll"))
                .collect();
            assert_eq!(chances, expected_chances, "chance moved for seed {seed}");

            let at = stream["restoreAt"].as_u64().expect("a restore position");
            let mut after = Rng::restore(seed, at);
            let resumed: Vec<u64> = (0..8).map(|_| u64::from(after.next_u32())).collect();
            let expected_resumed: Vec<u64> = stream["afterRestore"]
                .as_array()
                .expect("afterRestore")
                .iter()
                .map(|value| value.as_u64().expect("a word"))
                .collect();
            assert_eq!(resumed, expected_resumed, "restore moved for seed {seed}");
        }
    }

    #[test]
    fn the_same_seed_gives_the_same_stream() {
        let a: Vec<u32> = (0..64).map(|_| Rng::new(12_345).next_u32()).collect();
        let mut rng = Rng::new(12_345);
        let b: Vec<u32> = (0..64).map(|_| rng.next_u32()).collect();
        assert_eq!(a[0], b[0]);
        let mut again = Rng::new(12_345);
        assert_eq!(b, (0..64).map(|_| again.next_u32()).collect::<Vec<_>>());
    }

    #[test]
    fn different_seeds_diverge_immediately() {
        let mut one = Rng::new(1);
        let mut two = Rng::new(2);
        let first: Vec<u32> = (0..8).map(|_| one.next_u32()).collect();
        let second: Vec<u32> = (0..8).map(|_| two.next_u32()).collect();
        assert_ne!(first, second);
    }

    /// The seeding hazard sfc32 actually has: an all-zero state emits zero
    /// forever. A seed of 0 is the most likely thing a caller passes.
    #[test]
    fn a_seed_of_zero_still_produces_a_live_stream() {
        let mut rng = Rng::new(0);
        let values: Vec<u32> = (0..32).map(|_| rng.next_u32()).collect();
        assert!(
            values.iter().any(|&v| v != 0),
            "seed 0 must not produce a constant stream"
        );
        assert!(values.windows(2).any(|w| w[0] != w[1]));
    }

    #[test]
    fn restoring_lands_exactly_where_the_stream_was() {
        let mut live = Rng::new(0xABCD_EF01);
        for _ in 0..5_000 {
            live.next_u32();
        }
        let restored = Rng::restore(0xABCD_EF01, 5_000);
        assert_eq!(restored, live);
        assert_eq!(restored.draws(), 5_000);
    }

    /// Restore is linear in the number of draws, so the claim in its doc
    /// comment is worth checking rather than asserting.
    #[test]
    // The budget is for the optimised build a gallery runs (under 0.01 s here);
    // a debug build sharing the machine with the rest of the suite measures
    // the test harness, not the restore. package.json's test:rust runs this
    // with --release.
    #[cfg_attr(debug_assertions, ignore = "timed in release: cargo test --release")]
    fn restoring_a_fortnight_of_draws_is_fast_enough_to_do_at_startup() {
        // A fortnight at the room's busiest: ~24 Hz sensing, a few draws a
        // step, twelve hours a day.
        let draws = 24 * 6 * 60 * 60 * 12 * 14;
        let started = std::time::Instant::now();
        let rng = Rng::restore(7, draws);
        let elapsed = started.elapsed();
        assert_eq!(rng.draws(), draws);
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "restoring {draws} draws took {elapsed:?}; a gallery machine restarts in the morning"
        );
    }

    /// Every value is in range, and the range is half-open, so `index` can
    /// never select past the end of a collection.
    #[test]
    fn the_unit_interval_is_half_open() {
        let mut rng = Rng::new(99);
        let mut saw_low = false;
        for _ in 0..100_000 {
            let value = rng.next_f64();
            assert!((0.0..1.0).contains(&value), "{value} is outside [0, 1)");
            if value < 0.001 {
                saw_low = true;
            }
        }
        assert!(saw_low, "a stream that never approaches 0 is not uniform");
    }

    #[test]
    fn an_index_is_always_selectable_and_never_past_the_end() {
        let mut rng = Rng::new(4);
        for _ in 0..10_000 {
            let index = rng
                .index(7)
                .expect("a non-empty collection always yields an index");
            assert!(index < 7);
        }
        assert_eq!(rng.index(0), None);
    }

    /// The property that keeps the operator console from perturbing unrelated
    /// behaviour: turning a setting to zero must not shift the stream.
    #[test]
    fn a_refused_roll_consumes_the_same_stream_as_an_accepted_one() {
        let mut never = Rng::new(31);
        let mut always = Rng::new(31);
        for _ in 0..100 {
            assert!(!never.chance(0.0));
            assert!(always.chance(1.0));
        }
        assert_eq!(never.draws(), always.draws());
        assert_eq!(
            never.next_u32(),
            always.next_u32(),
            "the streams stayed aligned"
        );
    }

    #[test]
    fn a_chance_of_one_always_fires_and_a_chance_of_zero_never_does() {
        let mut rng = Rng::new(8);
        for _ in 0..5_000 {
            assert!(rng.chance(1.0));
            assert!(!rng.chance(0.0));
            assert!(!rng.chance(-1.0));
        }
    }

    /// Roughly uniform, because a generator that is reproducible and biased is
    /// worse than one that is neither: the bias would become part of the
    /// artwork's behaviour without anyone deciding it should be.
    #[test]
    fn the_stream_is_close_enough_to_uniform_for_the_decisions_it_makes() {
        let mut rng = Rng::new(0x5EED);
        let mut buckets = [0u32; 10];
        let samples = 200_000;
        for _ in 0..samples {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let bucket = (rng.next_f64() * 10.0) as usize;
            if let Some(slot) = buckets.get_mut(bucket.min(9)) {
                *slot += 1;
            }
        }
        let expected = f64::from(samples) / 10.0;
        for (index, &count) in buckets.iter().enumerate() {
            let deviation = (f64::from(count) - expected).abs() / expected;
            assert!(
                deviation < 0.05,
                "bucket {index} is {deviation:.3} off uniform"
            );
        }
    }
}
