//! Every accumulating structure in the room, with its bound attached to its
//! type.
//!
//! The installation runs eight to twelve hours a day for weeks with nobody
//! watching. "Bounded" is therefore not a nice property, it is the difference
//! between an artwork and a machine that dies on a Thursday. The TypeScript
//! half enforces these caps at the call sites — `if (ghosts.length > 120)
//! ghosts.shift()` inside the render component, `slice(-DEBUG_EVENT_LIMIT)`
//! inside the recorder — which means the cap is correct exactly as long as
//! every call site remembers it.
//!
//! Here the cap belongs to the container. [`Bounded`] cannot be constructed
//! over capacity and cannot be pushed past it; the oldest entry leaves to make
//! room, which is what the call sites were already doing.
//!
//! These are also the only compound types that satisfy
//! [`Persistable`](crate::privacy::Persistable), so the privacy rule and the
//! boundedness rule are held by the same mechanism: if it can go on disk, it
//! has a documented ceiling.

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::VecDeque;

/// A first-in-first-out collection that cannot exceed `N` entries.
///
/// Overflow drops the oldest, matching what the render component already did
/// with ghosts and whispers. Deserialisation truncates rather than failing:
/// a room saved by a build with a larger cap should reopen holding as much as
/// this build can hold, not refuse to open.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Bounded<T, const N: usize>(VecDeque<T>);

impl<T, const N: usize> Bounded<T, N> {
    /// The documented ceiling, available to tests and to diagnostics.
    pub const CAPACITY: usize = N;

    #[must_use]
    pub fn new() -> Self {
        Self(VecDeque::new())
    }

    /// Append, evicting the oldest entry if that would exceed the bound.
    ///
    /// Returns the evicted entry, so a caller that owns GPU resources or audio
    /// clips keyed by it can release them instead of leaking them behind a
    /// dropped id.
    pub fn push(&mut self, value: T) -> Option<T> {
        // A zero-capacity `Bounded` would silently swallow everything pushed
        // into it, which is the failure mode hardest to see in a gallery. It
        // is rejected when the type is instantiated, not when it is used.
        const { assert!(N > 0, "Bounded<T, 0> would discard every entry") };
        let evicted = if self.0.len() >= N {
            self.0.pop_front()
        } else {
            None
        };
        self.0.push_back(value);
        evicted
    }

    pub fn iter(&self) -> std::collections::vec_deque::Iter<'_, T> {
        self.0.iter()
    }

    pub fn iter_mut(&mut self) -> std::collections::vec_deque::IterMut<'_, T> {
        self.0.iter_mut()
    }

    /// Replace the contents in place, keeping the bound.
    pub fn refill(&mut self, values: impl IntoIterator<Item = T>) {
        self.0.clear();
        for value in values {
            self.push(value);
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[must_use]
    pub fn get(&self, index: usize) -> Option<&T> {
        self.0.get(index)
    }

    pub fn get_mut(&mut self, index: usize) -> Option<&mut T> {
        self.0.get_mut(index)
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }

    /// Keep only the entries a predicate accepts. Used for expiry sweeps.
    pub fn retain(&mut self, keep: impl FnMut(&T) -> bool) {
        self.0.retain(keep);
    }

    /// Build from an iterator, keeping the **last** `N` entries.
    ///
    /// Last rather than first because every caller is restoring history: the
    /// most recent memories are the ones worth keeping when a saved room
    /// exceeds this build's ceiling.
    pub fn from_iter_bounded(values: impl IntoIterator<Item = T>) -> Self {
        let mut out = Self::new();
        for value in values {
            out.push(value);
        }
        out
    }
}

impl<T, const N: usize> Default for Bounded<T, N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a, T, const N: usize> IntoIterator for &'a mut Bounded<T, N> {
    type Item = &'a mut T;
    type IntoIter = std::collections::vec_deque::IterMut<'a, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter_mut()
    }
}

impl<'a, T, const N: usize> IntoIterator for &'a Bounded<T, N> {
    type Item = &'a T;
    type IntoIter = std::collections::vec_deque::Iter<'a, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

impl<'de, T: Deserialize<'de>, const N: usize> Deserialize<'de> for Bounded<T, N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor<T, const N: usize>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>, const N: usize> serde::de::Visitor<'de> for Visitor<T, N> {
            type Value = Bounded<T, N>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "a bounded sequence")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                let mut out = Bounded::new();
                while let Some(value) = seq.next_element()? {
                    out.push(value);
                }
                Ok(out)
            }
        }
        deserializer.deserialize_seq(Visitor::<T, N>(std::marker::PhantomData))
    }
}

impl<T: crate::privacy::Persistable, const N: usize> crate::privacy::sealed::Sealed
    for Bounded<T, N>
{
}
impl<T: crate::privacy::Persistable, const N: usize> crate::privacy::Persistable for Bounded<T, N> {}

// ---------------------------------------------------------------------------
// The room's specific bounds, each with the reason for its number.
// ---------------------------------------------------------------------------

/// Points kept for one remembered path.
///
/// 72 is what `simplifyPath` already reduces to: enough to keep the shape of a
/// walk across a gallery, few enough that 120 of them is a few hundred
/// kilobytes.
pub const PATH_POINTS_MAX: usize = 72;

/// Amplitude samples kept for one whisper.
///
/// 32 is what `finishWhisper` already stores. It is also the number that makes
/// the envelope useless as audio: 32 points spread over up to 6.5 seconds is a
/// loudness curve, not speech.
pub const ENVELOPE_MAX: usize = 32;

/// Source ids retained on a composite false memory.
///
/// The TypeScript version has no bound here — `createFalseMemory` unions the
/// lineages of both parents, so a memory composited from composites grows its
/// lineage without limit. In practice false memories are rare and rarely
/// re-composited, which is why it has never been visible; it is still an
/// unbounded structure in a system that is not allowed to have one. 64 keeps
/// the provenance useful and the growth impossible.
pub const LINEAGE_MAX: usize = 64;

/// Remembered paths held at once. Matches the render component's `> 120`.
pub const GHOSTS_MAX: usize = 120;

/// Whisper textures held at once. Matches the render component's `> 80`.
pub const WHISPERS_MAX: usize = 80;

/// Live tracks. Above `MAX_DETECTED_BODIES` the sensing side already refuses to
/// believe the scene, so the engine never needs more.
pub const TRACKS_MAX: usize = 12;

/// The same bound where a count is wanted rather than a capacity.
///
/// Const-asserted equal to [`TRACKS_MAX`] so the two cannot drift; writing
/// `TRACKS_MAX as u32` instead would be a truncating cast that happens to be
/// safe today and would stay quiet if the bound ever grew past `u32::MAX`.
pub const TRACKS_MAX_COUNT: u32 = 12;
const _: () = assert!(TRACKS_MAX == 12 && TRACKS_MAX_COUNT == 12);

/// Points kept on a *live* track, before it is simplified into a memory.
///
/// Matches the tracker's existing `> 280` shift. Larger than
/// [`PATH_POINTS_MAX`] because a walk is recorded at sensing rate and only
/// reduced to its shape when the visitor leaves.
pub const TRACK_PATH_MAX: usize = 280;

/// Recalls presenting simultaneously.
///
/// Not a memory bound so much as an artistic one: more than a handful of
/// bodies crossing the room at once stops reading as memory and starts reading
/// as traffic.
pub const ACTIVE_RECALLS_MAX: usize = 8;

/// A bounded, validated path of room-space points.
pub type PathPoints = Bounded<crate::Point, PATH_POINTS_MAX>;

/// A bounded path of a track currently being watched.
pub type TrackPath = Bounded<crate::Point, TRACK_PATH_MAX>;

/// A bounded loudness envelope.
///
/// `f64` rather than `f32`, which is not about precision in the sound. An
/// envelope is 32 amplitudes rounded to three decimals, and either type holds
/// those comfortably. It is about the *chain*: every recall reads the stored
/// envelope, smooths each point against its neighbour, scales it by a draw and
/// stores the result, and a voice reached for all evening goes through that
/// dozens of times. In `f32` each pass quantises, so the Rust would drift away
/// from the TypeScript it has to match — slowly, invisibly, and only in rooms
/// that have been running long enough for nobody to be able to reproduce it.
///
/// Thirty-two `f64` against thirty-two `f32`, at `WHISPERS_MAX`, is ten
/// kilobytes. Being able to replay a gallery's evening is worth ten kilobytes.
pub type Envelope = Bounded<f64, ENVELOPE_MAX>;

/// Bounded provenance for a composite memory.
pub type Lineage = Bounded<crate::MemoryId, LINEAGE_MAX>;

#[cfg(test)]
mod tests {
    use super::{Bounded, GHOSTS_MAX};

    #[test]
    fn pushing_past_the_bound_evicts_the_oldest_and_hands_it_back() {
        let mut held: Bounded<u32, 3> = Bounded::new();
        assert_eq!(held.push(1), None);
        assert_eq!(held.push(2), None);
        assert_eq!(held.push(3), None);
        assert_eq!(
            held.push(4),
            Some(1),
            "the oldest leaves, and the caller is told which"
        );
        assert_eq!(held.len(), 3);
        assert_eq!(held.iter().copied().collect::<Vec<_>>(), vec![2, 3, 4]);
    }

    /// The property, not an example of it: no sequence of pushes can exceed the
    /// bound. This is the assertion the render component's `if (length > 120)`
    /// could never make about itself.
    #[test]
    fn no_number_of_pushes_can_exceed_the_bound() {
        let mut held: Bounded<u32, 8> = Bounded::new();
        for value in 0..10_000 {
            held.push(value);
            assert!(held.len() <= 8);
        }
        assert_eq!(
            held.iter().copied().collect::<Vec<_>>(),
            (9_992..10_000).collect::<Vec<_>>()
        );
    }

    /// A room saved by a build with a bigger ceiling must still open.
    #[test]
    fn restoring_more_than_the_bound_keeps_the_most_recent() {
        let saved: Vec<u32> = (0..u32::try_from(GHOSTS_MAX).unwrap_or(u32::MAX) + 40).collect();
        let restored: Bounded<u32, GHOSTS_MAX> = Bounded::from_iter_bounded(saved);
        assert_eq!(restored.len(), GHOSTS_MAX);
        assert_eq!(restored.get(0).copied(), Some(40));
    }

    #[test]
    fn deserialising_an_oversized_room_truncates_rather_than_failing() {
        let json = serde_json::to_string(&(0..200).collect::<Vec<u32>>()).expect("vec serialises");
        let restored: Bounded<u32, 8> = serde_json::from_str(&json).expect("truncates, not fails");
        assert_eq!(restored.len(), 8);
        assert_eq!(restored.get(7).copied(), Some(199));
    }
}
