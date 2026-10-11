//! Room space.
//!
//! Everything the engine reasons about lives in **room coordinates**: the unit
//! square, origin top-left, as the projector sees the wall. Camera coordinates
//! exist only on the sensing side of the boundary and are mapped through the
//! four-point homography before anything here sees them.
//!
//! That is a privacy property as much as a geometric one. A room-space
//! centroid in a 0..1 square, with the camera's framing already divided out,
//! is not attributable to a person in the way a pixel position in a known
//! camera's image is.

use serde::{Deserialize, Serialize};

/// A point on a remembered path: where, and when.
///
/// `t` is milliseconds on the engine's own monotonic clock, not a wall-clock
/// date. Paths are compared by shape, so the absolute origin never matters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub t: f64,
}

impl Point {
    #[must_use]
    pub const fn new(x: f64, y: f64, t: f64) -> Self {
        Self { x, y, t }
    }

    /// Distance to another point, ignoring time.
    #[must_use]
    pub fn distance_to(self, other: Self) -> f64 {
        (self.x - other.x).hypot(self.y - other.y)
    }
}

/// A position or a velocity, without a timestamp.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    #[must_use]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    #[must_use]
    pub fn length(self) -> f64 {
        self.x.hypot(self.y)
    }
}

/// The size of a detected region, in room units.
///
/// Carried because a stationary body whose extent is changing is doing
/// something with its arms, which a centroid alone cannot show.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Extent {
    pub width: f64,
    pub height: f64,
}

/// A projective mapping from camera space to room space.
///
/// Row-major 3x3, with `m[8]` normalised to 1 by [`solve`](Self::solve).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Homography(pub [f64; 9]);

impl Default for Homography {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Homography {
    pub const IDENTITY: Self = Self([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
}

crate::privacy::impl_persistable!(Point, Vec2, Extent);

#[cfg(test)]
mod tests {
    use super::{Point, Vec2};

    #[test]
    fn distance_ignores_time() {
        let a = Point::new(0.0, 0.0, 0.0);
        let b = Point::new(3.0, 4.0, 99_999.0);
        assert_eq!(a.distance_to(b), 5.0);
    }

    #[test]
    fn a_velocity_has_a_magnitude() {
        assert_eq!(Vec2::new(-3.0, 4.0).length(), 5.0);
    }
}
