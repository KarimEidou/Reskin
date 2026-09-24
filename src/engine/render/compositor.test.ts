import { describe, expect, it } from 'vitest';
import { compositeSurface } from './compositor';
import { createDocument, createRasterLayer, createTextLayer } from '../doc/document';
import type { Doc } from '../doc/types';
import { pixel, solidSurface, blockTextRasterizer } from '../test-helpers';
import { createEffect } from '../doc/effects';
import { renderStyledLayer } from './effects';
import { floatToSurface } from '../raster/float-image';
import { Surface } from '../raster/surface';

function twoLayerDoc(): Doc {
  const doc = createDocument({ pixelArt: 16 });
  if (doc.layers[0].kind === 'raster') doc.layers[0].surface.fill(0, 0, 255, 255);
  const top = createRasterLayer(doc, { surface: solidSurface(16, 16, [255, 0, 0, 255]) });
  doc.layers.push(top);
  return doc;
}

describe('compositor', () => {
  it('composites over a transparent background', () => {
    const doc = createDocument({ pixelArt: 16 });
    expect(pixel(compositeSurface(doc), 3, 3)).toEqual([0, 0, 0, 0]);
    expect(pixel(compositeSurface(doc, { background: { r: 10, g: 20, b: 30, a: 1 } }), 3, 3)).toEqual([10, 20, 30, 255]);
  });

  it('respects layer opacity', () => {
    const doc = twoLayerDoc();
    doc.layers[1].opacity = 0.6;
    expect(pixel(compositeSurface(doc), 5, 5)).toEqual([153, 0, 102, 255]);
  });

  it('skips hidden layers (unless asked) and zero opacity', () => {
    const doc = twoLayerDoc();
    doc.layers[1].visible = false;
    expect(pixel(compositeSurface(doc), 0, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(compositeSurface(doc, { includeHidden: true }), 0, 0)).toEqual([255, 0, 0, 255]);
    doc.layers[1].visible = true;
    doc.layers[1].opacity = 0;
    expect(pixel(compositeSurface(doc), 0, 0)).toEqual([0, 0, 255, 255]);
    doc.layers[0].visible = false;
    expect(pixel(compositeSurface(doc), 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('applies blend modes with opacity', () => {
    const doc = createDocument({ pixelArt: 16 });
    if (doc.layers[0].kind === 'raster') doc.layers[0].surface.fill(200, 100, 50, 255);
    doc.layers.push(createRasterLayer(doc, { surface: solidSurface(16, 16, [128, 255, 0, 255]), blend: 'multiply', opacity: 0.5 }));
    // multiply = b·s/255; then 50 % mix with the backdrop.
    const expected = [200, 100, 50].map((b, i) => Math.round(0.5 * b + 0.5 * ((b * [128, 255, 0][i]) / 255)));
    expect(pixel(compositeSurface(doc), 1, 1).slice(0, 3)).toEqual(expected);
  });

  it('keeps partial alpha straight', () => {
    const doc = createDocument({ pixelArt: 16 });
    if (doc.layers[0].kind === 'raster') doc.layers[0].surface.fill(40, 80, 120, 51);
    expect(pixel(compositeSurface(doc), 2, 2)).toEqual([40, 80, 120, 51]);
  });

  it('renders text layers through their cache', () => {
    const doc = createDocument({ pixelArt: 64 });
    const t = createTextLayer(doc, { text: 'A', x: 32, y: 10, fontSize: 20, color: { r: 0, g: 255, b: 0, a: 1 } });
    doc.layers.push(t);
    // Without a rasterizer there is nothing to draw yet.
    expect(pixel(compositeSurface(doc), 32, 20)).toEqual([0, 0, 0, 0]);
    expect(pixel(compositeSurface(doc, { textRasterizer: blockTextRasterizer() }), 32, 20)).toEqual([0, 255, 0, 255]);
    expect(t.cache).not.toBeNull();
  });
});

describe('layer effects', () => {
  function square(): Surface {
    const s = new Surface(64, 64);
    s.fill(255, 255, 255, 255, { x: 20, y: 20, w: 24, h: 24 });
    return s;
  }

  it('drop shadow falls away from the light', () => {
    const img = floatToSurface(
      renderStyledLayer(square(), [createEffect('dropShadow', { angle: 120, distance: 8, blur: 0, opacity: 1 })]),
    );
    // Light from the upper left → shadow to the lower right, outside the square.
    expect(img.getPixel(46, 50)[3]).toBeGreaterThan(200);
    expect(img.getPixel(18, 18)[3]).toBe(0);
    // The content stays on top, unchanged.
    expect(img.getPixel(30, 30)).toEqual([255, 255, 255, 255]);
  });

  it('outer glow surrounds the shape', () => {
    const img = floatToSurface(renderStyledLayer(square(), [createEffect('outerGlow', { size: 6, spread: 2 })]));
    for (const [x, y] of [[18, 30], [46, 30], [30, 18], [30, 46]]) expect(img.getPixel(x, y)[3]).toBeGreaterThan(0);
    expect(img.getPixel(2, 2)[3]).toBe(0);
  });

  it('outline positions grow or keep the silhouette', () => {
    const red = { r: 255, g: 0, b: 0, a: 1 };
    const outside = floatToSurface(renderStyledLayer(square(), [createEffect('outline', { width: 4, color: red })]));
    expect(outside.alphaBounds()).toEqual({ x: 16, y: 16, w: 32, h: 32 });
    expect(outside.getPixel(17, 30)).toEqual([255, 0, 0, 255]);
    expect(outside.getPixel(30, 30)).toEqual([255, 255, 255, 255]);
    const inside = floatToSurface(
      renderStyledLayer(square(), [createEffect('outline', { width: 4, color: red, position: 'inside' })]),
    );
    expect(inside.alphaBounds()).toEqual({ x: 20, y: 20, w: 24, h: 24 });
    expect(inside.getPixel(21, 30)).toEqual([255, 0, 0, 255]);
    expect(inside.getPixel(30, 30)).toEqual([255, 255, 255, 255]);
  });

  it('colour overlay recolours but keeps alpha', () => {
    const s = square();
    s.fill(255, 255, 255, 128, { x: 20, y: 20, w: 4, h: 4 });
    const img = floatToSurface(
      renderStyledLayer(s, [createEffect('colorOverlay', { color: { r: 10, g: 20, b: 30, a: 1 }, opacity: 1 })]),
    );
    expect(img.getPixel(30, 30)).toEqual([10, 20, 30, 255]);
    expect(img.getPixel(21, 21)).toEqual([10, 20, 30, 128]);
    expect(img.getPixel(5, 5)).toEqual([0, 0, 0, 0]);
  });

  it('inner shadow darkens the lit edge from inside only', () => {
    const img = floatToSurface(
      renderStyledLayer(square(), [createEffect('innerShadow', { angle: 120, distance: 4, blur: 0, opacity: 1 })]),
    );
    expect(img.getPixel(21, 21)[0]).toBeLessThan(50); // upper-left inside edge
    expect(img.getPixel(42, 42)).toEqual([255, 255, 255, 255]); // far edge untouched
    expect(img.alphaBounds()).toEqual({ x: 20, y: 20, w: 24, h: 24 });
  });

  it('disabled effects are ignored', () => {
    const src = square();
    const img = floatToSurface(renderStyledLayer(src, [createEffect('dropShadow', { enabled: false })]));
    expect(img.equals(src)).toBe(true);
  });
});
