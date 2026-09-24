import { describe, expect, it } from 'vitest';
import {
  colorDistance,
  hslToHsv,
  hslToRgb,
  hsvToHsl,
  hsvToRgb,
  mixColors,
  parseColor,
  parseHex,
  rgbToHsl,
  rgbToHsv,
  roundRgba,
  toCssHsl,
  toCssRgb,
  toHex,
  toHsvString,
  toRgba8,
} from './color';
import type { Rgba } from './color';
import { contrastRatio, readableTextColor, relativeLuminance, wcagLevel } from './contrast';
import { PALETTES } from './palettes';
import { seededRandom } from '../test-helpers';

function randomColor(rand: () => number): Rgba {
  return {
    r: Math.floor(rand() * 256),
    g: Math.floor(rand() * 256),
    b: Math.floor(rand() * 256),
    a: Math.floor(rand() * 256) / 255,
  };
}

function expectSameRgba8(a: Rgba, b: Rgba): void {
  expect(toRgba8(a)).toEqual(toRgba8(b));
}

describe('colour conversions (randomized round trips)', () => {
  const rand = seededRandom(1234);
  const samples = Array.from({ length: 5000 }, () => randomColor(rand));
  // Edge cases: greys, primaries, black/white, transparent.
  samples.push(
    { r: 0, g: 0, b: 0, a: 1 },
    { r: 255, g: 255, b: 255, a: 1 },
    { r: 128, g: 128, b: 128, a: 0 },
    { r: 255, g: 0, b: 0, a: 1 },
    { r: 0, g: 255, b: 0, a: 1 },
    { r: 0, g: 0, b: 255, a: 1 },
    { r: 255, g: 0, b: 255, a: 0.5019607843137255 },
  );

  it('hex ↔ rgb (with alpha) is exact', () => {
    for (const c of samples) {
      const hex = toHex(c, 'always');
      expect(hex).toMatch(/^#[0-9a-f]{8}$/);
      const back = parseHex(hex)!;
      expectSameRgba8(back, c);
      expect(toHex(back, 'always')).toBe(hex);
    }
  });

  it('rgb → hsv → rgb is exact after rounding', () => {
    for (const c of samples) expectSameRgba8(hsvToRgb(rgbToHsv(c)), c);
  });

  it('rgb → hsl → rgb is exact after rounding', () => {
    for (const c of samples) expectSameRgba8(hslToRgb(rgbToHsl(c)), c);
  });

  it('hsv ↔ hsl conversions agree with the rgb path', () => {
    for (const c of samples) {
      expectSameRgba8(hslToRgb(hsvToHsl(rgbToHsv(c))), c);
      expectSameRgba8(hsvToRgb(hslToHsv(rgbToHsl(c))), c);
    }
  });

  it('CSS strings round-trip through parseColor', () => {
    for (const c of samples) {
      for (const text of [toCssRgb(c), toCssHsl(c), toHsvString(c), toHex(c)]) {
        const back = parseColor(text);
        expect(back, text).not.toBeNull();
        expectSameRgba8(back!, c);
      }
    }
  });

  it('hsv → rgb → hsv preserves hue/saturation/value for chromatic colours', () => {
    const r2 = seededRandom(99);
    for (let i = 0; i < 2000; i++) {
      const hsv = { h: r2() * 360, s: 0.05 + r2() * 0.95, v: 0.05 + r2() * 0.95, a: r2() };
      const back = rgbToHsv(hsvToRgb(hsv));
      expect(back.h).toBeCloseTo(hsv.h, 6);
      expect(back.s).toBeCloseTo(hsv.s, 9);
      expect(back.v).toBeCloseTo(hsv.v, 9);
      expect(back.a).toBe(hsv.a);
    }
  });
});

describe('parseColor', () => {
  it('parses the common notations', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#0f08')).toEqual({ r: 0, g: 255, b: 0, a: 136 / 255 });
    expect(parseColor('7c5cff')).toEqual({ r: 124, g: 92, b: 255, a: 1 });
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor('rgba(10,20,30,0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('rgb(10 20 30 / 25%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
    expect(parseColor('rgb(100% 0% 50%)')).toEqual({ r: 255, g: 0, b: 127.5, a: 1 });
    expect(toRgba8(parseColor('hsl(120deg 100% 50%)')!)).toEqual([0, 255, 0, 255]);
    expect(toRgba8(parseColor('hsla(0.5turn, 100%, 50%, 0.5)')!)).toEqual([0, 255, 255, 128]);
    expect(toRgba8(parseColor('hsv(240 100% 100%)')!)).toEqual([0, 0, 255, 255]);
    expect(parseColor('RebeccaPurple')).toEqual({ r: 102, g: 51, b: 153, a: 1 });
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('rejects non-colours', () => {
    for (const bad of [
      '',
      'nope',
      '#12',
      '#12345',
      'rgb(1,2)',
      'rgb(1 2 3 4 5)',
      'hsl(10 20 30 / 1 / 2)',
      'rgb(a,b,c)',
      // Object.prototype members are not named colours.
      'constructor',
      '__proto__',
      'toString',
      'valueOf',
    ]) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });

  it('formats hex with auto alpha', () => {
    expect(toHex({ r: 255, g: 0, b: 0, a: 1 })).toBe('#ff0000');
    expect(toHex({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('#ff000080');
    expect(toHex({ r: 255, g: 0, b: 0, a: 0.5 }, 'never')).toBe('#ff0000');
    expect(toCssRgb({ r: 1, g: 2, b: 3, a: 1 })).toBe('rgb(1, 2, 3)');
    expect(toCssRgb({ r: 1, g: 2, b: 3, a: 0.25 })).toBe('rgba(1, 2, 3, 0.25)');
  });
});

describe('colour helpers', () => {
  it('mixes in premultiplied space', () => {
    const m = mixColors({ r: 255, g: 0, b: 0, a: 1 }, { r: 0, g: 0, b: 255, a: 0 }, 0.5);
    // Fading to transparent keeps the colour red instead of drifting purple.
    expect(roundRgba(m)).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 });
  });

  it('measures channel distance', () => {
    expect(colorDistance({ r: 0, g: 10, b: 0, a: 1 }, { r: 3, g: 0, b: 0, a: 1 })).toBe(10);
  });

  it('computes WCAG contrast', () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(relativeLuminance(white)).toBeCloseTo(1, 10);
    expect(contrastRatio(black, white)).toBeCloseTo(21, 6);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 10);
    expect(wcagLevel(4.6)).toBe('AA');
    expect(wcagLevel(2)).toBe('fail');
    expect(readableTextColor({ r: 20, g: 20, b: 40, a: 1 })).toEqual(white);
    expect(readableTextColor({ r: 250, g: 240, b: 200, a: 1 })).toEqual(black);
  });

  it('ships six palettes of 16–24 valid swatches', () => {
    expect(PALETTES.map((p) => p.id)).toEqual(['fluent', 'material', 'pastel', 'neon', 'earth', 'grayscale']);
    for (const p of PALETTES) {
      expect(p.colors.length).toBeGreaterThanOrEqual(16);
      expect(p.colors.length).toBeLessThanOrEqual(24);
      for (const c of p.colors) expect(parseHex(c), `${p.id} ${c}`).not.toBeNull();
      expect(new Set(p.colors).size).toBe(p.colors.length);
    }
  });
});
