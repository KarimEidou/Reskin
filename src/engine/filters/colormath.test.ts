import { describe, expect, it } from 'vitest';
import { hslToRgb, lumaInt, parseColor, rgbToHsl, toHex } from './colormath';
import { gradientLutRgba8, normalizeStops, resolveStops } from './gradient';
import { hash01, inverseNormalCdf, mulberry32, NORMAL_TABLE_SIZE, normalTable } from './prng';

describe('parseColor', () => {
  it('parses hex forms', () => {
    expect(parseColor('#f00')).toEqual([255, 0, 0, 255]);
    expect(parseColor('#f008')).toEqual([255, 0, 0, 0x88]);
    expect(parseColor('#12aBcD')).toEqual([0x12, 0xab, 0xcd, 255]);
    expect(parseColor('#12abcd80')).toEqual([0x12, 0xab, 0xcd, 0x80]);
  });

  it('parses rgb()/rgba() and transparent', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 255]);
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3, 128]);
    expect(parseColor('rgb(10 20 30 / 25%)')).toEqual([10, 20, 30, 64]);
    expect(parseColor('rgb(100%, 0%, 50%)')).toEqual([255, 0, 128, 255]);
    expect(parseColor('transparent')).toEqual([0, 0, 0, 0]);
  });

  it('rejects junk', () => {
    for (const s of ['', 'red', '#12', '#12345', 'rgb(1,2)', 'rgb(a,b,c)', '#ggg']) expect(parseColor(s)).toBeNull();
  });

  it('formats hex', () => {
    expect(toHex(255, 0, 16)).toBe('#ff0010');
    expect(toHex(255, 0, 16, 128)).toBe('#ff001080');
  });
});

describe('luma and HSL', () => {
  it('integer luma keeps greys exact', () => {
    for (let v = 0; v < 256; v++) expect(lumaInt(v, v, v)).toBe(v);
    expect(lumaInt(255, 0, 0)).toBe(54);
    expect(lumaInt(0, 255, 0)).toBe(182);
    expect(lumaInt(0, 0, 255)).toBe(18);
  });

  it('RGB → HSL → RGB round-trips every sampled 8-bit colour exactly', () => {
    const hsl = [0, 0, 0];
    const rgb = [0, 0, 0];
    for (let r = 0; r < 256; r += 15) {
      for (let g = 0; g < 256; g += 15) {
        for (let b = 0; b < 256; b += 15) {
          rgbToHsl(r / 255, g / 255, b / 255, hsl);
          hslToRgb(hsl[0], hsl[1], hsl[2], rgb);
          expect([Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255)]).toEqual([r, g, b]);
        }
      }
    }
  });

  it('HSL of primaries', () => {
    const hsl = [0, 0, 0];
    rgbToHsl(0, 1, 1, hsl);
    expect(hsl).toEqual([180, 1, 0.5]);
  });
});

describe('gradient stops', () => {
  it('sorts, clamps and validates stops', () => {
    const r = resolveStops(
      [
        { offset: 2, color: '#fff' },
        { offset: -1, color: '#000' },
        { offset: 0.5, color: 'bogus' },
      ],
      [],
    );
    expect(r.map((s) => s.offset)).toEqual([0, 1]);
    expect(r[0].rgba).toEqual([0, 0, 0, 255]);
  });

  it('a single stop becomes flat; none falls back', () => {
    expect(resolveStops([{ offset: 0.3, color: '#123456' }], [])).toHaveLength(2);
    const fb = [
      { offset: 0, color: '#000' },
      { offset: 1, color: '#fff' },
    ];
    expect(normalizeStops('nope', fb)).toEqual(fb);
  });

  it('LUT interpolates in premultiplied space', () => {
    const lut = gradientLutRgba8(
      resolveStops(
        [
          { offset: 0, color: '#ff000000' },
          { offset: 1, color: '#0000ffff' },
        ],
        [],
      ),
      3,
    );
    // halfway: only blue contributes colour (red is fully transparent)
    expect([lut[4], lut[5], lut[6]]).toEqual([0, 0, 255]);
    expect(lut[7]).toBe(128);
  });
});

describe('prng', () => {
  it('mulberry32 is deterministic per seed', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const c = mulberry32(8);
    const sa = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(sa);
    expect([c(), c(), c()]).not.toEqual(sa);
    for (const v of sa) expect(v >= 0 && v < 1).toBe(true);
  });

  it('inverseNormalCdf matches reference quantiles', () => {
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 12);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959963985, 7);
    expect(inverseNormalCdf(0.8413447461)).toBeCloseTo(1, 7);
    expect(inverseNormalCdf(0.001)).toBeCloseTo(-3.090232306, 7);
    expect(inverseNormalCdf(0.02)).toBeCloseTo(-2.053748911, 7);
    expect(inverseNormalCdf(0)).toBe(-Infinity);
    expect(inverseNormalCdf(1)).toBe(Infinity);
  });

  it('normalTable has zero mean, unit variance and is antisymmetric', () => {
    const t = normalTable();
    expect(t).toHaveLength(NORMAL_TABLE_SIZE);
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < t.length; i++) {
      sum += t[i];
      sq += t[i] * t[i];
      expect(t[i]).toBeCloseTo(-t[t.length - 1 - i], 5);
      if (i > 0) expect(t[i]).toBeGreaterThan(t[i - 1]);
    }
    expect(sum / t.length).toBeCloseTo(0, 6);
    expect(sq / t.length).toBeCloseTo(1, 5);
    expect(normalTable()).toBe(t);
  });

  it('hash01 is stable and roughly uniform', () => {
    expect(hash01(3, 4, 5, 0)).toBe(hash01(3, 4, 5, 0));
    expect(hash01(3, 4, 5, 0)).not.toBe(hash01(4, 3, 5, 0));
    let sum = 0;
    for (let i = 0; i < 10000; i++) sum += hash01(i % 100, Math.floor(i / 100), 1, 0);
    expect(sum / 10000).toBeGreaterThan(0.48);
    expect(sum / 10000).toBeLessThan(0.52);
  });
});
