export type Coordinate = { x: number; y: number };
export type Homography = [number, number, number, number, number, number, number, number, number];

export function solveHomography(source: Coordinate[], target: Coordinate[]): Homography {
  if (source.length !== 4 || target.length !== 4) throw new Error('A homography requires exactly four point pairs');
  const matrix: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = source[index];
    const { x: u, y: v } = target[index];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const solution = gaussianElimination(matrix);
  return [...solution, 1] as Homography;
}

export function applyHomography<T extends Coordinate>(point: T, matrix: Homography): T {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) < 1e-9) return { ...point };
  return {
    ...point,
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

export function mapCalibratedPoint<T extends Coordinate>(point: T, source: Coordinate[], target: Coordinate[]): T {
  try {
    return applyHomography(point, solveHomography(source, target));
  } catch {
    return { ...point };
  }
}

function gaussianElimination(rows: number[][]) {
  const size = 8;
  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(rows[row][pivot]) > Math.abs(rows[best][pivot])) best = row;
    }
    [rows[pivot], rows[best]] = [rows[best], rows[pivot]];
    const divisor = rows[pivot][pivot];
    if (Math.abs(divisor) < 1e-10) throw new Error('Calibration points are degenerate');
    for (let column = pivot; column <= size; column += 1) rows[pivot][column] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = rows[row][pivot];
      for (let column = pivot; column <= size; column += 1) rows[row][column] -= factor * rows[pivot][column];
    }
  }
  return rows.map((row) => row[size]);
}

