//! Browser-independent deterministic primitives for the staged room migration.
//! The TypeScript cognition remains authoritative until cross-runtime parity.
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]
pub mod attention;
pub mod attention_engine;
pub mod behavior;
pub mod behavior_engine;
pub mod disturbance;
pub mod emergence;
pub mod field;
pub mod field_engine;
pub mod homography;
pub mod math;
pub mod memory;
pub mod path;
pub mod personality;
pub mod rng;
pub mod track_assignment;
pub mod track_engine;
pub mod tracking;
