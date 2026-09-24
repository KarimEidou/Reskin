/**
 * System-font `TextRasterizer` backed by OffscreenCanvas (available in the
 * editor page and in workers; not in node). Use it for badges in the app;
 * the engine falls back to the bitmap font when it is unavailable.
 */
import type { TextRaster, TextRasterizer, TextStyle } from './text';

export const DEFAULT_FONT_FAMILY = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

type Ctx = OffscreenCanvasRenderingContext2D;

function context(w: number, h: number): Ctx | null {
  try {
    return new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  } catch {
    return null;
  }
}

/**
 * Creates a canvas text rasterizer, or returns null when OffscreenCanvas
 * 2D is unavailable (e.g. node). Glyphs are sized so capitals are
 * `capHeight` px tall (calibrated by measuring "H"), drawn in white, and
 * the alpha channel is returned cropped to the ink horizontally and to the
 * union of the ink and the cap-height box vertically.
 */
export function createCanvasTextRasterizer(defaultFamily: string = DEFAULT_FONT_FAMILY): TextRasterizer | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const measure = context(1, 1);
  if (!measure) return null;
  return {
    rasterize(text: string, capHeight: number, style?: TextStyle): TextRaster {
      const family = style?.fontFamily || defaultFamily;
      const weight = style?.bold === false ? '500' : '700';
      measure.font = `${weight} 100px ${family}`;
      const capAt100 = measure.measureText('H').actualBoundingBoxAscent || 70;
      const px = Math.max(1, (capHeight * 100) / capAt100);
      const font = `${weight} ${px}px ${family}`;
      measure.font = font;
      const m = measure.measureText(text);
      const left = Math.ceil(Math.max(0, m.actualBoundingBoxLeft)) + 2;
      const right = Math.ceil(Math.max(0, m.actualBoundingBoxRight)) + 2;
      const ascent = Math.ceil(Math.max(m.actualBoundingBoxAscent, capHeight)) + 2;
      const descent = Math.ceil(Math.max(0, m.actualBoundingBoxDescent)) + 2;
      const w = Math.max(1, left + right);
      const h = Math.max(1, ascent + descent);
      const ctx = context(w, h);
      if (!ctx) return { width: 1, height: 1, coverage: new Uint8Array(1) };
      ctx.font = font;
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, left, ascent);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (rgba[(y * w + x) * 4 + 3] === 0) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
      if (x1 < 0) return { width: 1, height: 1, coverage: new Uint8Array(1) };
      // Crop horizontally to the ink, but keep at least the cap-height box
      // vertically (baseline at the bottom), so short glyphs such as "-" or
      // "." keep their height above the baseline instead of being centred
      // on their own ink.
      const capTop = Math.max(0, ascent - Math.ceil(capHeight));
      if (capTop < y0) y0 = capTop;
      if (ascent - 1 > y1) y1 = Math.min(h - 1, ascent - 1);
      const cw = x1 - x0 + 1;
      const ch = y1 - y0 + 1;
      const coverage = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) coverage[y * cw + x] = rgba[((y + y0) * w + x + x0) * 4 + 3];
      }
      return { width: cw, height: ch, coverage };
    },
  };
}
