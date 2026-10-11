//! The four-point mapping from what the camera sees to where the room is.
//!
//! A projector and a camera almost never share a viewpoint in a gallery: the
//! camera is above the door, the projector is on the opposite wall, and the
//! surface between them is at an angle to both. Calibration is four corners
//! dragged into place by an operator, and this is what those four corners mean.
//!
//! The standard it enforces, from `ENGINEERING-STANDARDS.md`: *camera points
//! reach every projected immediate trace, path and field deposit through the
//! same four-point homography. Never calibrate only the visible renderer while
//! leaving the world model in camera coordinates.* That failure is
//! particularly nasty because the image looks right — it is the room's memory
//! of where people stood that is quietly wrong, and it only shows up hours
//! later when a recall walks through a wall.
//!
//! Ported from `homography.ts`, including the Gauss-Jordan elimination with
//! partial pivoting, so the two implementations agree to the last bit on the
//! same four corners.

use room_protocol::{Homography, Vec2};

/// Why a calibration could not be solved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CalibrationError {
    /// Not four corners.
    WrongPointCount,
    /// Three corners on a line, or two on top of each other. There is no
    /// projective map through them.
    Degenerate,
}

impl std::fmt::Display for CalibrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongPointCount => write!(f, "a calibration needs exactly four corners"),
            Self::Degenerate => write!(
                f,
                "the calibration corners are in a line or on top of each other"
            ),
        }
    }
}

impl std::error::Error for CalibrationError {}

/// Solve for the projective map taking `source` onto `target`.
pub fn solve(source: &[Vec2], target: &[Vec2]) -> Result<Homography, CalibrationError> {
    if source.len() != 4 || target.len() != 4 {
        return Err(CalibrationError::WrongPointCount);
    }
    // Eight equations, two per corner, in the eight unknowns of a homography
    // whose ninth element is fixed at 1. The ninth column holds the constant.
    let mut rows = [[0.0f64; 9]; 8];
    for index in 0..4 {
        let (Some(from), Some(to)) = (source.get(index), target.get(index)) else {
            return Err(CalibrationError::WrongPointCount);
        };
        let (x, y, u, v) = (from.x, from.y, to.x, to.y);
        if let Some(row) = rows.get_mut(index * 2) {
            *row = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        }
        if let Some(row) = rows.get_mut(index * 2 + 1) {
            *row = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
        }
    }
    let solution = gauss_jordan(&mut rows)?;
    Ok(Homography([
        solution[0],
        solution[1],
        solution[2],
        solution[3],
        solution[4],
        solution[5],
        solution[6],
        solution[7],
        1.0,
    ]))
}

/// Map a point through the matrix.
///
/// A vanishing denominator means the point is on the map's horizon, where the
/// projection is undefined. The point is returned unchanged rather than sent
/// to infinity: an uncalibratable corner should leave a trace where it was,
/// not throw it out of the room.
#[must_use]
pub fn apply(point: Vec2, matrix: &Homography) -> Vec2 {
    let m = &matrix.0;
    let denominator = m[6] * point.x + m[7] * point.y + m[8];
    if denominator.abs() < 1e-9 {
        return point;
    }
    Vec2 {
        x: (m[0] * point.x + m[1] * point.y + m[2]) / denominator,
        y: (m[3] * point.x + m[4] * point.y + m[5]) / denominator,
    }
}

/// Solve, and fall back to the identity if the corners are unusable.
///
/// The fallback is what keeps a mis-dragged calibration from taking the
/// installation down: the room draws in camera coordinates, visibly wrong, and
/// an operator fixes it. `mapCalibratedPoint` in `room-projection.ts` does the
/// same, with the same reasoning.
#[must_use]
pub fn map_calibrated(point: Vec2, source: &[Vec2], target: &[Vec2]) -> Vec2 {
    solve(source, target).map_or(point, |matrix| apply(point, &matrix))
}

/// Undo how the camera is mounted.
///
/// A camera turned on its side reports a room turned on its side, and every
/// downstream stage would otherwise inherit that. Quarter turns only: a camera
/// is bolted to something, not held. Ports `mapCameraPoint` in
/// `room-projection.ts`; a degree that is not 0/90/180/270 passes through
/// unchanged, matching that function's literal-typed parameter.
#[must_use]
pub fn map_camera(point: Vec2, rotation_degrees: u16) -> Vec2 {
    match rotation_degrees {
        90 => Vec2::new(1.0 - point.y, point.x),
        180 => Vec2::new(1.0 - point.x, 1.0 - point.y),
        270 => Vec2::new(point.y, 1.0 - point.x),
        _ => point,
    }
}

/// The whole journey: unmount the camera, then land the point on the wall.
///
/// Order matters and is not commutative. The calibration quad was captured in
/// upright camera space, so rotating after mapping would send every point
/// through a homography fitted to a different frame. Ports `mapRoomPoint`.
#[must_use]
pub fn map_room(point: Vec2, rotation_degrees: u16, source: &[Vec2], target: &[Vec2]) -> Vec2 {
    map_calibrated(map_camera(point, rotation_degrees), source, target)
}

fn gauss_jordan(rows: &mut [[f64; 9]; 8]) -> Result<[f64; 8], CalibrationError> {
    for pivot in 0..8 {
        let (best, _) = rows
            .iter()
            .enumerate()
            .skip(pivot)
            .max_by(|(_, a), (_, b)| {
                a.get(pivot)
                    .copied()
                    .unwrap_or(0.0)
                    .abs()
                    .total_cmp(&b.get(pivot).copied().unwrap_or(0.0).abs())
            })
            .ok_or(CalibrationError::Degenerate)?;
        rows.swap(pivot, best);
        let row = rows.get_mut(pivot).ok_or(CalibrationError::Degenerate)?;
        let divisor = *row.get(pivot).ok_or(CalibrationError::Degenerate)?;
        if !divisor.is_finite() || divisor.abs() < 1e-10 {
            return Err(CalibrationError::Degenerate);
        }
        for value in row.iter_mut().skip(pivot) {
            *value /= divisor;
        }
        let normalized = *row;
        for (index, row) in rows.iter_mut().enumerate() {
            if index == pivot {
                continue;
            }
            let factor = *row.get(pivot).ok_or(CalibrationError::Degenerate)?;
            for (value, source) in row.iter_mut().zip(normalized).skip(pivot) {
                *value -= factor * source;
            }
        }
    }
    let mut solution = [0.0; 8];
    for (slot, row) in solution.iter_mut().zip(rows.iter()) {
        *slot = *row.last().ok_or(CalibrationError::Degenerate)?;
    }
    Ok(solution)
}

#[cfg(test)]
mod tests {
    use super::{CalibrationError, apply, map_calibrated, map_camera, map_room, solve};
    use room_protocol::Vec2;

    fn unit_square() -> Vec<Vec2> {
        vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(1.0, 0.0),
            Vec2::new(1.0, 1.0),
            Vec2::new(0.0, 1.0),
        ]
    }

    #[test]
    fn mapping_a_square_onto_itself_is_the_identity() {
        let matrix = solve(&unit_square(), &unit_square()).expect("a square maps to itself");
        for point in [
            Vec2::new(0.3, 0.7),
            Vec2::new(0.0, 0.0),
            Vec2::new(1.0, 1.0),
        ] {
            let mapped = apply(point, &matrix);
            assert!((mapped.x - point.x).abs() < 1e-12);
            assert!((mapped.y - point.y).abs() < 1e-12);
        }
    }

    /// The property that matters: whatever the calibration, the four corners
    /// land exactly where the operator dragged them.
    #[test]
    fn the_corners_land_where_they_were_dragged() {
        let target = vec![
            Vec2::new(0.08, 0.12),
            Vec2::new(0.94, 0.03),
            Vec2::new(0.99, 0.88),
            Vec2::new(0.02, 0.97),
        ];
        let matrix = solve(&unit_square(), &target).expect("a convex quad is solvable");
        for (from, to) in unit_square().iter().zip(&target) {
            let mapped = apply(*from, &matrix);
            assert!((mapped.x - to.x).abs() < 1e-12, "{mapped:?} vs {to:?}");
            assert!((mapped.y - to.y).abs() < 1e-12, "{mapped:?} vs {to:?}");
        }
    }

    /// A real gallery calibration is a keystone, not a square, and the camera
    /// is above the door. This is that case, round-tripped.
    #[test]
    fn a_keystone_inverts_back_to_where_it_started() {
        let camera = unit_square();
        let wall = vec![
            Vec2::new(0.15, 0.05),
            Vec2::new(0.85, 0.05),
            Vec2::new(1.0, 0.95),
            Vec2::new(0.0, 0.95),
        ];
        let forward = solve(&camera, &wall).expect("solvable");
        let backward = solve(&wall, &camera).expect("solvable");
        let point = Vec2::new(0.42, 0.61);
        let there = apply(point, &forward);
        let back = apply(there, &backward);
        assert!((back.x - point.x).abs() < 1e-9, "{back:?}");
        assert!((back.y - point.y).abs() < 1e-9, "{back:?}");
    }

    /// The bug partial pivoting exists to prevent: the top-left corner of the
    /// room puts a zero on the diagonal.
    #[test]
    fn a_corner_at_the_origin_solves_rather_than_dividing_by_zero() {
        let target = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(0.9, 0.1),
            Vec2::new(0.8, 0.9),
            Vec2::new(0.1, 0.8),
        ];
        assert!(solve(&unit_square(), &target).is_ok());
    }

    #[test]
    fn three_corners_on_a_line_are_refused_by_name() {
        let collapsed = vec![
            Vec2::new(0.0, 0.0),
            Vec2::new(0.5, 0.0),
            Vec2::new(1.0, 0.0),
            Vec2::new(0.0, 1.0),
        ];
        assert_eq!(
            solve(&collapsed, &unit_square()),
            Err(CalibrationError::Degenerate)
        );
    }

    #[test]
    fn the_wrong_number_of_corners_is_refused_by_name() {
        assert_eq!(
            solve(&unit_square()[..3], &unit_square()),
            Err(CalibrationError::WrongPointCount)
        );
    }

    /// A bad calibration must leave the room drawing visibly wrong, not stop.
    #[test]
    fn an_unsolvable_calibration_falls_back_to_leaving_the_point_alone() {
        let collapsed = vec![Vec2::new(0.0, 0.0); 4];
        let point = Vec2::new(0.3, 0.4);
        assert_eq!(map_calibrated(point, &collapsed, &unit_square()), point);
    }

    /// Points on the horizon of a projective map have no image. Sending them
    /// to infinity would put NaN into the memory field, which never leaves.
    #[test]
    fn a_point_on_the_horizon_is_left_alone_rather_than_sent_to_infinity() {
        let horizon = room_protocol::Homography([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, -0.5]);
        let mapped = apply(Vec2::new(0.5, 0.2), &horizon);
        assert_eq!(mapped, Vec2::new(0.5, 0.2));
        assert!(mapped.x.is_finite() && mapped.y.is_finite());
    }

    #[test]
    fn an_unrotated_camera_leaves_a_point_where_it_found_it() {
        let point = Vec2::new(0.2, 0.7);
        assert_eq!(map_camera(point, 0), point);
    }

    #[test]
    fn every_quarter_turn_is_the_rotation_it_claims_to_be() {
        // The top-left corner is the only point that distinguishes a rotation
        // from a flip: mirroring the frame maps the centre to itself too.
        let top_left = Vec2::new(0.0, 0.0);
        assert_eq!(map_camera(top_left, 90), Vec2::new(1.0, 0.0));
        assert_eq!(map_camera(top_left, 180), Vec2::new(1.0, 1.0));
        assert_eq!(map_camera(top_left, 270), Vec2::new(0.0, 1.0));
    }

    #[test]
    fn four_quarter_turns_return_a_point_to_itself() {
        // The property, rather than three remembered pairs: a rotation that is
        // secretly a reflection passes the corner test above in isolation and
        // fails here, because reflecting twice is the identity and would come
        // back early.
        for start in [
            Vec2::new(0.13, 0.42),
            Vec2::new(0.9, 0.05),
            Vec2::new(0.5, 0.5),
        ] {
            let mut point = start;
            for _ in 0..4 {
                point = map_camera(point, 90);
            }
            assert!((point.x - start.x).abs() < 1e-9);
            assert!((point.y - start.y).abs() < 1e-9);
        }
    }

    #[test]
    fn a_quarter_turn_is_not_its_own_inverse_but_two_are_a_half_turn() {
        let point = Vec2::new(0.13, 0.42);
        let once = map_camera(point, 90);
        assert_ne!(map_camera(once, 90), point);
        assert_eq!(map_camera(once, 90), map_camera(point, 180));
    }

    #[test]
    fn map_room_rotates_before_calibrating_rather_than_after() {
        // Order is not commutative: a calibration fitted to upright camera
        // space applied before the rotation would land somewhere else. Use a
        // calibration that is not the identity so the two orders can actually
        // differ.
        let source = unit_square();
        let target = vec![
            Vec2::new(0.1, 0.1),
            Vec2::new(0.9, 0.0),
            Vec2::new(1.0, 0.9),
            Vec2::new(0.0, 1.0),
        ];
        let point = Vec2::new(0.2, 0.6);
        let correct_order = map_calibrated(map_camera(point, 90), &source, &target);
        assert_eq!(map_room(point, 90, &source, &target), correct_order);
        let wrong_order = map_camera(map_calibrated(point, &source, &target), 90);
        assert_ne!(map_room(point, 90, &source, &target), wrong_order);
    }
}
