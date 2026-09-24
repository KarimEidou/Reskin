// Symmetry for the painting tools (brush, pencil, eraser): every dab or
// pixel is replicated through a set of affine transforms. The first
// transform is always the identity (the real stroke).
//
// - 'x':  mirror left↔right across the vertical axis through the centre
// - 'y':  mirror top↔bottom across the horizontal axis
// - 'xy': both (4 copies)
// - 'radial': N rotations about the centre; with `mirror`, each rotation is
//   also reflected (kaleidoscope, 2N copies)

import type { Affine, Point } from '../geometry/affine';
import { IDENTITY, apply, compose, multiply, rotation, translation } from '../geometry/affine';

export type SymmetryMode = 'off' | 'x' | 'y' | 'xy' | 'radial';

export interface SymmetrySettings {
  mode: SymmetryMode;
  /** Radial copies (2..64). */
  rays: number;
  /** Radial: add mirrored copies. */
  mirror: boolean;
  /** Centre in document px; null = document centre. */
  cx: number | null;
  cy: number | null;
}

export const NO_SYMMETRY: Readonly<SymmetrySettings> = Object.freeze({
  mode: 'off',
  rays: 6,
  mirror: false,
  cx: null,
  cy: null,
});

export function symmetryCenter(s: SymmetrySettings, width: number, height: number): Point {
  return { x: s.cx ?? width / 2, y: s.cy ?? height / 2 };
}

/** Transforms (document px → document px), identity first. */
export function symmetryTransforms(s: SymmetrySettings, width: number, height: number): Affine[] {
  const { x: cx, y: cy } = symmetryCenter(s, width, height);
  const mirrorX: Affine = [-1, 0, 0, 1, 2 * cx, 0];
  const mirrorY: Affine = [1, 0, 0, -1, 0, 2 * cy];
  switch (s.mode) {
    case 'off':
      return [IDENTITY];
    case 'x':
      return [IDENTITY, mirrorX];
    case 'y':
      return [IDENTITY, mirrorY];
    case 'xy':
      return [IDENTITY, mirrorX, mirrorY, multiply(mirrorX, mirrorY)];
    case 'radial': {
      const n = Math.max(2, Math.min(64, Math.floor(s.rays)));
      const out: Affine[] = [];
      for (let k = 0; k < n; k++) {
        const rot = compose(translation(-cx, -cy), rotation((k * 2 * Math.PI) / n), translation(cx, cy));
        out.push(k === 0 ? IDENTITY : rot);
        if (s.mirror) out.push(multiply(rot, mirrorX));
      }
      return out;
    }
  }
}

/** Every symmetric copy of a document point (identity first). */
export function mirrorPoint(transforms: readonly Affine[], x: number, y: number): Point[] {
  return transforms.map((m) => apply(m, x, y));
}

/**
 * Every symmetric copy of pixel (px, py): the pixel centre is transformed
 * and floored. Duplicates and pixels outside the canvas are dropped.
 */
export function mirrorPixel(
  transforms: readonly Affine[],
  px: number,
  py: number,
  width: number,
  height: number,
): [number, number][] {
  const out: [number, number][] = [];
  const seen = new Set<number>();
  for (const m of transforms) {
    const p = apply(m, px + 0.5, py + 0.5);
    const x = Math.floor(p.x + 1e-9);
    const y = Math.floor(p.y + 1e-9);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const key = y * width + x;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([x, y]);
  }
  return out;
}
