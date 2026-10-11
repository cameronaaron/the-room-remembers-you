/**
 * Optimal bipartite matching between tracks and blobs, replacing greedy
 * nearest-neighbor claiming.
 *
 * Greedy claiming — sort every gated `{track, blob}` pair by distance, then
 * claim in that order — is not optimal assignment. A track gated to only one
 * blob can be starved when a different track, gated to two blobs, greedily
 * claims the shared one first, even though a global optimum could match both.
 * That is exactly the failure mode that costs the room a visitor: gates
 * overlap most when two people stand close together, which is precisely when
 * greedy and optimal diverge.
 *
 * The cost matrix passed in already encodes gating — an ungated pair is
 * `Infinity` — so this function cannot introduce a match the existing
 * distance-gate formula would have refused. Only the claiming strategy
 * changes; the gate itself is untouched.
 */

/**
 * Bound on the assignment problem this will ever solve. Matches the
 * detector's own cap on simultaneous bodies (`MAX_DETECTED_BODIES` in
 * `motion-tracker.ts`), named here rather than imported so this module has no
 * dependency on the detector — the ceiling is a property of the algorithm's
 * cost (O(n^3) on a matrix this large is still microseconds; larger is not
 * a case this installation's hardware profiles ever produce).
 */
export const ASSIGNMENT_CEILING = 12;

export type Assignment = { trackIndex: number; blobIndex: number };

/**
 * Matching over `costs[track][blob]` that first maximizes how many gated
 * pairs are matched, and only among matchings of that size minimizes total
 * distance. Ungated pairs must be `Infinity`.
 *
 * Pure minimum-cost matching is the wrong objective here: since every real
 * distance is non-negative, "leave everyone unmatched" always has cost zero
 * and a naive solver returns exactly that (caught by the brute-force
 * cross-check in the test file). A blob is motion evidence a caller wants
 * attributed to a track whenever a gated one exists, not a cost to be
 * minimized away — so opting out of a match must be made to cost more than
 * any real match ever could, which is what `unmatchedCost` below does.
 *
 * Implementation: Kuhn–Munkres (Hungarian algorithm) with potentials, the
 * standard O(n^3) shortest-augmenting-path formulation, over a matrix padded
 * to a `tracks + blobs` square (not merely `max(tracks, blobs)`, which gives
 * only one shared "unmatched" slot and forces every track/blob past the
 * first into some match regardless of cost). Padding to `tracks + blobs`
 * gives every real track its own dummy column and every real blob its own
 * dummy row, reachable only by its own real counterpart, so any one of them
 * can opt out independently at the shared `unmatchedCost`.
 */
export function assignTracks(costs: readonly (readonly number[])[]): Assignment[] {
  const tracks = costs.length;
  const blobs = tracks > 0 ? costs[0].length : 0;
  if (tracks > ASSIGNMENT_CEILING || blobs > ASSIGNMENT_CEILING) {
    throw new RangeError(
      `assignTracks: ${tracks} tracks x ${blobs} blobs exceeds the ${ASSIGNMENT_CEILING}-body ceiling`,
    );
  }
  if (tracks === 0 || blobs === 0) return [];

  const n = tracks + blobs;
  let sumOfFiniteCosts = 0;
  for (let i = 0; i < tracks; i++) {
    for (let j = 0; j < blobs; j++) {
      if (Number.isFinite(costs[i][j])) sumOfFiniteCosts += costs[i][j];
    }
  }
  // Exceeds even the sum of every gated pair's cost, so using one more real
  // edge always beats opting out, however far that edge is — matching is
  // strictly preferred to not matching, and distance only breaks ties among
  // matchings of the same size. Individually finite; the whole padded matrix
  // stays well inside `Number.MAX_SAFE_INTEGER` at the documented ceiling.
  const unmatchedCost = sumOfFiniteCosts + 1;
  // Exceeds the worst possible complete embedding (every slot opting out),
  // so a forbidden real pair is never chosen over that.
  const FORBIDDEN = unmatchedCost * (n + 1) + 1;

  // 1-indexed throughout: the augmenting-path formulation reserves index 0
  // for "no row/column yet", which a 0-indexed matrix would collide with.
  // Rows 1..tracks are real tracks; rows tracks+1..n are blob b's own dummy
  // row (b = row - tracks - 1). Columns 1..blobs are real blobs; columns
  // blobs+1..n are track t's own dummy column (t = col - blobs - 1).
  const a: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: n + 1 }, () => FORBIDDEN));
  for (let i = 1; i <= tracks; i++) {
    for (let j = 1; j <= blobs; j++) {
      const cost = costs[i - 1][j - 1];
      a[i][j] = Number.isFinite(cost) ? cost : FORBIDDEN;
    }
    a[i][blobs + i] = unmatchedCost; // track i's own "leave me unmatched" column
  }
  for (let b = 1; b <= blobs; b++) {
    a[tracks + b][b] = unmatchedCost; // blob b's own "leave me unmatched" row
  }
  for (let i = tracks + 1; i <= n; i++) {
    for (let j = blobs + 1; j <= n; j++) a[i][j] = 0; // dummy-dummy pairs settle the bookkeeping for free
  }

  const u = Array.from({ length: n + 1 }, () => 0);
  const v = Array.from({ length: n + 1 }, () => 0);
  const matchOf = Array.from({ length: n + 1 }, () => 0); // matchOf[j] = row currently matched to column j
  const parentCol = Array.from({ length: n + 1 }, () => 0);

  for (let i = 1; i <= n; i++) {
    matchOf[0] = i;
    let j0 = 0;
    const minCost = Array.from({ length: n + 1 }, () => Infinity);
    const visited = Array.from({ length: n + 1 }, () => false);
    do {
      visited[j0] = true;
      const i0 = matchOf[j0];
      let delta = Infinity;
      let nextJ = -1;
      for (let j = 1; j <= n; j++) {
        if (visited[j]) continue;
        const reduced = a[i0][j] - u[i0] - v[j];
        if (reduced < minCost[j]) { minCost[j] = reduced; parentCol[j] = j0; }
        if (minCost[j] < delta) { delta = minCost[j]; nextJ = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (visited[j]) { u[matchOf[j]] += delta; v[j] -= delta; }
        else minCost[j] -= delta;
      }
      j0 = nextJ;
    } while (matchOf[j0] !== 0);
    do {
      const j1 = parentCol[j0];
      matchOf[j0] = matchOf[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const result: Assignment[] = [];
  for (let j = 1; j <= n; j++) {
    const i = matchOf[j];
    if (i <= tracks && j <= blobs && a[i][j] < FORBIDDEN) {
      result.push({ trackIndex: i - 1, blobIndex: j - 1 });
    }
  }
  return result;
}
