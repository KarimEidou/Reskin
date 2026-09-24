// Damped harmonic spring, solved analytically, and helpers that turn it into
// WAAPI keyframes / CSS `linear()` easings with an exact settle duration.
//
// The spring moves a normalised progress value from 0 to 1:
//   m·x'' + c·x' + k·(x − 1) = 0,   x(0) = 0,   x'(0) = v0
// With d = 1 − x (distance left): d(0) = 1, d'(0) = −v0.

import { lerp } from './easing';

export interface SpringParams {
  /** Spring constant k. Higher = faster. */
  stiffness: number;
  /** Damping coefficient c. Critical damping is 2·√(k·m). */
  damping: number;
  /** Mass m. Higher = slower and more inert. */
  mass: number;
  /** Initial velocity toward the target, in progress units (0→1) per second. */
  velocity: number;
}

/** Tolerances that decide when a spring is "at rest" (progress units). */
export interface SpringRest {
  /** Max distance from the target (default 0.001 = 0.1 % of the travel). */
  restDelta?: number;
  /** Max speed, progress units per second (default 0.01). */
  restSpeed?: number;
}

/**
 * Tuned presets. Durations are settle times (default rest tolerances) at
 * animation speed 1; `spring.test.ts` pins them.
 */
export const SPRINGS = {
  /** Box ↔ editor morph: ~480 ms, confident, practically no overshoot. */
  morph: { stiffness: 260, damping: 30, mass: 1, velocity: 0 },
  /** Small UI moves (popovers, chips, the absorbed icon): ~330 ms, crisp. */
  snappy: { stiffness: 520, damping: 42, mass: 1, velocity: 0 },
  /** Soft, critically damped glide with no overshoot: ~720 ms. */
  gentle: { stiffness: 170, damping: 26, mass: 1, velocity: 0 },
  /** Playful ~15 % overshoot for squash & stretch and pops. */
  bouncy: { stiffness: 400, damping: 20, mass: 1, velocity: 0 },
} as const satisfies Record<string, SpringParams>;

export type SpringName = keyof typeof SPRINGS;

const DEFAULT_REST_DELTA = 0.001;
const DEFAULT_REST_SPEED = 0.01;
/** Settle-time search step and ceiling (seconds). */
const SCAN_STEP = 0.001;
const MAX_SETTLE = 10;

export interface Spring {
  readonly params: SpringParams;
  /** Damping ratio ζ (< 1 underdamped, 1 critical, > 1 overdamped). */
  readonly dampingRatio: number;
  /** Undamped angular frequency ω0 (rad/s). */
  readonly angularFrequency: number;
  /** Progress at `t` seconds: 0 at t = 0, tending to 1. */
  position(t: number): number;
  /** d(progress)/dt at `t` seconds. */
  velocity(t: number): number;
  /** Seconds until the spring stays within the rest tolerances for good. */
  settleTime(rest?: SpringRest): number;
}

export function resolveSpring(params: Partial<SpringParams> = {}): SpringParams {
  const p = { ...SPRINGS.morph, ...params };
  if (!(p.stiffness > 0) || !(p.mass > 0) || !(p.damping >= 0) || !Number.isFinite(p.velocity)) {
    throw new RangeError(`invalid spring ${JSON.stringify(p)}`);
  }
  return p;
}

/** Builds the closed-form solution for the given parameters. */
export function createSpring(params: Partial<SpringParams> = {}): Spring {
  const p = resolveSpring(params);
  const w0 = Math.sqrt(p.stiffness / p.mass);
  const zeta = p.damping / (2 * Math.sqrt(p.stiffness * p.mass));
  const v0 = p.velocity;

  // d(t), d'(t) and an envelope bound E(t) ≥ max(|d|, |d'| / rate) used to
  // stop the settle-time scan early.
  let d: (t: number) => number;
  let dd: (t: number) => number;
  let bound: (t: number) => { pos: number; vel: number };

  if (Math.abs(zeta - 1) < 1e-9) {
    // Critically damped: d = e^(−ω0 t)·(1 + β t).
    const beta = w0 - v0;
    d = (t) => Math.exp(-w0 * t) * (1 + beta * t);
    dd = (t) => Math.exp(-w0 * t) * (beta - w0 * (1 + beta * t));
    bound = (t) => {
      const e = Math.exp(-w0 * t);
      const a = 1 + Math.abs(beta) * t;
      return { pos: a * e, vel: (w0 * a + Math.abs(beta)) * e };
    };
  } else if (zeta < 1) {
    // Underdamped: d = e^(−α t)·(cos ωd t + B sin ωd t).
    const alpha = zeta * w0;
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const B = (alpha - v0) / wd;
    const amp = Math.hypot(1, B);
    d = (t) => Math.exp(-alpha * t) * (Math.cos(wd * t) + B * Math.sin(wd * t));
    dd = (t) => {
      const c = Math.cos(wd * t);
      const s = Math.sin(wd * t);
      return Math.exp(-alpha * t) * (-alpha * (c + B * s) + wd * (B * c - s));
    };
    bound = (t) => {
      const e = amp * Math.exp(-alpha * t);
      return { pos: e, vel: e * (alpha + wd) };
    };
  } else {
    // Overdamped: d = C1 e^(r1 t) + C2 e^(r2 t), r1 the slower root.
    const root = Math.sqrt(zeta * zeta - 1);
    const r1 = -w0 * (zeta - root);
    const r2 = -w0 * (zeta + root);
    const C2 = (-v0 - r1) / (r2 - r1);
    const C1 = 1 - C2;
    d = (t) => C1 * Math.exp(r1 * t) + C2 * Math.exp(r2 * t);
    dd = (t) => C1 * r1 * Math.exp(r1 * t) + C2 * r2 * Math.exp(r2 * t);
    bound = (t) => {
      const e = Math.exp(r1 * t);
      return {
        pos: (Math.abs(C1) + Math.abs(C2)) * e,
        vel: (Math.abs(C1 * r1) + Math.abs(C2 * r2)) * e,
      };
    };
  }

  return {
    params: p,
    dampingRatio: zeta,
    angularFrequency: w0,
    position: (t) => (t <= 0 ? 0 : 1 - d(t)),
    velocity: (t) => (t <= 0 ? v0 : -dd(t)),
    settleTime(rest: SpringRest = {}) {
      const delta = rest.restDelta ?? DEFAULT_REST_DELTA;
      const speed = rest.restSpeed ?? DEFAULT_REST_SPEED;
      let lastMoving = 0;
      for (let t = 0; t <= MAX_SETTLE; t += SCAN_STEP) {
        if (Math.abs(d(t)) > delta || Math.abs(dd(t)) > speed) lastMoving = t;
        const b = bound(t);
        // From here on the spring can never leave the tolerances again.
        if (b.pos <= delta && b.vel <= speed) break;
      }
      return Math.min(MAX_SETTLE, lastMoving + SCAN_STEP);
    },
  };
}

export interface SpringKeyframeOptions<V> extends Partial<SpringParams>, SpringRest {
  /** Turns an interpolated value (and its progress 0→1) into a keyframe. */
  render: (value: V, progress: number) => Keyframe;
  /** Real-time sampling interval in ms (default one 60 Hz frame). */
  frameMs?: number;
  /** Stretches the spring's timeline, e.g. `1 / animationSpeed` (default 1). */
  timeScale?: number;
}

export interface SpringAnimation {
  /** Evenly spaced keyframes (explicit offsets); first = from, last = to exactly. */
  keyframes: Keyframe[];
  /** Total duration in ms: the settle time × timeScale. Use `easing: 'linear'`. */
  duration: number;
}

type Values = number | readonly number[];

function mix<V extends Values>(from: V, to: V, t: number): V {
  if (typeof from === 'number') return lerp(from, to as number, t) as V;
  const target = to as readonly number[];
  if (from.length !== target.length) throw new RangeError('from/to length mismatch');
  return from.map((a, i) => lerp(a, target[i]!, t)) as unknown as V;
}

/**
 * Samples a spring from `from` to `to` into WAAPI keyframes. Scalars and
 * vectors (e.g. `[tx, ty, sx, sy]`) are interpolated with the same spring
 * progress, so they stay in step. The last keyframe is exactly `to`.
 *
 * ```ts
 * const { keyframes, duration } = springKeyframes(0, 1, {
 *   ...SPRINGS.snappy,
 *   render: (s) => ({ transform: `scale(${s})` }),
 * });
 * el.animate(keyframes, { duration, easing: 'linear' });
 * ```
 */
export function springKeyframes(
  from: number,
  to: number,
  opts: SpringKeyframeOptions<number>,
): SpringAnimation;
export function springKeyframes(
  from: readonly number[],
  to: readonly number[],
  opts: SpringKeyframeOptions<number[]>,
): SpringAnimation;
export function springKeyframes<V extends Values>(
  from: V,
  to: V,
  opts: SpringKeyframeOptions<V>,
): SpringAnimation {
  const spring = createSpring(opts);
  const timeScale = opts.timeScale ?? 1;
  const frameMs = opts.frameMs ?? 1000 / 60;
  if (!(timeScale > 0) || !(frameMs > 0)) throw new RangeError('timeScale and frameMs must be > 0');

  const settle = spring.settleTime(opts);
  const duration = settle * 1000 * timeScale;
  const count = Math.max(2, Math.ceil(duration / frameMs) + 1);
  const keyframes: Keyframe[] = [];
  for (let i = 0; i < count; i++) {
    const offset = i / (count - 1);
    const progress = i === count - 1 ? 1 : spring.position(offset * settle);
    const value = i === count - 1 ? to : mix(from, to, progress);
    keyframes.push({ ...opts.render(value, progress), offset });
  }
  return { keyframes, duration };
}

/**
 * The spring as a CSS `linear()` easing plus its duration, for CSS
 * transitions/animations: `transition: transform ${duration}ms ${easing}`.
 */
export function springEasing(
  params: Partial<SpringParams> = {},
  opts: SpringRest & { samples?: number; timeScale?: number } = {},
): { easing: string; duration: number } {
  const spring = createSpring(params);
  const settle = spring.settleTime(opts);
  const samples = Math.max(2, opts.samples ?? Math.min(64, Math.ceil(settle * 60) + 1));
  const points: string[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const p = i === samples - 1 ? 1 : spring.position(t * settle);
    points.push(String(Math.round(p * 10000) / 10000));
  }
  return { easing: `linear(${points.join(', ')})`, duration: settle * 1000 * (opts.timeScale ?? 1) };
}
