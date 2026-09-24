// Easing curves (CSS strings for WAAPI/CSS, JS functions for rAF-driven
// motion) and the tiny numeric helpers the motion modules share.

/** CSS timing functions, tuned to feel at home next to Fluent motion. */
export const EASE = {
  /** Most UI transitions: quick start, long gentle settle. */
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  /** Things entering the screen. */
  decelerate: 'cubic-bezier(0, 0, 0, 1)',
  /** Things leaving the screen. */
  accelerate: 'cubic-bezier(0.3, 0, 1, 0.8)',
  /** Point-to-point moves that should feel deliberate. */
  emphasized: 'cubic-bezier(0.5, 0, 0, 1)',
  /** A small overshoot for playful pops. */
  overshoot: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  linear: 'linear',
} as const;

export type EaseName = keyof typeof EASE;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * JS evaluation of a CSS `cubic-bezier(x1, y1, x2, y2)` timing function.
 * Solves x(s) = t with Newton–Raphson, falling back to bisection.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  // Polynomial coefficients of the Bézier components (P0 = 0, P3 = 1).
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  function solveX(t: number): number {
    let s = t;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - t;
      if (Math.abs(err) < 1e-7) return s;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < 40; i++) {
      const x = sampleX(s);
      if (Math.abs(x - t) < 1e-7) break;
      if (x < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  }

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveX(t));
  };
}

/** JS versions of {@link EASE}. */
export const ease = {
  standard: cubicBezier(0.2, 0, 0, 1),
  decelerate: cubicBezier(0, 0, 0, 1),
  accelerate: cubicBezier(0.3, 0, 1, 0.8),
  emphasized: cubicBezier(0.5, 0, 0, 1),
  overshoot: cubicBezier(0.34, 1.56, 0.64, 1),
  linear: (t: number) => clamp(t, 0, 1),
} satisfies Record<EaseName, (t: number) => number>;

/**
 * Samples any easing function into a CSS `linear()` timing function, so
 * curves CSS cannot express (springs, bounces) still run on the compositor.
 */
export function linearEasing(fn: (t: number) => number, samples = 32): string {
  const n = Math.max(2, Math.round(samples));
  const points: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    points.push(String(Math.round(fn(t) * 10000) / 10000));
  }
  return `linear(${points.join(', ')})`;
}
