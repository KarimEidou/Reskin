// DOM ONLY. Canvas-based TextRasterizer: measures with `measureText` and
// renders with `fillText` using the layout contract in ./text.ts, so hit
// testing, overlays and pixels agree. Install it with
// `new Engine({ textRasterizer: createCanvasTextRasterizer() })` or
// `engine.setTextRasterizer(...)`.

import type { TextProps } from '../doc/types';
import { Surface } from '../raster/surface';
import type { TextLayout, TextRasterizer, TextRenderOptions } from './text';
import { baselineOf, cssColor, cssFont, layoutFromWidths, lineStartX, splitLines } from './text';
import { createCanvas } from '../render/canvas-view';

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function ctxOf(w: number, h: number): Ctx2D {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true }) as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

class CanvasTextRasterizer implements TextRasterizer {
  private readonly probe: Ctx2D = ctxOf(1, 1);
  /** Reused render target (re-created only when the document size changes). */
  private target: Ctx2D | null = null;

  private targetFor(width: number, height: number): Ctx2D {
    const t = this.target;
    if (t && t.canvas.width === width && t.canvas.height === height) {
      t.setTransform(1, 0, 0, 1, 0, 0);
      t.clearRect(0, 0, width, height);
      return t;
    }
    this.target = ctxOf(width, height);
    return this.target;
  }

  measure(props: TextProps): TextLayout {
    const ctx = this.probe;
    ctx.font = cssFont(props);
    const lines = splitLines(props.text);
    const widths = lines.map((l) => ctx.measureText(l).width);
    const m = ctx.measureText('Hg');
    const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || props.fontSize * 0.8;
    const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || props.fontSize * 0.2;
    return layoutFromWidths(props, lines, widths, ascent, descent);
  }

  render(props: TextProps, width: number, height: number, opts: TextRenderOptions): Surface {
    const layout = this.measure(props);
    const ctx = this.targetFor(width, height);
    ctx.font = cssFont(props);
    ctx.fillStyle = cssColor({ color: { ...props.color, a: 1 } });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.translate(props.x, props.y);
    ctx.rotate((props.rotation * Math.PI) / 180);
    layout.lines.forEach((line, i) => {
      ctx.fillText(line.text, lineStartX(props.align, line.width), baselineOf(layout, i));
    });
    const img = ctx.getImageData(0, 0, width, height);
    const surface = new Surface(width, height, img.data);
    applyAlpha(surface, props.color.a, opts.crisp, props.color);
    return surface;
  }
}

/**
 * Applies the colour's alpha after rendering (so overlapping glyphs do not
 * double up) and pixel-art thresholding. The text is one solid colour, so
 * every covered pixel gets that exact colour back: the canvas stores
 * premultiplied 8-bit values, which would otherwise quantise faint edges.
 */
function applyAlpha(s: Surface, alpha: number, crisp: boolean, color: TextProps['color']): void {
  const d = s.data;
  for (let p = 0; p < d.length; p += 4) {
    let a = d[p + 3];
    if (a === 0) continue;
    if (crisp) a = a >= 128 ? 255 : 0;
    a *= alpha;
    if (a < 0.5) {
      // Rounds to fully transparent: keep the (0, 0, 0, 0) convention.
      d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0;
      continue;
    }
    d[p] = color.r;
    d[p + 1] = color.g;
    d[p + 2] = color.b;
    d[p + 3] = a;
  }
}

export function createCanvasTextRasterizer(): TextRasterizer {
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') {
    throw new Error('The canvas text rasterizer needs a browser environment');
  }
  return new CanvasTextRasterizer();
}

/** Resolves when the font used by `props` is ready (no-op without the Font Loading API). */
export async function ensureFontLoaded(props: Pick<TextProps, 'italic' | 'weight' | 'fontSize' | 'fontFamily'>): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts) return;
  try {
    await fonts.load(cssFont(props));
  } catch {
    // Unknown/system fonts fall back to the default face.
  }
}
