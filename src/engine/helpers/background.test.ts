import { describe, expect, it } from 'vitest';
import { makeMask, makePixels, pixelAt, type Px } from '../filters/test-utils';
import { detectBackground, removeBackground } from './background';

const C = 20; // centre of the 40×40 fixture

/**
 * White background, a black ring (radius 8..14, anti-aliased by 4×4
 * supersampling) and inside it a white disc — the same colour as the
 * background, but not connected to the border.
 */
function icon(): ReturnType<typeof makePixels> {
  return makePixels(40, 40, (x, y) => {
    let ink = 0;
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const d = Math.hypot(x + (sx + 0.5) / 4 - C, y + (sy + 0.5) / 4 - C);
        if (d >= 8 && d <= 14) ink++;
      }
    }
    const v = Math.round(255 * (1 - ink / 16));
    return [v, v, v, 255];
  });
}

const ringDist = (x: number, y: number) => Math.hypot(x + 0.5 - C, y + 0.5 - C);

describe('removeBackground', () => {
  it('clears the border-connected background but keeps the same-coloured interior', () => {
    const out = removeBackground(icon(), { tolerance: 12, feather: 0 });
    for (const [x, y] of [
      [0, 0],
      [39, 0],
      [0, 39],
      [39, 39],
      [20, 2],
    ]) {
      expect(pixelAt(out, x, y)[3]).toBe(0);
    }
    expect(pixelAt(out, C, C)).toEqual([255, 255, 255, 255]); // interior white disc survives
    expect(pixelAt(out, C + 3, C)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(out, C + 10, C)).toEqual([0, 0, 0, 255]); // ring
    expect(pixelAt(out, C, C - 11)).toEqual([0, 0, 0, 255]);
  });

  it('anti-aliases and decontaminates the outer edge', () => {
    const src = icon();
    const out = removeBackground(src, { tolerance: 12, feather: 0 });
    let partial = 0;
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        const d = ringDist(x, y);
        if (d < 13.2 || d > 15) continue;
        const [r, g, b, a] = pixelAt(out, x, y);
        const [sr] = pixelAt(src, x, y);
        if (a > 0 && a < 255) {
          partial++;
          // the white background mixed into the grey edge pixel is removed: the ink is black
          expect(r).toBeLessThan(40);
          expect(g).toBe(r);
          expect(b).toBe(r);
          // alpha tracks ink coverage (source grey = 255·(1 − coverage))
          expect(Math.abs(a - (255 - sr))).toBeLessThanOrEqual(3);
        }
      }
    }
    expect(partial).toBeGreaterThan(20);
  });

  it('feathers inwards without touching deeper pixels', () => {
    const hard = removeBackground(icon(), { feather: 0 });
    const soft = removeBackground(icon(), { feather: 3 });
    // A ring pixel ~1.5 px inside the outer edge fades; one 5 px in does not.
    expect(pixelAt(soft, C + 12, C)[3]).toBeLessThan(pixelAt(hard, C + 12, C)[3]);
    expect(pixelAt(soft, C + 9, C)[3]).toBe(255);
    expect(pixelAt(soft, C, C)[3]).toBe(255);
  });

  it('tolerates noisy backgrounds within tolerance', () => {
    const noisy = makePixels(20, 20, (x, y): Px => {
      if (x >= 6 && x < 14 && y >= 6 && y < 14) return [200, 30, 30, 255];
      const n = ((x * 7 + y * 13) % 11) - 5;
      return [250 + n, 250 - n, 250 + n, 255];
    });
    const out = removeBackground(noisy, { tolerance: 8, feather: 0 });
    expect(pixelAt(out, 0, 0)[3]).toBe(0);
    expect(pixelAt(out, 3, 17)[3]).toBe(0);
    expect(pixelAt(out, 10, 10)).toEqual([200, 30, 30, 255]);
    expect(removeBackground(noisy, { tolerance: 0 }).data).not.toEqual(out.data);
  });

  it('does not erode an icon whose background is already transparent (default feather)', () => {
    // Anti-aliased disc on transparency: nothing to cut, so nothing may change.
    const disc = makePixels(40, 40, (x, y): Px => {
      let c = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (Math.hypot(x + (sx + 0.5) / 4 - C, y + (sy + 0.5) / 4 - C) < 12) c++;
      return c ? [200, 40, 40, Math.round((255 * c) / 16)] : [0, 0, 0, 0];
    });
    expect(removeBackground(disc).data).toEqual(disc.data);
    expect(removeBackground(disc, { feather: 5 }).data).toEqual(disc.data);
    // Cutting an opaque background twice: the second pass only clears the faintest edge
    // pixels (alpha within the 12 % tolerance of the now transparent background).
    const once = removeBackground(icon());
    const twice = removeBackground(once);
    let cleared = 0;
    for (let i = 0; i < once.data.length; i += 4) {
      const same = [0, 1, 2, 3].every((c) => twice.data[i + c] === once.data[i + c]);
      if (!same) {
        expect(once.data[i + 3]).toBeLessThanOrEqual(0.12 * 255);
        expect(twice.data[i + 3]).toBe(0);
        cleared++;
      }
    }
    expect(cleared).toBeLessThan(20);
  });

  it('leaves already-transparent icons and unselected pixels alone', () => {
    const cut = removeBackground(icon(), { feather: 0 });
    const again = removeBackground(cut, { feather: 0 });
    for (let i = 3; i < cut.data.length; i += 4) expect(again.data[i]).toBe(cut.data[i]);
    const src = icon();
    expect(removeBackground(src, {}, makeMask(40, 40, () => 0)).data).toEqual(src.data);
    const left = removeBackground(src, {}, makeMask(40, 40, (x) => (x < 20 ? 255 : 0)));
    expect(pixelAt(left, 0, 0)[3]).toBe(0);
    expect(pixelAt(left, 39, 0)[3]).toBe(255);
  });
});

describe('detectBackground', () => {
  it('reports the border colour and the connected region', () => {
    const det = detectBackground(icon());
    expect(det.color).toEqual([255, 255, 255, 255]);
    expect(det.region[0]).toBe(1);
    expect(det.region[C * 40 + C]).toBe(0);
    let outside = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if (ringDist(x, y) > 15) outside++;
    expect(det.count).toBeGreaterThanOrEqual(outside);
    expect(det.count).toBeLessThan(outside + 120);
  });

  it('handles tiny images', () => {
    expect(detectBackground(makePixels(1, 1, () => [1, 2, 3, 255])).count).toBe(1);
    expect(detectBackground(makePixels(0, 0, () => [0, 0, 0, 0])).count).toBe(0);
  });
});
