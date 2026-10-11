//! Optimal bipartite matching between tracks and blobs, replacing greedy
//! nearest-neighbor claiming.
//!
//! Port of `lib/track-assignment.ts`, operation for operation — see that
//! file's module doc for the full reasoning. In short: greedy claiming (sort
//! every gated `{track, blob}` pair by distance, then claim in that order) can
//! starve a track gated to only one blob when a different track, gated to two
//! blobs, greedily claims the shared one first. Gates overlap most when two
//! people stand close together, which is exactly when that costs the room a
//! visitor. `tracking.rs` previously kept this greedy on purpose, reasoning
//! that switching to optimal assignment would be a behavioral change a pure
//! migration was not allowed to make — true for a *port*, but the undercount
//! above is a measured defect in what it was porting, not a matter of taste.
//! Both `lib/motion-tracker.ts` and this file now use optimal assignment, so
//! the migration's actual invariant — this crate agrees with the TypeScript
//! it mirrors — still holds; what changed is the specification both sides
//! implement, together.
//!
//! Pure minimum-cost matching is the wrong objective: since every real
//! distance is non-negative, "leave everyone unmatched" always costs zero and
//! a naive solver returns exactly that. A blob is motion evidence a caller
//! wants attributed to a track whenever a gated one exists, not a cost to
//! minimize away, so this first maximizes how many gated pairs are matched,
//! and only among matchings of that size minimizes total distance — enforced
//! by making the "stay unmatched" cost exceed any possible real match.

/// Bound on the assignment problem this ever solves: the sensing side's own
/// cap on simultaneous bodies ([`room_protocol::TRACKS_MAX`]). O(n^3) on a
/// matrix this large is still microseconds; larger is not a case this
/// installation's hardware profiles ever produce.
pub const ASSIGNMENT_CEILING: usize = room_protocol::TRACKS_MAX;

/// One accepted match: `track_index` into the caller's track list, `blob_index`
/// into the caller's blob list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Assignment {
    pub track_index: usize,
    pub blob_index: usize,
}

/// Read cell `(row, col)` of a rectangular `Vec<Vec<f64>>`.
///
/// A small accessor rather than `matrix[row][col]`, in the same
/// never-panic-on-an-index style as this crate's other bounded lookups (see
/// `tracking.rs`'s `taken_tracks.get(...).unwrap_or(true)`). The bound is
/// always satisfied here — every caller loops over `0..=total_slots` against
/// a matrix sized `total_slots + 1` — so `unwrap_or` never actually falls
/// back in practice; it exists so a future off-by-one degrades instead of
/// panicking the analysis loop.
fn cell(matrix: &[Vec<f64>], row: usize, col: usize) -> f64 {
    matrix
        .get(row)
        .and_then(|r| r.get(col))
        .copied()
        .unwrap_or(f64::INFINITY)
}

/// Write cell `(row, col)` of a rectangular `Vec<Vec<f64>>`. See [`cell`].
fn set_cell(matrix: &mut [Vec<f64>], row: usize, col: usize, value: f64) {
    if let Some(slot) = matrix.get_mut(row).and_then(|r| r.get_mut(col)) {
        *slot = value;
    }
}

/// Read slot `index` of a flat `Vec<T>`. See [`cell`] for why this exists.
fn at<T: Copy + Default>(slots: &[T], index: usize) -> T {
    slots.get(index).copied().unwrap_or_default()
}

/// Write slot `index` of a flat `Vec<T>`. See [`cell`].
fn set_at<T>(slots: &mut [T], index: usize, value: T) {
    if let Some(slot) = slots.get_mut(index) {
        *slot = value;
    }
}

/// Build the padded, square cost matrix `assign_tracks` solves over, and the
/// `forbidden` threshold a real match's cost is compared against on the way
/// out. See the module doc for what the padding represents.
fn build_padded_cost_matrix(
    costs: &[Vec<f64>],
    tracks: usize,
    blobs: usize,
) -> (Vec<Vec<f64>>, f64) {
    let total_slots = tracks + blobs;
    let sum_of_finite_costs: f64 = costs
        .iter()
        .flat_map(|row| row.iter())
        .filter(|cost| cost.is_finite())
        .sum();
    // Exceeds even the sum of every gated pair's cost, so using one more real
    // edge always beats opting out, however far that edge is — matching is
    // strictly preferred to not matching, and distance only breaks ties among
    // matchings of the same size.
    let unmatched_cost = sum_of_finite_costs + 1.0;
    // Exceeds the worst possible complete embedding (every slot opting out),
    // so a forbidden real pair is never chosen over that.
    #[allow(clippy::cast_precision_loss)]
    let forbidden = unmatched_cost * (total_slots as f64 + 1.0) + 1.0;

    // 1-indexed throughout: the augmenting-path formulation reserves index 0
    // for "no row/column yet". Rows 1..=tracks are real tracks; rows past
    // that are blob b's own dummy row. Columns 1..=blobs are real blobs;
    // columns past that are track t's own dummy column.
    let mut cost_matrix = vec![vec![forbidden; total_slots + 1]; total_slots + 1];
    for (track_index, row) in costs.iter().enumerate().take(tracks) {
        let matrix_row = track_index + 1;
        for (blob_index, &cost) in row.iter().enumerate().take(blobs) {
            set_cell(
                &mut cost_matrix,
                matrix_row,
                blob_index + 1,
                if cost.is_finite() { cost } else { forbidden },
            );
        }
        // track's own "leave me unmatched" column.
        set_cell(
            &mut cost_matrix,
            matrix_row,
            blobs + matrix_row,
            unmatched_cost,
        );
    }
    for blob_column in 1..=blobs {
        // blob's own "leave me unmatched" row.
        set_cell(
            &mut cost_matrix,
            tracks + blob_column,
            blob_column,
            unmatched_cost,
        );
    }
    // Dummy-dummy pairs settle the bookkeeping for free.
    for row in cost_matrix.iter_mut().skip(tracks + 1) {
        for slot in row.iter_mut().skip(blobs + 1) {
            *slot = 0.0;
        }
    }
    (cost_matrix, forbidden)
}

/// Kuhn–Munkres with potentials, the standard O(n^3) shortest-augmenting-path
/// formulation. Returns `match_of`, where `match_of[col]` is the row matched
/// to that column (0 = unmatched; unreachable here since every column has a
/// dummy fallback, but the type still allows it).
fn run_hungarian(cost_matrix: &[Vec<f64>], total_slots: usize) -> Vec<usize> {
    let mut row_potential = vec![0.0_f64; total_slots + 1];
    let mut col_potential = vec![0.0_f64; total_slots + 1];
    // match_of[col] = row currently matched to that column.
    let mut match_of = vec![0_usize; total_slots + 1];
    let mut parent_of_col = vec![0_usize; total_slots + 1];

    for row in 1..=total_slots {
        set_at(&mut match_of, 0, row);
        let mut current_col = 0_usize;
        let mut min_reduced_cost = vec![f64::INFINITY; total_slots + 1];
        let mut visited = vec![false; total_slots + 1];
        loop {
            set_at(&mut visited, current_col, true);
            let current_row = at(&match_of, current_col);
            let mut delta = f64::INFINITY;
            let mut next_col = 0_usize;
            for col in 1..=total_slots {
                if at(&visited, col) {
                    continue;
                }
                let reduced = cell(cost_matrix, current_row, col)
                    - at(&row_potential, current_row)
                    - at(&col_potential, col);
                if reduced < at(&min_reduced_cost, col) {
                    set_at(&mut min_reduced_cost, col, reduced);
                    set_at(&mut parent_of_col, col, current_col);
                }
                if at(&min_reduced_cost, col) < delta {
                    delta = at(&min_reduced_cost, col);
                    next_col = col;
                }
            }
            for col in 0..=total_slots {
                if at(&visited, col) {
                    let matched_row = at(&match_of, col);
                    let raised_row_potential = at(&row_potential, matched_row) + delta;
                    set_at(&mut row_potential, matched_row, raised_row_potential);
                    let lowered_col_potential = at(&col_potential, col) - delta;
                    set_at(&mut col_potential, col, lowered_col_potential);
                } else {
                    let lowered = at(&min_reduced_cost, col) - delta;
                    set_at(&mut min_reduced_cost, col, lowered);
                }
            }
            current_col = next_col;
            if at(&match_of, current_col) == 0 {
                break;
            }
        }
        loop {
            let parent_col = at(&parent_of_col, current_col);
            let inherited_row = at(&match_of, parent_col);
            set_at(&mut match_of, current_col, inherited_row);
            current_col = parent_col;
            if current_col == 0 {
                break;
            }
        }
    }
    match_of
}

/// Minimum-total-cost matching over `costs[track][blob]`, having first
/// maximized how many pairs are matched. Ungated pairs must be
/// [`f64::INFINITY`].
///
/// # Panics
///
/// Panics if either dimension exceeds [`ASSIGNMENT_CEILING`] — callers on the
/// sensing path never offer more than that many tracks or blobs at once (see
/// `tracking.rs`'s own defensive cap), so this is a programming error, not a
/// reachable runtime condition.
#[must_use]
pub fn assign_tracks(costs: &[Vec<f64>]) -> Vec<Assignment> {
    let tracks = costs.len();
    let blobs = costs.first().map_or(0, Vec::len);
    assert!(
        tracks <= ASSIGNMENT_CEILING && blobs <= ASSIGNMENT_CEILING,
        "assign_tracks: {tracks} tracks x {blobs} blobs exceeds the {ASSIGNMENT_CEILING}-body ceiling",
    );
    if tracks == 0 || blobs == 0 {
        return Vec::new();
    }

    let total_slots = tracks + blobs;
    let (cost_matrix, forbidden) = build_padded_cost_matrix(costs, tracks, blobs);
    let match_of = run_hungarian(&cost_matrix, total_slots);

    let mut result = Vec::new();
    for col in 1..=blobs {
        let row = at(&match_of, col);
        if row <= tracks && cell(&cost_matrix, row, col) < forbidden {
            result.push(Assignment {
                track_index: row - 1,
                blob_index: col - 1,
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{ASSIGNMENT_CEILING, Assignment, assign_tracks};

    const INF: f64 = f64::INFINITY;

    fn total_cost(costs: &[Vec<f64>], assignment: &[Assignment]) -> f64 {
        assignment
            .iter()
            .filter_map(|m| {
                costs
                    .get(m.track_index)
                    .and_then(|row| row.get(m.blob_index))
            })
            .sum()
    }

    /// Old greedy strategy, kept here only to prove it starves a track the
    /// new one does not.
    fn greedy_assign(costs: &[Vec<f64>]) -> Vec<Assignment> {
        let mut candidates: Vec<(usize, usize, f64)> = Vec::new();
        for (t, row) in costs.iter().enumerate() {
            for (b, &cost) in row.iter().enumerate() {
                if cost.is_finite() {
                    candidates.push((t, b, cost));
                }
            }
        }
        candidates.sort_by(|first, second| first.2.total_cmp(&second.2));
        let mut used_tracks = vec![false; costs.len()];
        let mut used_blobs = vec![false; costs.first().map_or(0, Vec::len)];
        let mut result = Vec::new();
        for (track_index, blob_index, _) in candidates {
            let track_used = used_tracks
                .get_mut(track_index)
                .expect("in bounds by construction");
            let blob_used = used_blobs
                .get_mut(blob_index)
                .expect("in bounds by construction");
            if *track_used || *blob_used {
                continue;
            }
            *track_used = true;
            *blob_used = true;
            result.push(Assignment {
                track_index,
                blob_index,
            });
        }
        result
    }

    /// Exhaustive search for the true objective: the largest number of gated
    /// pairs matchable at once, and the lowest total distance among matchings
    /// of that size. Used only to cross-check the Hungarian solver.
    fn search_best_matching(
        costs: &[Vec<f64>],
        track_index: usize,
        size: usize,
        cost: f64,
        used_blobs: &mut [bool],
        best: &mut (usize, f64),
    ) {
        let Some(row) = costs.get(track_index) else {
            if size > best.0 || (size == best.0 && cost < best.1) {
                *best = (size, cost);
            }
            return;
        };
        search_best_matching(costs, track_index + 1, size, cost, used_blobs, best);
        for (blob_index, &blob_cost) in row.iter().enumerate() {
            let used = used_blobs
                .get_mut(blob_index)
                .expect("in bounds by construction");
            if *used || !blob_cost.is_finite() {
                continue;
            }
            *used = true;
            search_best_matching(
                costs,
                track_index + 1,
                size + 1,
                cost + blob_cost,
                used_blobs,
                best,
            );
            *used_blobs
                .get_mut(blob_index)
                .expect("in bounds by construction") = false;
        }
    }

    fn brute_force_optimal(costs: &[Vec<f64>]) -> (usize, f64) {
        let blobs = costs.first().map_or(0, Vec::len);
        let mut best = (0_usize, 0.0_f64);
        let mut used_blobs = vec![false; blobs];
        search_best_matching(costs, 0, 0, 0.0, &mut used_blobs, &mut best);
        best
    }

    #[test]
    fn the_starvation_case_greedy_leaves_a_gated_track_unmatched_assignment_does_not() {
        // Track 0 is gated to blobs 0 and 1; track 1 is gated to blob 0 only.
        // Greedy claims the globally-nearest pair first (track 0 x blob 0,
        // cost 1), starving track 1 even though matching track 0 to blob 1
        // instead (cost 2) leaves track 1 free to take blob 0 (cost 1) for a
        // lower total.
        let costs = vec![vec![1.0, 2.0], vec![1.0, INF]];
        let greedy = greedy_assign(&costs);
        assert_eq!(greedy.len(), 1, "greedy claims only one pair");

        let mut optimal = assign_tracks(&costs);
        assert_eq!(optimal.len(), 2, "both tracks are matched");
        optimal.sort_by_key(|m| m.track_index);
        assert_eq!(
            optimal,
            vec![
                Assignment {
                    track_index: 0,
                    blob_index: 1
                },
                Assignment {
                    track_index: 1,
                    blob_index: 0
                },
            ]
        );
        assert!((total_cost(&costs, &optimal) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn an_ungated_pair_never_appears_however_cheap_the_alternative() {
        assert_eq!(assign_tracks(&[vec![INF]]), Vec::new());
    }

    #[test]
    fn empty_input_matches_nothing_and_does_not_panic() {
        assert_eq!(assign_tracks(&[]), Vec::new());
        assert_eq!(assign_tracks(&[vec![]]), Vec::new());
    }

    #[test]
    #[should_panic(expected = "exceeds the")]
    fn a_track_count_past_the_ceiling_is_refused() {
        let too_many = vec![vec![1.0]; ASSIGNMENT_CEILING + 1];
        let _ = assign_tracks(&too_many);
    }

    #[test]
    #[should_panic(expected = "exceeds the")]
    fn a_blob_count_past_the_ceiling_is_refused() {
        let too_many = vec![vec![1.0; ASSIGNMENT_CEILING + 1]];
        let _ = assign_tracks(&too_many);
    }

    #[test]
    fn exactly_at_the_ceiling_is_accepted() {
        let square: Vec<Vec<f64>> = (0..ASSIGNMENT_CEILING)
            .map(|i| {
                (0..ASSIGNMENT_CEILING)
                    .map(|j| if i == j { 0.0 } else { INF })
                    .collect()
            })
            .collect();
        let result = assign_tracks(&square);
        assert_eq!(result.len(), ASSIGNMENT_CEILING);
        for m in &result {
            assert_eq!(m.track_index, m.blob_index);
        }
    }

    /// A small linear-congruential stream, seeded, so a failure is
    /// reproducible. Not cryptographic; only used to generate test matrices.
    struct TestRng(u64);
    impl TestRng {
        fn next_unit(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(1_103_515_245).wrapping_add(12_345) & 0x7fff_ffff;
            #[allow(clippy::cast_precision_loss)]
            let numerator = self.0 as f64;
            numerator / f64::from(0x7fff_ffff_u32)
        }
    }

    #[test]
    fn the_solver_matches_a_brute_force_optimum_on_random_small_gated_matrices() {
        let mut rng = TestRng(0x02f6_e2b1);
        for trial in 0..200 {
            #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
            let tracks = 1 + (rng.next_unit() * 5.0) as usize;
            #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
            let blobs = 1 + (rng.next_unit() * 5.0) as usize;
            let costs: Vec<Vec<f64>> = (0..tracks)
                .map(|_| {
                    (0..blobs)
                        .map(|_| {
                            if rng.next_unit() < 0.35 {
                                INF
                            } else {
                                (rng.next_unit() * 100.0).round() / 10.0
                            }
                        })
                        .collect()
                })
                .collect();
            let optimal = assign_tracks(&costs);
            for m in &optimal {
                let cost = costs
                    .get(m.track_index)
                    .and_then(|row| row.get(m.blob_index))
                    .expect("reported indices are in bounds");
                assert!(cost.is_finite(), "trial {trial}: reported an ungated match");
            }
            let mut track_seen = vec![false; tracks];
            let mut blob_seen = vec![false; blobs];
            for m in &optimal {
                let track_slot = track_seen.get_mut(m.track_index).expect("in bounds");
                assert!(!*track_slot, "trial {trial}: a track matched twice");
                *track_slot = true;
                let blob_slot = blob_seen.get_mut(m.blob_index).expect("in bounds");
                assert!(!*blob_slot, "trial {trial}: a blob matched twice");
                *blob_slot = true;
            }
            let (expected_size, expected_cost) = brute_force_optimal(&costs);
            assert_eq!(
                optimal.len(),
                expected_size,
                "trial {trial}: wrong match count"
            );
            assert!(
                (total_cost(&costs, &optimal) - expected_cost).abs() < 1e-9,
                "trial {trial}: got {}, expected {expected_cost}",
                total_cost(&costs, &optimal)
            );
        }
    }

    #[test]
    fn a_worst_case_ceiling_by_ceiling_assignment_costs_a_small_fraction_of_the_full_tier_budget() {
        let mut rng = TestRng(0x051e_d270);
        let costs: Vec<Vec<f64>> = (0..ASSIGNMENT_CEILING)
            .map(|_| {
                (0..ASSIGNMENT_CEILING)
                    .map(|_| {
                        if rng.next_unit() < 0.5 {
                            INF
                        } else {
                            rng.next_unit() * 0.3
                        }
                    })
                    .collect()
            })
            .collect();
        let iterations = 500;
        let start = std::time::Instant::now();
        for _ in 0..iterations {
            let _ = assign_tracks(&costs);
        }
        let per_call_ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iterations);
        // The FULL hardware tier's analysis budget is 42ms (mirrors
        // lib/simulation.ts's HARDWARE_PROFILES); this must stay a small
        // fraction of it, not merely under it.
        let full_tier_budget_ms = 42.0;
        assert!(
            per_call_ms < full_tier_budget_ms * 0.05,
            "worst-case assign_tracks took {per_call_ms:.4}ms per call, over 5% of the {full_tier_budget_ms}ms FULL-tier budget"
        );
    }
}
