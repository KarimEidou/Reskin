// Magic wand: selects the region of similar colour around the clicked pixel
// (contiguous scanline flood) or every similar pixel of the image (global),
// sampling the active layer or the visible composite. Tolerance uses the
// paint bucket's metric (max premultiplied channel difference to the
// clicked pixel, 0..255). The region edge can be anti-aliased (never in
// pixel-art documents) and feathered. Modifiers at the press pick the
// operation like the marquees (Shift add, Alt subtract, Shift+Alt
// intersect; otherwise the `mode` option). One history entry per click.

import type { CursorHint, Tool, ToolContext } from './types';
import type { PointerInput } from '../input/pointer';
import type { SelectionOp } from '../selection/mask';
import { combineMasks, featherMask } from '../selection/mask';
import { wandMask } from '../selection/refine';
import { layerPixels } from '../doc/document';
import { Surface } from '../raster/surface';
import { selectionOpFor } from './select';
import { optionIn } from './dab-tool';

export interface MagicWandOptions {
  mode: SelectionOp;
  /** 0..255 (see raster/flood.ts for the distance metric). */
  tolerance: number;
  contiguous: boolean;
  /** Sample the visible composite instead of the active layer. */
  sampleMerged: boolean;
  /** Soft (anti-aliased) region edge. */
  antialias: boolean;
  /** Feather radius, document px. */
  feather: number;
}

export function defaultMagicWandOptions(): MagicWandOptions {
  return { mode: 'replace', tolerance: 32, contiguous: true, sampleMerged: false, antialias: true, feather: 0 };
}

export class MagicWandTool implements Tool<MagicWandOptions> {
  readonly id = 'magicWand' as const;
  readonly label = 'Magic wand';
  readonly shortcut = 'W';
  readonly icon = 'wand-sparkles';
  readonly usesSymmetry = false;

  defaultOptions(): MagicWandOptions {
    return defaultMagicWandOptions();
  }

  cursor(): CursorHint {
    return { css: 'crosshair', radius: 0 };
  }

  pointerDown(ctx: ToolContext, p: PointerInput, o: MagicWandOptions): void {
    const { doc } = ctx;
    const { width: w, height: h } = doc;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    let src: Surface | null;
    if (o.sampleMerged) {
      src = ctx.composite();
    } else {
      const layer = ctx.activeLayer();
      if (!layer) {
        ctx.message('Select a layer first', 'warning');
        return;
      }
      // A text layer that has not been rendered yet shows nothing.
      src = layerPixels(layer) ?? new Surface(w, h);
    }
    let shape = wandMask(src.data, w, h, x, y, {
      tolerance: optionIn(o.tolerance, 0, 255, 32),
      contiguous: o.contiguous,
      antialias: o.antialias && doc.pixelArt === null,
    });
    if (!shape) return;
    const feather = optionIn(o.feather, 0, 1024, 0);
    if (feather > 0) shape = featherMask(shape, feather) ?? shape;
    ctx.setSelection(combineMasks(doc.selection, shape, selectionOpFor(p, o.mode)), this.label);
  }

  pointerMove(): void {}

  pointerUp(): void {}

  cancel(): void {}
}

export function createMagicWandTool(): MagicWandTool {
  return new MagicWandTool();
}
