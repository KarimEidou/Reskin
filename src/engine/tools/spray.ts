// Spray (airbrush): every dab scatters round dots uniformly over a disc
// around the pointer. Dots accumulate into the stroke alpha plane with
// `flow` and the layer is recomposited from the transaction base, capped at
// the stroke `opacity` (the brush model, see ./paint.ts), so overlapping
// dots build up smoothly but never exceed the opacity.
//
// The dot pattern comes from a seeded PRNG (mulberry32) per stroke: its
// seed mixes the `seed` option, a per-tool stroke counter and the start
// point, so strokes differ from each other while identical input on a fresh
// engine always paints identical pixels. Dabs are spaced along the path
// (half the spray radius apart); holding the pointer still does not keep
// spraying. Pen pressure scales the number of dots (`pressureDensity`).

import type { Rgba } from '../color/color';
import type { Dab } from '../input/stroke-sampler';
import type { ToolContext } from './types';
import { compositeStroke, stampDab } from './paint';
import type { DabStroke } from './dab-tool';
import { DabTool, optionIn } from './dab-tool';
import { apply } from '../geometry/affine';
import { mulberry32 } from '../filters/prng';
import type { Rect } from '../util/rect';
import { unionRect } from '../util/rect';

export interface SprayOptions {
  /** Spray disc radius, document px (1..256). */
  radius: number;
  /**
   * 0..1: dots per dab. At 1 a dab scatters as many dots as would cover
   * 10 % of the disc (before overlaps).
   */
  density: number;
  /** Dot diameter, document px (0.5..32). */
  dotSize: number;
  /** Strength of each dot, 0..1 (builds up within a stroke). */
  flow: number;
  /** Maximum stroke opacity, 0..1. */
  opacity: number;
  /** Pen pressure scales the number of dots. */
  pressureDensity: boolean;
  /** Pattern seed (change it to reshuffle the dots). */
  seed: number;
}

export function defaultSprayOptions(): SprayOptions {
  return { radius: 24, density: 0.5, dotSize: 1.5, flow: 0.8, opacity: 1, pressureDensity: true, seed: 1 };
}

/** Hard cap on dots per dab (a 256 px spray of 0.5 px dots at density 1). */
export const MAX_SPRAY_DOTS = 8192;

/** Expected number of dots one dab scatters at `pressure` (0..1). */
export function sprayDotCount(o: SprayOptions, pressure: number): number {
  const radius = optionIn(o.radius, 1, 256, 24);
  const dot = optionIn(o.dotSize, 0.5, 32, 1.5);
  const density = optionIn(o.density, 0, 1, 0.5);
  const p = o.pressureDensity ? optionIn(pressure, 0, 1, 1) : 1;
  const ratio = ((2 * radius) / dot) ** 2; // disc area / dot area
  return Math.min(MAX_SPRAY_DOTS, density * 0.1 * ratio * p);
}

/** Integer seed of one stroke (see the file comment). */
export function spraySeed(seed: number, serial: number, x: number, y: number): number {
  let h = Math.imul((Number.isFinite(seed) ? Math.trunc(seed) : 0) | 0, 0x9e3779b1);
  h ^= Math.imul(serial | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h ^= Math.imul(Math.round(x * 256) | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= Math.imul(Math.round(y * 256) | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 16), 0x2c1b3c6d);
  return (h ^ (h >>> 15)) >>> 0;
}

interface SprayStroke extends DabStroke {
  alpha: Float32Array;
  color: Rgba;
  random: () => number;
}

export class SprayTool extends DabTool<SprayOptions, SprayStroke> {
  readonly id = 'spray' as const;
  readonly label = 'Spray';
  readonly shortcut = 'A';
  readonly icon = 'spray-can';
  override readonly group = 'brush' as const;
  private serial = 0;

  defaultOptions(): SprayOptions {
    return defaultSprayOptions();
  }

  protected footprintRadius(o: SprayOptions): number {
    return optionIn(o.radius, 1, 256, 24);
  }

  protected dabSpacing(o: SprayOptions): number {
    return Math.max(1, this.footprintRadius(o) / 2);
  }

  protected createStroke(ctx: ToolContext, base: DabStroke, o: SprayOptions): SprayStroke {
    const { width: w, height: h } = ctx.doc;
    return {
      ...base,
      alpha: ctx.scratch.floatPlane(w * h),
      color: base.button === 2 ? ctx.secondary : ctx.primary,
      random: mulberry32(spraySeed(o.seed, ++this.serial, base.last.x, base.last.y)),
    };
  }

  protected paint(ctx: ToolContext, s: SprayStroke, dabs: Dab[], o: SprayOptions): void {
    const { width: w, height: h } = ctx.doc;
    const radius = this.footprintRadius(o);
    const shape = { radius: optionIn(o.dotSize, 0.5, 32, 1.5) / 2, hardness: 1, aliased: s.aliased };
    const flow = optionIn(o.flow, 0, 1, 0.8);
    const rects: (Rect | null)[] = s.transforms.map(() => null);
    const rnd = s.random;
    for (const d of dabs) {
      const expected = sprayDotCount(o, d.pressure);
      let n = Math.floor(expected);
      if (rnd() < expected - n) n++;
      for (let k = 0; k < n; k++) {
        // Uniform over the disc.
        const rho = radius * Math.sqrt(rnd());
        const theta = 2 * Math.PI * rnd();
        const x = d.x + rho * Math.cos(theta);
        const y = d.y + rho * Math.sin(theta);
        for (let t = 0; t < s.transforms.length; t++) {
          const q = apply(s.transforms[t], x, y);
          rects[t] = unionRect(rects[t], stampDab(s.alpha, w, h, q.x, q.y, shape, flow));
        }
      }
    }
    const opacity = optionIn(o.opacity, 0, 1, 1);
    for (const r of rects) if (r) compositeStroke(s.tx, s.alpha, r, s.color, opacity, 'paint', s.selection);
  }

  protected historyLabel(): string {
    return 'Spray';
  }
}

export function createSprayTool(): SprayTool {
  return new SprayTool();
}
