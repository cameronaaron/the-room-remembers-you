//! What survives a reload, a crash and a reboot — and what must never.
//!
//! Two rules meet here.
//!
//! The privacy rule: every field of every version is
//! [`Persistable`](crate::privacy::Persistable), which is only implemented for
//! scalars and bounded records. A version that gained a frame buffer or a free
//! text field would not compile.
//!
//! The migration rule: gallery machines hold real rooms. A build that cannot
//! read what the previous build wrote does not "start clean", it deletes weeks
//! of an artwork's memory, silently, on a Tuesday morning. So versions are
//! explicit, conversion is explicit, and an unreadable state is a named error
//! the operator console can show rather than a `catch {}` that shrugs.
//!
//! These schemas are proposed migration formats. They are not yet a verified
//! adapter for every legacy TS record; do not replace gallery persistence.

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::bounded::{Bounded, GHOSTS_MAX, WHISPERS_MAX};
use crate::field::MemoryField;
use crate::memory::{Ghost, Whisper};
use crate::privacy::{assert_persistable_fields, impl_persistable};
use crate::snapshot::Lifecycle;

/// The state as the TypeScript build writes it today.
///
/// Field names and optionality match `PersistedRoom` in `persistence.ts`,
/// including the fields that build added later and therefore made optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomStateV1 {
    pub field: MemoryField,
    pub ghosts: Bounded<Ghost, GHOSTS_MAX>,
    pub whispers: Bounded<Whisper, WHISPERS_MAX>,
    pub installation_started_at: f64,
    pub saved_at: f64,
    #[serde(default)]
    pub day: Option<u32>,
    #[serde(default)]
    pub lifecycle: Option<Lifecycle>,
}

/// The state the Rust engine writes.
///
/// Adds what the engine needs to resume *deterministically* rather than merely
/// plausibly: the RNG stream position and the id sequence. Without them a
/// restarted room re-mints ids it has already used and re-rolls decisions it
/// has already made, which is exactly the class of bug a seeded engine exists
/// to remove.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomStateV2 {
    pub field: MemoryField,
    pub ghosts: Bounded<Ghost, GHOSTS_MAX>,
    pub whispers: Bounded<Whisper, WHISPERS_MAX>,
    pub installation_started_at: f64,
    pub saved_at: f64,
    pub day: u32,
    pub lifecycle: Lifecycle,
    /// The seed the engine was created with.
    pub seed: u64,
    /// How many values have been drawn from that seed. Restoring both is what
    /// makes a resumed room continue its stream rather than restart it.
    pub rng_draws: u64,
    /// Next value for the memory-id counter.
    pub id_sequence: u64,
}

/// A saved room, tagged with the schema that wrote it.
///
/// Untagged JSON was considered and rejected: `serde(untagged)` would let a
/// malformed V2 silently parse as a V1 that happens to share a prefix, which
/// turns a loud failure into a room that quietly forgets its RNG position.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "schema")]
pub enum PersistentState {
    #[serde(rename = "1")]
    V1(RoomStateV1),
    #[serde(rename = "2")]
    V2(RoomStateV2),
}

/// Why a saved room could not be restored.
#[derive(Clone, Debug, PartialEq)]
pub enum StateError {
    /// The bytes were not the JSON this format is written in.
    Unreadable(String),
    /// A schema this build does not know. Almost always a downgrade: the
    /// gallery machine was rolled back and the newer room is still on disk.
    UnknownSchema(String),
    /// Readable, and describing something impossible — a negative day, a save
    /// timestamp before the installation started, a NaN.
    Implausible(&'static str),
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable(why) => write!(f, "the saved room could not be read: {why}"),
            Self::UnknownSchema(schema) => {
                write!(
                    f,
                    "the saved room was written by a newer build (schema {schema})"
                )
            }
            Self::Implausible(why) => {
                write!(f, "the saved room describes something impossible: {why}")
            }
        }
    }
}

impl std::error::Error for StateError {}

/// The schema this build writes.
pub const STATE_SCHEMA: u32 = 2;

impl PersistentState {
    /// Parse a saved room, accepting every schema this build understands.
    ///
    /// A room written by `persistence.ts` has no `schema` key at all, because
    /// that build never had more than one shape. It is therefore read as V1
    /// when the tag is absent, which is the whole reason V1 exists here.
    pub fn parse(json: &str) -> Result<Self, StateError> {
        Self::parse_reporting(json).map(|(state, _dropped)| state)
    }

    /// Parse, and say how many memories this build could not read.
    ///
    /// The count belongs on the operator's diagnostics: a room that quietly
    /// opens two memories lighter every morning is a room losing its history,
    /// and "what is broken" is a question the console is supposed to answer.
    pub fn parse_reporting(json: &str) -> Result<(Self, usize), StateError> {
        if json.len() > 2 * 1024 * 1024 {
            return Err(StateError::Implausible("state exceeds 2 MiB"));
        }
        let mut value: serde_json::Value =
            serde_json::from_str(json).map_err(|e| StateError::Unreadable(e.to_string()))?;
        let dropped = drop_unreadable_memories(&mut value);
        let state = match value.get("schema") {
            None => serde_json::from_value::<RoomStateV1>(value)
                .map(Self::V1)
                .map_err(|e| StateError::Unreadable(e.to_string()))?,
            Some(tag) => {
                let tag = tag.to_string();
                if tag.trim_matches('"') != "1" && tag.trim_matches('"') != "2" {
                    return Err(StateError::UnknownSchema(tag));
                }
                serde_json::from_value::<Self>(value)
                    .map_err(|e| StateError::Unreadable(e.to_string()))?
            }
        };
        Ok((state, dropped))
    }

    /// Bring any readable version up to what the engine restores from.
    ///
    /// A V1 room has no RNG position, because the build that wrote it used
    /// `Math.random()` and had none. It resumes at draw zero with the seed it
    /// is given, which is correct: a room that was never deterministic cannot
    /// be resumed deterministically, and pretending otherwise would be the
    /// kind of claim this migration exists to stop making.
    pub fn migrate(self, seed: u64) -> Result<RoomStateV2, StateError> {
        let migrated = match self {
            Self::V2(state) => state,
            Self::V1(state) => RoomStateV2 {
                field: state.field,
                ghosts: state.ghosts,
                whispers: state.whispers,
                installation_started_at: state.installation_started_at,
                saved_at: state.saved_at,
                day: state.day.unwrap_or(1),
                lifecycle: state.lifecycle.unwrap_or(Lifecycle::Opening),
                seed,
                rng_draws: 0,
                id_sequence: 0,
            },
        };
        migrated.validate()?;
        Ok(migrated)
    }
}

/// Drop the memories this build cannot represent, and count them.
///
/// One unreadable memory must cost the room that memory, not the room. Serde
/// aborts a whole document on the first element it cannot read, so the
/// collections are filtered here, at the one seam where the saved room is
/// already a tree of values and each record can be tried on its own.
///
/// This is not hypothetical and it is not about corruption. Composite
/// false-memory ids used to embed both of their parents' ids, so a composite
/// of two composites embedded theirs; measured, the length roughly 2.6x'd per
/// generation and reached 38,312 characters by the eighth, against a
/// [`MEMORY_ID_MAX`](crate::MEMORY_ID_MAX) of 64. The TypeScript mints bounded
/// ids now, but the long ones are already on disk in every gallery that has
/// been running, and a room is not a file an operator can regenerate. Losing
/// weeks of a room because one id is too long is not failing safely.
fn drop_unreadable_memories(value: &mut serde_json::Value) -> usize {
    let mut dropped = 0_usize;
    for (field, readable) in [
        (
            "ghosts",
            readable::<Ghost> as fn(&serde_json::Value) -> bool,
        ),
        (
            "whispers",
            readable::<Whisper> as fn(&serde_json::Value) -> bool,
        ),
    ] {
        let Some(serde_json::Value::Array(records)) = value.get_mut(field) else {
            continue;
        };
        let before = records.len();
        records.retain(readable);
        dropped = dropped.saturating_add(before.saturating_sub(records.len()));
    }
    dropped
}

/// Whether one saved record reads as `T`. Clones because `from_value` consumes.
fn readable<T: serde::de::DeserializeOwned>(record: &serde_json::Value) -> bool {
    serde_json::from_value::<T>(record.clone()).is_ok()
}

impl RoomStateV2 {
    /// Reject state that describes something that cannot have happened.
    ///
    /// Not defensive programming for its own sake: a corrupted `saved_at` of
    /// NaN propagates into every decay calculation in the room and renders as
    /// a field that never fades, which looks like a bug in the artwork rather
    /// than a bad file.
    pub fn validate(&self) -> Result<(), StateError> {
        if !self.saved_at.is_finite() || !self.installation_started_at.is_finite() {
            return Err(StateError::Implausible("a timestamp is not a number"));
        }
        if self.saved_at < 0.0 || self.installation_started_at < 0.0 {
            return Err(StateError::Implausible("a timestamp is before the epoch"));
        }
        if self.day == 0 {
            return Err(StateError::Implausible("day zero; days start at one"));
        }
        for ghost in &self.ghosts {
            if !ghost.strength.is_finite() || !ghost.fidelity.is_finite() {
                return Err(StateError::Implausible(
                    "a memory has a strength that is not a number",
                ));
            }
            if ghost.path.is_empty() {
                return Err(StateError::Implausible("a memory has no path to replay"));
            }
        }
        Ok(())
    }

    /// Serialise with the schema tag this build writes.
    pub fn to_json(&self) -> Result<String, StateError> {
        serde_json::to_string(&PersistentState::V2(self.clone()))
            .map_err(|e| StateError::Unreadable(e.to_string()))
    }
}

impl_persistable!(RoomStateV1, RoomStateV2, Lifecycle);

assert_persistable_fields!(RoomStateV2 {
    field,
    ghosts,
    whispers,
    installation_started_at,
    saved_at,
    day,
    lifecycle,
    seed,
    rng_draws,
    id_sequence,
});

#[cfg(test)]
mod tests {
    use super::{PersistentState, RoomStateV2, StateError};
    use crate::snapshot::Lifecycle;

    const TYPESCRIPT_ROOM: &str = r#"{
        "field": [],
        "ghosts": [{
            "id": "ghost-lx9q2z-0",
            "createdAt": 1757000000000,
            "lastReplayedAt": 0,
            "path": [{"x":0.1,"y":0.2,"t":0}],
            "dwellSeconds": 4,
            "intensity": 0.35,
            "strength": 0.48,
            "fidelity": 1,
            "recallCount": 0,
            "lineage": [],
            "falseMemory": false,
            "day": 1
        }],
        "whispers": [],
        "installationStartedAt": 1756900000000,
        "savedAt": 1757000500000,
        "day": 3,
        "lifecycle": "active"
    }"#;

    /// One unreadable memory must cost the room that memory, not the room.
    ///
    /// The doc on `MemoryId::deserialize` has promised this since the crate was
    /// written. It was not true: serde aborts a whole document on the first
    /// element it cannot read, so a gallery holding one over-long composite id
    /// would have opened to an empty room and lost every memory it had.
    ///
    /// Not hypothetical, and not about corruption. Composite false-memory ids
    /// used to embed both of their parents' ids, so a composite of two
    /// composites embedded theirs; measured, the length roughly 2.6x'd per
    /// generation and reached 38,312 characters by the eighth, against a
    /// `MEMORY_ID_MAX` of 64. The TypeScript mints bounded ids now, but the
    /// long ones are already on disk in every gallery that has been running,
    /// and a room is not a file an operator can regenerate.
    #[test]
    fn one_unreadable_memory_costs_the_room_that_memory_and_not_the_room() {
        let readable = r#"{
            "id": "g-1a2b3c",
            "createdAt": 1757000000000,
            "lastReplayedAt": 0,
            "path": [{"x":0.4,"y":0.6,"t":0}],
            "dwellSeconds": 9,
            "intensity": 0.4,
            "strength": 0.5,
            "fidelity": 1,
            "recallCount": 0,
            "lineage": [],
            "falseMemory": false,
            "day": 2
        }"#;
        // A composite from the build that embedded its parents' ids.
        let over_long = format!("false-lx9q2z-{}", "g-1a2b3c-".repeat(12));
        assert!(over_long.len() > crate::MEMORY_ID_MAX);
        let unreadable = readable
            .replace(r#""g-1a2b3c""#, &format!(r#""{over_long}""#))
            .replace(r#""day": 2"#, r#""day": 3"#);
        let room = format!(
            r#"{{
                "field": [],
                "ghosts": [{readable}, {unreadable}],
                "whispers": [],
                "installationStartedAt": 1756900000000,
                "savedAt": 1757000500000,
                "day": 3,
                "lifecycle": "active"
            }}"#
        );

        let (parsed, dropped) = PersistentState::parse_reporting(&room)
            .expect("one unreadable memory must not fail the room");
        assert_eq!(dropped, 1, "exactly the memory that could not be read");
        let migrated = parsed.migrate(1).expect("and the rest must migrate");
        assert_eq!(migrated.ghosts.len(), 1, "the readable memory survives");
        assert_eq!(
            migrated.ghosts.get(0).map(|ghost| ghost.id.as_str()),
            Some("g-1a2b3c")
        );
        assert_eq!(migrated.day, 3, "and so does everything else");
    }

    /// A room with nothing wrong with it reports nothing dropped, so the count
    /// is a signal rather than a number that is always non-zero.
    #[test]
    fn a_room_this_build_can_read_entirely_drops_nothing() {
        let (_, dropped) =
            PersistentState::parse_reporting(TYPESCRIPT_ROOM).expect("a readable room");
        assert_eq!(dropped, 0);
    }

    /// The migration's whole point: a room the current build is holding right
    /// now must survive the upgrade. If this fails, deploying loses it.
    /// The migration's whole point: a room the current build is holding right
    /// now must survive the upgrade. If this fails, deploying loses it.
    #[test]
    fn a_room_written_by_the_typescript_build_migrates_without_loss() {
        let parsed = PersistentState::parse(TYPESCRIPT_ROOM).expect("the untagged shape is V1");
        assert!(matches!(parsed, PersistentState::V1(_)));
        let migrated = parsed.migrate(0x0D15_EA5E).expect("migrates");
        assert_eq!(migrated.day, 3);
        assert_eq!(migrated.lifecycle, Lifecycle::Active);
        assert_eq!(migrated.ghosts.len(), 1);
        assert_eq!(
            migrated.rng_draws, 0,
            "a room that was never seeded resumes at zero"
        );
        assert_eq!(migrated.seed, 0x0D15_EA5E);
    }

    /// The fields a later build added were optional in TypeScript, so a room
    /// saved before they existed is still out there.
    #[test]
    fn a_room_saved_before_days_existed_opens_on_day_one() {
        let older = TYPESCRIPT_ROOM
            .replace("\"day\": 3,", "")
            .replace("\"lifecycle\": \"active\"", "\"savedAt\": 1757000500000");
        let migrated = PersistentState::parse(&older)
            .expect("parses")
            .migrate(1)
            .expect("migrates");
        assert_eq!(migrated.day, 1);
        assert_eq!(migrated.lifecycle, Lifecycle::Opening);
    }

    /// A saved room's coordinates survive JSON, to within one unit in the last
    /// place — and not, in general, exactly.
    ///
    /// **`serde_json` 1.0.151 does not always parse an `f64` to the nearest
    /// representable value.** `0.20400000000000001`, which is what
    /// `JSON.stringify` writes for a coordinate the browser computed, comes
    /// back as `0.204`: one ULP low, where `str::parse::<f64>` is exact.
    /// Writing is fine — `ryu` produces a shortest form that round trips — so
    /// the loss is on the way in, and it applies to every room the gallery has
    /// already saved.
    ///
    /// This is recorded as a test rather than a paragraph because the tempting
    /// assertion is the wrong one. A future reader who writes
    /// `assert_eq!(restored, original)` will find it passes for the values they
    /// happened to choose and fails on a real room. The property that is true
    /// is stated here, with its bound.
    ///
    /// The artistic consequence is nil: one ULP of a room coordinate is about
    /// 3e-17 of a wall. The consequence for *deterministic replay* is not nil,
    /// which is why `docs/ARCHITECTURE.md` says a replay needs the observation
    /// log and not merely a restored room.
    #[test]
    fn a_saved_coordinate_survives_json_to_within_one_unit_in_the_last_place() {
        let awkward: f64 = "0.20400000000000001".parse().expect("a valid f64");
        let state = RoomStateV2 {
            installation_started_at: awkward,
            saved_at: 2.0,
            day: 1,
            ..Default::default()
        };
        let restored = PersistentState::parse(&state.to_json().expect("serialises"))
            .expect("parses")
            .migrate(0)
            .expect("migrates");

        let error = (restored.installation_started_at - awkward).abs();
        assert!(
            error <= f64::EPSILON * awkward.abs(),
            "a saved room drifted by {error}, which is more than a rounding"
        );
    }

    #[test]
    fn a_room_this_build_wrote_round_trips_with_its_rng_position() {
        let state = RoomStateV2 {
            installation_started_at: 1.0,
            saved_at: 2.0,
            day: 5,
            seed: 99,
            rng_draws: 123_456,
            id_sequence: 77,
            ..Default::default()
        };
        let json = state.to_json().expect("serialises");
        assert!(json.contains("\"schema\":\"2\""), "{json}");
        let restored = PersistentState::parse(&json)
            .expect("parses")
            .migrate(0)
            .expect("migrates");
        assert_eq!(
            restored.rng_draws, 123_456,
            "the stream resumes where it stopped"
        );
        assert_eq!(
            restored.seed, 99,
            "the saved seed wins over the offered one"
        );
    }

    /// A rolled-back gallery machine finding a newer room must say so, not
    /// quietly reinterpret it.
    #[test]
    fn a_room_from_a_newer_build_is_refused_by_name() {
        let newer = r#"{"schema":"9","field":[],"ghosts":[],"whispers":[]}"#;
        assert!(matches!(
            PersistentState::parse(newer),
            Err(StateError::UnknownSchema(_))
        ));
    }

    /// The failure this validation exists for: NaN survives every arithmetic
    /// operation in the decay path and renders as a room that never forgets.
    #[test]
    fn a_corrupted_timestamp_fails_the_restore_rather_than_the_evening() {
        let corrupted = TYPESCRIPT_ROOM.replace("1757000500000", "null");
        let error = PersistentState::parse(&corrupted)
            .and_then(|state| state.migrate(0))
            .expect_err("a null timestamp is not restorable");
        assert!(matches!(
            error,
            StateError::Unreadable(_) | StateError::Implausible(_)
        ));
    }

    #[test]
    fn a_memory_with_no_path_is_refused_rather_than_indexed_into() {
        let empty_path = TYPESCRIPT_ROOM.replace(r#"[{"x":0.1,"y":0.2,"t":0}]"#, "[]");
        let error = PersistentState::parse(&empty_path)
            .expect("parses")
            .migrate(0)
            .expect_err("a memory with nothing to replay is not a memory");
        assert_eq!(
            error,
            StateError::Implausible("a memory has no path to replay")
        );
    }

    #[test]
    fn unreadable_bytes_are_an_error_rather_than_an_empty_room() {
        assert!(matches!(
            PersistentState::parse("not json at all"),
            Err(StateError::Unreadable(_))
        ));
    }
}
