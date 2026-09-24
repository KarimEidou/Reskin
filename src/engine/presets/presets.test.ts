import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import { renderBackdrop } from '../backdrop/render';
import { createPixels, type Pixels } from '../filters/types';
import { Surface } from '../raster/surface';
import { getSticker, renderSticker } from '../stickers';
import {
  PRESETS,
  PRESET_IDS,
  analyzeIcon,
  applyPresetFromLayer,
  applyPresetResult,
  buildFromAnalysis,
  buildPreset,
  commitLayerStack,
  compositePreset,
  getPreset,
  insertLayer,
  isPresetId,
  makeRasterLayer,
} from './index';
import { over } from './paint';

/** A plate icon: a blue squircle tile with a white music note on it. */
function tileIcon(size = 256): Pixels {
  const tile = renderBackdrop(
    { shape: 'squircle', inset: 0.03, shadow: null, fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: '#3aa0ff' }, { offset: 1, color: '#1f5fd6' }] } },
    size,
  );
  over(tile, renderSticker(getSticker('music')!, { size, color: '#ffffff', box: size * 0.6 }));
  return tile;
}

/** A cut-out icon: a flame on transparency. */
function cutoutIcon(size = 256): Pixels {
  return renderSticker(getSticker('flame')!, { size });
}

/** A flat multi-colour disc (three sectors and a centre dot). */
function logoIcon(size = 256): Pixels {
  const out = createPixels(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const r = Math.hypot(dx, dy);
      const cov = Math.max(0, Math.min(1, size * 0.47 - r + 0.5));
      if (cov <= 0) continue;
      const ang = ((Math.atan2(dy, dx) * 180) / Math.PI + 450) % 360;
      let rgb = ang < 120 ? [234, 67, 53] : ang < 240 ? [251, 188, 5] : [52, 168, 83];
      if (r < size * 0.18) rgb = [66, 133, 244];
      out.data.set([...rgb, Math.round(cov * 255)], (y * size + x) * 4);
    }
  }
  return out;
}

function alphaSum(p: Pixels): number {
  let s = 0;
  for (let i = 3; i < p.data.length; i += 4) s += p.data[i]!;
  return s / 255;
}

function edgeMaxAlpha(p: Pixels): number {
  const { width: w, height: h, data } = p;
  let m = 0;
  for (let i = 0; i < w; i++) {
    m = Math.max(m, data[i * 4 + 3]!, data[((h - 1) * w + i) * 4 + 3]!, data[i * w * 4 + 3]!, data[(i * w + w - 1) * 4 + 3]!);
  }
  return m;
}

function meanAbsDiff(a: Pixels, b: Pixels): number {
  let s = 0;
  for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i]! - b.data[i]!);
  return s / a.data.length;
}

/** Byte equality without deep-diffing megabyte arrays. */
function same(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
}

function hashPixels(p: Pixels): number {
  let h = 2166136261;
  for (let i = 0; i < p.data.length; i++) h = Math.imul(h ^ p.data[i]!, 16777619);
  return h >>> 0;
}

describe('icon analysis', () => {
  it('finds the mark on a plate icon', () => {
    const a = analyzeIcon(tileIcon());
    expect(a.mode).toBe('plate');
    expect(a.glyphLuma).toBeGreaterThan(0.9); // the white note
    expect(a.hue).toBeGreaterThan(195);
    expect(a.hue).toBeLessThan(230);
    const share = a.glyph.reduce((s, v) => s + v, 0) / (a.size * a.size);
    expect(share).toBeGreaterThan(0.05);
    expect(share).toBeLessThan(0.4);
  });

  it('cuts a flat multi-colour logo along its colour boundaries', () => {
    const a = analyzeIcon(logoIcon());
    expect(a.mode).toBe('segments');
    const glyph = a.glyph.reduce((s, v) => s + v, 0);
    const alpha = alphaSum(a.fitted);
    expect(glyph).toBeLessThan(alpha * 0.97);
    expect(glyph).toBeGreaterThan(alpha * 0.8);
  });

  it('keeps plain cut-outs as silhouettes and handles empty icons', () => {
    const gear = analyzeIcon(renderSticker(getSticker('gear')!, { size: 200 }));
    expect(gear.mode).toBe('silhouette');
    const empty = analyzeIcon(createPixels(64, 64));
    expect(empty.mode).toBe('empty');
    expect(empty.achromatic).toBe(true);
  });
});

describe('presets', () => {
  const icons: [string, Pixels][] = [
    ['plate', tileIcon()],
    ['cutout', cutoutIcon()],
    ['logo', logoIcon()],
  ];

  it('lists the twelve looks', () => {
    expect(PRESET_IDS).toEqual(['glass', 'neon', 'monoLight', 'monoDark', 'pastel', 'retroPixel', 'sticker', 'clay', 'gradientSilhouette', 'fluent', 'duotone', 'sketch']);
    expect(PRESETS.map((p) => p.label)).toContain('Mono Light');
    expect(getPreset('neon').usesHue).toBe(true);
    expect(isPresetId('glass')).toBe(true);
    expect(isPresetId('nope')).toBe(false);
    expect(() => getPreset('nope' as never)).toThrow(RangeError);
  });

  describe.each(PRESET_IDS)('%s', (id) => {
    it('builds a non-empty 512 px stack that differs from the icon and stays in bounds', () => {
      for (const [, icon] of icons) {
        const result = buildPreset(id, icon, 512);
        expect(result.size).toBe(512);
        expect(result.layers.length).toBeGreaterThanOrEqual(2);
        expect(result.layers[result.iconIndex]!.role).toBe('icon');
        for (const l of result.layers) {
          expect(l.pixels.width).toBe(512);
          expect(l.pixels.height).toBe(512);
          expect(l.opacity).toBeGreaterThan(0);
        }
        const out = compositePreset(result);
        expect(alphaSum(out)).toBeGreaterThan(512 * 512 * 0.3);
        // Soft shadows may just reach the edge; nothing solid is cut off.
        expect(edgeMaxAlpha(out)).toBeLessThan(40);
        const plainIcon = createPixels(512, 512);
        over(plainIcon, analyzeIcon(icon, 512).fitted);
        expect(meanAbsDiff(out, plainIcon)).toBeGreaterThan(8);
      }
    }, 30_000);

    it('is deterministic and resolution independent', () => {
      const icon = icons[0]![1];
      const a = analyzeIcon(icon);
      const one = compositePreset(buildFromAnalysis(id, a, 96));
      const two = compositePreset(buildFromAnalysis(id, a, 96));
      expect(hashPixels(one)).toBe(hashPixels(two));
      // Same design at two sizes: the coverage fraction agrees.
      const big = compositePreset(buildFromAnalysis(id, a, 192));
      expect(alphaSum(big) / (192 * 192)).toBeCloseTo(alphaSum(one) / (96 * 96), 1);
    });

    it('responds to hue / intensity / shape options', () => {
      const a = analyzeIcon(icons[0]![1]);
      const base = compositePreset(buildFromAnalysis(id, a, 96));
      const info = getPreset(id);
      const intense = compositePreset(buildFromAnalysis(id, a, 96, { intensity: 1 }));
      expect(meanAbsDiff(base, intense)).toBeGreaterThan(0);
      if (info.usesHue) {
        const shifted = compositePreset(buildFromAnalysis(id, a, 96, { hue: (a.hue + 150) % 360 }));
        expect(meanAbsDiff(base, shifted)).toBeGreaterThan(2);
      }
      if (id !== 'sticker') {
        const other = info.shape === 'circle' ? 'hexagon' : 'circle';
        const reshaped = compositePreset(buildFromAnalysis(id, a, 96, { shape: other }));
        expect(meanAbsDiff(base, reshaped)).toBeGreaterThan(0.5);
      }
    });
  });

  it('scales layer effects with the output size', () => {
    const a = analyzeIcon(tileIcon());
    const small = buildFromAnalysis('neon', a, 128);
    const large = buildFromAnalysis('neon', a, 512);
    const glow = (r: typeof small) => r.layers[r.iconIndex]!.effects.find((e) => e.type === 'outerGlow');
    expect(glow(large)!.type).toBe('outerGlow');
    const s = glow(small) as { size: number };
    const l = glow(large) as { size: number };
    expect(l.size / s.size).toBeCloseTo(4, 5);
  });

  it('rejects bad sizes and ids', () => {
    const a = analyzeIcon(tileIcon(64));
    expect(() => buildFromAnalysis('glass', a, 8)).toThrow(RangeError);
    expect(() => buildFromAnalysis('bogus' as never, a, 64)).toThrow(RangeError);
  });
});

describe('committing to an engine', () => {
  function engineWithIcon(): { engine: Engine; iconId: string } {
    const engine = new Engine();
    const icon = tileIcon(512);
    const base = engine.doc.layers[0]!.id;
    const iconId = engine.importImage(new Surface(512, 512, new Uint8ClampedArray(icon.data)), 'App', { padding: 0 })!;
    engine.deleteLayer(base);
    engine.clearHistory();
    return { engine, iconId };
  }

  it('replaces the layer stack as one undo step and restores it exactly', () => {
    const { engine } = engineWithIcon();
    const before = engine.doc.layers.slice();
    const beforeBytes = engine.composite().data.slice();
    const events: string[] = [];
    engine.subscribe((e) => events.push(e.kind));
    const result = buildPreset('neon', tileIcon(), 512);
    const iconLayer = applyPresetResult(engine, result);
    expect(engine.historyEntries).toHaveLength(1);
    expect(engine.historyEntries[0]!.label).toBe('Style: Neon');
    expect(engine.doc.layers.map((l) => l.name)).toEqual(result.layers.map((l) => l.name));
    expect(engine.doc.activeLayerId).toBe(iconLayer);
    expect(events).toContain('layers');
    expect(events).toContain('history');
    expect(same(engine.composite().data, beforeBytes)).toBe(false);

    engine.undo();
    expect(engine.doc.layers).toEqual(before);
    expect(same(engine.composite().data, beforeBytes)).toBe(true);
    engine.redo();
    expect(engine.doc.layers.map((l) => l.name)).toEqual(result.layers.map((l) => l.name));
  });

  it('inserts a single layer at a position as one step', () => {
    const { engine } = engineWithIcon();
    const px = renderSticker(getSticker('star')!, { size: 512 });
    const id = insertLayer(engine, 'Add sticker', makeRasterLayer(engine, 'Star', px), 0, false);
    expect(engine.doc.layers[0]!.id).toBe(id);
    expect(engine.doc.activeLayerId).not.toBe(id);
    expect(engine.historyEntries.map((e) => e.label)).toEqual(['Add sticker']);
    engine.undo();
    expect(engine.doc.layers.some((l) => l.id === id)).toBe(false);
  });

  it('refuses stacks that do not fit the document', () => {
    const { engine } = engineWithIcon();
    expect(() => commitLayerStack(engine, 'x', [], null)).toThrow(RangeError);
    expect(() => applyPresetResult(engine, buildPreset('glass', tileIcon(64), 128))).toThrow(RangeError);
    expect(engine.historyEntries).toHaveLength(0);
  });

  it('replays a preset from an icon layer (Apply style to all)', () => {
    const { engine, iconId } = engineWithIcon();
    const newIcon = applyPresetFromLayer(engine, 'sticker', iconId, { intensity: 0.8 });
    expect(newIcon).not.toBeNull();
    expect(engine.doc.layers.find((l) => l.id === newIcon)!.name).toBe('Icon');
    expect(engine.historyEntries).toHaveLength(1);
    expect(applyPresetFromLayer(engine, 'sticker', 'missing')).toBeNull();
  });
});
