import { describe, expect, it } from 'vitest';
import type { Pixels } from '../filters/types';
import {
  EMOJI,
  PathSyntaxError,
  STICKERS,
  canRenderEmoji,
  flattenPath,
  getSticker,
  parsePath,
  polygonsToPath,
  renderEmoji,
  renderEmojiStamp,
  renderSticker,
  renderStickerStamp,
  searchEmoji,
  searchStickers,
  stickerSvgElements,
  stickerVariants,
} from './index';

function alphaSum(p: Pixels): number {
  let s = 0;
  for (let i = 3; i < p.data.length; i += 4) s += p.data[i]!;
  return s / 255;
}

function edgeAlpha(p: Pixels): number {
  const { width: w, height: h, data } = p;
  let max = 0;
  for (let x = 0; x < w; x++) {
    max = Math.max(max, data[x * 4 + 3]!, data[((h - 1) * w + x) * 4 + 3]!);
  }
  for (let y = 0; y < h; y++) {
    max = Math.max(max, data[y * w * 4 + 3]!, data[(y * w + w - 1) * 4 + 3]!);
  }
  return max;
}

/** Polygon area (shoelace), absolute. */
function area(poly: readonly number[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length;
    a += poly[i]! * poly[j + 1]! - poly[j]! * poly[i + 1]!;
  }
  return Math.abs(a / 2);
}

describe('path data', () => {
  it('parses absolute and relative commands with implicit linetos', () => {
    const cmds = parsePath('M10 10 20 10 l0 10 h-10z m 5,5 v2');
    expect(cmds.map((c) => c.op)).toEqual(['M', 'L', 'l', 'h', 'z', 'm', 'v']);
    const polys = flattenPath('M10 10 L20 10 L20 20 L10 20 Z');
    expect(polys).toHaveLength(1);
    expect(area(polys[0]!)).toBeCloseTo(100, 6);
    const rel = flattenPath('m10 10 l10 0 l0 10 l-10 0 z');
    expect(rel[0]).toEqual(polys[0]);
  });

  it('flattens arcs and curves within tolerance', () => {
    // A full circle from two half arcs: area → π r².
    const circle = flattenPath('M0 50 A50 50 0 1 0 100 50 A50 50 0 1 0 0 50 Z', { tolerance: 0.05 });
    expect(area(circle[0]!)).toBeGreaterThan(Math.PI * 2500 * 0.995);
    expect(area(circle[0]!)).toBeLessThanOrEqual(Math.PI * 2500);
    // Compact arc flags ("01") are read digit by digit.
    const compact = flattenPath('M0 50 a50 50 0 1050 0 a50 50 0 10-50 0z');
    expect(compact[0]!.length).toBeGreaterThan(20);
    // A quadratic and its smooth continuation stay inside their hull.
    const q = flattenPath('M0 0 Q50 100 100 0 T200 0 Z');
    for (let i = 1; i < q[0]!.length; i += 2) expect(q[0]![i]).toBeGreaterThanOrEqual(-50.01);
    // Scaling and offsets apply to every point.
    const scaled = flattenPath('M0 0 H10 V10 H0 Z', { scale: 2, offsetX: 5, offsetY: 1 });
    expect(scaled[0]!.slice(0, 4)).toEqual([5, 1, 25, 1]);
  });

  it('rejects malformed data', () => {
    expect(() => parsePath('10 10')).toThrow(PathSyntaxError);
    expect(() => parsePath('M10')).toThrow(PathSyntaxError);
    expect(() => parsePath('M10 10 X5')).toThrow(PathSyntaxError);
  });

  it('writes polygons back as path data', () => {
    expect(polygonsToPath([[0, 0, 10, 0, 10, 10]])).toBe('M0 0L10 0L10 10Z');
    expect(polygonsToPath([[0, 0, 1]])).toBe('');
  });
});

describe('sticker set', () => {
  it('has at least 24 uniquely named stickers', () => {
    expect(STICKERS.length).toBeGreaterThanOrEqual(24);
    expect(new Set(STICKERS.map((s) => s.id)).size).toBe(STICKERS.length);
    for (const id of ['star', 'heart', 'sparkle', 'check', 'cross', 'plus', 'bolt', 'crown', 'flame', 'drop', 'leaf', 'moon', 'sun', 'cloud', 'music', 'gear', 'arrow-right', 'speech', 'badge', 'ribbon', 'shield', 'trophy']) {
      expect(getSticker(id), id).toBeDefined();
    }
  });

  it.each(STICKERS.map((s) => [s.id, s] as const))('%s renders filled, inside its box, deterministically', (_id, def) => {
    const px = renderSticker(def, { size: 128 });
    const covered = alphaSum(px);
    // Visible and substantial: at least 12 % of its 102 px box.
    expect(covered).toBeGreaterThan(102 * 102 * 0.12);
    // The 80 % box keeps the art off the canvas edges.
    expect(edgeAlpha(px)).toBe(0);
    expect(renderSticker(def, { size: 128 }).data).toEqual(px.data);
  });

  it('recolours the main colour and keeps fixed details', () => {
    const heart = getSticker('heart')!;
    const red = renderSticker(heart, { size: 64 });
    const blue = renderSticker(heart, { size: 64, color: '#2255ff' });
    const centre = (p: Pixels) => Array.from(p.data.subarray((40 * 64 + 32) * 4, (40 * 64 + 32) * 4 + 4));
    expect(centre(red)[0]).toBeGreaterThan(200);
    expect(centre(blue)[2]).toBeGreaterThan(200);
    expect(alphaSum(blue)).toBeCloseTo(alphaSum(red), 3);
    // The smile's eyes are a fixed dark colour: box 51.2 px at offset 6.4 → eye centre ≈ (24, 26).
    const smile = getSticker('smile')!;
    const eye = (p: Pixels) => p.data[(26 * 64 + 24) * 4]!;
    expect(eye(renderSticker(smile, { size: 64 }))).toBeLessThan(80);
    expect(eye(renderSticker(smile, { size: 64, color: '#ff00ff' }))).toBeLessThan(80);
  });

  it('adds an outline around the whole sticker', () => {
    const star = getSticker('star')!;
    const plain = renderSticker(star, { size: 128 });
    const outlined = renderSticker(star, { size: 128, outline: { color: '#ffffff', width: 6 } });
    expect(alphaSum(outlined)).toBeGreaterThan(alphaSum(plain) * 1.15);
    // A pixel just outside the art is outline-white.
    let white = 0;
    for (let i = 0; i < outlined.data.length; i += 4) {
      if (plain.data[i + 3] === 0 && outlined.data[i + 3]! > 250 && outlined.data[i]! > 250 && outlined.data[i + 2]! > 250) white++;
    }
    expect(white).toBeGreaterThan(100);
  });

  it('places and sizes the art', () => {
    const plus = getSticker('plus')!;
    const px = renderSticker(plus, { size: 200, box: 50, cx: 50, cy: 150 });
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        const a = px.data[(y * 200 + x) * 4 + 3]!;
        sx += x * a;
        sy += y * a;
        n += a;
      }
    }
    expect(sx / n).toBeCloseTo(49.5, 0);
    expect(sy / n).toBeCloseTo(149.5, 0);
    expect(() => renderSticker(plus, { size: 0 })).toThrow(RangeError);
  });

  it('renders stamps cropped to the art, outline included', () => {
    const heart = getSticker('heart')!;
    const box = 120;
    for (const outline of [null, { color: '#ffffff', width: 8 }]) {
      const stamp = renderStickerStamp(heart, { box, color: '#2255ff', outline })!;
      // Cropped: every edge touches the art.
      expect(edgeAlpha(stamp)).toBeGreaterThan(0);
      // Same pixels as the full render, just without the empty margin.
      const full = renderSticker(heart, { size: 400, box, color: '#2255ff', outline });
      expect(alphaSum(stamp)).toBeCloseTo(alphaSum(full), 3);
      expect(stamp.width).toBeLessThanOrEqual(box * 1.25 + (outline ? 2 * outline.width : 0));
    }
    const plain = renderStickerStamp(heart, { box })!;
    const outlined = renderStickerStamp(heart, { box, outline: { color: '#ffffff', width: 8 } })!;
    expect(outlined.width).toBeGreaterThan(plain.width + 12);
  });

  it('derives shade and tint variants', () => {
    const v = stickerVariants('#7c5cff');
    expect(v.main).toBe('#7c5cff');
    const lum = (h: string) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
    expect(lum(v.shade)).toBeLessThan(lum(v.main));
    expect(lum(v.tint)).toBeGreaterThan(lum(v.main));
  });

  it('describes stickers as SVG elements for previews', () => {
    for (const def of STICKERS) {
      const els = stickerSvgElements(def, '#123456');
      expect(els.length).toBeGreaterThan(0);
      for (const el of els) {
        expect(el.d).toMatch(/^M[-\d.]+ [-\d.]+/);
        expect(el.color).toMatch(/^#|^[a-z]/);
      }
    }
    const check = stickerSvgElements(getSticker('check')!);
    expect(check[0]).toMatchObject({ kind: 'stroke', color: '#2fbf71', cap: 'round' });
    // Filled parts keep their own path data: exact curves, nothing flattened.
    const heart = getSticker('heart')!;
    const part = heart.layers[0]!.parts[0] as { d: string };
    expect(stickerSvgElements(heart)[0]).toMatchObject({ kind: 'fill', d: part.d });
  });

  it('searches labels and keywords', () => {
    expect(searchStickers('').length).toBe(STICKERS.length);
    expect(searchStickers('love').map((s) => s.id)).toContain('heart');
    expect(searchStickers('SETTINGS').map((s) => s.id)).toEqual(['gear']);
    expect(searchStickers('zzzz')).toEqual([]);
  });
});

describe('emoji', () => {
  it('lists common emoji with search words', () => {
    expect(EMOJI.length).toBeGreaterThan(100);
    expect(new Set(EMOJI.map((e) => e.char)).size).toBe(EMOJI.length);
    expect(searchEmoji('rocket').map((e) => e.char)).toContain('🚀');
    expect(searchEmoji('heart love').length).toBeGreaterThan(3);
    expect(searchEmoji('').length).toBe(EMOJI.length);
  });

  it('declines to render without a canvas (node)', () => {
    expect(canRenderEmoji()).toBe(false);
    expect(renderEmoji('🚀', { size: 64 })).toBeNull();
    expect(renderEmojiStamp('🚀', 64)).toBeNull();
  });
});
