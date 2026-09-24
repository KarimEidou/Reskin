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
