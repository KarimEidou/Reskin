// Work-buffer kernels of the layer-effect renderer (./effects.ts): the
// Gaussian blur of raster/blur.ts and the anti-aliased dilate / erode of
// raster/distance.ts on single-channel planes, computing the very same
// numbers (same kernels, same summation order, same float32 rounding) but
// writing into caller-owned buffers and walking memory row by row (the
// vertical passes keep one running sum per column), so rendering effects
// allocates nothing and stays cache-friendly. Each kernel also knows how
// far it reaches, which lets the renderer work on a bounded region.

/** Sampled Gaussian below this σ, three box passes from it (raster/blur.ts). */
const KERNEL_SIGMA_MAX = 2;
/** "Infinitely far" squared distance of the distance transform. */
const INF = 1e20;

/** Reusable planes and work arrays; grows as needed, never shrinks. */
export class EffectScratch {
  private readonly pool: Float32Array[] = [];
  private used = 0;
  private f64 = new Float64Array(0);
  private sums = new Float64Array(0);
  private line = { f: new Float64Array(0), d: new Float64Array(0), v: new Int32Array(0), z: new Float64Array(0) };

  /** Starts a render: every plane handed out before becomes free again. */
  reset(): void {
    this.used = 0;
  }

  /** A plane of `n` floats (NOT cleared), valid until the next `reset`. */
  plane(n: number): Float32Array {
    let buf = this.pool[this.used];
    if (!buf || buf.length < n) {
      buf = new Float32Array(Math.max(n, buf ? buf.length * 2 : 0));
      this.pool[this.used] = buf;
    }
    this.used++;
    return buf.subarray(0, n);
  }

  /** A zeroed plane of `n` floats. */
  zeroed(n: number): Float32Array {
    const p = this.plane(n);
    p.fill(0);
    return p;
  }

  /** `n` doubles (the distance transform's grid). */
  grid(n: number): Float64Array {
    if (this.f64.length < n) this.f64 = new Float64Array(n);
    return this.f64;
  }

  /** One running sum per column of a `w`-wide plane. */
  columnSums(w: number): Float64Array {
    if (this.sums.length < w) this.sums = new Float64Array(w);
    return this.sums;
  }

  /** 1-D work arrays of the distance transform for lines of up to `n` pixels. */
  lines(n: number): { f: Float64Array; d: Float64Array; v: Int32Array; z: Float64Array } {
    if (this.line.f.length < n) {
      this.line = { f: new Float64Array(n), d: new Float64Array(n), v: new Int32Array(n), z: new Float64Array(n + 1) };
    }
    return this.line;
  }
}

// ---- Gaussian blur ------------------------------------------------------------

/** Box sizes whose triple convolution approximates a Gaussian (Kutskir). */
function boxesForGauss(sigma: number, n = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** How far (px, per axis) a blur of `sigma` spreads a pixel. */
export function blurReach(sigma: number): number {
  if (!(sigma > 0.2)) return 0;
  if (sigma < KERNEL_SIGMA_MAX) return Math.max(1, Math.ceil(sigma * 3));
  let reach = 0;
  for (const size of boxesForGauss(sigma)) {
    const r = (size - 1) >> 1;
    if (r >= 1) reach += r;
  }
  return reach;
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let sum = 0;
    for (let k = 0; k <= r && k < w; k++) sum += src[base + k];
    for (let x = 0; x < w; x++) {
      dst[base + x] = sum * inv;
      const add = x + r + 1;
      const sub = x - r;
      if (add < w) sum += src[base + add];
      if (sub >= 0) sum -= src[base + sub];
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, sums: Float64Array): void {
  const inv = 1 / (2 * r + 1);
  sums.fill(0, 0, w);
  for (let k = 0; k <= r && k < h; k++) {
    const row = k * w;
    for (let x = 0; x < w; x++) sums[x] += src[row + x];
  }
  for (let y = 0; y < h; y++) {
    const out = y * w;
    for (let x = 0; x < w; x++) dst[out + x] = sums[x] * inv;
    const add = y + r + 1;
    const sub = y - r;
    if (add < h) {
      const row = add * w;
      for (let x = 0; x < w; x++) sums[x] += src[row + x];
    }
    if (sub >= 0) {
      const row = sub * w;
      for (let x = 0; x < w; x++) sums[x] -= src[row + x];
    }
  }
}

function convolveH(src: Float32Array, dst: Float32Array, w: number, h: number, kernel: Float32Array): void {
  const r = (kernel.length - 1) >> 1;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      const k0 = Math.max(-r, -x);
      const k1 = Math.min(r, w - 1 - x);
      for (let k = k0; k <= k1; k++) v += src[base + x + k] * kernel[k + r];
      dst[base + x] = v;
    }
  }
}

function convolveV(src: Float32Array, dst: Float32Array, w: number, h: number, kernel: Float32Array, acc: Float64Array): void {
  const r = (kernel.length - 1) >> 1;
  for (let y = 0; y < h; y++) {
    acc.fill(0, 0, w);
    const k0 = Math.max(-r, -y);
    const k1 = Math.min(r, h - 1 - y);
    for (let k = k0; k <= k1; k++) {
      const row = (y + k) * w;
      const kv = kernel[k + r];
      for (let x = 0; x < w; x++) acc[x] += src[row + x] * kv;
    }
    const out = y * w;
    for (let x = 0; x < w; x++) dst[out + x] = acc[x];
  }
}

/**
 * Gaussian blur of a `w`×`h` plane in place (outside the plane counts as
 * 0), exactly like `gaussianBlurPlane` of raster/blur.ts. `tmp` holds at
 * least w·h floats.
 */
export function blurPlane(plane: Float32Array, w: number, h: number, sigma: number, tmp: Float32Array, scratch: EffectScratch): void {
  if (!(sigma > 0.2)) return;
  const sums = scratch.columnSums(w);
  if (sigma < KERNEL_SIGMA_MAX) {
    const k = gaussianKernel(sigma);
    convolveH(plane, tmp, w, h, k);
    convolveV(tmp, plane, w, h, k, sums);
    return;
  }
  for (const size of boxesForGauss(sigma)) {
    const r = (size - 1) >> 1;
    if (r < 1) continue;
    boxH(plane, tmp, w, h, r);
    boxV(tmp, plane, w, h, r, sums);
  }
}

// ---- distance transform, dilate / erode ---------------------------------------------

function dt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number): void {
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
 * Squared Euclidean distance from every pixel to the nearest pixel whose
 * plane value is ≥ 0.5 (`above`) or < 0.5 (otherwise), into `grid`.
 */
function squaredDistances(plane: Float32Array, w: number, h: number, above: boolean, scratch: EffectScratch): Float64Array {
  const n = w * h;
  const grid = scratch.grid(n);
  for (let i = 0; i < n; i++) grid[i] = plane[i] >= 0.5 === above ? 0 : INF;
  const { f, d, v, z } = scratch.lines(Math.max(w, h));
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    dt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    dt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
  return grid;
}

/** How far (px, per axis) dilating by `radius` spreads a shape. */
export function dilateReach(radius: number): number {
  return radius > 0 ? Math.ceil(radius) + 1 : 0;
}

/**
 * Anti-aliased dilation of a coverage plane by `radius` px, from `src` into
 * `dst` (may be the same plane), exactly like `dilate` of raster/distance.ts.
 */
export function dilatePlane(src: Float32Array, dst: Float32Array, w: number, h: number, radius: number, scratch: EffectScratch): void {
  const n = w * h;
  if (radius <= 0) {
    if (dst !== src) dst.set(src.subarray(0, n));
    return;
  }
  const grid = squaredDistances(src, w, h, true, scratch);
  for (let i = 0; i < n; i++) {
    const c = radius + 1 - Math.fround(Math.sqrt(grid[i]));
    const cov = c <= 0 ? 0 : c >= 1 ? 1 : c;
    const p = src[i];
    dst[i] = cov > p ? cov : p;
  }
}

/**
 * `src` minus its anti-aliased erosion by `radius` px (the inner band of
 * an outline), into `dst`, exactly like raster/distance.ts's `erode`.
 */
export function innerBandPlane(src: Float32Array, dst: Float32Array, w: number, h: number, radius: number, scratch: EffectScratch): void {
  const n = w * h;
  const grid = squaredDistances(src, w, h, false, scratch);
  for (let i = 0; i < n; i++) {
    const c = Math.fround(Math.sqrt(grid[i])) - radius;
    const cov = c <= 0 ? 0 : c >= 1 ? 1 : c;
    const p = src[i];
    const eroded = Math.fround(cov < p ? cov : p);
    dst[i] = Math.max(0, p - eroded);
  }
}
