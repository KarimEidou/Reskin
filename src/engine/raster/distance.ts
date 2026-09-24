// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher 2012) and
// the anti-aliased morphology built on it (dilate/erode by any radius in
// O(pixels), used by outline, spread and choke effects).

const INF = 1e20;

function dt1d(
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Distance (px, between pixel centres) from every pixel to the nearest pixel
 * where `inside(i)` holds; 0 on inside pixels, ~1e10 when there are none.
 */
export function distanceTransform(
  w: number,
  h: number,
  inside: (index: number) => boolean,
): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = inside(i) ? 0 : INF;
  // Columns.
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    dt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  // Rows.
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    dt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) out[row + x] = Math.sqrt(d[x]);
  }
  return out;
}

/**
 * Anti-aliased dilation of a 0..1 coverage plane by `radius` px. The shape
 * is thresholded at 0.5 for the distance field; original soft edges are
 * kept (max with the input).
 */
export function dilate(plane: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return plane.slice();
  const dist = distanceTransform(w, h, (i) => plane[i] >= 0.5);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const c = radius + 1 - dist[i];
    const cov = c <= 0 ? 0 : c >= 1 ? 1 : c;
    out[i] = cov > plane[i] ? cov : plane[i];
  }
  return out;
}

/** Anti-aliased erosion of a 0..1 coverage plane by `radius` px. */
export function erode(plane: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return plane.slice();
  const dist = distanceTransform(w, h, (i) => plane[i] < 0.5);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const c = dist[i] - radius;
    const cov = c <= 0 ? 0 : c >= 1 ? 1 : c;
    out[i] = cov < plane[i] ? cov : plane[i];
  }
  return out;
}
