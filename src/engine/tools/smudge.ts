// Smudge: picks up the colour under the brush and drags it along the
// stroke (classic accumulation, as in GIMP/Photoshop). Every symmetric copy
// carries its own patch of premultiplied colour the size of the footprint,
// aligned to the pixel grid around the dab:
//
//   first dab:   carried ← canvas                (pick up, nothing changes)
//   later dabs:  carried ← s·carried + (1 − s)·canvas
//                canvas  ← canvas + (carried − canvas) · coverage
//
// with s = strength (× pen pressure when `pressureStrength`) and coverage
// = dab shape × selection. Strength 1 drags the first colour forever
// (finger painting); 0 does nothing. All mixing happens in PREMULTIPLIED
// space, so smudging colour into transparency fades its alpha without
// darkening it, and transparent pixels never tint their neighbours. The
// canvas is read and written in place (the effect is cumulative), touching
// only each dab's footprint; the transaction base keeps undo exact.

import type { Dab } from '../input/stroke-sampler';
import type { ToolContext } from './types';
import type { DabShape } from './paint';
import type { DabStroke } from './dab-tool';
import { DabTool, dabPixelCoverage, optionIn } from './dab-tool';
import { clipRect } from '../util/rect';

export interface SmudgeOptions {
  /** Diameter, document px (1..512). */
  size: number;
  /** 0 soft … 1 hard. */
  hardness: number;
  /** How far colour is dragged, 0..1. */
  strength: number;
  /** Distance between dabs as a fraction of the diameter (0.02..1). */
  spacing: number;
  /** Pen pressure scales the strength. */
  pressureStrength: boolean;
}

export function defaultSmudgeOptions(): SmudgeOptions {
  return { size: 24, hardness: 0.5, strength: 0.5, spacing: 0.1, pressureStrength: true };
}

interface SmudgeStroke extends DabStroke {
  /** Patch half-size: the patch is (2·reach + 1)² pixels. */
  reach: number;
  /** Carried premultiplied colour (0..255 scale) per symmetric copy; null until picked up. */
  patches: (Float32Array | null)[];
}

export class SmudgeTool extends DabTool<SmudgeOptions, SmudgeStroke> {
  readonly id = 'smudge' as const;
  readonly label = 'Smudge';
  readonly shortcut = 'R';
  readonly icon = 'pointer';
  override readonly group = 'retouch' as const;

  defaultOptions(): SmudgeOptions {
    return defaultSmudgeOptions();
  }

  protected footprintRadius(o: SmudgeOptions): number {
    return optionIn(o.size, 1, 512, 24) / 2;
  }

  protected dabSpacing(o: SmudgeOptions): number {
    return Math.max(0.5, optionIn(o.spacing, 0.02, 1, 0.1) * 2 * this.footprintRadius(o));
  }

  protected createStroke(_ctx: ToolContext, base: DabStroke, o: SmudgeOptions): SmudgeStroke {
    return {
      ...base,
      reach: Math.ceil(Math.max(this.footprintRadius(o), 0.5)) + 1,
      patches: base.transforms.map(() => null),
    };
  }

  protected paint(_ctx: ToolContext, s: SmudgeStroke, dabs: Dab[], o: SmudgeOptions): void {
    const shape: DabShape = {
      radius: this.footprintRadius(o),
      hardness: optionIn(o.hardness, 0, 1, 0.5),
      aliased: s.aliased,
    };
    const base = optionIn(o.strength, 0, 1, 0.5);
    for (const d of dabs) {
      const strength = o.pressureStrength ? base * optionIn(d.pressure, 0, 1, 1) : base;
      for (let t = 0; t < s.transforms.length; t++) {
        const m = s.transforms[t];
        this.dab(s, t, m[0] * d.x + m[2] * d.y + m[4], m[1] * d.x + m[3] * d.y + m[5], shape, strength);
      }
    }
  }

  protected historyLabel(): string {
    return 'Smudge';
  }

  private dab(s: SmudgeStroke, t: number, x: number, y: number, shape: DabShape, strength: number): void {
    const { tx } = s;
    const w = tx.width;
    const h = tx.height;
    const data = tx.surface.data;
    const reach = s.reach;
    const size = 2 * reach + 1;
    const ox = Math.floor(x) - reach;
    const oy = Math.floor(y) - reach;
    let patch = s.patches[t];
    if (!patch) {
      // Pick up (outside the canvas: the nearest edge pixel).
      patch = new Float32Array(size * size * 4);
      s.patches[t] = patch;
      for (let j = 0; j < size; j++) {
        const py = clampInt(oy + j, h);
        for (let i = 0; i < size; i++) {
          const p = (py * w + clampInt(ox + i, w)) * 4;
          const k = (j * size + i) * 4;
          const a = data[p + 3];
          const m = a / 255;
          patch[k] = data[p] * m;
          patch[k + 1] = data[p + 1] * m;
          patch[k + 2] = data[p + 2] * m;
          patch[k + 3] = a;
        }
      }
      return;
    }
    const area = clipRect({ x: ox, y: oy, w: size, h: size }, w, h);
    if (area) tx.touch(area);
    const sel = s.selection?.data ?? null;
    const keep = strength;
    const take = 1 - strength;
    for (let j = 0; j < size; j++) {
      const py = oy + j;
      const rowIn = py >= 0 && py < h;
      const cy = clampInt(py, h);
      for (let i = 0; i < size; i++) {
        const px = ox + i;
        const p = (cy * w + clampInt(px, w)) * 4;
        const k = (j * size + i) * 4;
        // Canvas (premultiplied, 0..255).
        const a = data[p + 3];
        const m = a / 255;
        const cr = data[p] * m;
        const cg = data[p + 1] * m;
        const cb = data[p + 2] * m;
        // carried ← s·carried + (1 − s)·canvas
        const kr = (patch[k] = patch[k] * keep + cr * take);
        const kg = (patch[k + 1] = patch[k + 1] * keep + cg * take);
        const kb = (patch[k + 2] = patch[k + 2] * keep + cb * take);
        const ka = (patch[k + 3] = patch[k + 3] * keep + a * take);
        if (!rowIn || px < 0 || px >= w) continue;
        const c = dabPixelCoverage(px, py, x, y, shape, sel, w);
        if (c <= 0) continue;
        const na = a + (ka - a) * c;
        if (na < 0.5) {
          data[p] = data[p + 1] = data[p + 2] = data[p + 3] = 0;
          continue;
        }
        const inv = 255 / na;
        data[p] = (cr + (kr - cr) * c) * inv;
        data[p + 1] = (cg + (kg - cg) * c) * inv;
        data[p + 2] = (cb + (kb - cb) * c) * inv;
        data[p + 3] = na;
      }
    }
  }
}

function clampInt(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

export function createSmudgeTool(): SmudgeTool {
  return new SmudgeTool();
}
