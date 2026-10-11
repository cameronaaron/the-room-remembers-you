//! Paths: the shape of a walk, and how two walks are compared.
//!
//! A path is the only durable record the room keeps of a person, and the
//! comparison in [`trajectory_distance`] is what "you have walked this before"
//! actually means. Both are ported operation for operation from
//! `memory-engine.ts`.
//!
//! Everything here works on `&[Point]` rather than on the bounded types, so a
//! caller can compare a live track's path with a stored memory's without
//! converting between capacities.

use room_protocol::Point;

use crate::math::clamp;

/// Resample to a fixed number of evenly spaced points.
///
/// Fixed count, not fixed spacing: comparison needs two paths with the same
/// number of samples, and a walk across the room and a shuffle in one corner
/// must be comparable as *shapes*.
#[must_use]
#[expect(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "nonnegative interpolation indices are bounded by the input slice"
)]
pub fn normalize_path(path: &[Point], samples: usize) -> Vec<Point> {
    let Some(first) = path.first() else {
        return Vec::new();
    };
    if path.len() == 1 {
        return vec![*first; samples];
    }
    let last_index = path.len() - 1;
    let mut result = Vec::with_capacity(samples);
    for index in 0..samples {
        // `samples - 1` in the denominator mirrors the TypeScript, which means
        // one sample resamples to the *last* point rather than the first. No
        // caller asks for one sample; the arithmetic is kept identical anyway
        // so the parity harness does not have to carve out an exception.
        let position = if samples <= 1 {
            0.0
        } else {
            (index as f64 / (samples - 1) as f64) * last_index as f64
        };
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let low = position.floor() as usize;
        let high = last_index.min(position.ceil() as usize);
        let mix = position - low as f64;
        let (Some(a), Some(b)) = (path.get(low), path.get(high)) else {
            continue;
        };
        result.push(Point {
            x: a.x + (b.x - a.x) * mix,
            y: a.y + (b.y - a.y) * mix,
            t: a.t + (b.t - a.t) * mix,
        });
    }
    result
}

/// Reduce a long walk to at most `max_points`, keeping its shape.
#[must_use]
#[expect(
    clippy::cast_precision_loss,
    reason = "interpolation indices are bounded by the input slice"
)]
pub fn simplify_path(path: &[Point], max_points: usize) -> Vec<Point> {
    if path.len() <= max_points || max_points == 0 {
        return path.to_vec();
    }
    let last_index = path.len() - 1;
    let mut result = Vec::with_capacity(max_points);
    for index in 0..max_points {
        let position = if max_points <= 1 {
            0.0
        } else {
            (index as f64 / (max_points - 1) as f64) * last_index as f64
        };
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let source = position.round() as usize;
        if let Some(point) = path.get(source.min(last_index)) {
            result.push(*point);
        }
    }
    result
}

/// How far a path actually reaches, as the diagonal of its bounding box.
///
/// Needed because [`trajectory_distance`] between the two halves of a path is
/// near zero for someone standing still — their "path" is a cloud of points at
/// one spot, and its first half matches its second half perfectly. Without a
/// requirement that the path went somewhere, a visitor who simply sat down was
/// told "you have walked this before" about eleven seconds after arriving.
#[must_use]
pub fn path_extent(path: &[Point]) -> f64 {
    if path.len() < 2 {
        return 0.0;
    }
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for point in path {
        min_x = min_x.min(point.x);
        max_x = max_x.max(point.x);
        min_y = min_y.min(point.y);
        max_y = max_y.max(point.y);
    }
    (max_x - min_x).hypot(max_y - min_y)
}

/// A path must reach at least this far before "you came back" means anything.
pub const RETURN_MIN_EXTENT: f64 = 0.28;

/// Samples used when comparing two paths.
const COMPARISON_SAMPLES: usize = 16;

/// Mean per-sample distance between two walks, whichever direction they agree
/// in best.
///
/// Comparing both directions is what makes a corridor walked back the other
/// way count as the same route, which is how a visitor pacing a gallery is
/// recognised at all. Returns infinity for a path too short to have a shape.
#[must_use]
#[expect(
    clippy::cast_precision_loss,
    reason = "the normalized path has 16 samples"
)]
pub fn trajectory_distance(first: &[Point], second: &[Point]) -> f64 {
    if first.len() < 2 || second.len() < 2 {
        return f64::INFINITY;
    }
    let a = normalize_path(first, COMPARISON_SAMPLES);
    let b = normalize_path(second, COMPARISON_SAMPLES);
    let mut forward = 0.0;
    let mut reverse = 0.0;
    for index in 0..a.len() {
        let (Some(here), Some(there)) = (a.get(index), b.get(index)) else {
            continue;
        };
        forward += (here.x - there.x).hypot(here.y - there.y);
        if let Some(mirrored) = b.get(b.len() - index - 1) {
            reverse += (here.x - mirrored.x).hypot(here.y - mirrored.y);
        }
    }
    forward.min(reverse) / a.len() as f64
}

/// Default threshold below which two walks are the same walk.
pub const CONVERGENCE_THRESHOLD: f64 = 0.07;

/// The stored path a new one most nearly repeats, if any is near enough.
///
/// Takes the paths rather than the memories so that the comparison stays pure:
/// what it means for two routes to be the same route is arithmetic, and which
/// memory that corresponds to is the caller's business.
#[must_use]
pub fn nearest_path(candidate: &[Point], others: &[Vec<Point>], threshold: f64) -> Option<usize> {
    let mut best = threshold;
    let mut found = None;
    for (index, other) in others.iter().enumerate() {
        let distance = trajectory_distance(candidate, other);
        if distance < best {
            best = distance;
            found = Some(index);
        }
    }
    found
}

/// Smooth and jitter a path, as a memory does when it is recalled.
///
/// The mutation is proportional to how much fidelity has already been lost, so
/// a memory recalled many times drifts faster than one recalled once. Each
/// point is a weighted average of itself and its neighbours, which is what
/// makes a remembered walk lose its corners before it loses its route.
pub fn mutate_recalled_path(
    source: &[Point],
    fidelity: f64,
    mut jitter: impl FnMut() -> f64,
) -> Vec<Point> {
    let mutation = (1.0 - fidelity) * 0.035;
    let mut result = Vec::with_capacity(source.len());
    for index in 0..source.len() {
        let (Some(point), Some(before), Some(after)) = (
            source.get(index),
            source.get(index.saturating_sub(1)),
            source.get((index + 1).min(source.len().saturating_sub(1))),
        ) else {
            continue;
        };
        let smoothed_x = before.x * 0.2 + point.x * 0.6 + after.x * 0.2;
        let smoothed_y = before.y * 0.2 + point.y * 0.6 + after.y * 0.2;
        result.push(Point {
            x: clamp(smoothed_x + (jitter() - 0.5) * mutation, 0.0, 1.0),
            y: clamp(smoothed_y + (jitter() - 0.5) * mutation, 0.0, 1.0),
            t: point.t,
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{
        CONVERGENCE_THRESHOLD, RETURN_MIN_EXTENT, mutate_recalled_path, nearest_path,
        normalize_path, path_extent, simplify_path, trajectory_distance,
    };
    use room_protocol::Point;

    fn line(points: &[(f64, f64)]) -> Vec<Point> {
        points
            .iter()
            .enumerate()
            .map(|(i, &(x, y))| {
                Point::new(
                    x,
                    y,
                    f64::from(u32::try_from(i).expect("test path fits u32")) * 100.0,
                )
            })
            .collect()
    }

    #[test]
    fn resampling_keeps_the_ends_and_spaces_the_middle() {
        let path = line(&[(0.0, 0.0), (1.0, 0.0)]);
        let resampled = normalize_path(&path, 5);
        assert_eq!(resampled.len(), 5);
        assert_eq!(resampled[0].x, 0.0);
        assert_eq!(resampled[4].x, 1.0);
        assert!((resampled[2].x - 0.5).abs() < 1e-12);
    }

    #[test]
    fn a_single_point_resamples_to_itself_repeated() {
        let resampled = normalize_path(&line(&[(0.3, 0.4)]), 6);
        assert_eq!(resampled.len(), 6);
        assert!(resampled.iter().all(|p| p.x == 0.3 && p.y == 0.4));
    }

    #[test]
    fn an_empty_path_resamples_to_nothing_rather_than_to_the_origin() {
        assert!(normalize_path(&[], 16).is_empty());
    }

    #[test]
    fn simplification_leaves_a_short_path_alone() {
        let path = line(&[(0.0, 0.0), (0.5, 0.5), (1.0, 1.0)]);
        assert_eq!(simplify_path(&path, 72), path);
    }

    #[test]
    fn simplification_reduces_a_long_path_to_its_ceiling() {
        let path: Vec<Point> = (0..500)
            .map(|i| Point::new(f64::from(i) / 500.0, 0.5, 0.0))
            .collect();
        let reduced = simplify_path(&path, 72);
        assert_eq!(reduced.len(), 72);
        assert_eq!(reduced[0].x, 0.0);
        assert!((reduced[71].x - 499.0 / 500.0).abs() < 1e-12);
    }

    /// The defect this exists for: a visitor who sat down was told they had
    /// walked this before, because a cloud of points matches itself perfectly.
    #[test]
    fn standing_still_has_no_extent_however_many_points_it_produces() {
        let sitting: Vec<Point> = (0..200)
            .map(|i| Point::new(0.5 + f64::from(i % 3) * 0.001, 0.5, f64::from(i)))
            .collect();
        assert!(path_extent(&sitting) < RETURN_MIN_EXTENT);
        assert!(
            trajectory_distance(&sitting[..100], &sitting[100..]) < CONVERGENCE_THRESHOLD,
            "which is exactly why extent has to be checked as well"
        );
    }

    #[test]
    fn a_walk_across_the_room_has_extent() {
        assert!(path_extent(&line(&[(0.1, 0.1), (0.9, 0.8)])) > RETURN_MIN_EXTENT);
    }

    /// A corridor walked back the other way is the same corridor. Without this
    /// a visitor pacing a gallery is never recognised.
    #[test]
    fn a_route_walked_backwards_is_the_same_route() {
        let there = line(&[(0.1, 0.5), (0.4, 0.5), (0.7, 0.5), (0.9, 0.5)]);
        let back: Vec<Point> = there.iter().rev().copied().collect();
        assert!(trajectory_distance(&there, &back) < 1e-12);
    }

    #[test]
    fn two_unrelated_walks_are_far_apart() {
        let across = line(&[(0.0, 0.1), (1.0, 0.1)]);
        let down = line(&[(0.5, 0.0), (0.5, 1.0)]);
        assert!(trajectory_distance(&across, &down) > CONVERGENCE_THRESHOLD);
    }

    #[test]
    fn a_path_too_short_to_have_a_shape_matches_nothing() {
        let single = line(&[(0.5, 0.5)]);
        let real = line(&[(0.0, 0.0), (1.0, 1.0)]);
        assert!(trajectory_distance(&single, &real).is_infinite());
        assert_eq!(nearest_path(&single, &[real], CONVERGENCE_THRESHOLD), None);
    }

    #[test]
    fn the_nearest_stored_path_is_the_one_returned() {
        let candidate = line(&[(0.1, 0.5), (0.9, 0.5)]);
        let stored = vec![
            line(&[(0.5, 0.0), (0.5, 1.0)]),
            line(&[(0.11, 0.5), (0.89, 0.5)]),
            line(&[(0.2, 0.52), (0.8, 0.52)]),
        ];
        assert_eq!(
            nearest_path(&candidate, &stored, CONVERGENCE_THRESHOLD),
            Some(1)
        );
    }

    /// Nothing recalled remains unchanged. A mutation that happened to be zero
    /// would satisfy "it ran" and violate the invariant.
    #[test]
    fn recalling_a_path_always_changes_it() {
        let original = line(&[(0.1, 0.1), (0.5, 0.4), (0.9, 0.2), (0.6, 0.8)]);
        let mut roll = 0.0f64;
        let mutated = mutate_recalled_path(&original, 0.5, || {
            roll += 0.37;
            roll.fract()
        });
        assert_eq!(mutated.len(), original.len());
        assert!(
            mutated
                .iter()
                .zip(&original)
                .any(|(a, b)| a.x != b.x || a.y != b.y),
            "a recall that returns the path unchanged is not a memory"
        );
        assert!(
            mutated
                .iter()
                .all(|p| (0.0..=1.0).contains(&p.x) && (0.0..=1.0).contains(&p.y))
        );
    }

    #[test]
    fn a_faded_memory_drifts_further_than_a_fresh_one() {
        let original = line(&[(0.5, 0.5), (0.5, 0.5), (0.5, 0.5), (0.5, 0.5)]);
        let drift = |fidelity: f64| {
            let mutated = mutate_recalled_path(&original, fidelity, || 1.0);
            mutated.iter().map(|p| (p.x - 0.5).abs()).sum::<f64>()
        };
        assert!(drift(0.1) > drift(0.9));
    }
}
