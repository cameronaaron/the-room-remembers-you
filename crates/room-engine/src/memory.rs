//! What happens to a memory when the room reaches for it.
//!
//! A port of the recall primitives in `lib/memory-engine.ts` and
//! `lib/memory-records.ts`, which remain authoritative in the gallery until
//! this agrees with them. These are the arithmetic underneath recall
//! scheduling rather than the scheduling itself: what a ghost becomes when it
//! is replayed, what a whisper becomes, what two memories make together, and
//! which memory the room reaches for.
//!
//! # Nothing recalled remains unchanged
//!
//! That is the rule the whole piece rests on, and it is four things at once:
//! every replay raises `recall_count`, lowers `fidelity`, mutates the `path`,
//! and reinforces `strength`. A recall that left a memory intact would make the
//! room a slideshow of fixed images; a recall that only degraded it would make
//! the room forget everything it ever looked at. The pair is the point.
//!
//! # Randomness is a parameter
//!
//! Every function here that draws takes the room's [`Rng`](crate::rng::Rng).
//! `lib/room-rng.ts` is the same generator, so a session can be replayed across
//! the boundary rather than approximately. The draw *order* is part of the
//! contract — two engines that draw the same values in a different order are
//! two different rooms — so it is stated at each site rather than left to be
//! inferred.
//!
//! # No clock
//!
//! `Date.now()` appears three times in the TypeScript these came from, to stamp
//! `last_replayed_at` and to name a composite. Here the caller passes the
//! instant. A pure engine that reads a clock cannot be replayed, which is the
//! one property this crate exists to have.

use room_protocol::{Ghost, LINEAGE_MAX, Lineage, MemoryId, PathPoints, Point, Whisper};

use crate::math::clamp;
use crate::path::normalize_path;
use crate::rng::Rng;

/// Samples a recalled path is resampled to, bounded either side.
///
/// The lower bound keeps a short walk from degenerating into a line as it is
/// smoothed; the upper keeps a long one from carrying more detail than the
/// renderer draws. Both mirror `rememberGhost`.
const RECALL_SAMPLES_MIN: usize = 12;
const RECALL_SAMPLES_MAX: usize = 72;

/// Floors on fidelity. A memory decays towards a shape, never to nothing.
const GHOST_FIDELITY_FLOOR: f64 = 0.04;
const WHISPER_FIDELITY_FLOOR: f64 = 0.03;

/// How much a replay reinforces what it degrades.
const GHOST_REINFORCEMENT: f64 = 0.12;
const WHISPER_REINFORCEMENT: f64 = 0.08;

/// Shortest envelope worth keeping. Below this a whisper is a click.
const ENVELOPE_MIN: usize = 3;

/// How a recalled memory renders, settling upwards a little on each replay.
const INTENSITY_DECAY: f64 = 0.96;
const INTENSITY_GAIN: f64 = 0.025;

/// What a composite starts life with. Deliberately low on all three: a false
/// memory should read as something the room is unsure of.
const FALSE_INTENSITY: f64 = 0.28;
const FALSE_STRENGTH: f64 = 0.24;
const FALSE_FIDELITY_SCALE: f64 = 0.72;

/// Samples each parent contributes to a composite, and where they are joined.
const FALSE_SAMPLES: usize = 24;
const FALSE_SEAM: usize = 12;

/// How far a whisper's envelope bends the path of a memory it is part of.
const FALSE_VOICE_BEND: f64 = 0.025;

/// Lose strength over time.
///
/// Halving rather than an exponential decay constant, because the setting an
/// operator is given is a half-life in hours and the arithmetic should be the
/// thing they were promised.
#[must_use]
pub fn decay_strength(strength: f64, elapsed_seconds: f64, half_life_hours: f64) -> f64 {
    let half_life = (half_life_hours * 3600.0).max(1.0);
    clamp(
        strength * 2.0_f64.powf(-elapsed_seconds / half_life),
        0.0,
        1.0,
    )
}

/// Gain strength, by a share of what is left to gain.
///
/// So reinforcement never overshoots and a memory already held firmly gains
/// less from a replay than one barely held at all.
#[must_use]
pub fn reinforce_strength(strength: f64, amount: f64) -> f64 {
    clamp(
        strength + (1.0 - strength) * clamp(amount, 0.0, 1.0),
        0.0,
        1.0,
    )
}

/// Whether an event at `rate_per_second` happens in `elapsed_seconds`.
///
/// A Poisson arrival rather than a per-frame probability. Rolling once per
/// analysis tick tied the room's pace to the hardware profile — the same
/// installation remembered 2.4x more often on FULL than on CHEAP — so the
/// chance is derived from wall-clock time and the caller banks the elapsed
/// seconds between rolls.
///
/// The elapsed time is clamped to a minute: a tab that was backgrounded for an
/// hour must not bank an hour of chances and fire the instant it returns.
#[must_use]
pub fn event_chance(rate_per_second: f64, elapsed_seconds: f64) -> f64 {
    let rate = rate_per_second.max(0.0);
    let elapsed = elapsed_seconds.clamp(0.0, 60.0);
    1.0 - (-rate * elapsed).exp()
}

/// What a remembered walk becomes when the room replays it.
///
/// Four things at once, and all four are the rule: `recall_count` rises,
/// `fidelity` falls, the `path` mutates, `strength` is reinforced.
///
/// # Draw order
///
/// One draw for the fidelity loss, then two per path point — x before y. The
/// TypeScript draws in exactly that order and a different one is a different
/// room, not a rounding difference.
#[must_use]
pub fn remember_ghost(ghost: &Ghost, now: f64, rng: &mut Rng) -> Ghost {
    let fidelity = clamp(
        ghost.fidelity * (0.93 - rng.next_f64() * 0.025),
        GHOST_FIDELITY_FLOOR,
        1.0,
    );
    let samples = ghost
        .path
        .len()
        .clamp(RECALL_SAMPLES_MIN, RECALL_SAMPLES_MAX);
    let source = normalize_path(&ghost.path.iter().copied().collect::<Vec<Point>>(), samples);
    let mutation = (1.0 - fidelity) * 0.035;

    let mut path = PathPoints::new();
    for index in 0..source.len() {
        let last = source.len().saturating_sub(1);
        let (Some(point), Some(before), Some(after)) = (
            source.get(index),
            source.get(index.saturating_sub(1)),
            source.get(index.saturating_add(1).min(last)),
        ) else {
            continue;
        };
        // A weighted average of a point and its neighbours, which is what makes
        // a remembered walk lose its corners before it loses its route.
        let smoothed_x = before.x * 0.2 + point.x * 0.6 + after.x * 0.2;
        let smoothed_y = before.y * 0.2 + point.y * 0.6 + after.y * 0.2;
        path.push(Point {
            x: clamp(smoothed_x + (rng.next_f64() - 0.5) * mutation, 0.0, 1.0),
            y: clamp(smoothed_y + (rng.next_f64() - 0.5) * mutation, 0.0, 1.0),
            t: point.t,
        });
    }

    Ghost {
        path,
        last_replayed_at: now,
        recall_count: ghost.recall_count.saturating_add(1),
        fidelity,
        strength: reinforce_strength(ghost.strength, GHOST_REINFORCEMENT),
        intensity: clamp(ghost.intensity * INTENSITY_DECAY + INTENSITY_GAIN, 0.0, 1.0),
        ..ghost.clone()
    }
}

/// What the texture of something said becomes when the room replays it.
///
/// The envelope is thinned in proportion to what fidelity is left, then each
/// surviving point is smoothed against the one before it and scaled by a small
/// draw. A voice recalled often becomes a shape rather than a phrase, which is
/// the honest rendering of a memory of a sound.
///
/// # Draw order
///
/// One draw for the fidelity loss, then one per surviving envelope point.
#[must_use]
pub fn remember_whisper(whisper: &Whisper, now: f64, rng: &mut Rng) -> Whisper {
    let fidelity = clamp(
        whisper.fidelity * (0.88 - rng.next_f64() * 0.04),
        WHISPER_FIDELITY_FLOOR,
        1.0,
    );
    // The thinning step: at full fidelity every point survives, and as
    // fidelity falls the envelope keeps every second, third, fourth point.
    // `fidelity.max(0.08)` caps the stride, so a nearly-lost voice is sparse
    // rather than empty.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let stride = ((1.0 / fidelity.max(0.08)).floor() as usize).max(1);

    let kept: Vec<f64> = whisper
        .envelope
        .iter()
        .enumerate()
        .filter(|(index, _)| index % stride == 0)
        .map(|(_, value)| *value)
        .collect();
    let mut smoothed: Vec<f64> = Vec::with_capacity(kept.len());
    for (index, value) in kept.iter().enumerate() {
        // Index 0 reads itself, so the first point smooths against nothing.
        let neighbour = kept.get(index.saturating_sub(1)).copied().unwrap_or(*value);
        smoothed.push(clamp(
            (value * 0.68 + neighbour * 0.32) * (0.9 + rng.next_f64() * 0.08),
            0.0,
            1.0,
        ));
    }

    // A voice thinned below three points is a click, not a memory of a sound.
    // The original's opening is kept instead, unsmoothed: better a fragment of
    // what was said than an artefact of the smoothing.
    let envelope = if smoothed.len() >= ENVELOPE_MIN {
        smoothed
    } else {
        whisper
            .envelope
            .iter()
            .copied()
            .take(ENVELOPE_MIN)
            .collect()
    };

    Whisper {
        envelope: room_protocol::Envelope::from_iter_bounded(envelope),
        fidelity,
        strength: reinforce_strength(whisper.strength, WHISPER_REINFORCEMENT),
        recall_count: whisper.recall_count.saturating_add(1),
        last_replayed_at: now,
        ..whisper.clone()
    }
}

/// A memory of something that did not happen, made from two that did.
///
/// The first half of one walk joined to the second half of another, with the
/// second translated so the seam does not jump, and optionally bent by the
/// shape of a voice recorded nearby. It is the room being unreliable on
/// purpose, and it is the only thing the room does that is not true.
///
/// A composite runs cold — [`FALSE_INTENSITY`] against the 0.85 to 1.0 of a
/// genuine recall — which is the single wordless signal a visitor is given
/// that a memory is fabricated.
///
/// # Naming
///
/// Named *after* its parents rather than *from* them: `false-<base36
/// now>-<hash>`. Embedding the parents' ids made the length roughly 2.6x per
/// generation — measured at 38,312 characters by the eighth — and the
/// provenance belongs in `lineage`, which is bounded and which the recall
/// rules already require. `lib/memory-engine.ts` mints the identical id.
#[must_use]
pub fn create_false_memory(
    first: &Ghost,
    second: &Ghost,
    now: f64,
    voice: Option<&Whisper>,
) -> Ghost {
    let a = normalize_path(
        &first.path.iter().copied().collect::<Vec<Point>>(),
        FALSE_SAMPLES,
    );
    let b = normalize_path(
        &second.path.iter().copied().collect::<Vec<Point>>(),
        FALSE_SAMPLES,
    );
    // The seam: the last point of the first half against the first point of
    // the second, so the join is a continuation rather than a jump.
    let offset_x = a
        .get(FALSE_SEAM.saturating_sub(1))
        .zip(b.get(FALSE_SEAM))
        .map_or(0.0, |(end, start)| end.x - start.x);
    let offset_y = a
        .get(FALSE_SEAM.saturating_sub(1))
        .zip(b.get(FALSE_SEAM))
        .map_or(0.0, |(end, start)| end.y - start.y);

    let envelope: Vec<f64> = voice
        .map(|whisper| whisper.envelope.iter().copied().collect())
        .unwrap_or_default();
    let mut path = PathPoints::new();
    for (index, point) in a
        .iter()
        .take(FALSE_SEAM)
        .copied()
        .chain(b.iter().skip(FALSE_SEAM).map(|point| Point {
            x: clamp(point.x + offset_x, 0.0, 1.0),
            y: clamp(point.y + offset_y, 0.0, 1.0),
            t: point.t,
        }))
        .enumerate()
    {
        // The voice bends the path it is part of, which is how a whisper
        // reaches the wall as a shape rather than as a label.
        let bent = if envelope.is_empty() {
            point.y
        } else {
            let at = envelope.get(index % envelope.len()).copied().unwrap_or(0.5);
            clamp(point.y + (at - 0.5) * FALSE_VOICE_BEND, 0.0, 1.0)
        };
        path.push(Point {
            x: point.x,
            y: bent,
            t: point.t,
        });
    }

    let mut lineage = Lineage::new();
    // Order matches the TypeScript's: each parent's own lineage, then the
    // parent, then the voice. When it overflows, `Bounded` keeps the most
    // recent — which are the immediate parents, the useful end of a chain.
    for id in first
        .lineage
        .iter()
        .chain(std::iter::once(&first.id))
        .chain(second.lineage.iter())
        .chain(std::iter::once(&second.id))
        .chain(voice.map(|whisper| &whisper.id))
    {
        if lineage.iter().any(|held| held == id) {
            continue;
        }
        lineage.push(id.clone());
    }

    Ghost {
        id: composite_id(now, &first.id, &second.id),
        created_at: now,
        last_replayed_at: 0.0,
        path,
        dwell_seconds: f64::midpoint(first.dwell_seconds, second.dwell_seconds),
        intensity: FALSE_INTENSITY,
        strength: FALSE_STRENGTH,
        fidelity: first.fidelity.min(second.fidelity) * FALSE_FIDELITY_SCALE,
        recall_count: 0,
        lineage,
        false_memory: true,
        day: first.day.max(second.day),
    }
}

/// The name a composite is given. Bounded, and identical to `lib/memory-engine.ts`.
#[must_use]
pub fn composite_id(now: f64, first: &MemoryId, second: &MemoryId) -> MemoryId {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let stamp = base36(now.max(0.0) as u64);
    let hash = base36(u64::from(id_hash(&[first.as_str(), second.as_str()])));
    // `minted` rather than `new`: a composite has been made and it needs a
    // handle, so there is no sensible way to fail here. It alters nothing —
    // a prefix, a base 36 stamp and a base 36 hash is 23 characters of
    // `[a-z0-9-]` against a ceiling of 64 — and it means this site does not
    // have to choose between an `unwrap` and a fallback invented on the spot.
    MemoryId::minted(&format!("false-{stamp}-{hash}"))
}

/// A 32-bit FNV-1a hash of several strings.
///
/// FNV-1a because it is four lines and expressible exactly in both languages —
/// a wrapping multiply here, `Math.imul` in JavaScript — which is the same
/// reason [`Rng`](crate::rng::Rng) is sfc32. It is not cryptographic and does
/// not need to be; it distinguishes one composite from another inside a single
/// millisecond.
#[must_use]
pub fn id_hash(parts: &[&str]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for part in parts {
        for byte in part.bytes() {
            hash = (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193);
        }
        // A separator inside the hash, so ("ab", "c") and ("a", "bc") differ.
        hash = (hash ^ 0x1f).wrapping_mul(0x0100_0193);
    }
    hash
}

/// Base 36, lowercase, matching JavaScript's `Number.prototype.toString(36)`.
fn base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while value > 0 {
        #[allow(clippy::cast_possible_truncation)]
        let digit = (value % 36) as usize;
        out.push(DIGITS.get(digit).copied().unwrap_or(b'0'));
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Choose a memory, favouring the ones the room has not shown lately.
///
/// Weighted by minutes since it was created or last replayed, whichever is
/// more recent, with a floor of one so a just-recalled memory is unlikely
/// rather than impossible. Uniform choice would let a small collection replay
/// the same two memories all evening, which reads as a loop; weighting by
/// neglect is what makes a returning visitor meet something they have not
/// already seen.
///
/// Returns the index rather than the memory, so a caller that needs to write
/// the recalled version back does not have to search for it again.
///
/// # Draw order
///
/// Exactly one draw, taken **before** the empty check, so that turning recall
/// off or emptying the room does not shift every later decision in the stream.
#[must_use]
pub fn choose_rare(ghosts: &[Ghost], now: f64, rng: &mut Rng) -> Option<usize> {
    let roll = rng.next_f64();
    if ghosts.is_empty() {
        return None;
    }
    let weight =
        |ghost: &Ghost| ((now - ghost.created_at.max(ghost.last_replayed_at)) / 60_000.0).max(1.0);
    let total: f64 = ghosts.iter().map(weight).sum();
    let mut target = roll * total;
    for (index, ghost) in ghosts.iter().enumerate() {
        target -= weight(ghost);
        if target <= 0.0 {
            return Some(index);
        }
    }
    // A draw of very nearly one leaves `target` above zero after the last
    // subtraction only within floating-point luck; falling back to the first
    // keeps this total, exactly as `chooseRareGhost` does.
    Some(0)
}

/// The room admits only `LINEAGE_MAX` sources per composite, which is the same
/// figure `lib/memory-engine.ts` holds.
const _: () = assert!(LINEAGE_MAX == 64);

#[cfg(test)]
mod tests {
    use super::*;
    use room_protocol::{MEMORY_ID_MAX, Vec2};

    fn id(text: &str) -> MemoryId {
        MemoryId::new(text).expect("a test id")
    }

    fn ghost(name: &str, points: usize) -> Ghost {
        Ghost {
            id: id(name),
            created_at: 1_000.0,
            last_replayed_at: 0.0,
            path: PathPoints::from_iter_bounded((0..points).map(|step| {
                let at = f64::from(u32::try_from(step).expect("a small path"));
                Point::new(0.1 + at * 0.02, 0.4 + (at * 0.3).sin() * 0.1, at * 100.0)
            })),
            dwell_seconds: 6.0,
            intensity: 0.5,
            strength: 0.5,
            fidelity: 1.0,
            recall_count: 0,
            lineage: Lineage::new(),
            false_memory: false,
            day: 1,
        }
    }

    fn whisper(name: &str, points: usize) -> Whisper {
        Whisper {
            id: id(name),
            created_at: 500.0,
            last_replayed_at: 0.0,
            duration: 1.5,
            envelope: room_protocol::Envelope::from_iter_bounded((0..points).map(|step| {
                let at = f64::from(u32::try_from(step).expect("a small envelope"));
                0.2 + (at * 0.4).sin().abs() * 0.7
            })),
            brightness: 0.5,
            position: Vec2::new(0.5, 0.5),
            strength: 0.5,
            fidelity: 1.0,
            recall_count: 0,
            lineage: Lineage::new(),
            day: 1,
        }
    }

    /// The rule the whole piece rests on, as four assertions.
    #[test]
    fn nothing_recalled_remains_unchanged() {
        let held = ghost("g-1a2b3c", 20);
        let mut rng = Rng::new(7);
        let recalled = remember_ghost(&held, 5_000.0, &mut rng);
        assert_eq!(recalled.recall_count, held.recall_count + 1);
        assert!(recalled.fidelity < held.fidelity, "fidelity must fall");
        assert!(recalled.strength > held.strength, "strength must rise");
        assert_eq!(recalled.last_replayed_at, 5_000.0);
        let before: Vec<(f64, f64)> = held.path.iter().map(|p| (p.x, p.y)).collect();
        let after: Vec<(f64, f64)> = recalled.path.iter().map(|p| (p.x, p.y)).collect();
        assert_ne!(before, after, "the path must mutate");
    }

    /// A memory decays towards a shape, never to nothing, however often it is
    /// reached for. Otherwise a room that runs for weeks ends up holding a
    /// hundred identical flat lines.
    #[test]
    fn a_memory_recalled_all_day_keeps_a_floor_and_a_shape() {
        let mut held = ghost("g-1a2b3c", 40);
        let mut rng = Rng::new(11);
        for _ in 0..2_000 {
            held = remember_ghost(&held, 5_000.0, &mut rng);
            assert!(held.fidelity >= GHOST_FIDELITY_FLOOR);
            assert!(held.strength <= 1.0 && held.intensity <= 1.0);
            assert!(held.path.len() >= RECALL_SAMPLES_MIN);
            assert!(held.path.len() <= RECALL_SAMPLES_MAX);
            assert!(held.path.iter().all(|p| (0.0..=1.0).contains(&p.x)));
        }
        assert_eq!(held.fidelity, GHOST_FIDELITY_FLOOR);
    }

    #[test]
    fn a_voice_recalled_all_day_thins_towards_a_shape_and_stops() {
        let mut held = whisper("w-1a2b3c", 32);
        let mut rng = Rng::new(3);
        for _ in 0..500 {
            held = remember_whisper(&held, 900.0, &mut rng);
            assert!(held.fidelity >= WHISPER_FIDELITY_FLOOR);
            assert!(
                held.envelope.len() >= ENVELOPE_MIN,
                "a click is not a memory"
            );
            assert!(
                held.envelope
                    .iter()
                    .all(|value| (0.0..=1.0).contains(value))
            );
        }
        assert_eq!(held.fidelity, WHISPER_FIDELITY_FLOOR);
    }

    /// §12, and the reason the Rust found it: a composite's name must not grow
    /// with its ancestry.
    #[test]
    fn compositing_composites_cannot_grow_a_name_or_a_lineage() {
        let mut first = ghost("g-1a2b3c", 24);
        let mut second = ghost("g-4d5e6f", 24);
        for generation in 1..=24_u32 {
            let made = create_false_memory(&first, &second, f64::from(generation), None);
            assert!(made.id.as_str().len() <= MEMORY_ID_MAX);
            assert!(made.lineage.len() <= LINEAGE_MAX);
            assert!(made.false_memory);
            second = create_false_memory(&second, &made, f64::from(generation) + 1.0, None);
            first = made;
        }
        // And the provenance that survives is the useful end: the parents.
        let last = create_false_memory(&first, &second, 99.0, None);
        assert!(last.lineage.iter().any(|held| *held == first.id));
        assert!(last.lineage.iter().any(|held| *held == second.id));
    }

    /// A composite is named after its parents, so the same pair in the same
    /// millisecond names the same memory — and the order they were joined in
    /// is part of what was made.
    #[test]
    fn a_composite_is_named_deterministically_from_what_it_was_made_of() {
        let one = ghost("g-aaa", 24);
        let two = ghost("g-bbb", 24);
        assert_eq!(
            create_false_memory(&one, &two, 99.0, None).id,
            create_false_memory(&one, &two, 99.0, None).id
        );
        assert_ne!(
            create_false_memory(&one, &two, 99.0, None).id,
            create_false_memory(&two, &one, 99.0, None).id
        );
        assert_ne!(id_hash(&["ab", "c"]), id_hash(&["a", "bc"]));
    }

    /// A composite runs cold. It is the only wordless signal a visitor is given
    /// that a memory is fabricated, so it is pinned rather than left to drift.
    #[test]
    fn a_composite_runs_cold_and_carries_both_of_its_sources() {
        let one = ghost("g-aaa", 24);
        let two = ghost("g-bbb", 24);
        let voice = whisper("w-ccc", 8);
        let made = create_false_memory(&one, &two, 4_000.0, Some(&voice));
        assert_eq!(made.intensity, FALSE_INTENSITY);
        assert_eq!(made.strength, FALSE_STRENGTH);
        assert!(made.fidelity < one.fidelity.min(two.fidelity));
        assert_eq!(made.recall_count, 0);
        for source in [&one.id, &two.id, &voice.id] {
            assert!(
                made.lineage.iter().any(|held| held == source),
                "{source} is missing from the lineage"
            );
        }
        assert!(made.path.iter().all(|p| (0.0..=1.0).contains(&p.y)));
    }

    /// Weighting by neglect is what stops a small collection looping. The claim
    /// is statistical, so it is measured over a run rather than asserted once.
    #[test]
    fn the_room_reaches_for_what_it_has_not_shown_lately() {
        let mut recent = ghost("g-recent", 12);
        recent.last_replayed_at = 590_000.0;
        let mut neglected = ghost("g-old", 12);
        neglected.last_replayed_at = 0.0;
        neglected.created_at = 0.0;
        let held = [recent, neglected];

        let mut rng = Rng::new(2_024);
        let mut chosen_neglected = 0;
        for _ in 0..10_000 {
            if choose_rare(&held, 600_000.0, &mut rng) == Some(1) {
                chosen_neglected += 1;
            }
        }
        assert!(
            chosen_neglected > 8_000,
            "the neglected memory was chosen {chosen_neglected} times in 10,000"
        );
    }

    /// The draw happens either way, so emptying the room does not shift every
    /// later decision in the stream. Same rule as `Rng::chance`.
    #[test]
    fn choosing_from_nothing_still_costs_a_draw() {
        let mut rng = Rng::new(5);
        assert_eq!(choose_rare(&[], 0.0, &mut rng), None);
        assert_eq!(rng.draws(), 1);
    }

    #[test]
    fn strength_decays_by_half_lives_and_is_reinforced_by_what_is_left() {
        assert!((decay_strength(1.0, 3600.0, 1.0) - 0.5).abs() < 1e-12);
        assert!((decay_strength(1.0, 7200.0, 1.0) - 0.25).abs() < 1e-12);
        assert_eq!(decay_strength(0.0, 100.0, 1.0), 0.0);
        // A half-life of zero would divide by zero; it is floored at a second.
        assert!(decay_strength(1.0, 1.0, 0.0) < 1.0);

        assert_eq!(reinforce_strength(0.0, 1.0), 1.0);
        assert_eq!(reinforce_strength(1.0, 1.0), 1.0);
        assert!((reinforce_strength(0.5, 0.5) - 0.75).abs() < 1e-12);
        // Reinforcement never overshoots, whatever it is handed.
        assert_eq!(reinforce_strength(0.5, 99.0), 1.0);
        assert_eq!(reinforce_strength(0.5, -99.0), 0.5);
    }

    /// The rate is against wall-clock time, not against frames. Rolling once
    /// per analysis tick made the same installation remember 2.4x more often
    /// on FULL than on CHEAP.
    #[test]
    fn the_chance_of_remembering_is_a_rate_against_the_clock() {
        assert_eq!(event_chance(0.0, 100.0), 0.0);
        assert_eq!(event_chance(1.0, 0.0), 0.0);
        assert!(event_chance(0.045, 10.0) > event_chance(0.045, 5.0));
        // A backgrounded tab must not bank an hour and fire on return.
        assert_eq!(event_chance(0.045, 3_600.0), event_chance(0.045, 60.0));
        assert_eq!(event_chance(-1.0, 10.0), 0.0);
    }

    #[test]
    fn base_thirty_six_matches_javascript() {
        for (value, expected) in [(0_u64, "0"), (35, "z"), (36, "10"), (1_295, "zz")] {
            assert_eq!(base36(value), expected);
        }
    }
}
