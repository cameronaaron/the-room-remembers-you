//! Opaque identifiers.
//!
//! A [`MemoryId`] names a remembered path or a whisper. It is deliberately not
//! a `String`: persisted state must not be able to carry free text, because
//! free text is where a caption, a filename, a device label or a base64 blob
//! would arrive. The constructor accepts lowercase letters, digits and hyphens
//! only, up to 64 characters, which is enough for the generated forms the room
//! uses (`g-1a2b3c`, `false-<base36>-<id>-<id>`) and useless for anything else.
//!
//! [`TrackId`] is not persisted at all. A track is a thing the room is
//! currently looking at; when the visitor leaves, the track ends and its id
//! means nothing. Keeping it out of [`Persistable`](crate::privacy::Persistable)
//! is what stops "which anonymous track was this" from becoming a durable fact
//! about a person.

use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;

/// Longest id the room will store or accept.
pub const MEMORY_ID_MAX: usize = 64;

/// The identifier of a persisted memory. Opaque, bounded, and not free text.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct MemoryId(Box<str>);

/// Why a candidate id was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdError {
    /// Empty, or longer than [`MEMORY_ID_MAX`].
    Length,
    /// Contained something outside `[a-z0-9-]`.
    Alphabet,
}

impl fmt::Display for IdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Length => write!(f, "a memory id must be 1..={MEMORY_ID_MAX} characters"),
            Self::Alphabet => write!(f, "a memory id may contain only [a-z0-9-]"),
        }
    }
}

impl std::error::Error for IdError {}

impl MemoryId {
    /// Validate and wrap a candidate id.
    pub fn new(candidate: &str) -> Result<Self, IdError> {
        if candidate.is_empty() || candidate.len() > MEMORY_ID_MAX {
            return Err(IdError::Length);
        }
        if !candidate
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(IdError::Alphabet);
        }
        Ok(Self(candidate.into()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// A name the room can always give something.
    ///
    /// [`new`](Self::new) is the right constructor for an id that arrives from
    /// outside, where a refusal is information. This one is for an id the room
    /// is *minting*, where there is no sensible way to fail: a composite has
    /// been made and it needs a handle. Anything outside `[a-z0-9-]` is
    /// dropped, uppercase is folded, the result is truncated to
    /// [`MEMORY_ID_MAX`] and an empty result becomes `unnamed`.
    ///
    /// Every current caller passes something already valid — a prefix, a base
    /// 36 timestamp and a base 36 hash — so this never alters anything today.
    /// It exists so that no site minting an id has to choose between an
    /// `unwrap` and a fallback it invented on the spot, which is how a panic
    /// gets into a production path in the first place.
    #[must_use]
    pub fn minted(candidate: &str) -> Self {
        let mut clean = String::with_capacity(candidate.len().min(MEMORY_ID_MAX));
        for byte in candidate.bytes() {
            if clean.len() >= MEMORY_ID_MAX {
                break;
            }
            let lowered = byte.to_ascii_lowercase();
            if lowered.is_ascii_lowercase() || lowered.is_ascii_digit() || lowered == b'-' {
                clean.push(char::from(lowered));
            }
        }
        if clean.is_empty() {
            clean.push_str("unnamed");
        }
        Self(clean.into())
    }
}

impl fmt::Display for MemoryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for MemoryId {
    /// Restoring a room is the one place ids arrive from outside this process.
    ///
    /// A saved room written by an older TypeScript build can hold ids this
    /// build would not mint — `crypto.randomUUID()` produced lowercase hex with
    /// hyphens, which passes, and composite false-memory ids used to embed
    /// both of their parents', which does not: measured, those reached 38,312
    /// characters against a [`MEMORY_ID_MAX`] of 64.
    ///
    /// An invalid id therefore fails its record rather than the whole room.
    /// Serde aborts a document on the first element it cannot read, so that is
    /// not something this impl can arrange on its own: the collections are
    /// filtered in [`PersistentState::parse`](crate::PersistentState::parse),
    /// which is the one seam where each record can be tried by itself. The
    /// promise was in this comment for a while before it was true anywhere.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::new(&raw).map_err(serde::de::Error::custom)
    }
}

/// A track the room is currently watching. Never persisted; see module docs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TrackId(pub u32);

impl fmt::Display for TrackId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "t-{}", self.0)
    }
}

crate::privacy::impl_persistable!(MemoryId);

#[cfg(test)]
mod tests {
    use super::{IdError, MEMORY_ID_MAX, MemoryId};

    #[test]
    fn the_forms_the_room_actually_mints_are_accepted() {
        for candidate in ["g-1a2b3c", "false-lx9q2-g-1a2b3c-g-4d5e6f", "0"] {
            assert!(
                MemoryId::new(candidate).is_ok(),
                "{candidate} should be a valid id"
            );
        }
    }

    /// The point of the newtype: the shapes that would let persisted state
    /// carry something other than an identifier.
    #[test]
    fn free_text_and_encoded_payloads_are_refused() {
        // Base64 needs uppercase, `+`, `/` and `=`; none survive the alphabet.
        assert_eq!(MemoryId::new("SGVsbG8gd29ybGQ="), Err(IdError::Alphabet));
        assert_eq!(
            MemoryId::new("a caption about someone"),
            Err(IdError::Alphabet)
        );
        assert_eq!(
            MemoryId::new("/tmp/someone/frame.png"),
            Err(IdError::Alphabet)
        );
        assert_eq!(MemoryId::new(""), Err(IdError::Length));
        assert_eq!(
            MemoryId::new(&"a".repeat(MEMORY_ID_MAX + 1)),
            Err(IdError::Length)
        );
        assert!(
            MemoryId::new(&"a".repeat(MEMORY_ID_MAX)).is_ok(),
            "the bound itself is allowed"
        );
    }

    #[test]
    fn an_id_restored_from_a_saved_room_is_validated_too() {
        assert!(serde_json::from_str::<MemoryId>("\"g-1a2b3c\"").is_ok());
        assert!(
            serde_json::from_str::<MemoryId>("\"Not An Id\"").is_err(),
            "deserialisation must not be a way around the constructor"
        );
    }
}
