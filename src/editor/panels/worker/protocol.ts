// The panels worker's requests and their (DOM-free) handler, shared by the
// module worker and the client's same-thread fallback.
//
//   layerThumbs  → Pixels[]            engine layerThumbnail() per layer
//   renderSizes  → {size, pixels}[]    engine renderSizes() — the export path
//   presetThumb  → Pixels              preset built at `size`, composited
//   presetBuild  → PresetResult        preset layer stack at `size`
//   helper       → Pixels              icon helper on a layer image
//   sticker      → Pixels              vector sticker rasterized
//   stickerStamp → Pixels | null       sticker cropped to its art (stamp tool)
//   fit          → Pixels              an imported picture fitted and centred
//                                      into a size px document (engine
//                                      fitAndCenter: the engine's import
//                                      then only copies it)

import { layerThumbnail } from '$engine/doc/thumbnails';
import { renderSizes } from '$engine/export/export';
import type { Pixels } from '$engine/filters/types';
import { createCanvasTextRasterizer } from '$engine/helpers';
import { fitAndCenter } from '$engine/io/import';
import { Surface } from '$engine/raster/surface';
import { analyzeIcon, buildFromAnalysis, compositePreset, type IconAnalysis, type PresetId, type PresetOptions, type PresetResult } from '$engine/presets';
import { getSticker, renderSticker, renderStickerStamp, type StickerDef, type StickerOutline } from '$engine/stickers';
import { runHelper, type HelperId } from '../adjust/helper-defs';
import { docFromSnapshot, layerFromSnapshot, type DocSnapshot, type LayerSnapshot } from './snapshot';

export type PanelRequest =
  | { op: 'layerThumbs'; layers: LayerSnapshot[]; size: number; crisp: boolean }
  | { op: 'renderSizes'; doc: DocSnapshot; sizes: number[] }
  | { op: 'presetThumb'; iconKey: string; icon: Pixels; id: PresetId; size: number; options: Partial<PresetOptions> }
  | { op: 'presetBuild'; iconKey: string; icon: Pixels; id: PresetId; size: number; options: Partial<PresetOptions> }
  | { op: 'helper'; id: HelperId; pixels: Pixels; values: Record<string, unknown>; mask: Uint8Array | null }
  | { op: 'sticker'; id: string; size: number; box: number; color: string | null; outline: StickerOutline | null }
  | { op: 'stickerStamp'; id: string; box: number; color: string | null; outline: StickerOutline | null }
  | { op: 'fit'; pixels: Pixels; size: number };

export interface PanelResults {
  layerThumbs: (Pixels | null)[];
  renderSizes: { size: number; pixels: Pixels }[];
  presetThumb: Pixels;
  presetBuild: PresetResult;
  helper: Pixels;
  sticker: Pixels;
  stickerStamp: Pixels | null;
  fit: Pixels;
}

export type PanelOp = PanelRequest['op'];
export type RequestOf<K extends PanelOp> = Extract<PanelRequest, { op: K }>;

export type PanelMessage = PanelRequest & { reqId: number };
export type PanelResponse = { reqId: number; result: unknown } | { reqId: number; error: string };

function plain(p: { width: number; height: number; data: Uint8ClampedArray }): Pixels {
  return { width: p.width, height: p.height, data: p.data };
}

function buffers(list: (Pixels | null | undefined)[]): Transferable[] {
  const out: Transferable[] = [];
  const seen = new Set<ArrayBufferLike>();
  for (const p of list) {
    const b = p?.data.buffer;
    if (b instanceof ArrayBuffer && !seen.has(b) && p!.data.byteOffset === 0 && p!.data.byteLength === b.byteLength) {
      seen.add(b);
      out.push(b);
    }
  }
  return out;
}

function sticker(id: string): StickerDef {
  const def = getSticker(id);
  if (!def) throw new RangeError(`unknown sticker "${id}"`);
  return def;
}

/** Icon analyses by icon key (the Styles grid builds 12 presets from one icon). */
const analyses = new Map<string, IconAnalysis>();

function analysisFor(key: string, icon: Pixels): IconAnalysis {
  let a = analyses.get(key);
  if (!a) {
    a = analyzeIcon(icon);
    analyses.set(key, a);
    while (analyses.size > 6) analyses.delete(analyses.keys().next().value!);
  }
  return a;
}

let textRasterizer: ReturnType<typeof createCanvasTextRasterizer> | undefined;

/** Runs one request; returns the result and the buffers to transfer back. */
export function handlePanelRequest(req: PanelRequest): { result: unknown; transfer: Transferable[] } {
  switch (req.op) {
    case 'layerThumbs': {
      const thumbs = req.layers.map((l) => {
        const s = layerThumbnail(layerFromSnapshot(l), req.size, req.crisp);
        return s ? plain(s) : null;
      });
      return { result: thumbs, transfer: buffers(thumbs) };
    }
    case 'renderSizes': {
      const out = renderSizes(docFromSnapshot(req.doc), req.sizes).map((r) => ({ size: r.size, pixels: plain(r.surface) }));
      return { result: out, transfer: buffers(out.map((o) => o.pixels)) };
    }
    case 'presetThumb': {
      const px = compositePreset(buildFromAnalysis(req.id, analysisFor(req.iconKey, req.icon), req.size, req.options));
      return { result: px, transfer: buffers([px]) };
    }
    case 'presetBuild': {
      const res = buildFromAnalysis(req.id, analysisFor(req.iconKey, req.icon), req.size, req.options);
      return { result: res, transfer: buffers(res.layers.map((l) => l.pixels)) };
    }
    case 'helper': {
      if (textRasterizer === undefined) textRasterizer = createCanvasTextRasterizer();
      const px = runHelper(req.id, req.pixels, req.values, req.mask, textRasterizer);
      return { result: px, transfer: buffers([px]) };
    }
    case 'sticker': {
      const px = renderSticker(sticker(req.id), { size: req.size, box: req.box, color: req.color ?? undefined, outline: req.outline });
      return { result: px, transfer: buffers([px]) };
    }
    case 'stickerStamp': {
      const px = renderStickerStamp(sticker(req.id), { box: req.box, color: req.color ?? undefined, outline: req.outline });
      return { result: px, transfer: buffers([px]) };
    }
    case 'fit': {
      const { width, height, data } = req.pixels;
      const px = plain(fitAndCenter(Surface.fromRgba(width, height, data), { size: req.size }));
      return { result: px, transfer: buffers([px]) };
    }
  }
}

/** Handles a posted message; never throws. */
export function handlePanelMessage(msg: PanelMessage): { response: PanelResponse; transfer: Transferable[] } {
  try {
    const { result, transfer } = handlePanelRequest(msg);
    return { response: { reqId: msg.reqId, result }, transfer };
  } catch (e) {
    return { response: { reqId: msg.reqId, error: e instanceof Error ? e.message : String(e) }, transfer: [] };
  }
}
