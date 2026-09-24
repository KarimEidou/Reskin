// Dodge / Burn (one tool, `mode` option): lightens or darkens the
// luminance of the pixels under the brush and leaves hue and alpha alone.
//
// Dabs accumulate into a stroke alpha plane (like the brush, capped by pen
// pressure when `pressureExposure`), and the touched area is recomputed
// FROM THE TRANSACTION BASE on every move:
//
//   L = luma of the base colour (0..1), a = stroke alpha × selection
//   e = exposure · a · weight(range, L)
//   dodge: L' = L + e·(1 − L)        burn: L' = L − e·L
//
// `weight` is (1 − L)² for shadows, 4L(1 − L) for midtones and L² for
// highlights (raster/tone.ts), and the new luminance is applied with the
// W3C SetLum/ClipColor rule. One stroke therefore changes a pixel by at
// most `exposure`, however often it passes over it (a new stroke builds on
// the result), and the output is independent of dab spacing.

import type { Dab } from '../input/stroke-sampler';
import type { ToolContext } from './types';
import type { DabShape } from './paint';
import { stampDab } from './paint';
import type { DabStroke } from './dab-tool';
import { DabTool, optionIn } from './dab-tool';
import type { ToneRange } from '../raster/tone';
import { luminance01, setLuminance, toneRangeWeight } from '../raster/tone';
import type { Rect } from '../util/rect';
import { unionRect } from '../util/rect';

export type DodgeBurnMode = 'dodge' | 'burn';

export interface DodgeBurnOptions {
  mode: DodgeBurnMode;
  /** Tones affected most. */
  range: ToneRange;
  /** Strength of one stroke, 0..1. */
  exposure: number;
  /** Diameter, document px (1..512). */
  size: number;
  /** 0 soft … 1 hard. */
  hardness: number;
  /** Distance between dabs as a fraction of the diameter (0.02..1). */
  spacing: number;
  /** Pen pressure caps the exposure each dab can build up to. */
  pressureExposure: boolean;
}

export function defaultDodgeBurnOptions(): DodgeBurnOptions {
  return {
    mode: 'dodge',
    range: 'midtones',
    exposure: 0.5,
    size: 32,
    hardness: 0.5,
    spacing: 0.15,
    pressureExposure: true,
  };
}

interface ToneStroke extends DabStroke {
  alpha: Float32Array;
  mode: DodgeBurnMode;
  range: ToneRange;
  exposure: number;
}

/** Work buffer of `recompute` (one colour). */
const RGB = new Float64Array(3);

export class DodgeBurnTool extends DabTool<DodgeBurnOptions, ToneStroke> {
  readonly id = 'dodgeBurn' as const;
  readonly label = 'Dodge / Burn';
  readonly shortcut = 'O';
  readonly icon = 'sun';
  override readonly group = 'retouch' as const;

  defaultOptions(): DodgeBurnOptions {
    return defaultDodgeBurnOptions();
  }

  protected footprintRadius(o: DodgeBurnOptions): number {
    return optionIn(o.size, 1, 512, 32) / 2;
  }

  protected dabSpacing(o: DodgeBurnOptions): number {
    return Math.max(0.5, optionIn(o.spacing, 0.02, 1, 0.15) * 2 * this.footprintRadius(o));
  }

  protected createStroke(ctx: ToolContext, base: DabStroke, o: DodgeBurnOptions): ToneStroke {
    const { width: w, height: h } = ctx.doc;
    return {
      ...base,
      alpha: ctx.scratch.floatPlane(w * h),
      mode: o.mode === 'burn' ? 'burn' : 'dodge',
      range: o.range === 'shadows' || o.range === 'highlights' ? o.range : 'midtones',
      exposure: optionIn(o.exposure, 0, 1, 0.5),
    };
  }

  protected paint(ctx: ToolContext, s: ToneStroke, dabs: Dab[], o: DodgeBurnOptions): void {
    const { width: w, height: h } = ctx.doc;
    const rects: (Rect | null)[] = s.transforms.map(() => null);
    const shape: DabShape = {
      radius: this.footprintRadius(o),
      hardness: optionIn(o.hardness, 0, 1, 0.5),
      aliased: s.aliased,
    };
    for (const d of dabs) {
      const ceiling = o.pressureExposure ? optionIn(d.pressure, 0, 1, 1) : 1;
      for (let t = 0; t < s.transforms.length; t++) {
        const m = s.transforms[t];
        const x = m[0] * d.x + m[2] * d.y + m[4];
        const y = m[1] * d.x + m[3] * d.y + m[5];
        rects[t] = unionRect(rects[t], stampDab(s.alpha, w, h, x, y, shape, 1, ceiling));
      }
    }
    for (const r of rects) if (r) this.recompute(s, r);
  }

  protected historyLabel(s: ToneStroke): string {
    return s.mode === 'burn' ? 'Burn' : 'Dodge';
  }

  /** Recomputes `rect` from the base and the stroke alpha. */
  private recompute(s: ToneStroke, rect: Rect): void {
    const c = s.tx.touch(rect);
    if (!c) return;
    const { tx, alpha } = s;
    const w = tx.width;
    const base = tx.base;
    const out = tx.surface.data;
    const sel = s.selection?.data ?? null;
    const dodge = s.mode === 'dodge';
    const rgb = RGB;
    for (let y = c.y; y < c.y + c.h; y++) {
      for (let x = c.x; x < c.x + c.w; x++) {
        const i = y * w + x;
        const p = i * 4;
        let a = alpha[i] * s.exposure;
        if (sel) a *= sel[i] / 255;
        const ba = base[p + 3];
        if (a <= 0 || ba === 0) {
          out[p] = base[p];
          out[p + 1] = base[p + 1];
          out[p + 2] = base[p + 2];
          out[p + 3] = ba;
          continue;
        }
        rgb[0] = base[p] / 255;
        rgb[1] = base[p + 1] / 255;
        rgb[2] = base[p + 2] / 255;
        const l = luminance01(rgb[0], rgb[1], rgb[2]);
        const e = a * toneRangeWeight(s.range, l);
        setLuminance(rgb, dodge ? l + e * (1 - l) : l - e * l);
        out[p] = rgb[0] * 255;
        out[p + 1] = rgb[1] * 255;
        out[p + 2] = rgb[2] * 255;
        out[p + 3] = ba;
      }
    }
  }
}

export function createDodgeBurnTool(): DodgeBurnTool {
  return new DodgeBurnTool();
}
