// Eyedropper: picks the colour under the pointer from the visible composite
// or the active layer, averaging a 1×1, 3×3 or 5×5 square. Primary colour by
// default; the right button (or Alt) picks the secondary. Fully transparent
// samples are ignored.

import type { CursorHint, Tool, ToolContext } from './types';
import type { PointerInput } from '../input/pointer';
import { averageColor } from '../raster/sample';
import { layerPixels } from '../doc/document';
import type { Rgba } from '../color/color';
import { roundRgba } from '../color/color';

export interface EyedropperOptions {
  sample: 'composite' | 'layer';
  /** Square averaged around the pixel: 1, 3 or 5. */
  size: 1 | 3 | 5;
}

export function defaultEyedropperOptions(): EyedropperOptions {
  return { sample: 'composite', size: 1 };
}

/** The colour the eyedropper would pick at document point (x, y), or null. */
export function sampleAt(ctx: ToolContext, x: number, y: number, o: EyedropperOptions): Rgba | null {
  const px = Math.floor(x);
  const py = Math.floor(y);
  const { width, height } = ctx.doc;
  if (px < 0 || py < 0 || px >= width || py >= height) return null;
  let src;
  if (o.sample === 'layer') {
    const layer = ctx.activeLayer();
    src = layer ? layerPixels(layer) : null;
  } else {
    src = ctx.composite();
  }
  if (!src) return null;
  const c = averageColor(src, px, py, o.size);
  return c.a > 0 ? roundRgba(c) : null;
}

export class EyedropperTool implements Tool<EyedropperOptions> {
  readonly id = 'eyedropper' as const;
  readonly label = 'Eyedropper';
  readonly shortcut = 'I';
  readonly usesSymmetry = false;
  private target: 'primary' | 'secondary' | null = null;

  defaultOptions(): EyedropperOptions {
    return defaultEyedropperOptions();
  }

  cursor(): CursorHint {
    return { css: 'crosshair', radius: 0 };
  }

  pointerDown(ctx: ToolContext, p: PointerInput, o: EyedropperOptions): void {
    this.target = p.button === 2 || p.modifiers.alt ? 'secondary' : 'primary';
    this.pick(ctx, p, o);
  }

  pointerMove(ctx: ToolContext, p: PointerInput, o: EyedropperOptions): void {
    if (this.target) this.pick(ctx, p, o);
  }

  pointerUp(ctx: ToolContext, p: PointerInput, o: EyedropperOptions): void {
    if (this.target) this.pick(ctx, p, o);
    this.target = null;
  }

  cancel(): void {
    this.target = null;
  }

  private pick(ctx: ToolContext, p: PointerInput, o: EyedropperOptions): void {
    const c = sampleAt(ctx, p.x, p.y, o);
    if (c && this.target) ctx.setColor(this.target, c);
  }
}

export function createEyedropperTool(): EyedropperTool {
  return new EyedropperTool();
}
