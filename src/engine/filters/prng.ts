/**
 * Deterministic randomness: a seeded sequential PRNG (mulberry32) and an
 * order-independent integer hash for per-pixel noise.
 */

/** Normalises any number to a uint32 seed. */
export function seedOf(seed: number): number {
  return Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
}

/** mulberry32: a fast seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seedOf(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hash of (x, y, seed, salt) → float in [0, 1). The value depends only on the
 * arguments, so noise stays put regardless of processing order or masks.
 */
export function hash01(x: number, y: number, seed: number, salt: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9) ^ Math.imul(salt | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Inverse of the standard normal CDF (Acklam's rational approximation,
 * relative error < 1.2e-9) for p in (0, 1); ±Infinity at the ends.
 */
export function inverseNormalCdf(p: number): number {
  if (!(p > 0)) return -Infinity;
  if (!(p < 1)) return Infinity;
  const plow = 0.02425;
  if (p < plow || p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(p < plow ? p : 1 - p));
    const x =
      (((((-7.784894002430293e-3 * q - 3.223964580411365e-1) * q - 2.400758277161838) * q - 2.549732539343734) * q + 4.374664141464968) * q + 2.938163982698783) /
      ((((7.784695709041462e-3 * q + 3.224671290700398e-1) * q + 2.445134137142996) * q + 3.754408661907416) * q + 1);
    return p < plow ? x : -x;
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((-3.969683028665376e1 * r + 2.209460984245205e2) * r - 2.759285104469687e2) * r + 1.38357751867269e2) * r - 3.066479806614716e1) * r + 2.506628277459239) * q) /
    (((((-5.447609879822406e1 * r + 1.615858368580409e2) * r - 1.556989798598866e2) * r + 6.680131188771972e1) * r - 1.328068155288572e1) * r + 1)
  );
}

/** Size of the `normalTable` lookup (a power of two). */
export const NORMAL_TABLE_SIZE = 4096;

let normal: Float32Array | null = null;

/**
 * Standard-normal quantiles at the midpoints of `NORMAL_TABLE_SIZE` equal
 * probability bins, rescaled to exactly zero mean and unit variance.
 * Indexing it with `(u * NORMAL_TABLE_SIZE) | 0` for a uniform u ∈ [0, 1)
 * turns one uniform sample into a Gaussian one (tails cut at ≈ ±3.7σ).
 */
export function normalTable(): Float32Array {
  if (normal) return normal;
  const n = NORMAL_TABLE_SIZE;
  const t = new Float64Array(n);
  let sq = 0;
  for (let i = 0; i < n; i++) {
    t[i] = inverseNormalCdf((i + 0.5) / n);
    sq += t[i] * t[i];
  }
  // The table is antisymmetric, so its mean is 0; normalise the variance.
  const k = 1 / Math.sqrt(sq / n);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = t[i] * k;
  normal = out;
  return out;
}
