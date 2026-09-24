// 2D affine matrices in canvas order: [a, b, c, d, e, f] maps
// (x, y) → (a·x + c·y + e, b·x + d·y + f), same as `ctx.setTransform`.

export type Affine = readonly [number, number, number, number, number, number];

export interface Point {
  x: number;
  y: number;
}

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function translation(tx: number, ty: number): Affine {
  return [1, 0, 0, 1, tx, ty];
}

export function scaling(sx: number, sy: number = sx): Affine {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotation(rad: number): Affine {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

/** `m · n`: applies `n` first, then `m`. */
export function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Composes left to right: `compose(a, b, c)` applies a, then b, then c. */
export function compose(...ms: Affine[]): Affine {
  let out = IDENTITY;
  for (const m of ms) out = multiply(m, out);
  return out;
}

export function determinant(m: Affine): number {
  return m[0] * m[3] - m[1] * m[2];
}

/** Inverse, or null when the matrix is singular. */
export function invert(m: Affine): Affine | null {
  const det = determinant(m);
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    m[3] * id,
    -m[1] * id,
    -m[2] * id,
    m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id,
  ];
}

export function apply(m: Affine, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Rotation/scale part only (for vectors). */
export function applyVector(m: Affine, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y };
}

export function isIdentity(m: Affine, eps = 1e-9): boolean {
  return (
    Math.abs(m[0] - 1) < eps &&
    Math.abs(m[1]) < eps &&
    Math.abs(m[2]) < eps &&
    Math.abs(m[3] - 1) < eps &&
    Math.abs(m[4]) < eps &&
    Math.abs(m[5]) < eps
  );
}

/** True for a pure translation by whole pixels. */
export function isIntegerTranslation(m: Affine, eps = 1e-9): boolean {
  return (
    Math.abs(m[0] - 1) < eps &&
    Math.abs(m[1]) < eps &&
    Math.abs(m[2]) < eps &&
    Math.abs(m[3] - 1) < eps &&
    Math.abs(m[4] - Math.round(m[4])) < eps &&
    Math.abs(m[5] - Math.round(m[5])) < eps
  );
}

/** Rotation/scale about a pivot. */
export function aboutPoint(m: Affine, px: number, py: number): Affine {
  return compose(translation(-px, -py), m, translation(px, py));
}
