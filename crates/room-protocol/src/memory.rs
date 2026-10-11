//! What the room keeps.
//!
//! Two records, both anonymous by construction. A [`Ghost`] is the shape of a
//! walk; a [`Whisper`] is the loudness curve of something said. Neither can
//! hold an image, a recording, a name or a device identifier, because neither
//! has a field whose type would permit it — see [`crate::privacy`].
//!
//! Field names match the TypeScript records exactly, and serialise in
//! camelCase, so a room saved by the existing build restores into these types
//! without a conversion step. That is deliberate: the migration is only safe if
//! the first Rust build can read what the last TypeScript build wrote.

use serde::{Deserialize, Serialize};

use crate::bounded::{Envelope, Lineage, PathPoints};
use crate::geometry::Vec2;
use crate::ids::MemoryId;
use crate::privacy::{assert_persistable_fields, impl_persistable};

/// A remembered walk.
///
/// Nothing recalled remains unchanged: every replay must raise `recall_count`,
/// lower `fidelity`, mutate `path` and reinforce `strength`. That invariant
/// lives in the engine, and `memory-engine.test.ts` and the engine's own tests
/// both fail if a recall leaves a ghost intact.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ghost {
    pub id: MemoryId,
    /// Wall-clock milliseconds. Used only for expiry and for recall weighting.
    pub created_at: f64,
    pub last_replayed_at: f64,
    pub path: PathPoints,
    pub dwell_seconds: f64,
    /// How brightly it renders. 0..1.
    pub intensity: f64,
    /// How firmly it is held. 0..1. Decays with time, reinforced by recall.
    pub strength: f64,
    /// How faithful it still is to what happened. 0..1, only ever falling.
    pub fidelity: f64,
    pub recall_count: u32,
    /// The ids this memory was composited from. Internal provenance; never
    /// shown to a visitor.
    pub lineage: Lineage,
    pub false_memory: bool,
    /// Which day of the installation's life it belongs to.
    pub day: u32,
}

/// The texture of something said, with the saying discarded.
///
/// `envelope` is up to 32 normalised amplitudes — the shape of the sound, not
/// the sound. The PCM lives in the browser's session-only store, is never
/// handed to this crate, and is cleared on reset, microphone shutdown and page
/// close.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Whisper {
    pub id: MemoryId,
    pub created_at: f64,
    pub last_replayed_at: f64,
    /// Seconds. Bounded by the capture rule at 6.5.
    pub duration: f64,
    pub envelope: Envelope,
    /// Spectral centroid, 0..1. Dark to bright, not identity.
    pub brightness: f64,
    pub position: Vec2,
    pub strength: f64,
    pub fidelity: f64,
    pub recall_count: u32,
    pub lineage: Lineage,
    pub day: u32,
}

impl_persistable!(Ghost, Whisper);

assert_persistable_fields!(Ghost {
    id,
    created_at,
    last_replayed_at,
    path,
    dwell_seconds,
    intensity,
    strength,
    fidelity,
    recall_count,
    lineage,
    false_memory,
    day,
});

assert_persistable_fields!(Whisper {
    id,
    created_at,
    last_replayed_at,
    duration,
    envelope,
    brightness,
    position,
    strength,
    fidelity,
    recall_count,
    lineage,
    day,
});

#[cfg(test)]
mod tests {
    use super::{Ghost, Whisper};
    use crate::bounded::{Bounded, Envelope, Lineage, PathPoints};
    use crate::geometry::{Point, Vec2};
    use crate::ids::MemoryId;

    fn id(text: &str) -> MemoryId {
        MemoryId::new(text).expect("test ids are well-formed")
    }

    /// A room written by the existing TypeScript build must restore here.
    ///
    /// This is the migration's load-bearing assertion: if the camelCase names
    /// or the value shapes drift, the first gallery to upgrade loses every
    /// memory it was holding, silently, and reopens as a room that has never
    /// seen anyone.
    #[test]
    fn a_ghost_saved_by_the_typescript_build_restores_unchanged() {
        let saved = r#"{
            "id": "ghost-lx9q2z-3",
            "createdAt": 1757000000000,
            "lastReplayedAt": 0,
            "path": [{"x":0.1,"y":0.2,"t":10},{"x":0.4,"y":0.6,"t":1200}],
            "dwellSeconds": 12.5,
            "intensity": 0.35,
            "strength": 0.48,
            "fidelity": 1,
            "recallCount": 0,
            "lineage": ["t-4"],
            "falseMemory": false,
            "day": 1
        }"#;
        let ghost: Ghost = serde_json::from_str(saved).expect("the existing shape parses");
        assert_eq!(ghost.id.as_str(), "ghost-lx9q2z-3");
        assert_eq!(ghost.path.len(), 2);
        assert_eq!(ghost.lineage.len(), 1);
        assert!(!ghost.false_memory);

        let round_tripped: Ghost =
            serde_json::from_str(&serde_json::to_string(&ghost).expect("serialises"))
                .expect("round trips");
        assert_eq!(round_tripped, ghost);
    }

    #[test]
    fn a_whisper_saved_by_the_typescript_build_restores_unchanged() {
        let saved = r#"{
            "id": "0f8b2c11-4a3d-4c9e-9f21-7a6b5c4d3e2f",
            "createdAt": 1757000000000,
            "lastReplayedAt": 0,
            "duration": 2.75,
            "envelope": [0.1, 0.9, 0.4],
            "brightness": 0.42,
            "position": {"x": 0.3, "y": 0.6},
            "strength": 0.38,
            "fidelity": 1,
            "recallCount": 0,
            "lineage": [],
            "day": 0
        }"#;
        let whisper: Whisper = serde_json::from_str(saved).expect("the existing shape parses");
        assert_eq!(whisper.envelope.len(), 3);
        assert_eq!(whisper.position, Vec2::new(0.3, 0.6));
    }

    /// The bound is on the type, so an oversized saved record is truncated
    /// rather than becoming an unbounded structure in a long-running process.
    #[test]
    fn an_oversized_saved_path_is_truncated_to_the_bound() {
        let points: Vec<_> = (0..500)
            .map(|i| format!(r#"{{"x":{},"y":0,"t":{i}}}"#, f64::from(i) / 500.0))
            .collect();
        let saved = format!(
            r#"{{"id":"g-1","createdAt":0,"lastReplayedAt":0,"path":[{}],"dwellSeconds":1,
                 "intensity":0.3,"strength":0.4,"fidelity":1,"recallCount":0,"lineage":[],
                 "falseMemory":false,"day":1}}"#,
            points.join(",")
        );
        let ghost: Ghost = serde_json::from_str(&saved).expect("parses");
        assert_eq!(ghost.path.len(), PathPoints::CAPACITY);
    }

    #[test]
    fn a_whisper_is_constructible_only_out_of_bounded_parts() {
        let whisper = Whisper {
            id: id("w-1"),
            created_at: 0.0,
            last_replayed_at: 0.0,
            duration: 1.0,
            envelope: Envelope::from_iter_bounded((0..200).map(|i| f64::from(i) / 200.0)),
            brightness: 0.5,
            position: Vec2::new(0.5, 0.5),
            strength: 0.38,
            fidelity: 1.0,
            recall_count: 0,
            lineage: Lineage::new(),
            day: 1,
        };
        assert_eq!(
            whisper.envelope.len(),
            Envelope::CAPACITY,
            "200 samples cannot become 200 samples on disk"
        );
        let _ = Bounded::<Point, 4>::new();
    }
}
