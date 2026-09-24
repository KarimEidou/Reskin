/**
 * Auto-trim and fit-and-centre: find the visible content, then scale it
 * (keeping aspect) into a square canvas with padding.
 */
import { assertPixels, createPixels, type Pixels, type Rect } from '../filters/types';
import { blitPixels, cropPixels, resizePixels, type Resampling } from './resample';

/** Smallest rectangle holding every pixel with alpha ≥ threshold (1..255), or null if none. */
export function alphaBounds(src: Pixels, threshold = 1): Rect | null {
  assertPixels(src, 'src');
  const t = Math.max(1, Math.min(255, Math.round(threshold)));
  const { width: w, height: h, data: d } = src;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    let i = y * w * 4 + 3;
    for (let x = 0; x < w; x++, i += 4) {
      if (d[i] >= t) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export interface TrimOptions {
  /** Transparent margin kept around the content, px (default 0). */
  padding?: number;
  /** Minimum alpha that counts as content, 1..255 (default 1). */
  threshold?: number;
}

export interface TrimResult {
  /** The kept region in source coordinates (may extend past the image when padded). */
  rect: Rect;
  pixels: Pixels;
}

/** Crops to the content's alpha bounds plus padding; null when the image is fully transparent. */
export function autoTrim(src: Pixels, opts: TrimOptions = {}): TrimResult | null {
  const b = alphaBounds(src, opts.threshold ?? 1);
  if (!b) return null;
  const pad = Math.max(0, Math.round(opts.padding ?? 0));
  const rect = { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
  return { rect, pixels: cropPixels(src, rect) };
}

export type Alignment = 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface FitOptions {
  /** Margin on every side as a fraction of the canvas, 0..0.45 (default 0.1). */
  paddingRatio?: number;
  /** Where the content sits inside the padded area (default 'center'). */
  alignment?: Alignment;
  /** Fit the alpha bounds instead of the whole image (default true). */
  trim?: boolean;
  /** Alpha threshold for trimming, 1..255 (default 1). */
  threshold?: number;
  /** 'smooth' (area-average down / bilinear up) or 'nearest' for pixel art (default 'smooth'). */
  resampling?: Resampling;
  /** Allow enlarging small content (default true). */
  upscale?: boolean;
}

export interface FitPlacement {
  /** Region of the source that is placed. */
  source: Rect;
  /** Destination rectangle inside the size × size canvas. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Scale factor source → destination. */
  scale: number;
}

/**
 * Where `fitAndCenter` would put the content, without resampling — useful
 * for applying the same fit as a layer transform. Null for empty images.
 */
export function computeFit(src: Pixels, size: number, opts: FitOptions = {}): FitPlacement | null {
  assertPixels(src, 'src');
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`invalid canvas size ${size}`);
  const source = opts.trim === false ? (src.width && src.height ? { x: 0, y: 0, width: src.width, height: src.height } : null) : alphaBounds(src, opts.threshold ?? 1);
  if (!source) return null;
  const ratio = Math.max(0, Math.min(0.45, opts.paddingRatio ?? 0.1));
  const pad = size * ratio;
  const avail = Math.max(1, size - 2 * pad);
  let scale = Math.min(avail / source.width, avail / source.height);
  if (opts.upscale === false) scale = Math.min(scale, 1);
  const width = Math.max(1, Math.min(size, Math.round(source.width * scale)));
  const height = Math.max(1, Math.min(size, Math.round(source.height * scale)));
  const align = opts.alignment ?? 'center';
  const padPx = Math.round(pad);
  const horiz = align.endsWith('left') ? 'start' : align.endsWith('right') ? 'end' : 'mid';
  const vert = align.startsWith('top') ? 'start' : align.startsWith('bottom') ? 'end' : 'mid';
  const place = (mode: 'start' | 'mid' | 'end', len: number) =>
    mode === 'start' ? Math.min(padPx, size - len) : mode === 'end' ? Math.max(0, size - padPx - len) : Math.round((size - len) / 2);
  return { source, x: place(horiz, width), y: place(vert, height), width, height, scale };
}

/**
 * Trims (by default), scales to fit a size × size canvas inside the padding
 * while keeping aspect ratio, and aligns the result (centred by default).
 * Returns a transparent canvas for fully transparent input.
 */
export function fitAndCenter(src: Pixels, size: number, opts: FitOptions = {}): Pixels {
  const out = createPixels(size, size);
  const fit = computeFit(src, size, opts);
  if (!fit) return out;
  const content = cropPixels(src, fit.source);
  const scaled = resizePixels(content, fit.width, fit.height, opts.resampling ?? 'smooth');
  blitPixels(scaled, out, fit.x, fit.y);
  return out;
}
