/**
 * Text rasterization for badges.
 *
 * Real font rendering needs a canvas, which the pure engine (and its node
 * tests) cannot assume, so badge text goes through the `TextRasterizer`
 * interface. Two implementations ship:
 *
 * - `bitmapTextRasterizer`: a built-in 5×7 pixel font (digits, A–Z, a few
 *   symbols) rendered with exact area coverage — no dependencies, works in
 *   node and workers, looks deliberately "LED".
 * - `createCanvasTextRasterizer()` (in `canvas-text.ts`): system fonts via
 *   OffscreenCanvas, for the editor.
 */

/** A text coverage mask: `coverage[y * width + x]` is 0..255 ink coverage. */
export interface TextRaster {
  width: number;
  height: number;
  coverage: Uint8Array;
}

export interface TextStyle {
  /** CSS font-family list (canvas rasterizers only). */
  fontFamily?: string;
  bold?: boolean;
}

/**
 * Renders a short string to a coverage mask.
 *
 * Contract: `capHeight` is the target height in px of capital letters /
 * digits. The returned raster should be cropped to the ink horizontally and
 * span at least the cap height vertically (descenders may extend it); the
 * badge centres the raster on the badge as a box. Implementations must be
 * deterministic and must not retain the returned buffer.
 */
export interface TextRasterizer {
  rasterize(text: string, capHeight: number, style?: TextStyle): TextRaster;
}

/* 5×7 glyphs, one string of five 0/1 per row, top to bottom. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '10001', '11111', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '10001', '01010', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '*': ['00000', '00100', '10101', '01110', '10101', '00100', '00000'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '/': ['00000', '00001', '00010', '00100', '01000', '10000', '00000'],
  '%': ['11000', '11001', '00010', '00100', '01000', '10011', '00011'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  '@': ['01110', '10001', '00001', '01101', '10101', '10101', '01110'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '<': ['00010', '00100', '01000', '10000', '01000', '00100', '00010'],
  '>': ['01000', '00100', '00010', '00001', '00010', '00100', '01000'],
  '$': ['00100', '01111', '10100', '01110', '00101', '11110', '00100'],
  '♥': ['00000', '01010', '11111', '11111', '01110', '00100', '00000'],
  '★': ['00100', '00100', '11111', '01110', '01110', '11011', '10001'],
  '✓': ['00000', '00001', '00011', '10110', '11100', '01000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/** Characters the bitmap font can draw (lower-case letters are drawn as capitals). */
export const BITMAP_FONT_CHARS: string = Object.keys(GLYPHS).join('');

function glyphFor(ch: string): readonly string[] {
  return GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS['?'];
}

/**
 * Built-in 5×7 bitmap font. Each lit cell is a square of capHeight / 7 px;
 * pixel coverage is the exact overlap area, so any size anti-aliases
 * cleanly. Bold widens every cell by 40 %.
 */
export const bitmapTextRasterizer: TextRasterizer = {
  rasterize(text: string, capHeight: number, style?: TextStyle): TextRaster {
    const chars = [...text];
    const cell = Math.max(0.5, capHeight) / 7;
    const boldExtra = style?.bold ? cell * 0.4 : 0;
    const advance = 6 * cell + boldExtra;
    const inkWidth = chars.length > 0 ? chars.length * advance - cell : 0;
    const width = Math.max(1, Math.ceil(inkWidth));
    const height = Math.max(1, Math.ceil(7 * cell));
    const acc = new Float32Array(width * height);
    chars.forEach((ch, k) => {
      const rows = glyphFor(ch);
      const gx = k * advance;
      for (let row = 0; row < 7; row++) {
        const bits = rows[row];
        for (let col = 0; col < 5; col++) {
          if (bits.charCodeAt(col) !== 49) continue; // '1'
          const x0 = gx + col * cell;
          const x1 = x0 + cell + boldExtra;
          const y0 = row * cell;
          const y1 = y0 + cell;
          for (let py = Math.floor(y0); py < Math.min(height, Math.ceil(y1)); py++) {
            const oy = Math.min(y1, py + 1) - Math.max(y0, py);
            if (oy <= 0) continue;
            for (let px = Math.floor(x0); px < Math.min(width, Math.ceil(x1)); px++) {
              const ox = Math.min(x1, px + 1) - Math.max(x0, px);
              if (ox > 0) acc[py * width + px] += ox * oy;
            }
          }
        }
      }
    });
    const coverage = new Uint8Array(width * height);
    for (let i = 0; i < acc.length; i++) coverage[i] = Math.round(Math.min(1, acc[i]) * 255);
    return { width, height, coverage };
  },
};
