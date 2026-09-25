// Colour maths for theming: hex parsing, OKLCH (perceptual) adjustments and
// WCAG contrast. Accent shades are derived in OKLCH so lighter/darker steps
// look evenly spaced for any hue, like Windows' AccentLight/AccentDark ramp.

export interface Rgb {
  /** 0..255 */
  r: number;
  g: number;
  b: number;
}

export interface Oklch {
  /** Perceptual lightness 0..1. */
  l: number;
  /** Chroma, 0 = grey (sRGB colours stay below ~0.37). */
  c: number;
  /** Hue in degrees. */
  h: number;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored). */
export function parseHex(hex: string): Rgb | null {
  const m = HEX_RE.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((ch) => ch + ch).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const hx = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/** "r g b" for `rgb(var(--x-rgb) / 0.5)`. */
export function rgbTriplet({ r, g, b }: Rgb): string {
  return `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`;
}

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return c * 255;
};

/** sRGB → OKLCH (Björn Ottosson's OKLab). */
export function rgbToOklch(rgb: Rgb): Oklch {
  const r = toLinear(rgb.r);
  const g = toLinear(rgb.g);
  const b = toLinear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = c < 1e-7 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

/** OKLCH → linear-light sRGB channels (may fall outside 0..1). */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (ch: [number, number, number]) => ch.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/**
 * OKLCH → sRGB, reducing chroma (keeping lightness and hue) until the colour
 * fits the sRGB gamut, so shades never clip to a different hue.
 */
export function oklchToRgb(color: Oklch): Rgb {
  const l = Math.min(1, Math.max(0, color.l));
  let lo = 0;
  let hi = Math.max(0, color.c);
  let ch = oklchToLinear({ l, c: hi, h: color.h });
  if (!inGamut(ch)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const test = oklchToLinear({ l, c: mid, h: color.h });
      if (inGamut(test)) lo = mid;
      else hi = mid;
    }
    ch = oklchToLinear({ l, c: lo, h: color.h });
  }
  const [r, g, b] = ch.map((v) => fromLinear(Math.min(1, Math.max(0, v))));
  return { r: r!, g: g!, b: b! };
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/**
 * Text colour for `bg`: white whenever it meets WCAG AA (4.5:1) — WCAG's
 * luminance model undervalues white on saturated mid-tones such as
 * #0078d4, where white is clearly the more legible choice — otherwise
 * whichever of black/white contrasts more.
 */
export function readableOn(bg: Rgb): Rgb {
  const white = contrast(bg, WHITE);
  if (white >= 4.5) return WHITE;
  return white >= contrast(bg, BLACK) ? WHITE : BLACK;
}

/** Same hue/chroma at a new perceptual lightness. */
export function withLightness(rgb: Rgb, l: number): Rgb {
  const o = rgbToOklch(rgb);
  return oklchToRgb({ ...o, l });
}

const rounded = ({ r, g, b }: Rgb): Rgb => ({ r: Math.round(r), g: Math.round(g), b: Math.round(b) });

/**
 * `color` with at least `ratio` contrast against `bg`: `color` itself when
 * it has that once rounded to whole channels (as hex writes it), else the
 * nearest lightness in the given direction that has it — same hue, and
 * chroma as far as sRGB allows — in whole channels. Black or white, the far
 * ends, are the most it can give.
 */
export function withContrast(color: Rgb, bg: Rgb, ratio: number, towards: 'darker' | 'lighter'): Rgb {
  if (contrast(rounded(color), bg) >= ratio) return color;
  const enough = (l: number) => contrast(rounded(withLightness(color, l)), bg) >= ratio;
  // Bisect between the colour's own lightness (too little) and the far end.
  let short = rgbToOklch(color).l;
  let far = towards === 'darker' ? 0 : 1;
  for (let i = 0; i < 24; i++) {
    const mid = (short + far) / 2;
    if (enough(mid)) far = mid;
    else short = mid;
  }
  return rounded(withLightness(color, far));
}

/**
 * The accent ramp. `light1..3` / `dark1..3` step lightness in OKLCH like
 * Windows' AccentLight/AccentDark colours; `vivid` is a saturated mid-light
 * version for glows and rims that must pop on any wallpaper.
 */
export interface AccentRamp {
  base: Rgb;
  light1: Rgb;
  light2: Rgb;
  light3: Rgb;
  dark1: Rgb;
  dark2: Rgb;
  dark3: Rgb;
  vivid: Rgb;
}

export function accentRamp(base: Rgb): AccentRamp {
  const o = rgbToOklch(base);
  const at = (l: number, c = o.c) => oklchToRgb({ l, c, h: o.h });
  const clampL = (l: number) => Math.min(0.97, Math.max(0.12, l));
  return {
    base,
    light1: at(clampL(o.l + 0.09)),
    light2: at(clampL(o.l + 0.18)),
    light3: at(clampL(o.l + 0.27)),
    dark1: at(clampL(o.l - 0.08)),
    dark2: at(clampL(o.l - 0.16)),
    dark3: at(clampL(o.l - 0.24)),
    // Greys stay grey: boosting chroma would invent a hue (h = 0 → red).
    vivid: at(Math.min(0.78, Math.max(0.64, o.l)), o.c < 0.03 ? o.c : Math.max(o.c, 0.16)),
  };
}
