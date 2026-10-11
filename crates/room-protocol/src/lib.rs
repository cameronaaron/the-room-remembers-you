//! Types shared by the room's three runtimes.
//!
//! The browser shell, the WASM engine and the native supervisor all need to
//! agree about what a memory is, what an observation is, and what "the room is
//! still running" means. Putting those definitions in one crate that none of
//! them depends on behaviourally is what keeps the boundaries honest: a change
//! to the shape of a ghost is a change to this crate, visible in one diff,
//! rather than three parallel edits that drift.
//!
//! Two invariants are enforced here rather than documented:
//!
//! * **Privacy.** See [`privacy`]. Persisted types are built only from scalars
//!   and bounded records; raw media is not representable.
//! * **Boundedness.** See [`bounded`]. Every accumulating structure carries its
//!   ceiling in its type, because the installation runs for weeks unattended.
//!
//! This crate has no clock, no randomness and no I/O. It is pure data.

#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::cast_precision_loss
    )
)]

pub mod bounded;
pub mod command;
pub mod config;
pub mod field;
pub mod geometry;
pub mod heartbeat;
pub mod ids;
pub mod memory;
pub mod observation;
pub mod persistent;
pub mod privacy;
pub mod snapshot;

pub use bounded::{
    ACTIVE_RECALLS_MAX, Bounded, ENVELOPE_MAX, Envelope, GHOSTS_MAX, LINEAGE_MAX, Lineage,
    PATH_POINTS_MAX, PathPoints, TRACK_PATH_MAX, TRACKS_MAX, TrackPath, WHISPERS_MAX,
};
pub use command::EngineCommand;
pub use config::{
    AudioConfig, CONFIG_SCHEMA, ConfigError, EngineConfig, HardwareProfile, InstallationConfig,
    PrivacyConfig, RendererBackend, RendererConfig, SensorConfig, SupervisorConfig,
};
pub use field::{FIELD_CELLS, FIELD_HEIGHT, FIELD_WIDTH, MemoryField};
pub use geometry::{Extent, Homography, Point, Vec2};
pub use heartbeat::{HEARTBEAT_INTERVAL_MS, Heartbeat, Liveness};
pub use ids::{IdError, MEMORY_ID_MAX, MemoryId, TrackId};
pub use memory::{Ghost, Whisper};
pub use observation::{AudioEvent, Observation, ObservationFrame, ObservationSource};
pub use persistent::{PersistentState, RoomStateV1, RoomStateV2, STATE_SCHEMA, StateError};
pub use snapshot::{
    Impulse, ImpulseKind, Interest, Lifecycle, MAX_PRESENCES, Personality, Presence, PresenceKind,
    RecallKind, RenderSnapshot, SoundKind, SpatialSound, Visual,
};
