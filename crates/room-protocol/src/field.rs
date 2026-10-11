//! The memory field: where the room has been lived in.
//!
//! A fixed 64x36 grid of `f32` densities in 0..1, one value per cell, in room
//! coordinates. Deposited into by bodies that are actually observed, decayed
//! continuously, and read by the renderer as the flow the particles run along.
//!
//! Fixed size on purpose. It is the largest thing that crosses the WASM
//! boundary every frame, and a fixed extent means the JavaScript side can hold
//! one `Float32Array` view over WASM memory for the life of the engine instead
//! of reallocating per frame. It is also why the field is `f32` rather than
//! `f64`: it matches the `Float32Array` the TypeScript engine already uses, so
//! the two implementations round identically.
//!
//! What it is not: an image. 2,304 cells over a whole room is about one value
//! per 15cm square of wall, accumulated over hours. Nothing in it describes a
//! person.

use serde::{Deserialize, Serialize};

/// Cells across.
pub const FIELD_WIDTH: usize = 64;
/// Cells down.
pub const FIELD_HEIGHT: usize = 36;
/// Total cells.
pub const FIELD_CELLS: usize = FIELD_WIDTH * FIELD_HEIGHT;

/// The same count as a divisor. Const-asserted equal so the two cannot drift.
const FIELD_CELLS_F64: f64 = 2_304.0;
const _: () = assert!(FIELD_CELLS == 2_304);

/// Accumulated presence, one `f32` per cell.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MemoryField(#[serde(with = "field_serde")] Box<[f32; FIELD_CELLS]>);

impl Default for MemoryField {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryField {
    #[must_use]
    pub fn new() -> Self {
        Self(Box::new([0.0; FIELD_CELLS]))
    }

    /// Restore from a saved room, tolerating a different length.
    ///
    /// A field saved by a build with a different grid is not reinterpreted —
    /// reshaping densities would silently move every memory in the room — so a
    /// wrong length yields an empty field. The room forgets, which is a thing
    /// it already does, rather than remembering the wrong places.
    #[must_use]
    pub fn from_saved(values: &[f32]) -> Self {
        let mut field = Self::new();
        if values.len() == FIELD_CELLS {
            field.0.copy_from_slice(values);
            for cell in field.0.iter_mut() {
                // A saved NaN propagates through decay and renders as nothing
                // at all, forever. Clamp on the way in.
                *cell = if cell.is_finite() {
                    cell.clamp(0.0, 1.0)
                } else {
                    0.0
                };
            }
        }
        field
    }

    #[must_use]
    pub fn as_slice(&self) -> &[f32] {
        self.0.as_slice()
    }

    pub fn as_mut_slice(&mut self) -> &mut [f32] {
        self.0.as_mut_slice()
    }

    /// Read one cell. Out-of-range coordinates read as 0 rather than panicking:
    /// a renderer asking about the edge of the room is not an error.
    #[must_use]
    pub fn get(&self, x: usize, y: usize) -> f32 {
        if x >= FIELD_WIDTH || y >= FIELD_HEIGHT {
            return 0.0;
        }
        self.0.get(y * FIELD_WIDTH + x).copied().unwrap_or(0.0)
    }

    pub fn set(&mut self, x: usize, y: usize, value: f32) {
        if x >= FIELD_WIDTH || y >= FIELD_HEIGHT {
            return;
        }
        if let Some(cell) = self.0.get_mut(y * FIELD_WIDTH + x) {
            *cell = value;
        }
    }

    pub fn clear(&mut self) {
        self.0.fill(0.0);
    }

    /// Mean density. The number the room's personality is partly chosen from.
    #[must_use]
    pub fn density(&self) -> f64 {
        let total: f64 = self.0.iter().map(|&v| f64::from(v)).sum();
        total / FIELD_CELLS_F64
    }
}

/// Serialise as a flat array, matching what `persistence.ts` writes.
mod field_serde {
    use super::FIELD_CELLS;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(
        field: &[f32; FIELD_CELLS],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        field.as_slice().serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Box<[f32; FIELD_CELLS]>, D::Error> {
        let values = Vec::<f32>::deserialize(deserializer)?;
        let mut out = Box::new([0.0f32; FIELD_CELLS]);
        if values.len() == FIELD_CELLS {
            out.copy_from_slice(&values);
        }
        Ok(out)
    }
}

crate::privacy::impl_persistable!(MemoryField);

#[cfg(test)]
mod tests {
    use super::{FIELD_CELLS, FIELD_HEIGHT, FIELD_WIDTH, MemoryField};

    #[test]
    fn the_grid_is_the_one_the_typescript_engine_uses() {
        assert_eq!((FIELD_WIDTH, FIELD_HEIGHT), (64, 36));
        assert_eq!(FIELD_CELLS, 2_304);
    }

    #[test]
    fn reading_outside_the_room_is_empty_rather_than_fatal() {
        let field = MemoryField::new();
        assert_eq!(field.get(FIELD_WIDTH, 0), 0.0);
        assert_eq!(field.get(0, FIELD_HEIGHT), 0.0);
    }

    /// A field saved under a different grid must not be reshaped. Densities
    /// are positional; stretching them would move every memory in the room.
    #[test]
    fn a_field_of_the_wrong_size_restores_empty_rather_than_reshaped() {
        let restored = MemoryField::from_saved(&vec![0.5; 1_000]);
        assert_eq!(restored.density(), 0.0);
    }

    /// NaN in a saved field is the silent killer: it survives every decay
    /// multiply and renders as nothing forever.
    #[test]
    fn a_saved_nan_is_cleaned_rather_than_carried() {
        let mut saved = vec![0.25f32; FIELD_CELLS];
        saved[10] = f32::NAN;
        saved[11] = f32::INFINITY;
        saved[12] = -3.0;
        let restored = MemoryField::from_saved(&saved);
        assert_eq!(restored.get(10, 0), 0.0);
        assert_eq!(restored.get(11, 0), 0.0);
        assert_eq!(restored.get(12, 0), 0.0);
        assert!(restored.density().is_finite());
    }

    #[test]
    fn a_field_round_trips_through_the_saved_flat_array() {
        let mut field = MemoryField::new();
        field.set(3, 4, 0.75);
        let json = serde_json::to_string(&field).expect("serialises");
        assert!(
            json.starts_with('['),
            "saved as a flat array, as persistence.ts writes"
        );
        let restored: MemoryField = serde_json::from_str(&json).expect("round trips");
        assert_eq!(restored.get(3, 4), 0.75);
    }
}
