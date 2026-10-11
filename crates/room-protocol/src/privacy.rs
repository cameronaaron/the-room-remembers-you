//! Privacy and boundedness as type system rules rather than paragraphs.
//!
//! The installation's first invariant is that camera frames, microphone PCM,
//! faces and device identifiers never reach storage or a log. Its second is
//! that nothing accumulates without a bound, because the room runs unattended
//! for weeks. In the TypeScript half both are held by an allowlist in
//! `persistence.ts`, by bounds checks scattered through the call sites, and by
//! regression tests. All of that works, and all of it depends on the next
//! person to add a field noticing that they should have looked.
//!
//! Here it is a compile error instead. [`Persistable`] is sealed and
//! implemented for exactly two kinds of thing:
//!
//! * numeric scalars and `bool`;
//! * the bounded newtypes in [`crate::bounded`], each of which carries a
//!   documented capacity it enforces in its constructor.
//!
//! It is deliberately **not** implemented for `u8`, `String`, `Vec<T>`, or any
//! slice. A struct that gains a frame buffer, a base64 blob, a free-text
//! caption or an unbounded list stops compiling.
//!
//! Every persisted struct pairs its `impl Persistable` with an
//! [`assert_persistable_fields!`] block that destructures it exhaustively.
//! Adding a field breaks the pattern, which forces whoever added it to name the
//! field and prove its type is allowed on disk.
//!
//! These checks restrict field shapes, not the meaning of numeric data. Floats
//! can encode audio samples; types alone cannot prove that a caller reduced
//! media correctly. Keep the browser media boundary and persistence allowlist
//! tests. Do not treat this trait as information-flow verification.

pub(crate) mod sealed {
    pub trait Sealed {}
}

/// Types allowed to appear inside persisted room state.
///
/// Sealed: implementations live in this crate, next to the reasoning for each
/// one. See the module docs for what is deliberately missing and why.
/// ```compile_fail
/// use room_protocol::privacy::Persistable;
/// fn allowed<T: Persistable>() {}
/// allowed::<Vec<u8>>();
/// ```
/// ```compile_fail
/// use room_protocol::privacy::Persistable;
/// fn allowed<T: Persistable>() {}
/// allowed::<String>();
/// ```
pub trait Persistable: sealed::Sealed {}

macro_rules! persistable_scalar {
    ($($t:ty),* $(,)?) => {
        $(
            impl sealed::Sealed for $t {}
            impl Persistable for $t {}
        )*
    };
}

// Scalars. `u8` is absent on purpose: it is the building block of every image
// and audio buffer, and excluding it is what makes `Vec<u8>` unrepresentable
// in persisted state even if someone implements `Persistable` for `Vec<T>`.
persistable_scalar!(bool, f32, f64, i32, i64, u16, u32, u64, usize);

/// Implement [`Persistable`] for a bounded container or record.
///
/// Used only by [`crate::bounded`] and by the persisted records themselves, so
/// that "this may be written to disk" is always a deliberate line of code.
macro_rules! impl_persistable {
    ($($t:ty),* $(,)?) => {
        $(
            impl $crate::privacy::sealed::Sealed for $t {}
            impl $crate::privacy::Persistable for $t {}
        )*
    };
}

pub(crate) use impl_persistable;

/// Prove every field of a struct is [`Persistable`], exhaustively.
///
/// The destructuring pattern is the mechanism: it must name every field, so a
/// new one is a compile error until it is added here, and adding it is a
/// compile error unless its type is allowed on disk.
macro_rules! assert_persistable_fields {
    ($ty:ident { $($field:ident),* $(,)? }) => {
        const _: () = {
            fn allowed<T: $crate::privacy::Persistable + ?Sized>(_: &T) {}
            fn check(value: &$ty) {
                let $ty { $($field),* } = value;
                $(allowed($field);)*
            }
            let _: fn(&$ty) = check;
        };
    };
}

pub(crate) use assert_persistable_fields;

#[cfg(test)]
mod tests {
    use super::Persistable;

    /// The positive half of the claim, pinned so that widening the allowlist
    /// shows up in a diff as a test change rather than as one more macro line.
    ///
    /// The negative half — that `Vec<u8>`, `String` and `[u8]` are *not*
    /// persistable — is not expressible as an assertion, because Rust has no
    /// negative trait bounds. It is held instead by the absence of any `impl`
    /// for them in this file, and by the fact that every persisted struct
    /// routes through `assert_persistable_fields!`.
    #[test]
    fn the_allowed_leaf_types_are_the_ones_we_reviewed() {
        fn allowed<T: Persistable>() {}
        allowed::<bool>();
        allowed::<f32>();
        allowed::<f64>();
        allowed::<i32>();
        allowed::<i64>();
        allowed::<u16>();
        allowed::<u32>();
        allowed::<u64>();
        allowed::<usize>();
    }
}
