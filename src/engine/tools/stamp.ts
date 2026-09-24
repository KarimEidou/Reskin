// Sticker stamp: places the `stamp` image (a sticker, emoji or any Surface)
// centred on the pointer, scaled, rotated and faded by the options. A click
// stamps once; a drag previews the stamp live under the pointer (rendered
// into the layer from the transaction base, so the preview is exactly the
// result, selection clipping included) and stamps once where it is
// released. Symmetry stamps every mirrored/rotated copy (mirror copies are
// mirror images). One history entry per stamp.
//
// Sampling is bilinear on premultiplied colour (nearest in pixel-art
// documents). When the rotation is a multiple of 90° the stamp's box is
// snapped to whole pixels, so an unscaled stamp lands pixel-exact.

import type { CursorHint, Tool, ToolContext } from './types';
import type { PointerInput } from '../input/pointer';
import type { Affine, Point } from '../geometry/affine';
import { apply, compose, invert, multiply, rotation, scaling, translation } from '../geometry/affine';
import type { PixelTransaction } from '../history/pixel-transaction';
import type { FloatImage } from '../raster/float-image';
import { surfaceToFloat } from '../raster/float-image';
import type { Surface } from '../raster/surface';
import { sampleBilinear, sampleNearest } from '../raster/sample';
import { symmetryTransforms } from '../symmetry/symmetry';
import type { SelectionMask } from '../selection/mask';
import type { OverlayPainter } from '../render/overlay';
import type { Rect } from '../util/rect';
import { clipRect, coverRect, unionRect } from '../util/rect';
import { optionIn } from './dab-tool';

export interface StampOptions {
  /** The image to stamp (straight RGBA, any size), or null (nothing chosen yet). */
  stamp: Surface | null;
  /** Scale factor (0.01..16). */
  scale: number;
  /** Clockwise rotation, degrees. */
  rotation: number;
  /** 0..1 */
  opacity: number;
}

export function defaultStampOptions(): StampOptions {
  return { stamp: null, scale: 1, rotation: 0, opacity: 1 };
}

/**
 * Maps stamp pixels to document px for a stamp centred at (x, y): scale,
 * rotate about the stamp's centre, then translate (snapped to whole pixels
 * when the rotation is a multiple of 90°).
 */
export function stampMatrix(stamp: { width: number; height: number }, o: StampOptions, x: number, y: number): Affine {
  const s = optionIn(o.scale, 0.01, 16, 1);
  const deg = optionIn(o.rotation, -1e6, 1e6, 0);
  const quarter = Math.abs(deg / 90 - Math.round(deg / 90)) < 1e-9;
  const rad = quarter ? (Math.round(deg / 90) * Math.PI) / 2 : (deg * Math.PI) / 180;
  const local = compose(translation(-stamp.width / 2, -stamp.height / 2), scaling(s), snapRotation(rad, quarter));
  let tx = x;
  let ty = y;
  if (quarter) {
    // Snap the transformed box's top-left corner to the pixel grid.
    const corners = [apply(local, 0, 0), apply(local, stamp.width, 0), apply(local, 0, stamp.height), apply(local, stamp.width, stamp.height)];
    const minX = Math.min(...corners.map((c) => c.x)) + x;
    const minY = Math.min(...corners.map((c) => c.y)) + y;
    tx += Math.round(minX) - minX;
    ty += Math.round(minY) - minY;
  }
  return compose(local, translation(tx, ty));
}

/** Exact quarter turns (no 1e-17 residue from cos/sin). */
function snapRotation(rad: number, quarter: boolean): Affine {
  if (!quarter) return rotation(rad);
  const q = ((Math.round(rad / (Math.PI / 2)) % 4) + 4) % 4;
  const c = [1, 0, -1, 0][q];
  const s = [0, 1, 0, -1][q];
  return [c, s, -s, c, 0, 0];
}

/** Document-space corners (TL, TR, BR, BL) of a stamp placed with `m`. */
export function stampCorners(stamp: { width: number; height: number }, m: Affine): Point[] {
  return [apply(m, 0, 0), apply(m, stamp.width, 0), apply(m, stamp.width, stamp.height), apply(m, 0, stamp.height)];
}

interface StampDrag {
  tx: PixelTransaction;
  src: FloatImage;
  stamp: Surface;
  transforms: Affine[];
  selection: SelectionMask | null;
  nearest: boolean;
  /** Area the last preview wrote (restored before the next one). */
  area: Rect | null;
  at: Point;
}

export class StampTool implements Tool<StampOptions> {
  readonly id = 'stamp' as const;
  readonly label = 'Sticker stamp';
  readonly shortcut = 'S';
  readonly icon = 'stamp';
  readonly usesSymmetry = true;
  private drag: StampDrag | null = null;

  defaultOptions(): StampOptions {
    return defaultStampOptions();
  }

  cursor(o: StampOptions): CursorHint {
    return { css: o.stamp ? 'copy' : 'not-allowed', radius: 0 };
  }

  pointerDown(ctx: ToolContext, p: PointerInput, o: StampOptions): void {
    this.cancel(ctx);
    const stamp = o.stamp;
    if (!stamp) {
      ctx.message('Choose a sticker to stamp first');
      return;
    }
    const layer = ctx.paintableLayer();
    if (!layer) return;
    const { doc } = ctx;
    this.drag = {
      tx: ctx.beginPixels(layer),
      src: surfaceToFloat(stamp),
      stamp,
      transforms: symmetryTransforms(ctx.symmetry, doc.width, doc.height),
      selection: doc.selection,
      nearest: doc.pixelArt !== null,
      area: null,
      at: { x: p.x, y: p.y },
    };
    this.render(ctx, this.drag, o);
  }

  pointerMove(ctx: ToolContext, p: PointerInput, o: StampOptions): void {
    const d = this.drag;
    if (!d) return;
    if (d.at.x === p.x && d.at.y === p.y) return;
    d.at = { x: p.x, y: p.y };
    this.render(ctx, d, o);
  }

  pointerUp(ctx: ToolContext, p: PointerInput, o: StampOptions): void {
    const d = this.drag;
    if (!d) return;
    this.pointerMove(ctx, p, o);
    this.drag = null;
    ctx.commitPixels(d.tx, 'Stamp');
    ctx.overlayChanged();
  }

  cancel(ctx: ToolContext): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    ctx.cancelPixels(d.tx);
    ctx.overlayChanged();
  }

  drawOverlay(painter: OverlayPainter, ctx: ToolContext, o: StampOptions, hover: Point | null): void {
    const stamp = this.drag?.stamp ?? o.stamp;
    const at = this.drag?.at ?? hover;
    if (!stamp || !at) return;
    const { doc } = ctx;
    const transforms = this.drag?.transforms ?? symmetryTransforms(ctx.symmetry, doc.width, doc.height);
    const m = stampMatrix(stamp, o, at.x, at.y);
    for (const t of transforms) {
      const q = stampCorners(stamp, multiply(t, m));
      painter.polyline(q.flatMap((pt) => [pt.x, pt.y]), true, { dash: [4, 4] });
    }
  }

  /** Restores the previous preview and stamps every symmetric copy at `d.at`. */
  private render(ctx: ToolContext, d: StampDrag, o: StampOptions): void {
    const { tx } = d;
    if (d.area) tx.restore(d.area);
    const w = tx.width;
    const h = tx.height;
    const m = stampMatrix(d.stamp, o, d.at.x, d.at.y);
    const opacity = optionIn(o.opacity, 0, 1, 1);
    let area: Rect | null = null;
    if (opacity > 0) {
      for (const t of d.transforms) {
        const r = this.composite(d, multiply(t, m), opacity, w, h);
        area = unionRect(area, r);
      }
    }
    d.area = area;
    ctx.pixelsChanged(tx);
    ctx.overlayChanged();
  }

  /** Composites one placed copy over the current pixels. Returns the touched rect. */
  private composite(d: StampDrag, m: Affine, opacity: number, w: number, h: number): Rect | null {
    const inv = invert(m);
    if (!inv) return null;
    const q = stampCorners(d.stamp, m);
    const box = coverRect(
      Math.min(...q.map((p) => p.x)),
      Math.min(...q.map((p) => p.y)),
      Math.max(...q.map((p) => p.x)),
      Math.max(...q.map((p) => p.y)),
    );
    const area = box ? clipRect(box, w, h) : null;
    if (!area) return null;
    d.tx.touch(area);
    const out = d.tx.surface.data;
    const sel = d.selection?.data ?? null;
    const sample = d.nearest ? sampleNearest : sampleBilinear;
    const px = new Float32Array(4);
    for (let y = area.y; y < area.y + area.h; y++) {
      // Walk the row incrementally in stamp space.
      const start = apply(inv, area.x + 0.5, y + 0.5);
      for (let x = area.x; x < area.x + area.w; x++) {
        const i = y * w + x;
        let k = opacity;
        if (sel) {
          k *= sel[i] / 255;
          if (k <= 0) continue;
        }
        const dx = x - area.x;
        sample(d.src, start.x + inv[0] * dx, start.y + inv[1] * dx, px, 0, 'transparent');
        const sa = px[3] * k;
        if (sa <= 0) continue;
        const p = i * 4;
        const ba = out[p + 3] / 255;
        const oa = sa + ba * (1 - sa);
        const kb = (ba * (1 - sa)) / oa;
        out[p] = (px[0] * k * 255) / oa + out[p] * kb;
        out[p + 1] = (px[1] * k * 255) / oa + out[p + 1] * kb;
        out[p + 2] = (px[2] * k * 255) / oa + out[p + 2] * kb;
        out[p + 3] = oa * 255;
      }
    }
    return area;
  }
}

export function createStampTool(): StampTool {
  return new StampTool();
}
