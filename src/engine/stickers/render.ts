/**
 * Sticker rasterization: every colour layer is the union of its parts
 * (filled paths through the engine's anti-aliased scanline rasterizer,
 * polylines through its stroker), composited in premultiplied float, with
 * an optional outline (a distance-field dilation of the whole sticker)
 * underneath. Pure and deterministic; works in node and workers.
 */
import { fromPremultiplied } from '../filters/blur-core';
import { colorOr, hslToRgb, rgbToHsl, type Rgba as Rgba8 } from '../filters/colormath';
import { createPixels, type Pixels } from '../filters/types';
import { rasterizePolygons } from '../geometry/rasterize';
import { strokePolygons } from '../geometry/shapes';
import { autoTrim } from '../helpers/trim';
import { dilate } from '../raster/distance';
import type { StickerColorRef, StickerDef, StickerPart } from './library';
import { flattenPath } from './path';

/** The sticker art box (path units). */
export const STICKER_BOX = 100;

export interface StickerOutline {
  color: string;
  /** Outline width in output px. */
  width: number;
}

export interface StickerRenderOptions {
  /** Output canvas size (square), px. */
  size: number;
  /** Main colour (default: the sticker's own). */
  color?: string;
  /** Size of the sticker's 100-unit box in px (default 80 % of `size`). */
  box?: number;
  /** Centre of the box (default: the canvas centre). */
  cx?: number;
  cy?: number;
  outline?: StickerOutline | null;
}

/** A darker (`shade`) and lighter (`tint`) variant of a colour, for sticker depth. */
export function stickerVariants(color: string): { main: string; shade: string; tint: string } {
  const [r, g, b, a] = colorOr(color, '#000000');
  const hsl = [0, 0, 0];
  rgbToHsl(r / 255, g / 255, b / 255, hsl);
  const [h, s, l] = hsl as [number, number, number];
  const out = [0, 0, 0];
  const hex = (hh: number, ss: number, ll: number) => {
    hslToRgb(hh, Math.min(1, Math.max(0, ss)), Math.min(1, Math.max(0, ll)), out);
    const c = (v: number) => Math.round(Math.min(255, Math.max(0, v * 255))).toString(16).padStart(2, '0');
    return `#${c(out[0]!)}${c(out[1]!)}${c(out[2]!)}${a < 255 ? c(a / 255) : ''}`;
  };
  return {
    main: hex(h, s, l),
    shade: hex(h, s * 1.05 + 0.02, l * 0.72),
    tint: hex(h, s * 0.95, l + (1 - l) * 0.45),
  };
}

function resolveColor(ref: StickerColorRef, variants: ReturnType<typeof stickerVariants>): string {
  return ref === 'main' || ref === 'shade' || ref === 'tint' ? variants[ref as 'main' | 'shade' | 'tint'] : ref;
}

function isStroke(p: StickerPart): p is Extract<StickerPart, { line: readonly number[] }> {
  return 'line' in p;
}

/** Coverage (0..1) of the union of `parts`, drawn with `scale`/offset into size × size. */
function partsCoverage(parts: readonly StickerPart[], size: number, scale: number, ox: number, oy: number): Float32Array {
  const plane = new Float32Array(size * size);
  const clip = { x: 0, y: 0, w: size, h: size };
  for (const part of parts) {
    let polys: number[][];
    let rule: 'nonzero' | 'evenodd' = 'nonzero';
    if (isStroke(part)) {
      const pts = part.line.map((v, i) => (i % 2 === 0 ? v * scale + ox : v * scale + oy));
      polys = strokePolygons(pts, {
        width: part.width * scale,
        closed: part.closed ?? false,
        cap: part.cap ?? 'round',
        join: part.join ?? 'round',
      });
    } else {
      polys = flattenPath(part.d, { scale, offsetX: ox, offsetY: oy, tolerance: 0.15 });
      rule = part.rule ?? 'nonzero';
    }
    const cov = rasterizePolygons(polys, { fillRule: rule, clip });
    if (!cov) continue;
    // Union by max: parts may be wound in different directions.
    for (let y = 0; y < cov.h; y++) {
      const src = y * cov.w;
      const dst = (cov.y + y) * size + cov.x;
      for (let x = 0; x < cov.w; x++) {
        const v = cov.data[src + x]!;
        if (v > plane[dst + x]!) plane[dst + x] = v;
      }
    }
  }
  return plane;
}

/** Source-over of a colour with per-pixel coverage into a premultiplied (0..255) accumulator. */
function paint(acc: Float32Array, plane: Float32Array, color: Rgba8, opacity: number): void {
  const k = (color[3] / 255) * opacity;
  if (k <= 0) return;
  const [r, g, b] = color;
  for (let i = 0, p = 0; i < plane.length; i++, p += 4) {
    const a = plane[i]! * k;
    if (a <= 0) continue;
    const inv = 1 - a;
    acc[p] = r * a + acc[p]! * inv;
    acc[p + 1] = g * a + acc[p + 1]! * inv;
    acc[p + 2] = b * a + acc[p + 2]! * inv;
    acc[p + 3] = 255 * a + acc[p + 3]! * inv;
  }
}

/** Renders a sticker into a transparent size × size image. */
export function renderSticker(def: StickerDef, opts: StickerRenderOptions): Pixels {
  const size = Math.round(opts.size);
  if (!Number.isInteger(size) || size < 1 || size > 4096) throw new RangeError(`invalid sticker size ${opts.size}`);
  const box = opts.box ?? size * 0.8;
  const scale = box / STICKER_BOX;
  const ox = (opts.cx ?? size / 2) - box / 2;
  const oy = (opts.cy ?? size / 2) - box / 2;
  const variants = stickerVariants(opts.color ?? def.color);
  const acc = new Float32Array(size * size * 4);
  const planes = def.layers.map((layer) => partsCoverage(layer.parts, size, scale, ox, oy));

  const outline = opts.outline;
  if (outline && outline.width > 0) {
    const union = new Float32Array(size * size);
    for (const plane of planes) {
      for (let i = 0; i < union.length; i++) if (plane[i]! > union[i]!) union[i] = plane[i]!;
    }
    paint(acc, dilate(union, size, size, outline.width), colorOr(outline.color, '#ffffff'), 1);
  }
  def.layers.forEach((layer, i) => {
    paint(acc, planes[i]!, colorOr(resolveColor(layer.color, variants), '#000000'), layer.opacity ?? 1);
  });
  const out = createPixels(size, size);
  fromPremultiplied(acc, out.data);
  return out;
}

export interface StickerStampOptions {
  /** Size of the sticker's 100-unit box, px. */
  box: number;
  /** Main colour (default: the sticker's own). */
  color?: string;
  outline?: StickerOutline | null;
}

/**
 * The sticker on its own, cropped to its visible pixels: the image the
 * stamp tool places (centred on the pointer). Null when nothing shows.
 */
export function renderStickerStamp(def: StickerDef, opts: StickerStampOptions): Pixels | null {
  const outline = opts.outline && opts.outline.width > 0 ? opts.outline.width : 0;
  // Room for art drawn past the 100-unit box and for the outline.
  const size = Math.min(4096, Math.ceil(opts.box * 1.5 + 2 * outline + 4));
  const px = renderSticker(def, { size, box: opts.box, color: opts.color, outline: opts.outline });
  return autoTrim(px)?.pixels ?? null;
}

/** One drawable element of a sticker preview (SVG, 100 × 100 box). */
export type StickerSvgElement =
  | { kind: 'fill'; d: string; rule: 'nonzero' | 'evenodd'; color: string; opacity: number }
  | { kind: 'stroke'; d: string; width: number; cap: 'butt' | 'round' | 'square'; join: 'miter' | 'round'; color: string; opacity: number };

/**
 * The sticker as SVG elements (for crisp, zero-cost previews in the
 * picker). Colours are resolved; draw them in order.
 */
export function stickerSvgElements(def: StickerDef, color: string = def.color): StickerSvgElement[] {
  const variants = stickerVariants(color);
  const out: StickerSvgElement[] = [];
  for (const layer of def.layers) {
    const c = resolveColor(layer.color, variants);
    const opacity = layer.opacity ?? 1;
    for (const part of layer.parts) {
      if (isStroke(part)) {
        const pts = part.line;
        let d = `M${pts[0]} ${pts[1]}`;
        for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]!.toFixed(2)} ${pts[i + 1]!.toFixed(2)}`;
        if (part.closed) d += 'Z';
        out.push({ kind: 'stroke', d, width: part.width, cap: part.cap ?? 'round', join: part.join ?? 'round', color: c, opacity });
      } else {
        // Sticker paths are SVG path data: drawn as they are (exact, and nothing to flatten).
        out.push({ kind: 'fill', d: part.d, rule: part.rule ?? 'nonzero', color: c, opacity });
      }
    }
  }
  return out;
}
