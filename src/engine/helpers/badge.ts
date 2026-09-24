/**
 * Corner badges: a filled circle (or pill, for wider labels) with an
 * optional outline ring and a 1–3 character label, composited over the
 * icon with anti-aliased edges.
 */
import { roundedRectSdf } from '../backdrop/shapes';
import { colorOr, lumaInt, type Rgba } from '../filters/colormath';
import { assertPixels, type Mask, type Pixels } from '../filters/types';
import { beginOutput, finishOutput } from '../filters/util';
import { bitmapTextRasterizer, type TextRaster, type TextRasterizer } from './text';

export type BadgePosition = 'tl' | 'tr' | 'bl' | 'br';

export interface BadgeOptions {
  /** Label; only the first 3 characters are used. Empty/absent → a plain dot. */
  text?: string;
  /** Badge fill (default '#e81123'). */
  color?: string;
  /** Label colour (default: black or white, whichever contrasts with `color`). */
  textColor?: string;
  /** Corner (default 'br'). */
  position?: BadgePosition;
  /** Badge height as a fraction of the image's shorter side, 0.1..0.8 (default 0.36). */
  size?: number;
  /** Gap to the image edges as a fraction of the shorter side, 0..0.2 (default 0.02). */
  margin?: number;
  /** Outline ring width as a fraction of the badge height, 0..0.3 (default 0.08). */
  ring?: number;
  /** Ring colour (default '#ffffff'). */
  ringColor?: string;
  /** Text renderer (default: the built-in 5×7 bitmap font). */
  rasterizer?: TextRasterizer;
  fontFamily?: string;
  bold?: boolean;
}

export interface BadgeLayout {
  /** Badge body (without the ring), px. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Ring width, px. */
  ring: number;
  /** Rendered label and its top-left position, or null. */
  text: TextRaster | null;
  textX: number;
  textY: number;
}

function clampOpt(v: number | undefined, def: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
}

/** Where the badge and its label go on a width × height image (for rendering and hit-testing). */
export function badgeLayout(width: number, height: number, opts: BadgeOptions = {}): BadgeLayout {
  const side = Math.min(width, height);
  const H = clampOpt(opts.size, 0.36, 0.1, 0.8) * side;
  const ring = clampOpt(opts.ring, 0.08, 0, 0.3) * H;
  const margin = clampOpt(opts.margin, 0.02, 0, 0.2) * side;
  const label = [...(opts.text ?? '').trim()].slice(0, 3).join('');
  const raster = opts.rasterizer ?? bitmapTextRasterizer;
  const style = { fontFamily: opts.fontFamily, bold: opts.bold };
  const padX = H * 0.6;
  const maxW = Math.max(H, width - 2 * margin - 2 * ring);
  let text: TextRaster | null = null;
  let W = H;
  if (label) {
    let cap = H * 0.5;
    text = raster.rasterize(label, cap, style);
    if (text.width + padX > maxW && text.width > 0) {
      cap = Math.max(1, cap * ((maxW - padX) / text.width));
      text = raster.rasterize(label, cap, style);
    }
    W = Math.min(maxW, Math.max(H, text.width + padX));
  }
  const left = opts.position === 'tl' || opts.position === 'bl';
  const top = opts.position === 'tl' || opts.position === 'tr';
  const x = left ? margin + ring : width - margin - ring - W;
  const y = top ? margin + ring : height - margin - ring - H;
  const textX = text ? Math.round(x + W / 2 - text.width / 2) : 0;
  const textY = text ? Math.round(y + H / 2 - text.height / 2) : 0;
  return { x, y, width: W, height: H, ring, text, textX, textY };
}

/** Premultiplied "over" into acc = [r, g, b (0..255 · alpha), alpha (0..1)]. */
function over(acc: Float64Array, col: Rgba, alpha: number): void {
  if (alpha <= 0) return;
  const keep = 1 - alpha;
  acc[0] = col[0] * alpha + acc[0] * keep;
  acc[1] = col[1] * alpha + acc[1] * keep;
  acc[2] = col[2] * alpha + acc[2] * keep;
  acc[3] = alpha + acc[3] * keep;
}

/** Composites a badge onto a copy of the image (only selected pixels change when `mask` is given). */
export function addBadge(src: Pixels, opts: BadgeOptions = {}, mask?: Mask | null): Pixels {
  assertPixels(src, 'src');
  const { width: w, height: h } = src;
  const dst = beginOutput(src, mask, undefined);
  dst.data.set(src.data);
  if (w === 0 || h === 0) return finishOutput(src, dst, mask);
  const L = badgeLayout(w, h, opts);
  const fill = colorOr(opts.color, '#e81123');
  const ringC = colorOr(opts.ringColor, '#ffffff');
  const autoText: Rgba = lumaInt(fill[0], fill[1], fill[2]) > 160 ? [0, 0, 0, 255] : [255, 255, 255, 255];
  const textC = opts.textColor !== undefined ? colorOr(opts.textColor, '#ffffff') : autoText;
  const sdf = roundedRectSdf(L.x + L.width / 2, L.y + L.height / 2, L.width / 2, L.height / 2, L.height / 2);
  const x0 = Math.max(0, Math.floor(L.x - L.ring - 1));
  const y0 = Math.max(0, Math.floor(L.y - L.ring - 1));
  const x1 = Math.min(w, Math.ceil(L.x + L.width + L.ring + 1));
  const y1 = Math.min(h, Math.ceil(L.y + L.height + L.ring + 1));
  const d = dst.data;
  const t = L.text;
  const fa = fill[3] / 255;
  const ra = ringC[3] / 255;
  const ta = textC[3] / 255;
  const acc = new Float64Array(4);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dist = sdf(x + 0.5, y + 0.5, Infinity);
      let cFill = 0.5 - dist;
      cFill = cFill < 0 ? 0 : cFill > 1 ? 1 : cFill;
      let cRing = L.ring > 0 ? 0.5 + L.ring - dist : 0;
      cRing = cRing < 0 ? 0 : cRing > 1 ? 1 : cRing;
      if (cFill <= 0 && cRing <= 0) continue;
      const i = (y * w + x) * 4;
      const a0 = d[i + 3] / 255;
      acc[0] = d[i] * a0;
      acc[1] = d[i + 1] * a0;
      acc[2] = d[i + 2] * a0;
      acc[3] = a0;
      // Ring first (the full dilated pill, so fill over it leaves no seam), then fill, then label.
      over(acc, ringC, cRing * ra);
      over(acc, fill, cFill * fa);
      if (t) {
        const tx = x - L.textX;
        const ty = y - L.textY;
        if (tx >= 0 && ty >= 0 && tx < t.width && ty < t.height) {
          over(acc, textC, (t.coverage[ty * t.width + tx] / 255) * cFill * ta);
        }
      }
      if (acc[3] <= 0) continue;
      d[i] = acc[0] / acc[3];
      d[i + 1] = acc[1] / acc[3];
      d[i + 2] = acc[2] / acc[3];
      d[i + 3] = acc[3] * 255;
    }
  }
  return finishOutput(src, dst, mask);
}
