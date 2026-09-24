import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import type { EngineEvent } from '../engine';
import { createDocument } from '../doc/document';
import type { RasterLayer } from '../doc/types';
import type { PointerInput } from '../input/pointer';
import { alphaSum, pixel, pointer } from '../test-helpers';
import { rectMask } from '../selection/mask';
import { Surface } from '../raster/surface';
import type { Rect } from '../util/rect';
import { unionRect } from '../util/rect';
import { sprayDotCount, spraySeed, defaultSprayOptions } from './spray';
import { stampMatrix, defaultStampOptions } from './stamp';
import { luminance01, setLuminance, toneRangeWeight } from '../raster/tone';
import { apply } from '../geometry/affine';

const RED = { r: 255, g: 0, b: 0, a: 1 };

function engine(pixelArt: 16 | 32 | 64 | null = null): Engine {
  return new Engine({ doc: createDocument({ pixelArt }), primary: RED });
}

function surfaceOf(e: Engine) {
  return (e.activeLayer as RasterLayer).surface;
}

function stroke(e: Engine, pts: [number, number][], extra: Partial<PointerInput> = {}): void {
  let t = 0;
  const p = (x: number, y: number) => pointer(x, y, { time: (t += 8), ...extra });
  e.pointerDown(p(...pts[0]));
  for (const q of pts.slice(1)) e.pointerMove(p(...q));
  e.pointerUp(p(...pts[pts.length - 1]));
}

/** Records the union of pixel events while `fn` runs. */
function dirtyDuring(e: Engine, fn: () => void): Rect | null {
  let r: Rect | null = null;
  const off = e.subscribe((ev: EngineEvent) => {
    if (ev.kind === 'pixels') r = unionRect(r, ev.rect);
  });
  fn();
  off();
  return r;
}

function lum(s: Surface, x: number, y: number): number {
  const [r, g, b] = s.getPixel(x, y);
  return luminance01(r / 255, g / 255, b / 255);
}

/** Variance of the luminance over a square. */
function variance(s: Surface, x0: number, y0: number, n: number): number {
  const v: number[] = [];
  for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) v.push(lum(s, x, y));
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
}

/** One stroke = one entry, and undo/redo are byte-exact. */
function expectExactUndo(e: Engine, label: string, before: Surface): void {
  expect(e.historyEntries.map((h) => h.label)).toEqual([label]);
  const after = surfaceOf(e).clone();
  expect(after.equals(before)).toBe(false);
  e.undo();
  expect(surfaceOf(e).equals(before)).toBe(true);
  e.redo();
  expect(surfaceOf(e).equals(after)).toBe(true);
}

function mirrored(s: Surface, tolerance = 0): boolean {
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width / 2; x++) {
      const a = s.getPixel(x, y);
      const b = s.getPixel(s.width - 1 - x, y);
      for (let c = 0; c < 4; c++) if (Math.abs(a[c] - b[c]) > tolerance) return false;
    }
  }
  return true;
}

describe('spray', () => {
  const path: [number, number][] = [[60, 60], [120, 90], [200, 100], [260, 180]];

  it('is deterministic for identical input and varies with the seed', () => {
    const run = (seed: number) => {
      const e = engine();
      e.setTool('spray');
      e.setToolOptions('spray', { seed });
      stroke(e, path);
      return surfaceOf(e).clone();
    };
    const a = run(1);
    expect(a.equals(run(1))).toBe(true);
    expect(a.equals(run(2))).toBe(false);
    expect(alphaSum(a)).toBeGreaterThan(0);
    // Dots stay within the spray radius of the path.
    expect(a.alphaBounds()!.x).toBeGreaterThanOrEqual(60 - 24 - 2);
    expect(spraySeed(1, 1, 10, 10)).not.toBe(spraySeed(1, 2, 10, 10));
  });

  it('successive strokes get different patterns', () => {
    const e = engine();
    e.setTool('spray');
    stroke(e, [[100, 100], [101, 100]]);
    const first = surfaceOf(e).clone();
    e.undo();
    stroke(e, [[100, 100], [101, 100]]);
    expect(surfaceOf(e).equals(first)).toBe(false);
  });

  it('density and pressure scale the paint', () => {
    const paint = (density: number, pressure = 1) => {
      const e = engine();
      e.setTool('spray');
      e.setToolOptions('spray', { density, flow: 0.5 });
      stroke(e, path, { pointerType: 'pen', pressure });
      return alphaSum(surfaceOf(e));
    };
    expect(paint(0.2)).toBeLessThan(paint(0.8));
    expect(paint(0.8, 0.25)).toBeLessThan(paint(0.8, 1));
    expect(paint(0)).toBe(0);
    const o = defaultSprayOptions();
    expect(sprayDotCount(o, 1)).toBeCloseTo(0.5 * 0.1 * 32 * 32, 6);
    expect(sprayDotCount({ ...o, pressureDensity: false }, 0.1)).toBe(sprayDotCount(o, 1));
  });

  it('caps the stroke at its opacity', () => {
    const e = engine();
    e.setTool('spray');
    e.setToolOptions('spray', { density: 1, dotSize: 6, flow: 1, opacity: 0.5 });
    const pts: [number, number][] = [];
    for (let i = 0; i < 40; i++) pts.push([100 + (i % 2) * 4, 100]);
    stroke(e, pts);
    let max = 0;
    const d = surfaceOf(e).data;
    for (let i = 3; i < d.length; i += 4) max = Math.max(max, d[i]);
    expect(max).toBe(128);
  });

  it('mirrors through symmetry, clips to the selection, one exact undo step', () => {
    const e = engine();
    e.setTool('spray');
    e.setSymmetry({ mode: 'x' });
    const before = surfaceOf(e).clone();
    stroke(e, path);
    const s = surfaceOf(e);
    expect(mirrored(s, 1)).toBe(true);
    // Both halves got paint (the copy is not just empty on both sides).
    let left = 0;
    for (let y = 0; y < 512; y++) for (let x = 0; x < 256; x++) left += s.getPixel(x, y)[3];
    expect(left).toBeGreaterThan(0);
    expect(alphaSum(s)).toBeCloseTo(2 * left, -3);
    expectExactUndo(e, 'Spray', before);

    const c = engine();
    c.setTool('spray');
    c.setSelection(rectMask(512, 512, { x: 0, y: 0, w: 100, h: 512 }));
    stroke(c, path);
    expect(surfaceOf(c).alphaBounds()!.x + surfaceOf(c).alphaBounds()!.w).toBeLessThanOrEqual(100);
  });

  it('right button sprays the secondary colour', () => {
    const e = engine();
    e.setColor('secondary', { r: 0, g: 0, b: 255, a: 1 });
    e.setTool('spray');
    e.setToolOptions('spray', { density: 1, dotSize: 4, flow: 1 });
    stroke(e, [[100, 100], [110, 100]], { button: 2 });
    const d = surfaceOf(e).data;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) expect([d[i], d[i + 1], d[i + 2]]).toEqual([0, 0, 255]);
  });
});

describe('smudge', () => {
  function halves(): Engine {
    const e = engine(64);
    const s = surfaceOf(e);
    s.fill(255, 0, 0, 255, { x: 0, y: 0, w: 32, h: 64 });
    s.fill(0, 0, 255, 255, { x: 32, y: 0, w: 32, h: 64 });
    e.setTool('smudge');
    e.setToolOptions('smudge', { size: 8, hardness: 1, strength: 0.8, spacing: 0.1 });
    return e;
  }

  it('drags colour along the stroke', () => {
    const e = halves();
    const before = surfaceOf(e).clone();
    const pts: [number, number][] = [];
    for (let x = 24; x <= 44; x += 1) pts.push([x + 0.5, 32.5]);
    stroke(e, pts);
    const s = surfaceOf(e);
    // Red has been pushed into the blue half…
    expect(pixel(s, 38, 32)[0]).toBeGreaterThan(60);
    // …and fades out along the stroke.
    expect(pixel(s, 34, 32)[0]).toBeGreaterThan(pixel(s, 43, 32)[0]);
    // Away from the stroke nothing changed.
    expect(pixel(s, 38, 10)).toEqual([0, 0, 255, 255]);
    expectExactUndo(e, 'Smudge', before);
  });

  it('mixes in premultiplied space: colour smudged into transparency keeps its hue', () => {
    const e = engine(64);
    surfaceOf(e).fill(255, 0, 0, 255, { x: 0, y: 0, w: 32, h: 64 });
    e.setTool('smudge');
    e.setToolOptions('smudge', { size: 10, hardness: 1, strength: 0.9 });
    const pts: [number, number][] = [];
    for (let x = 26; x <= 46; x += 1) pts.push([x + 0.5, 32.5]);
    stroke(e, pts);
    const s = surfaceOf(e);
    let seen = 0;
    for (let x = 32; x < 50; x++) {
      const [r, g, b, a] = pixel(s, x, 32);
      if (a === 0) continue;
      seen++;
      expect([r, g, b]).toEqual([255, 0, 0]);
    }
    expect(seen).toBeGreaterThan(5);
    // Transparency smudged into the red fades alpha, not colour.
    const back = engine(64);
    surfaceOf(back).fill(255, 0, 0, 255, { x: 0, y: 0, w: 32, h: 64 });
    back.setTool('smudge');
    back.setToolOptions('smudge', { size: 10, hardness: 1, strength: 0.9 });
    const rev: [number, number][] = [];
    for (let x = 40; x >= 22; x -= 1) rev.push([x + 0.5, 32.5]);
    stroke(back, rev);
    let faded = 0;
    for (let x = 0; x < 32; x++) {
      const [r, g, b, a] = pixel(surfaceOf(back), x, 32);
      if (a === 0 || a === 255) continue;
      faded++;
      expect([r, g, b]).toEqual([255, 0, 0]);
    }
    expect(faded).toBeGreaterThan(3);
  });

  it('strength 0 changes nothing; the first dab only picks up', () => {
    const e = halves();
    e.setToolOptions('smudge', { strength: 0 });
    const before = surfaceOf(e).clone();
    stroke(e, [[28.5, 32.5], [40.5, 32.5]]);
    expect(surfaceOf(e).equals(before)).toBe(true);
    expect(e.history.length).toBe(0);
    e.setToolOptions('smudge', { strength: 1 });
    stroke(e, [[28.5, 32.5]]);
    expect(surfaceOf(e).equals(before)).toBe(true);
  });

  it('respects the selection and only touches the stroke footprint', () => {
    const e = engine();
    const s = surfaceOf(e);
    s.fill(255, 0, 0, 255, { x: 0, y: 0, w: 256, h: 512 });
    s.fill(0, 0, 255, 255, { x: 256, y: 0, w: 256, h: 512 });
    e.setSelection(rectMask(512, 512, { x: 0, y: 0, w: 512, h: 250 }));
    e.setTool('smudge');
    e.setToolOptions('smudge', { size: 20, strength: 1 });
    const pts: [number, number][] = [];
    for (let x = 240; x <= 280; x += 2) pts.push([x, 250]);
    const dirty = dirtyDuring(e, () => stroke(e, pts));
    expect(dirty!.x).toBeGreaterThanOrEqual(240 - 13);
    expect(dirty!.x + dirty!.w).toBeLessThanOrEqual(280 + 13);
    expect(dirty!.y).toBeGreaterThanOrEqual(250 - 13);
    expect(dirty!.y + dirty!.h).toBeLessThanOrEqual(250 + 13);
    expect(pixel(s, 262, 252)).toEqual([0, 0, 255, 255]); // below the selection
    expect(pixel(s, 262, 247)[0]).toBeGreaterThan(0);
  });
});

describe('blur / sharpen', () => {
  function checker(): Engine {
    const e = engine(64);
    const s = surfaceOf(e);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const v = ((x >> 1) + (y >> 1)) % 2 ? 230 : 30;
      s.setPixel(x, y, v, v, v, 255);
    }
    e.setTool('blurSharpen');
    e.setToolOptions('blurSharpen', { size: 20, hardness: 1, strength: 1 });
    return e;
  }

  it('blur lowers local variance, one exact undo step', () => {
    const e = checker();
    const before = surfaceOf(e).clone();
    const v0 = variance(surfaceOf(e), 26, 26, 12);
    stroke(e, [[24, 32], [40, 32]]);
    expect(variance(surfaceOf(e), 26, 26, 12)).toBeLessThan(v0 * 0.5);
    // Far away the checkerboard is intact.
    expect(variance(surfaceOf(e), 0, 0, 8)).toBeCloseTo(variance(before, 0, 0, 8), 9);
    expectExactUndo(e, 'Blur', before);
  });

  it('sharpen raises local variance of a soft edge', () => {
    const e = engine(64);
    const s = surfaceOf(e);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const v = Math.round(255 / (1 + Math.exp(-(x - 32) / 3)));
      s.setPixel(x, y, v, v, v, 255);
    }
    e.setTool('blurSharpen');
    e.setToolOptions('blurSharpen', { mode: 'sharpen', size: 24, hardness: 1, strength: 1 });
    const before = s.clone();
    const v0 = variance(s, 24, 24, 16);
    stroke(e, [[32, 20], [32, 44]]);
    expect(variance(surfaceOf(e), 24, 24, 16)).toBeGreaterThan(v0 * 1.05);
    // The dark side gets darker and the light side lighter.
    expect(lum(surfaceOf(e), 29, 32)).toBeLessThan(lum(before, 29, 32));
    expect(lum(surfaceOf(e), 35, 32)).toBeGreaterThan(lum(before, 35, 32));
    expectExactUndo(e, 'Sharpen', before);
  });

  it('sharpening a silhouette neither brightens its edge nor changes its alpha', () => {
    const e = engine(64);
    const s = surfaceOf(e);
    s.fill(128, 128, 128, 255, { x: 0, y: 0, w: 32, h: 64 });
    s.fill(128, 128, 128, 100, { x: 32, y: 0, w: 2, h: 64 });
    e.setTool('blurSharpen');
    e.setToolOptions('blurSharpen', { mode: 'sharpen', size: 16, hardness: 1, strength: 1 });
    const before = s.clone();
    stroke(e, [[32, 20], [32, 44]]);
    // Transparent neighbours do not count as black: a flat colour stays flat.
    for (const x of [29, 30, 31, 32, 33]) expect(pixel(s, x, 32), `x=${x}`).toEqual(pixel(before, x, 32));
    expect(pixel(s, 36, 32)).toEqual([0, 0, 0, 0]);
    expect(e.history.length).toBe(0);
  });

  it('blurring a transparent edge does not darken it (premultiplied)', () => {
    const e = engine(64);
    surfaceOf(e).fill(255, 255, 0, 255, { x: 0, y: 0, w: 32, h: 64 });
    e.setTool('blurSharpen');
    e.setToolOptions('blurSharpen', { size: 16, strength: 1, blurRadius: 3 });
    stroke(e, [[32, 20], [32, 44]]);
    const [r, g, b, a] = pixel(surfaceOf(e), 33, 32);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
    expect([r, g, b]).toEqual([255, 255, 0]);
  });

  it('processes only the dabs of the stroke on a 512 document and clips to the selection', () => {
    const e = engine();
    const s = surfaceOf(e);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) s.setPixel(x, y, (x * 7) & 255, (y * 5) & 255, 90, 255);
    e.setSelection(rectMask(512, 512, { x: 0, y: 0, w: 256, h: 512 }));
    e.setTool('blurSharpen');
    e.setToolOptions('blurSharpen', { size: 16, strength: 1 });
    const before = s.clone();
    const dirty = dirtyDuring(e, () => stroke(e, [[240, 100], [270, 100]]));
    expect(dirty!.x).toBeGreaterThanOrEqual(240 - 10);
    expect(dirty!.x + dirty!.w).toBeLessThanOrEqual(270 + 10);
    expect(dirty!.h).toBeLessThanOrEqual(20);
    // The top entry stores only the tiles under the stroke.
    expect(e.historyEntries[1].bytes).toBeLessThan(4 * 64 * 64 * 4 + 1024);
    for (let x = 256; x < 280; x++) expect(pixel(s, x, 100)).toEqual(pixel(before, x, 100));
    expect(pixel(s, 250, 100)).not.toEqual(pixel(before, 250, 100));
  });
});

describe('dodge / burn', () => {
  function grey(v: number): Engine {
    const e = engine(16);
    surfaceOf(e).fill(v, v, v, 255);
    e.setTool('dodgeBurn');
    e.setToolOptions('dodgeBurn', { size: 40, hardness: 1, exposure: 0.5 });
    return e;
  }

  it('dodge brightens and burn darkens, one exact step each', () => {
    const d = grey(128);
    const before = surfaceOf(d).clone();
    stroke(d, [[8, 8], [9, 8]]);
    expect(pixel(surfaceOf(d), 8, 8)[0]).toBeGreaterThan(128);
    expectExactUndo(d, 'Dodge', before);
    const b = grey(128);
    b.setToolOptions('dodgeBurn', { mode: 'burn' });
    stroke(b, [[8, 8], [9, 8]]);
    expect(pixel(surfaceOf(b), 8, 8)[0]).toBeLessThan(128);
    expect(b.historyEntries.map((h) => h.label)).toEqual(['Burn']);
    // Midtones at 50 % exposure: L' = L + 0.5·(4L(1 − L))·(1 − L).
    const l = 128 / 255;
    const expected = (l + 0.5 * 4 * l * (1 - l) * (1 - l)) * 255;
    expect(pixel(surfaceOf(d), 8, 8)[0]).toBeCloseTo(expected, -0.5);
  });

  it('weights tones by range', () => {
    const delta = (range: 'shadows' | 'midtones' | 'highlights', v: number) => {
      const e = grey(v);
      e.setToolOptions('dodgeBurn', { range, mode: range === 'highlights' ? 'burn' : 'dodge' });
      stroke(e, [[8, 8], [9, 8]]);
      return Math.abs(pixel(surfaceOf(e), 8, 8)[0] - v);
    };
    expect(delta('shadows', 40)).toBeGreaterThan(delta('shadows', 200));
    expect(delta('highlights', 220)).toBeGreaterThan(delta('highlights', 60));
    expect(delta('midtones', 128)).toBeGreaterThan(delta('midtones', 20));
    expect(toneRangeWeight('shadows', 0)).toBe(1);
    expect(toneRangeWeight('midtones', 0.5)).toBe(1);
    expect(toneRangeWeight('highlights', 1)).toBe(1);
  });

  it('changes luminance only: hue and alpha are kept', () => {
    const e = engine(16);
    surfaceOf(e).fill(200, 80, 40, 180);
    e.setTool('dodgeBurn');
    e.setToolOptions('dodgeBurn', { size: 40, exposure: 0.6, mode: 'burn', range: 'highlights' });
    stroke(e, [[8, 8], [9, 8]]);
    const [r, g, b, a] = pixel(surfaceOf(e), 8, 8);
    expect(a).toBe(180);
    expect(r).toBeLessThan(200);
    // Burning subtracts the same amount from every channel (SetLum): the
    // channel differences, and so the hue, are kept.
    expect(r - g).toBeGreaterThanOrEqual(119);
    expect(r - g).toBeLessThanOrEqual(121);
    expect(g - b).toBeGreaterThanOrEqual(39);
    expect(g - b).toBeLessThanOrEqual(41);
    const rgb = [0.9, 0.2, 0.1];
    setLuminance(rgb, 0.8);
    expect(luminance01(rgb[0], rgb[1], rgb[2])).toBeCloseTo(0.8, 9);
    expect(Math.max(...rgb)).toBeLessThanOrEqual(1);
  });

  it('one stroke never exceeds its exposure, however often it passes', () => {
    const once = grey(100);
    stroke(once, [[8, 8], [9, 8]]);
    const scrub = grey(100);
    const pts: [number, number][] = [];
    for (let i = 0; i < 30; i++) pts.push([i % 2 ? 4 : 12, 8]);
    stroke(scrub, pts);
    expect(pixel(surfaceOf(scrub), 8, 8)).toEqual(pixel(surfaceOf(once), 8, 8));
  });

  it('clips to the selection and leaves transparent pixels alone', () => {
    const e = grey(128);
    surfaceOf(e).clear({ x: 0, y: 0, w: 4, h: 16 });
    e.setSelection(rectMask(16, 16, { x: 0, y: 0, w: 8, h: 16 }));
    stroke(e, [[8, 8], [9, 8]]);
    const s = surfaceOf(e);
    expect(pixel(s, 6, 8)[0]).toBeGreaterThan(128);
    expect(pixel(s, 10, 8)).toEqual([128, 128, 128, 255]);
    expect(pixel(s, 2, 8)).toEqual([0, 0, 0, 0]);
  });
});

describe('sticker stamp', () => {
  function sticker(): Surface {
    const s = new Surface(5, 3);
    s.fill(0, 200, 0, 255);
    s.setPixel(0, 0, 255, 0, 0, 255); // marks the top-left corner
    return s;
  }

  it('stamps centred and pixel-exact on click, one exact undo step', () => {
    const e = engine(64);
    e.setTool('stamp');
    e.setToolOptions('stamp', { stamp: sticker() });
    const before = surfaceOf(e).clone();
    e.pointerDown(pointer(20.5, 20.5));
    e.pointerUp(pointer(20.5, 20.5));
    const s = surfaceOf(e);
    expect(s.alphaBounds()).toEqual({ x: 18, y: 19, w: 5, h: 3 });
    expect(pixel(s, 18, 19)).toEqual([255, 0, 0, 255]);
    expect(pixel(s, 22, 21)).toEqual([0, 200, 0, 255]);
    expectExactUndo(e, 'Stamp', before);
  });

  it('a drag previews live and stamps once where it is released', () => {
    const e = engine(64);
    e.setTool('stamp');
    e.setToolOptions('stamp', { stamp: sticker() });
    e.pointerDown(pointer(10.5, 10.5));
    expect(surfaceOf(e).alphaBounds()).toEqual({ x: 8, y: 9, w: 5, h: 3 });
    e.pointerMove(pointer(30.5, 20.5));
    expect(surfaceOf(e).alphaBounds()).toEqual({ x: 28, y: 19, w: 5, h: 3 });
    e.pointerMove(pointer(40.5, 40.5));
    e.pointerUp(pointer(40.5, 40.5));
    expect(surfaceOf(e).alphaBounds()).toEqual({ x: 38, y: 39, w: 5, h: 3 });
    expect(alphaSum(surfaceOf(e))).toBe(15 * 255);
    expect(e.history.length).toBe(1);
    // Escape during a drag leaves nothing behind.
    e.pointerDown(pointer(10.5, 10.5));
    e.keyDown('Escape', { shift: false, alt: false, ctrl: false, meta: false });
    expect(alphaSum(surfaceOf(e))).toBe(15 * 255);
    expect(e.history.length).toBe(1);
  });

  it('scales, rotates and fades', () => {
    const e = engine(64);
    e.setTool('stamp');
    e.setToolOptions('stamp', { stamp: sticker(), scale: 2, rotation: 90, opacity: 0.5 });
    e.pointerDown(pointer(32, 32));
    e.pointerUp(pointer(32, 32));
    const s = surfaceOf(e);
    expect(s.alphaBounds()).toEqual({ x: 29, y: 27, w: 6, h: 10 });
    // Rotated 90° clockwise: the red top-left corner is now top-right.
    expect(pixel(s, 34, 27)).toEqual([255, 0, 0, 128]);
    const m = stampMatrix({ width: 5, height: 3 }, { ...defaultStampOptions(), rotation: 90 }, 32, 32);
    expect(apply(m, 0, 0)).toEqual({ x: 34, y: 30 });
  });

  it('stamps mirrored copies with symmetry and respects the selection', () => {
    const e = engine(64);
    e.setTool('stamp');
    e.setToolOptions('stamp', { stamp: sticker() });
    e.setSymmetry({ mode: 'x' });
    e.pointerDown(pointer(10.5, 10.5));
    e.pointerUp(pointer(10.5, 10.5));
    const s = surfaceOf(e);
    expect(mirrored(s)).toBe(true);
    expect(pixel(s, 63 - 8, 9)).toEqual([255, 0, 0, 255]); // mirror image: marker on the right
    expect(alphaSum(s)).toBe(2 * 15 * 255);

    const c = engine(64);
    c.setTool('stamp');
    c.setToolOptions('stamp', { stamp: sticker() });
    c.setSelection(rectMask(64, 64, { x: 0, y: 0, w: 10, h: 64 }));
    c.pointerDown(pointer(10.5, 10.5));
    c.pointerUp(pointer(10.5, 10.5));
    expect(surfaceOf(c).alphaBounds()).toEqual({ x: 8, y: 9, w: 2, h: 3 });
  });

  it('asks for a sticker when none is chosen', () => {
    const e = engine(16);
    const messages: string[] = [];
    e.subscribe((ev) => ev.kind === 'message' && messages.push(ev.text));
    e.setTool('stamp');
    expect(e.cursor.css).toBe('not-allowed');
    e.pointerDown(pointer(5, 5));
    e.pointerUp(pointer(5, 5));
    expect(messages).toHaveLength(1);
    expect(e.history.length).toBe(0);
  });
});

describe('dab tools share the painting rules', () => {
  const PAINTERS = ['spray', 'smudge', 'blurSharpen', 'dodgeBurn', 'stamp'] as const;

  /** A busy picture every tool visibly changes, small footprints. */
  function textured(): Engine {
    const e = engine(64);
    const s = surfaceOf(e);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) s.setPixel(x, y, (x * 37) & 255, (y * 23) & 255, 120, 255);
    const sticker = new Surface(6, 6);
    sticker.fill(255, 255, 255, 255);
    e.setToolOptions('stamp', { stamp: sticker });
    e.setToolOptions('spray', { radius: 4, density: 1, dotSize: 2 });
    e.setToolOptions('smudge', { size: 8, strength: 0.9 });
    e.setToolOptions('blurSharpen', { size: 8, strength: 1 });
    e.setToolOptions('dodgeBurn', { size: 8 });
    return e;
  }

  it('refuse hidden and text layers with a message and no entry', () => {
    for (const tool of PAINTERS) {
      const e = textured();
      const messages: string[] = [];
      e.subscribe((ev) => ev.kind === 'message' && messages.push(ev.text));
      e.setLayerProps(e.doc.activeLayerId!, { visible: false });
      e.setTool(tool);
      stroke(e, [[20, 20], [40, 30]]);
      expect(messages, tool).toHaveLength(1);
      expect(e.history.length, tool).toBe(1);
      e.addTextLayer({ text: 'Hi' });
      stroke(e, [[20, 20], [40, 30]]);
      expect(messages, tool).toHaveLength(2);
      expect(e.history.length, tool).toBe(2);
    }
  });

  it('Escape mid-stroke restores the layer and records nothing', () => {
    for (const tool of PAINTERS) {
      const e = textured();
      e.setTool(tool);
      const before = surfaceOf(e).clone();
      e.pointerDown(pointer(20, 20, { time: 1 }));
      for (let i = 1; i <= 10; i++) e.pointerMove(pointer(20 + i * 2, 20 + i, { time: 1 + i }));
      expect(surfaceOf(e).equals(before), tool).toBe(false);
      expect(e.keyDown('Escape', { shift: false, alt: false, ctrl: false, meta: false })).toBe(true);
      expect(surfaceOf(e).equals(before), tool).toBe(true);
      expect(e.history.length, tool).toBe(0);
    }
  });

  it('a stroke entirely outside the selection changes nothing and records nothing', () => {
    for (const tool of PAINTERS) {
      const e = textured();
      e.setSelection(rectMask(64, 64, { x: 50, y: 50, w: 14, h: 14 }));
      e.setTool(tool);
      const before = surfaceOf(e).clone();
      stroke(e, [[10, 10], [20, 14]]);
      expect(surfaceOf(e).equals(before), tool).toBe(true);
      expect(e.history.length, tool).toBe(1); // just the selection
    }
  });

  it('smudge, blur and dodge mirror through symmetry', () => {
    for (const tool of ['smudge', 'blurSharpen', 'dodgeBurn'] as const) {
      const e = engine(64);
      const s = surfaceOf(e);
      // A left/right symmetric picture.
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 32; x++) {
          const v = ((x >> 2) + (y >> 2)) % 2 ? 220 : 40;
          s.setPixel(x, y, v, 255 - v, 90, 255);
          s.setPixel(63 - x, y, v, 255 - v, 90, 255);
        }
      }
      e.setSymmetry({ mode: 'x' });
      e.setTool(tool);
      e.setToolOptions('smudge', { size: 12, strength: 0.8 });
      e.setToolOptions('blurSharpen', { size: 12, strength: 0.8 });
      e.setToolOptions('dodgeBurn', { size: 12 });
      const before = s.clone();
      stroke(e, [[10.3, 20.6], [18.2, 26.1], [25.7, 30.4]]);
      expect(s.equals(before), tool).toBe(false);
      expect(mirrored(s, 1), tool).toBe(true);
      expect(e.historyEntries, tool).toHaveLength(1);
    }
  });

  it('refuse locked layers and paint pixel-art with whole-pixel footprints', () => {
    for (const tool of ['spray', 'smudge', 'blurSharpen', 'dodgeBurn'] as const) {
      const e = engine(16);
      surfaceOf(e).fill(120, 120, 120, 255, { x: 0, y: 0, w: 8, h: 16 });
      e.setLayerProps(e.doc.activeLayerId!, { locked: true });
      e.setTool(tool);
      stroke(e, [[6, 6], [10, 8]]);
      expect(e.history.length, tool).toBe(1);
      expect(e.cursor.radius, tool).toBeGreaterThan(0);
    }
    const e = engine(16);
    e.setTool('spray');
    e.setToolOptions('spray', { density: 1, dotSize: 2 });
    stroke(e, [[8, 8], [9, 8]]);
    const d = surfaceOf(e).data;
    for (let i = 3; i < d.length; i += 4) expect(d[i] === 0 || d[i] >= 200).toBe(true);
  });
});
