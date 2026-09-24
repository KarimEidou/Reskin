// Blur / Sharpen brush (one tool, `mode` option). Every dab takes the
// pixels under its footprint plus a 3σ margin, blurs that patch with the
// filters' Gaussian core (premultiplied, edges extend the border pixel like
// the Blur filter) and blends the result back under the footprint:
//
//   blur:    P ← P + (B − P) · c         (premultiplied, like the Blur filter)
//   sharpen: C ← C + (C − B̂) · c,  α kept (like the Sharpen filter)
//
// where P / B are the premultiplied pixel and its blur, C the straight
// colour and B̂ = B.rgb / B.α the alpha-weighted average colour around it,
// so transparent neighbours never count as black: sharpening a shape's
// silhouette does not brighten its edge, and blurring it does not darken
// it. c = dab coverage × selection × strength (× pen pressure). The effect
// is cumulative, like the classic tools: scrubbing over an area keeps
// softening (or crisping) it. Only each dab's padded footprint is read and
// only its footprint is written, whatever the document size.

import type { Dab } from '../input/stroke-sampler';
import type { ToolContext } from './types';
import type { DabShape } from './paint';
import type { DabStroke } from './dab-tool';
import { DabTool, dabFootprint, dabPixelCoverage, optionIn } from './dab-tool';
import { gaussianBlur } from '../filters/blur-core';
import { clipRect, inflateRect } from '../util/rect';

export type BlurSharpenMode = 'blur' | 'sharpen';

export interface BlurSharpenOptions {
  mode: BlurSharpenMode;
  /** Diameter, document px (1..512). */
  size: number;
  /** 0 soft … 1 hard. */
  hardness: number;
  /** Per-dab strength, 0..1. */
  strength: number;
  /** Gaussian σ of the local blur, document px (0.3..16). */
  blurRadius: number;
  /** Distance between dabs as a fraction of the diameter (0.02..1). */
  spacing: number;
  /** Pen pressure scales the strength. */
  pressureStrength: boolean;
}

export function defaultBlurSharpenOptions(): BlurSharpenOptions {
  return {
    mode: 'blur',
    size: 32,
    hardness: 0.5,
    strength: 0.5,
    blurRadius: 1.5,
    spacing: 0.25,
    pressureStrength: true,
  };
}

interface BlurStroke extends DabStroke {
  mode: BlurSharpenMode;
  /** Reusable work buffers (grow as needed). */
  orig: Float32Array;
  blurred: Float32Array;
}

export class BlurSharpenTool extends DabTool<BlurSharpenOptions, BlurStroke> {
  readonly id = 'blurSharpen' as const;
  readonly label = 'Blur / Sharpen';
  readonly shortcut = 'Shift+R';
  readonly icon = 'droplets';
  override readonly group = 'retouch' as const;

  defaultOptions(): BlurSharpenOptions {
    return defaultBlurSharpenOptions();
  }

  protected footprintRadius(o: BlurSharpenOptions): number {
    return optionIn(o.size, 1, 512, 32) / 2;
  }

  protected dabSpacing(o: BlurSharpenOptions): number {
    return Math.max(0.5, optionIn(o.spacing, 0.02, 1, 0.25) * 2 * this.footprintRadius(o));
  }

  protected createStroke(_ctx: ToolContext, base: DabStroke, o: BlurSharpenOptions): BlurStroke {
    return {
      ...base,
      mode: o.mode === 'sharpen' ? 'sharpen' : 'blur',
      orig: new Float32Array(0),
      blurred: new Float32Array(0),
    };
  }

  protected paint(_ctx: ToolContext, s: BlurStroke, dabs: Dab[], o: BlurSharpenOptions): void {
    const shape: DabShape = {
      radius: this.footprintRadius(o),
      hardness: optionIn(o.hardness, 0, 1, 0.5),
      aliased: s.aliased,
    };
    const sigma = optionIn(o.blurRadius, 0.3, 16, 1.5);
    const base = optionIn(o.strength, 0, 1, 0.5);
    for (const d of dabs) {
      const strength = o.pressureStrength ? base * optionIn(d.pressure, 0, 1, 1) : base;
      if (strength <= 0) continue;
      for (const m of s.transforms) {
        this.dab(s, m[0] * d.x + m[2] * d.y + m[4], m[1] * d.x + m[3] * d.y + m[5], shape, sigma, strength);
      }
    }
  }

  protected historyLabel(s: BlurStroke): string {
    return s.mode === 'sharpen' ? 'Sharpen' : 'Blur';
  }

  private dab(s: BlurStroke, x: number, y: number, shape: DabShape, sigma: number, strength: number): void {
    const { tx } = s;
    const w = tx.width;
    const h = tx.height;
    const foot = dabFootprint(x, y, shape.radius, w, h);
    if (!foot) return;
    const region = clipRect(inflateRect(foot, Math.ceil(3 * sigma) + 1), w, h);
    if (!region) return;
    const n = region.w * region.h * 4;
    if (s.orig.length < n) {
      s.orig = new Float32Array(n);
      s.blurred = new Float32Array(n);
    }
    const orig = s.orig;
    const data = tx.surface.data;
    // Premultiplied copy of the padded region (0..255 scale).
    for (let j = 0; j < region.h; j++) {
      let p = ((region.y + j) * w + region.x) * 4;
      let k = j * region.w * 4;
      for (let i = 0; i < region.w; i++, p += 4, k += 4) {
        const a = data[p + 3];
        const m = a / 255;
        orig[k] = data[p] * m;
        orig[k + 1] = data[p + 1] * m;
        orig[k + 2] = data[p + 2] * m;
        orig[k + 3] = a;
      }
    }
    const blurred = s.blurred.subarray(0, n);
    blurred.set(orig.subarray(0, n));
    gaussianBlur(blurred, region.w, region.h, 4, sigma);
    tx.touch(foot);
    const sel = s.selection?.data ?? null;
    const sharpen = s.mode === 'sharpen';
    for (let py = foot.y; py < foot.y + foot.h; py++) {
      for (let px = foot.x; px < foot.x + foot.w; px++) {
        const c = dabPixelCoverage(px, py, x, y, shape, sel, w) * strength;
        if (c <= 0) continue;
        const k = ((py - region.y) * region.w + (px - region.x)) * 4;
        const p = (py * w + px) * 4;
        if (sharpen) {
          // Straight colour against the alpha-weighted blur; alpha kept.
          const a = data[p + 3];
          const ba = blurred[k + 3];
          if (a === 0 || ba <= 1e-3) continue;
          const kb = 255 / ba;
          const r = data[p];
          const g = data[p + 1];
          const b = data[p + 2];
          data[p] = r + (r - blurred[k] * kb) * c;
          data[p + 1] = g + (g - blurred[k + 1] * kb) * c;
          data[p + 2] = b + (b - blurred[k + 2] * kb) * c;
          continue;
        }
        const a = orig[k + 3] + (blurred[k + 3] - orig[k + 3]) * c;
        if (a < 0.5) {
          data[p] = data[p + 1] = data[p + 2] = data[p + 3] = 0;
          continue;
        }
        const inv = 255 / a;
        data[p] = (orig[k] + (blurred[k] - orig[k]) * c) * inv;
        data[p + 1] = (orig[k + 1] + (blurred[k + 1] - orig[k + 1]) * c) * inv;
        data[p + 2] = (orig[k + 2] + (blurred[k + 2] - orig[k + 2]) * c) * inv;
        data[p + 3] = a;
      }
    }
  }
}

export function createBlurSharpenTool(): BlurSharpenTool {
  return new BlurSharpenTool();
}
