import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine';
import type { EngineEvent } from './engine';
import { createDocument } from './doc/document';
import type { RasterLayer, TextLayer } from './doc/types';
import { createEffect } from './doc/effects';
import { Surface } from './raster/surface';
import { pointer, pixel, alphaSum, blockTextRasterizer } from './test-helpers';
import { Viewport } from './viewport/viewport';
import { decodeBase64 } from './util/base64';
import * as api from './index';

function collect(e: Engine): EngineEvent[] {
  const out: EngineEvent[] = [];
  e.subscribe((ev) => out.push(ev));
  return out;
}

function raster(e: Engine, id = e.doc.activeLayerId!): Surface {
  return (e.getLayer(id) as RasterLayer).surface;
}

describe('Engine layers', () => {
  it('adds, renames, reorders, duplicates and deletes with undo', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 16 }) });
    const events = collect(e);
    const base = e.doc.activeLayerId!;
    const a = e.addLayer()!;
    expect(e.doc.layers.map((l) => l.name)).toEqual(['Layer 1', 'Layer 2']);
    expect(e.doc.activeLayerId).toBe(a);
    expect(events.some((ev) => ev.kind === 'layers')).toBe(true);
    expect(events.some((ev) => ev.kind === 'history')).toBe(true);
    e.renameLayer(a, '  Sparkles ');
    expect(e.getLayer(a)!.name).toBe('Sparkles');
    e.moveLayer(a, 0);
    expect(e.doc.layers[0].id).toBe(a);
    const copy = e.duplicateLayer(a)!;
    expect(e.getLayer(copy)!.name).toBe('Sparkles copy');
    expect(e.doc.layers.map((l) => l.id)).toEqual([a, copy, base]);
    e.deleteLayer(copy);
    expect(e.doc.layers).toHaveLength(2);
    expect(e.historyEntries.map((h) => h.label)).toEqual([
      'New layer',
      'Rename layer',
      'Move Sparkles',
      'Duplicate Sparkles',
      'Delete Sparkles copy',
    ]);
    e.jumpTo(0);
    expect(e.doc.layers.map((l) => l.id)).toEqual([base]);
    e.jumpTo(5);
    expect(e.doc.layers.map((l) => l.id)).toEqual([a, base]);
  });

  it('refuses to delete the last layer with a message', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 16 }) });
    const events = collect(e);
    expect(e.deleteLayer()).toBe(false);
    expect(events).toContainEqual({ kind: 'message', level: 'warning', text: 'A design needs at least one layer' });
  });

  it('merges slider changes into one entry', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 16 }) });
    const id = e.doc.activeLayerId!;
    for (const o of [0.9, 0.8, 0.5]) e.setLayerProps(id, { opacity: o }, { merge: 'opacity' });
    expect(e.history.length).toBe(1);
    e.undo();
    expect(e.getLayer(id)!.opacity).toBe(1);
  });

  it('merges down with blend, opacity and effects baked', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 16 }) });
    const lower = e.doc.activeLayerId!;
    raster(e).fill(0, 0, 255, 255);
    const upper = e.addLayer()!;
    raster(e).fill(255, 0, 0, 255, { x: 4, y: 4, w: 4, h: 4 });
    e.setLayerProps(upper, { opacity: 0.6 });
    const before = e.composite().clone();
    expect(e.mergeDown(upper)).toBe(true);
    expect(e.doc.layers).toHaveLength(1);
    expect(e.doc.activeLayerId).toBe(lower);
    expect(e.composite().equals(before)).toBe(true);
    e.undo();
    expect(e.doc.layers).toHaveLength(2);
    expect(e.mergeDown(lower)).toBe(false);
  });

  it('flattens visible layers only', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 16 }) });
    raster(e).fill(10, 20, 30, 255);
    const top = e.addLayer()!;
    raster(e, top).fill(255, 255, 255, 255);
    e.setLayerProps(top, { visible: false });
    e.addLayer();
    e.setLayerProps(e.doc.activeLayerId!, { effects: [createEffect('colorOverlay')] });
    const composite = e.composite().clone();
    expect(e.flatten()).toBe(true);
    expect(e.doc.layers).toHaveLength(1);
    expect(raster(e).equals(composite)).toBe(true);
    expect(e.flatten()).toBe(false);
  });

  it('text layers render through the rasterizer and can be rasterized', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 64 }), textRasterizer: blockTextRasterizer() });
    const events = collect(e);
    const id = e.addTextLayer({ text: 'Hey', x: 32, y: 8, fontSize: 12, color: { r: 0, g: 0, b: 0, a: 1 } })!;
    expect(events.some((ev) => ev.kind === 'pixels' && ev.layerId === id)).toBe(true);
    expect(pixel(e.composite(), 32, 14)).toEqual([0, 0, 0, 255]);
    e.updateText(id, { color: { r: 255, g: 0, b: 0, a: 1 } });
    expect(pixel(e.composite(), 32, 14)).toEqual([255, 0, 0, 255]);
    e.undo();
    expect(pixel(e.composite(), 32, 14)).toEqual([0, 0, 0, 255]);
    expect(e.rasterizeLayer(id)).toBe(true);
    expect(e.getLayer(id)!.kind).toBe('raster');
    expect(pixel(raster(e, id), 32, 14)).toEqual([0, 0, 0, 255]);
    // Painting a text layer is refused.
    e.undo();
    e.setTool('brush');
    const msgs = collect(e);
    e.pointerDown(pointer(5, 5));
    e.pointerUp(pointer(5, 5));
    expect(msgs.find((m) => m.kind === 'message')).toMatchObject({ level: 'warning' });
  });

  it('text layers follow the rasterizer being installed later', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 32 }) });
    const id = e.addTextLayer({ text: 'A', x: 16, y: 4, fontSize: 8 })!;
    expect((e.getLayer(id) as TextLayer).cache).toBeNull();
    e.setTextRasterizer(blockTextRasterizer());
    expect((e.getLayer(id) as TextLayer).cache).not.toBeNull();
  });
});

describe('Engine painting & history', () => {
  it('edits pixels with arbitrary code as one step and clears the selection', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 16 }) });
    const id = e.doc.activeLayerId!;
    e.editLayerPixels(id, 'Invert', (s) => s.fill(9, 9, 9, 255));
    expect(alphaSum(raster(e))).toBe(16 * 16 * 255);
    e.selectShape('rect', { x: 0, y: 0, w: 8, h: 16 });
    e.clearPixels();
    expect(pixel(raster(e), 2, 2)).toEqual([0, 0, 0, 0]);
    expect(pixel(raster(e), 12, 2)).toEqual([9, 9, 9, 255]);
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Invert', 'Rectangle select', 'Clear']);
    e.undo();
    expect(pixel(raster(e), 2, 2)).toEqual([9, 9, 9, 255]);
  });

  it('selection commands: all, invert, feather, deselect', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 16 }) });
    const events = collect(e);
    e.selectAll();
    expect(e.doc.selection!.data.every((v) => v === 255)).toBe(true);
    e.invertSelection();
    expect(e.doc.selection).toBeNull();
    e.selectShape('ellipse', { x: 0, y: 0, w: 16, h: 16 });
    e.featherSelection(2);
    e.deselect();
    expect(e.doc.selection).toBeNull();
    expect(events.filter((ev) => ev.kind === 'selection').length).toBeGreaterThanOrEqual(4);
    e.undo();
    expect(e.doc.selection).not.toBeNull();
  });

  it('switches to pixel-art mode and back, undoably and exactly', () => {
    const e = new Engine({ doc: createDocument() });
    const vp = new Viewport({ viewWidth: 600, viewHeight: 600 });
    e.attachViewport(vp);
    raster(e).fill(255, 0, 0, 255, { x: 0, y: 0, w: 256, h: 512 });
    const original = raster(e).clone();
    const events = collect(e);
    e.setPixelArt(32);
    expect([e.doc.width, e.doc.pixelArt]).toEqual([32, { grid: 32 }]);
    expect(raster(e).width).toBe(32);
    expect(pixel(raster(e), 5, 5)).toEqual([255, 0, 0, 255]);
    expect(pixel(raster(e), 20, 5)).toEqual([0, 0, 0, 0]);
    expect(vp.docWidth).toBe(32);
    expect(events.some((ev) => ev.kind === 'document')).toBe(true);
    e.setPixelArt(null);
    expect(e.doc.width).toBe(512);
    expect(pixel(raster(e), 100, 100)).toEqual([255, 0, 0, 255]);
    e.undo();
    e.undo();
    expect(raster(e).equals(original)).toBe(true);
    expect(e.doc.pixelArt).toBeNull();
  });

  it('tool overrides route input without committing pending work', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 64 }) });
    const vp = new Viewport({ viewWidth: 800, viewHeight: 800, docWidth: 64, docHeight: 64 });
    e.attachViewport(vp);
    raster(e).fill(0, 0, 0, 255, { x: 10, y: 10, w: 10, h: 10 });
    e.setTool('move');
    e.pointerDown(pointer(15, 15));
    e.pointerMove(pointer(25, 15));
    e.pointerUp(pointer(25, 15));
    expect(e.hasPending).toBe(true);
    e.setToolOverride('hand');
    expect(e.toolId).toBe('hand');
    const panX = vp.panX;
    e.pointerDown(pointer(0, 0, { screenX: 100, screenY: 100 }));
    e.pointerMove(pointer(0, 0, { screenX: 130, screenY: 100 }));
    e.pointerUp(pointer(0, 0, { screenX: 130, screenY: 100 }));
    expect(vp.panX).toBeCloseTo(panX + 30, 9);
    e.setToolOverride(null);
    expect(e.hasPending).toBe(true);
    e.commitPending();
    expect(e.historyEntries.map((h) => h.label)).toEqual(['Move']);
  });

  it('zoom tool steps around the click', () => {
    const e = new Engine();
    const vp = new Viewport({ viewWidth: 800, viewHeight: 800 });
    e.attachViewport(vp);
    e.setTool('zoom');
    vp.setZoom(1);
    e.pointerDown(pointer(0, 0, { screenX: 200, screenY: 300 }));
    e.pointerUp(pointer(0, 0, { screenX: 200, screenY: 300 }));
    expect(vp.zoom).toBe(1.5);
  });

  it('exposes cursor hints, colours and symmetry', () => {
    const e = new Engine();
    const events = collect(e);
    expect(e.cursor).toEqual({ css: 'crosshair', radius: 12 });
    e.setToolOptions('brush', { size: 50 });
    expect(e.cursor.radius).toBe(25);
    e.setColor('primary', { r: 300, g: -5, b: 10, a: 2 });
    expect(e.primary).toEqual({ r: 255, g: 0, b: 10, a: 1 });
    e.swapColors();
    expect(e.secondary).toEqual({ r: 255, g: 0, b: 10, a: 1 });
    e.setSymmetry({ mode: 'radial', rays: 200 });
    expect(e.symmetry.rays).toBe(64);
    expect(events.map((ev) => ev.kind)).toEqual(expect.arrayContaining(['tool', 'color', 'symmetry', 'overlay']));
  });

  it('draws overlays through the painter interface', () => {
    const e = new Engine();
    e.setSymmetry({ mode: 'xy' });
    const calls: string[] = [];
    const painter = {
      scale: 1,
      line: () => calls.push('line'),
      rect: () => calls.push('rect'),
      ellipse: () => calls.push('ellipse'),
      polyline: () => calls.push('polyline'),
      handle: () => calls.push('handle'),
    };
    e.pointerHover(pointer(100, 100));
    e.drawOverlay(painter);
    expect(calls).toEqual(['line', 'line', 'ellipse']);
  });
});

describe('Engine documents', () => {
  it('serializes, loads and exports', async () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 16 }) });
    raster(e).fill(1, 2, 3, 255, { x: 0, y: 0, w: 8, h: 8 });
    e.addLayer();
    const json = await e.serialize();
    const f = new Engine();
    const events = collect(f);
    await f.loadProject(json);
    expect(f.doc.layers).toHaveLength(2);
    expect(pixel((f.doc.layers[0] as RasterLayer).surface, 1, 1)).toEqual([1, 2, 3, 255]);
    expect(f.history.length).toBe(0);
    expect(events.map((ev) => ev.kind)).toEqual(expect.arrayContaining(['document', 'layers', 'history']));
    const pngs = await f.exportPngs([16, 32]);
    expect(pngs.map((p) => p.size)).toEqual([16, 32]);
    expect(decodeBase64(pngs[0].png).subarray(1, 4)).toEqual(new TextEncoder().encode('PNG'));
    expect(f.thumbnail(8).width).toBe(8);
    expect(f.layerThumbnail(f.doc.layers[0].id, 4)!.width).toBe(4);
  });

  it('newDocument resets history; dispose silences events', () => {
    const e = new Engine();
    e.addLayer();
    e.newDocument({ pixelArt: 48 });
    expect(e.doc.width).toBe(48);
    expect(e.canUndo).toBe(false);
    const events = collect(e);
    e.dispose();
    e.addLayer();
    e.pointerDown(pointer(1, 1));
    expect(events).toEqual([]);
    expect(e.isDisposed).toBe(true);
  });

  it('caches the composite until something changes', () => {
    const e = new Engine({ doc: createDocument({ pixelArt: 16 }) });
    const a = e.composite();
    expect(e.composite()).toBe(a);
    e.setTool('pencil');
    e.pointerDown(pointer(1, 1));
    e.pointerUp(pointer(1, 1));
    expect(e.composite()).not.toBe(a);
    expect(pixel(e.composite(), 1, 1)[3]).toBe(255);
  });
});

describe('module boundaries', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const DOM_MODULES = ['render/canvas-view', 'text/measure-canvas', 'io/decode-dom', 'dom'];

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  }

  it('the pure core never imports DOM-only modules', () => {
    for (const file of files(root)) {
      const rel = relative(root, file).replace(/\\/g, '/').replace(/\.ts$/, '');
      if (DOM_MODULES.includes(rel) || rel.endsWith('.test')) continue;
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
        const target = m[1];
        expect(DOM_MODULES.some((d) => target.endsWith(d)), `${rel} imports ${target}`).toBe(false);
      }
    }
  });

  it('the public barrel loads in Node and exposes the main API', () => {
    expect(typeof api.Engine).toBe('function');
    expect(typeof api.toSizedPngs).toBe('function');
    expect(typeof api.serializeProject).toBe('function');
    expect(api.BLEND_MODES).toHaveLength(12);
    expect(api.TOOL_ORDER).toContain('brush');
    expect(api.DEFAULT_ICO_SIZES).toEqual([16, 20, 24, 32, 40, 48, 60, 64, 72, 96, 128, 256]);
    expect(typeof api.Surface).toBe('function');
  });
});
