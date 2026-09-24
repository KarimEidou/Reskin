// Paint bucket: flood-fills the clicked region (contiguous or global,
// sampling the active layer or the visible composite) with the primary
// colour (secondary with the right button), clipped to the selection.

import type { CursorHint, Tool, ToolContext } from './types';
import type { PointerInput } from '../input/pointer';
import { floodFill } from '../raster/flood';
import { overPixel } from '../raster/blit';

export interface FillOptions {
  /** 0..255 (see raster/flood.ts for the distance metric). */
  tolerance: number;
  contiguous: boolean;
  /** Sample the visible composite instead of the active layer. */
  sampleMerged: boolean;
  /** 0..1 */
  opacity: number;
}

export function defaultFillOptions(): FillOptions {
  return { tolerance: 32, contiguous: true, sampleMerged: false, opacity: 1 };
}

export class FillTool implements Tool<FillOptions> {
  readonly id = 'fill' as const;
  readonly label = 'Fill';
  readonly shortcut = 'G';
  readonly icon = 'paint-bucket';
  readonly usesSymmetry = false;

  defaultOptions(): FillOptions {
    return defaultFillOptions();
  }

  cursor(): CursorHint {
    return { css: 'crosshair', radius: 0 };
  }

  pointerDown(ctx: ToolContext, p: PointerInput, o: FillOptions): void {
    const layer = ctx.paintableLayer();
    if (!layer) return;
    const { doc } = ctx;
    const { width: w, height: h } = doc;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const source = o.sampleMerged ? ctx.composite().data : layer.surface.data;
    const region = floodFill(source, w, h, x, y, { tolerance: o.tolerance, contiguous: o.contiguous });
    if (!region.bounds) return;
    const color = p.button === 2 ? ctx.secondary : ctx.primary;
    const k = Math.min(1, Math.max(0, o.opacity)) * color.a;
    const sel = doc.selection?.data ?? null;
    const tx = ctx.beginPixels(layer);
    const b = region.bounds;
    tx.touch(b);
    const out = tx.surface.data;
    for (let py = b.y; py < b.y + b.h; py++) {
      for (let px = b.x; px < b.x + b.w; px++) {
        const i = py * w + px;
        if (!region.mask[i]) continue;
        const s = sel ? (k * sel[i]) / 255 : k;
        if (s > 0) overPixel(out, out, i * 4, color.r, color.g, color.b, s);
      }
    }
    ctx.commitPixels(tx, 'Fill');
  }

  pointerMove(): void {}

  pointerUp(): void {}

  cancel(): void {}
}

export function createFillTool(): FillTool {
  return new FillTool();
}
