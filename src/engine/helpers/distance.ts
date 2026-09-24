/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), O(n).
 */

const INF = 1e20;

function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * For every pixel, the Euclidean distance (px, centre to centre) to the
 * nearest pixel where `feature` is non-zero; 0 on feature pixels and
 * `Infinity` everywhere when there are none.
 */
export function distanceTransform(feature: Uint8Array, width: number, height: number): Float32Array {
  const n = width * height;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const grid = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (feature[i]) any = true;
    else grid[i] = INF;
  }
  if (!any) return out.fill(Infinity);
  const len = Math.max(width, height);
  const f = new Float64Array(len);
  const d = new Float64Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    dt1d(f, height, d, v, z);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = grid[row + x];
    dt1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) out[row + x] = Math.sqrt(d[x]);
  }
  return out;
}
