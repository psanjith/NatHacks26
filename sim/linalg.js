// Solves A x = b for a small dense system (Gaussian elimination, partial pivoting).
export function solveLinear(A, b) {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < 1e-15) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = col + 1; row < n; row += 1) {
      const f = m[row][col] / m[col][col];
      for (let k = col; k <= n; k += 1) m[row][k] -= f * m[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = m[row][n];
    for (let k = row + 1; k < n; k += 1) sum -= m[row][k] * x[k];
    x[row] = sum / m[row][row];
  }
  return x;
}
