import { describe, expect, it } from 'vitest';
import { makeMask, pixelAt } from '../filters/test-utils';
import { solidPixels } from '../filters/types';
import { addBadge, badgeLayout } from './badge';
import { createCanvasTextRasterizer } from './canvas-text';
import { BITMAP_FONT_CHARS, bitmapTextRasterizer, type TextRasterizer } from './text';

const base = () => solidPixels(100, 100, 30, 60, 90);

describe('bitmap text rasterizer', () => {
  it('renders the 5×7 glyphs at one pixel per cell exactly', () => {
    const t = bitmapTextRasterizer.rasterize('1', 7);
    expect(t.width).toBe(5);
    expect(t.height).toBe(7);
    const rows: string[] = [];
    for (let y = 0; y < 7; y++) rows.push([...t.coverage.subarray(y * 5, y * 5 + 5)].map((v) => (v === 255 ? '1' : v === 0 ? '0' : '?')).join(''));
    expect(rows).toEqual(['00100', '01100', '00100', '00100', '00100', '00100', '01110']);
  });

  it('lays out multiple characters with one-cell gaps and scales with anti-aliasing', () => {
    expect(bitmapTextRasterizer.rasterize('12', 7).width).toBe(11);
    const big = bitmapTextRasterizer.rasterize('8', 10.5);
    expect(big.height).toBe(11);
    expect([...big.coverage].some((v) => v > 0 && v < 255)).toBe(true);
    expect(bitmapTextRasterizer.rasterize('a', 7).coverage).toEqual(bitmapTextRasterizer.rasterize('A', 7).coverage);
    expect(bitmapTextRasterizer.rasterize('~', 7).coverage).toEqual(bitmapTextRasterizer.rasterize('?', 7).coverage);
    expect(BITMAP_FONT_CHARS).toContain('Z');
  });

  it('canvas rasterizer is unavailable in node', () => {
    expect(createCanvasTextRasterizer()).toBeNull();
  });
});

describe('addBadge', () => {
  it('draws a filled circle in the chosen corner and leaves the rest', () => {
    const out = addBadge(base(), { color: '#00ff00', size: 0.3, margin: 0, ring: 0 });
    const L = badgeLayout(100, 100, { size: 0.3, margin: 0, ring: 0 });
    expect(L).toMatchObject({ x: 70, y: 70, width: 30, height: 30 });
    expect(pixelAt(out, 85, 85)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(out, 99, 99)).toEqual([30, 60, 90, 255]); // outside the circle, in the corner
    expect(pixelAt(out, 20, 20)).toEqual([30, 60, 90, 255]);
    const tl = addBadge(base(), { color: '#00ff00', position: 'tl', size: 0.3, margin: 0, ring: 0 });
    expect(pixelAt(tl, 15, 15)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(tl, 85, 85)).toEqual([30, 60, 90, 255]);
  });

  it('adds a ring around the badge', () => {
    const out = addBadge(base(), { color: '#ff0000', ringColor: '#0000ff', size: 0.3, ring: 0.2, margin: 0 });
    const L = badgeLayout(100, 100, { size: 0.3, ring: 0.2, margin: 0 });
    const cy = Math.floor(L.y + L.height / 2);
    expect(pixelAt(out, Math.floor(L.x + L.width / 2), cy)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(out, Math.floor(L.x - L.ring / 2), cy)).toEqual([0, 0, 255, 255]);
  });

  it('draws a label in a contrasting colour, widening to a pill for longer text', () => {
    const one = addBadge(base(), { text: '7', color: '#e81123', size: 0.4 });
    const L1 = badgeLayout(100, 100, { text: '7', size: 0.4 });
    const t = L1.text!;
    let white = 0;
    for (let y = 0; y < t.height; y++) {
      for (let x = 0; x < t.width; x++) {
        if (t.coverage[y * t.width + x] === 255) {
          expect(pixelAt(one, L1.textX + x, L1.textY + y)).toEqual([255, 255, 255, 255]);
          white++;
        }
      }
    }
    expect(white).toBeGreaterThan(20);
    const onYellow = addBadge(base(), { text: '7', color: '#ffff00', size: 0.4 });
    expect(pixelAt(onYellow, L1.textX + 1, L1.textY + 1)).toEqual([0, 0, 0, 255]); // top bar of the 7
    const L3 = badgeLayout(100, 100, { text: '999', size: 0.4 });
    expect(L3.width).toBeGreaterThan(L1.width);
    expect(badgeLayout(100, 100, { text: '12345', size: 0.4 }).text!.width).toBe(L3.text!.width);
  });

  it('uses an injected rasterizer', () => {
    const calls: [string, number][] = [];
    const fake: TextRasterizer = {
      rasterize(text, cap) {
        calls.push([text, cap]);
        return { width: 4, height: 4, coverage: new Uint8Array(16).fill(255) };
      },
    };
    const out = addBadge(base(), { text: 'NEW!', rasterizer: fake, textColor: '#123456', size: 0.4 });
    expect(calls[0][0]).toBe('NEW');
    expect(calls[0][1]).toBeCloseTo(20);
    const L = badgeLayout(100, 100, { text: 'NEW', rasterizer: fake, size: 0.4 });
    expect(pixelAt(out, L.textX + 2, L.textY + 2)).toEqual([0x12, 0x34, 0x56, 255]);
  });

  it('respects the selection mask and transparent images', () => {
    const src = base();
    expect(addBadge(src, { color: '#00ff00' }, makeMask(100, 100, () => 0)).data).toEqual(src.data);
    const clear = addBadge(solidPixels(40, 40, 0, 0, 0, 0), { color: '#ff0000', size: 0.5, ring: 0 });
    const L = badgeLayout(40, 40, { size: 0.5, ring: 0 });
    expect(pixelAt(clear, Math.floor(L.x + L.width / 2), Math.floor(L.y + L.height / 2))).toEqual([255, 0, 0, 255]);
    expect(pixelAt(clear, 2, 2)[3]).toBe(0);
  });
});
