//! First migrated engine subsystem: bounded field state and coarse frame input.
//! Association, recalls and attention remain in TS until their parity gates pass.
use crate::field;
use room_protocol::{FIELD_CELLS, MemoryField, TRACKS_MAX, Vec2};

/// Maximum commands in one analysis frame (visitors plus recall/voice deposits).
pub const MAX_DEPOSITS: usize = TRACKS_MAX + 8;
/// Each deposit is x, y, amount, radius. No media or free-form payload.
pub const DEPOSIT_STRIDE: usize = 4;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FieldEngine {
    field: MemoryField,
    tick: u64,
}

impl FieldEngine {
    pub fn step(
        &mut self,
        deposits: &[f64],
        elapsed: f64,
        half_life: f64,
        empty: f64,
    ) -> Result<(), &'static str> {
        // Validate the entire batch before mutation. A bad last record must not
        // leave the first record applied when the shell retries on its fallback.
        if deposits.len() > MAX_DEPOSITS * DEPOSIT_STRIDE
            || !deposits.len().is_multiple_of(DEPOSIT_STRIDE)
        {
            return Err("invalid deposit count");
        }
        if !elapsed.is_finite()
            || !(0.0..=86_400.0).contains(&elapsed)
            || !half_life.is_finite()
            || !(1.0..=1440.0).contains(&half_life)
            || !empty.is_finite()
            || !(1.0..=10_000.0).contains(&empty)
        {
            return Err("invalid decay parameters");
        }
        // The length check above leaves no remainder, so `.0` is every record.
        let records = deposits.as_chunks::<DEPOSIT_STRIDE>().0;
        for &[x, y, amount, radius] in records {
            if ![x, y, amount, radius].iter().all(|v| v.is_finite())
                || !(0.0..=1.0).contains(&x)
                || !(0.0..=1.0).contains(&y)
                || !(0.0..=1.0).contains(&amount)
                || !(0.01..=64.0).contains(&radius)
            {
                return Err("invalid deposit");
            }
        }
        for &[x, y, amount, radius] in records {
            field::deposit(&mut self.field, Vec2::new(x, y), amount, radius);
        }
        // Zero means no upkeep happened this analysis frame. In particular,
        // don't prune sub-threshold deposits earlier than the existing engine.
        if elapsed > 0.0 {
            field::decay(&mut self.field, elapsed, half_life, empty);
        }
        self.tick = self.tick.saturating_add(1);
        Ok(())
    }

    pub fn restore(&mut self, values: &[f32]) -> Result<(), &'static str> {
        if values.len() != FIELD_CELLS
            || values
                .iter()
                .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
        {
            return Err("expected 2304 finite densities in 0..1");
        }
        self.field = MemoryField::from_saved(values);
        Ok(())
    }
    pub fn reset(&mut self) {
        self.field.clear();
    }
    #[must_use]
    pub const fn tick(&self) -> u64 {
        self.tick
    }
    #[must_use]
    pub fn snapshot(&self) -> &[f32] {
        self.field.as_slice()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_batches_are_atomic_and_cannot_advance_time() {
        let mut brain = FieldEngine::default();
        let before = brain.clone();
        for values in [
            vec![0.5, 0.5, 0.1],
            vec![0.5, 0.5, 0.1, 2.0, f64::NAN, 0.5, 0.1, 2.0],
            vec![0.0; 4 * (MAX_DEPOSITS + 1)],
        ] {
            assert!(brain.step(&values, 0.0, 120.0, 1.0).is_err());
            assert_eq!(brain, before);
        }
        for dt in [f64::NAN, f64::INFINITY, -1.0, 86_401.0] {
            assert!(brain.step(&[], dt, 120.0, 1.0).is_err());
            assert_eq!(brain, before);
        }
    }
    #[test]
    fn restore_rejects_invalid_state_without_erasing_the_room() {
        let mut brain = FieldEngine::default();
        brain.step(&[0.5, 0.5, 0.1, 2.0], 0.0, 120.0, 1.0).unwrap();
        let before = brain.clone();
        assert!(brain.restore(&[0.0; 3]).is_err());
        assert!(brain.restore(&[f32::NAN; FIELD_CELLS]).is_err());
        assert_eq!(brain, before);
    }
    #[test]
    fn a_twelve_hour_replay_is_deterministic_and_bounded() {
        let mut a = FieldEngine::default();
        let mut b = a.clone();
        for t in 0..43_200_u32 {
            let batch = [f64::from(t % 100) / 100.0, 0.5, 0.0018, 3.4];
            a.step(&batch, 1.0, 120.0, 1.0).unwrap();
            b.step(&batch, 1.0, 120.0, 1.0).unwrap();
        }
        assert_eq!(a, b);
        assert_eq!(a.snapshot().len(), 2304);
        assert_eq!(a.tick(), 43_200);
        assert!(
            a.snapshot()
                .iter()
                .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
        );
        a.reset();
        assert!(a.snapshot().iter().all(|&v| v == 0.0));
        assert_eq!(
            a.tick(),
            43_200,
            "reset must not roll back progress counters"
        );
    }
}
