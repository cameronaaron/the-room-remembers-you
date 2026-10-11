//! Depositing into and decaying the memory field.
//!
//! The field is where "the room remembers you" is literally true: standing
//! somewhere raises a few cells, and those cells fade over hours. Everything
//! else — recalls, false memories, the room's mood — is built on top of it.
//!
//! # Precision, deliberately
//!
//! The field is `f32` and the arithmetic is `f64`. That is not an oversight: it
//! is what `Float32Array` does in the TypeScript engine, where every read
//! widens to a double, the arithmetic happens in doubles, and the store rounds
//! back to single. Reproducing the rounding exactly is what lets the parity
//! harness compare the two engines cell by cell instead of within a tolerance
//! chosen to hide the difference.

use room_protocol::{FIELD_HEIGHT, FIELD_WIDTH, MemoryField, Vec2};

use crate::math::clamp;

/// Raise the field around a point.
///
/// `radius` is in cells, and the Gaussian is evaluated out to twice it, which
/// is where the weight has fallen to about 1.8% and further cells would round
/// to nothing in `f32` anyway.
#[expect(
    clippy::cast_precision_loss,
    reason = "coordinates are indices into the fixed 64 by 36 field"
)]
pub fn deposit(field: &mut MemoryField, at: Vec2, amount: f64, radius: f64) {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let cx = (clamp(at.x, 0.0, 1.0) * (FIELD_WIDTH - 1) as f64).round() as usize;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let cy = (clamp(at.y, 0.0, 1.0) * (FIELD_HEIGHT - 1) as f64).round() as usize;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let reach = (radius * 2.0).ceil().max(1.0) as usize;

    let low_y = cy.saturating_sub(reach);
    let high_y = (cy.saturating_add(reach)).min(FIELD_HEIGHT - 1);
    let low_x = cx.saturating_sub(reach);
    let high_x = (cx.saturating_add(reach)).min(FIELD_WIDTH - 1);

    for y in low_y..=high_y {
        for x in low_x..=high_x {
            let dx = x as f64 - cx as f64;
            let dy = y as f64 - cy as f64;
            let distance_squared = dx * dx + dy * dy;
            let weight = (-distance_squared / (2.0 * radius * radius)).exp();
            let current = f64::from(field.get(x, y));
            #[allow(clippy::cast_possible_truncation)]
            let next = clamp(current + amount * weight, 0.0, 1.0) as f32;
            field.set(x, y, next);
        }
    }
}

/// How much a still body deposits per pass, and over how many cells.
///
/// Standing still leaves a deeper, wider mark than walking through, which is
/// the whole reason a room can be said to remember where people *stayed*
/// rather than merely where they went.
pub const STILL_AMOUNT: f64 = 0.0018;
pub const STILL_RADIUS: f64 = 3.4;
pub const MOVING_AMOUNT: f64 = 0.0008;
pub const MOVING_RADIUS: f64 = 1.8;

/// Below this speed a body counts as still.
pub const STILLNESS_SPEED: f64 = 0.025;

/// Deposit for one observed body.
///
/// `weight` is the per-visitor scale the room's interest applies: for under a
/// minute, a few times a day, one person's trace lingers a little longer than
/// anyone else's. It defaults to 1, which is what the room does for everybody
/// the rest of the time.
pub fn deposit_body(field: &mut MemoryField, at: Vec2, speed: f64, weight: f64) {
    let still = speed < STILLNESS_SPEED;
    let weight = weight.max(0.0);
    let (amount, radius) = if still {
        (STILL_AMOUNT, STILL_RADIUS)
    } else {
        (MOVING_AMOUNT, MOVING_RADIUS)
    };
    deposit(field, at, amount * weight, radius);
}

/// Fade the whole field.
///
/// `empty_multiplier` above 1 makes an unoccupied room forget faster, which is
/// what makes coming back after a while feel like coming back.
///
/// Cells below 1e-4 are zeroed rather than left as denormals: a field of
/// 2,304 values that never quite reaches zero is a field the renderer keeps
/// drawing, faintly, forever.
pub fn decay(
    field: &mut MemoryField,
    elapsed_seconds: f64,
    half_life_minutes: f64,
    empty_multiplier: f64,
) {
    let half_life = (half_life_minutes * 60.0).max(60.0);
    let decay = (-(elapsed_seconds * empty_multiplier) / half_life).exp2();
    for cell in field.as_mut_slice() {
        #[allow(clippy::cast_possible_truncation)]
        let next = (f64::from(*cell) * decay) as f32;
        *cell = next;
        if *cell < 1e-4 {
            *cell = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MOVING_AMOUNT, STILL_AMOUNT, STILLNESS_SPEED, decay, deposit, deposit_body};
    use room_protocol::{FIELD_HEIGHT, FIELD_WIDTH, MemoryField, Vec2};

    #[test]
    fn depositing_raises_the_cell_it_is_aimed_at_most() {
        let mut field = MemoryField::new();
        deposit(&mut field, Vec2::new(0.5, 0.5), 0.5, 2.0);
        let centre = field.get(FIELD_WIDTH / 2, FIELD_HEIGHT / 2);
        assert!(centre > 0.0);
        assert!(field.get(FIELD_WIDTH / 2 + 3, FIELD_HEIGHT / 2) < centre);
    }

    #[test]
    fn a_deposit_at_the_corner_stays_inside_the_room() {
        let mut field = MemoryField::new();
        deposit(&mut field, Vec2::new(0.0, 0.0), 0.9, 4.0);
        deposit(&mut field, Vec2::new(1.0, 1.0), 0.9, 4.0);
        assert!(field.get(0, 0) > 0.0);
        assert!(field.get(FIELD_WIDTH - 1, FIELD_HEIGHT - 1) > 0.0);
        assert!(field.density().is_finite());
    }

    /// The field is a density, not an accumulator. Without the ceiling, a
    /// visitor who stands in one place all afternoon produces a single cell
    /// worth thousands, which the renderer maps to the same colour as one and
    /// which never decays back within a gallery's lifetime.
    #[test]
    fn no_amount_of_standing_still_pushes_a_cell_past_one() {
        let mut field = MemoryField::new();
        for _ in 0..100_000 {
            deposit_body(&mut field, Vec2::new(0.5, 0.5), 0.0, 1.0);
        }
        assert_eq!(field.get(FIELD_WIDTH / 2, FIELD_HEIGHT / 2), 1.0);
        assert!(field.as_slice().iter().all(|&v| (0.0..=1.0).contains(&v)));
    }

    #[test]
    fn standing_still_leaves_a_deeper_mark_than_walking_through() {
        let mut still = MemoryField::new();
        let mut moving = MemoryField::new();
        deposit_body(&mut still, Vec2::new(0.5, 0.5), 0.0, 1.0);
        deposit_body(&mut moving, Vec2::new(0.5, 0.5), STILLNESS_SPEED * 2.0, 1.0);
        assert!(still.density() > moving.density());
        const {
            assert!(STILL_AMOUNT > MOVING_AMOUNT);
        }
    }

    #[test]
    fn a_body_the_room_is_interested_in_leaves_more_behind() {
        let mut ordinary = MemoryField::new();
        let mut noticed = MemoryField::new();
        deposit_body(&mut ordinary, Vec2::new(0.4, 0.4), 0.0, 1.0);
        deposit_body(&mut noticed, Vec2::new(0.4, 0.4), 0.0, 1.6);
        assert!(noticed.density() > ordinary.density());
    }

    #[test]
    fn a_negative_interest_weight_cannot_erase_a_memory() {
        let mut field = MemoryField::new();
        deposit_body(&mut field, Vec2::new(0.4, 0.4), 0.0, 1.0);
        let before = field.density();
        deposit_body(&mut field, Vec2::new(0.4, 0.4), 0.0, -5.0);
        assert_eq!(field.density(), before);
    }

    #[test]
    fn the_field_halves_over_its_half_life() {
        let mut field = MemoryField::new();
        deposit(&mut field, Vec2::new(0.5, 0.5), 0.8, 2.0);
        let before = field.density();
        decay(&mut field, 120.0 * 60.0, 120.0, 1.0);
        let after = field.density();
        assert!((after / before - 0.5).abs() < 0.01, "{before} -> {after}");
    }

    #[test]
    fn an_empty_room_forgets_faster() {
        let seed = |f: &mut MemoryField| deposit(f, Vec2::new(0.5, 0.5), 0.8, 2.0);
        let mut occupied = MemoryField::new();
        let mut empty = MemoryField::new();
        seed(&mut occupied);
        seed(&mut empty);
        decay(&mut occupied, 600.0, 120.0, 1.0);
        decay(&mut empty, 600.0, 120.0, 3.0);
        assert!(empty.density() < occupied.density());
    }

    /// A field that decays asymptotically is a field the renderer keeps
    /// drawing faintly forever, and a room that is never truly empty.
    #[test]
    fn the_field_reaches_exactly_empty_rather_than_approaching_it() {
        let mut field = MemoryField::new();
        deposit(&mut field, Vec2::new(0.5, 0.5), 1.0, 3.0);
        for _ in 0..200 {
            decay(&mut field, 600.0, 10.0, 1.0);
        }
        assert_eq!(field.density(), 0.0);
        assert!(field.as_slice().iter().all(|&v| v == 0.0));
    }

    #[test]
    fn decay_over_no_time_changes_nothing() {
        let mut field = MemoryField::new();
        deposit(&mut field, Vec2::new(0.5, 0.5), 0.8, 2.0);
        let before = field.as_slice().to_vec();
        decay(&mut field, 0.0, 120.0, 1.0);
        assert_eq!(field.as_slice(), before.as_slice());
    }

    /// A half-life below a minute is floored rather than dividing by zero.
    #[test]
    fn an_absurd_half_life_is_floored_rather_than_fatal() {
        let mut field = MemoryField::new();
        deposit(&mut field, Vec2::new(0.5, 0.5), 1.0, 2.0);
        decay(&mut field, 1.0, 0.0, 1.0);
        assert!(field.density().is_finite());
        assert!(
            field.density() > 0.0,
            "one second at the floor half-life is not oblivion"
        );
    }
}
