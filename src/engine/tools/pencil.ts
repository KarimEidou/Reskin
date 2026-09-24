// Pixel pencil: hard, aliased square nibs on whole pixels (Bresenham between
// samples). At size 1 with `pixelPerfect`, L-shaped corners are removed as
// the stroke is drawn (Aseprite's algorithm): whenever the last three pixels
// a, b, c form an L — b orthogonally adjacent to both, a and c diagonal
// neighbours — b is un-painted and dropped from the path, leaving clean
// one-pixel diagonals.
//
// Every pixel is painted from the transaction base (never accumulated), and
// a per-pixel reference count makes un-painting safe where the stroke or its
// symmetric copies cross themselves.

import type { CursorHint, Tool, ToolContext } from './types';
import type { PointerInput } from '../input/pointer';
import type { PixelTransaction } from '../history/pixel-transaction';
import type { Affine, Point } from '../geometry/affine';
import { apply } from '../geometry/affine';
import { symmetryTransforms } from '../symmetry/symmetry';
import { overPixel } from '../raster/blit';
import type { Rgba } from '../color/color';
import type { SelectionMask } from '../selection/mask';
import type { OverlayPainter } from '../render/overlay';

export interface PencilOptions {
  /** Square nib size in document px (1..64). */
  size: number;
  /** Remove L-corners (size 1 only). */
  pixelPerfect: boolean;
  /** 0..1 */
  opacity: number;
}

export function defaultPencilOptions(): PencilOptions {
  return { size: 1, pixelPerfect: true, opacity: 1 };
}

/** Integer points of the line from (x0, y0) to (x1, y1), both ends included. */
export function bresenham(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** True when b is an L-corner between a and c. */
export function isLCorner(a: readonly number[], b: readonly number[], c: readonly number[]): boolean {
  return (
    (a[0] === b[0] || a[1] === b[1]) &&
    (c[0] === b[0] || c[1] === b[1]) &&
    Math.abs(a[0] - c[0]) === 1 &&
    Math.abs(a[1] - c[1]) === 1
  );
}

interface PencilStroke {
  tx: PixelTransaction;
  counts: Uint16Array;
  color: Rgba;
  selection: SelectionMask | null;
  transforms: Affine[];
  /** Recent path pixels (for L detection). */
  path: [number, number][];
  lastPixel: [number, number];
}

export class PencilTool implements Tool<PencilOptions> {
  readonly id = 'pencil' as const;
  readonly label = 'Pencil';
  readonly shortcut = 'P';
  readonly usesSymmetry = true;
  private stroke: PencilStroke | null = null;

  defaultOptions(): PencilOptions {
    return defaultPencilOptions();
  }

  cursor(o: PencilOptions): CursorHint {
    return { css: 'crosshair', radius: Math.max(1, Math.round(o.size)) / 2 };
  }

  pointerDown(ctx: ToolContext, p: PointerInput, o: PencilOptions): void {
    this.cancel(ctx);
    const layer = ctx.paintableLayer();
    if (!layer) return;
    const { doc } = ctx;
    const px: [number, number] = [Math.floor(p.x), Math.floor(p.y)];
    const s: PencilStroke = {
      tx: ctx.beginPixels(layer),
      counts: ctx.scratch.counters(doc.width * doc.height),
      color: p.button === 2 ? ctx.secondary : ctx.primary,
      selection: doc.selection,
      transforms: symmetryTransforms(ctx.symmetry, doc.width, doc.height),
      path: [px],
      lastPixel: px,
    };
    this.stroke = s;
    this.plot(s, px, o, 1);
    ctx.pixelsChanged(s.tx);
  }

  pointerMove(ctx: ToolContext, p: PointerInput, o: PencilOptions): void {
    const s = this.stroke;
    if (!s) return;
    const to: [number, number] = [Math.floor(p.x), Math.floor(p.y)];
    const [lx, ly] = s.lastPixel;
    if (to[0] === lx && to[1] === ly) return;
    const line = bresenham(lx, ly, to[0], to[1]);
    const perfect = o.pixelPerfect && Math.round(o.size) <= 1;
    for (let i = 1; i < line.length; i++) {
      const pt = line[i];
      s.path.push(pt);
      this.plot(s, pt, o, 1);
      if (perfect && s.path.length >= 3) {
        const n = s.path.length;
        if (isLCorner(s.path[n - 3], s.path[n - 2], s.path[n - 1])) {
          this.plot(s, s.path[n - 2], o, -1);
          s.path.splice(n - 2, 1);
        }
      }
      if (s.path.length > 3) s.path.splice(0, s.path.length - 3);
    }
    s.lastPixel = to;
    ctx.pixelsChanged(s.tx);
  }

  pointerUp(ctx: ToolContext, p: PointerInput, o: PencilOptions): void {
    const s = this.stroke;
    if (!s) return;
    this.pointerMove(ctx, p, o);
    this.stroke = null;
    ctx.commitPixels(s.tx, 'Pencil');
  }

  cancel(ctx: ToolContext): void {
    if (!this.stroke) return;
    ctx.cancelPixels(this.stroke.tx);
    this.stroke = null;
  }

  drawOverlay(painter: OverlayPainter, _ctx: ToolContext, o: PencilOptions, hover: Point | null): void {
    if (!hover) return;
    const n = Math.max(1, Math.round(o.size));
    const x0 = Math.floor(hover.x) - Math.floor((n - 1) / 2);
    const y0 = Math.floor(hover.y) - Math.floor((n - 1) / 2);
    if (n * painter.scale >= 4) painter.rect(x0, y0, n, n);
  }

  /** Paints (delta = 1) or un-paints (delta = −1) the nib at `pt` and its symmetric copies. */
  private plot(s: PencilStroke, pt: readonly [number, number], o: PencilOptions, delta: 1 | -1): void {
    const { tx, counts } = s;
    const w = tx.width;
    const h = tx.height;
    const n = Math.max(1, Math.round(o.size));
    const base = tx.base;
    const out = tx.surface.data;
    const k = Math.min(1, Math.max(0, o.opacity)) * s.color.a;
    const sel = s.selection?.data ?? null;
    for (const [ox, oy] of nibOrigins(s.transforms, pt[0], pt[1], n)) {
      tx.touch({ x: ox, y: oy, w: n, h: n });
      for (let y = oy; y < oy + n; y++) {
        if (y < 0 || y >= h) continue;
        for (let x = ox; x < ox + n; x++) {
          if (x < 0 || x >= w) continue;
          const i = y * w + x;
          const p = i * 4;
          if (delta > 0) {
            if (counts[i]++ > 0) continue;
            const cov = sel ? (k * sel[i]) / 255 : k;
            overPixel(base, out, p, s.color.r, s.color.g, s.color.b, cov);
          } else {
            if (counts[i] === 0 || --counts[i] > 0) continue;
            out[p] = base[p];
            out[p + 1] = base[p + 1];
            out[p + 2] = base[p + 2];
            out[p + 3] = base[p + 3];
          }
        }
      }
    }
  }
}

/**
 * Top-left corners of an n×n nib at pixel `(px, py)` and its symmetric
 * copies (the nib's centre is transformed, so even-sized nibs mirror
 * exactly). Duplicates are removed.
 */
export function nibOrigins(transforms: readonly Affine[], px: number, py: number, n: number): [number, number][] {
  const x0 = px - Math.floor((n - 1) / 2);
  const y0 = py - Math.floor((n - 1) / 2);
  const cx = x0 + n / 2;
  const cy = y0 + n / 2;
  const out: [number, number][] = [];
  const seen = new Set<string>();
  for (const m of transforms) {
    const c = apply(m, cx, cy);
    const ox = Math.round(c.x - n / 2 + 1e-9);
    const oy = Math.round(c.y - n / 2 + 1e-9);
    const key = `${ox},${oy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([ox, oy]);
  }
  return out;
}

export function createPencilTool(): PencilTool {
  return new PencilTool();
}
