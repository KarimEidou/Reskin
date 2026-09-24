// The 1€ filter (Casiez, Roussel & Vogel, CHI 2012): a low-pass filter whose
// cutoff rises with speed — heavy smoothing when the pen moves slowly (kills
// jitter), little lag when it moves fast.

export interface OneEuroOptions {
  /** Cutoff at zero speed, Hz. Lower = smoother. */
  minCutoff: number;
  /** Speed coefficient. Higher = less lag on fast moves. */
  beta: number;
  /** Cutoff for the derivative, Hz. */
  dCutoff: number;
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** Assumed interval when timestamps repeat or go backwards. */
const FALLBACK_DT = 1 / 120;

export class OneEuroFilter {
  private x = 0;
  private dx = 0;
  private t = 0;
  private started = false;

  constructor(public options: OneEuroOptions) {}

  reset(): void {
    this.started = false;
    this.dx = 0;
  }

  /** Filters `value` sampled at `timeMs`. */
  filter(value: number, timeMs: number): number {
    if (!this.started) {
      this.started = true;
      this.x = value;
      this.dx = 0;
      this.t = timeMs;
      return value;
    }
    let dt = (timeMs - this.t) / 1000;
    if (!(dt > 0)) dt = FALLBACK_DT;
    this.t = timeMs;
    const { minCutoff, beta, dCutoff } = this.options;
    const rawDx = (value - this.x) / dt;
    this.dx += (rawDx - this.dx) * alpha(dCutoff, dt);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += (value - this.x) * alpha(cutoff, dt);
    return this.x;
  }
}

/** Filters 2D positions (speed is taken per axis, like the reference). */
export class OneEuroFilter2D {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(options: OneEuroOptions) {
    this.fx = new OneEuroFilter(options);
    this.fy = new OneEuroFilter(options);
  }

  set options(o: OneEuroOptions) {
    this.fx.options = o;
    this.fy.options = o;
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  filter(x: number, y: number, timeMs: number): { x: number; y: number } {
    return { x: this.fx.filter(x, timeMs), y: this.fy.filter(y, timeMs) };
  }
}

/**
 * Maps a UI "smoothing" amount (0 = off … 1 = maximum) to filter
 * parameters tuned for document-pixel coordinates. Returns null for 0.
 */
export function smoothingToOneEuro(smoothing: number): OneEuroOptions | null {
  const s = Math.min(1, Math.max(0, smoothing));
  if (s === 0) return null;
  return {
    minCutoff: 20 * Math.pow(0.5 / 20, s), // 20 Hz → 0.5 Hz
    beta: 0.02 * (1 - s) + 0.002,
    dCutoff: 1,
  };
}
