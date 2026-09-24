// Export entry points: what `apply_icon` / `export_file` receive.

import type { SizedPng } from '$lib/ipc/types';
import type { Doc } from '../doc/types';
import type { CompositeOptions } from '../render/compositor';
import { compositeDocument } from '../render/compositor';
import { floatToSurface } from '../raster/float-image';
import type { Surface } from '../raster/surface';
import { surfaceToPngBase64 } from './png';
import { DEFAULT_ICO_SIZES, planExport, renderPlan } from './plan';

export interface ExportOptions extends Pick<CompositeOptions, 'background' | 'textRasterizer'> {
  /** Light unsharp mask at ≤ 32 px (default true). */
  sharpenSmall?: boolean;
}

/** Every requested size as straight-alpha surfaces, ascending by size. */
export function renderSizes(
  doc: Doc,
  sizes: readonly number[] = DEFAULT_ICO_SIZES,
  opts: ExportOptions = {},
): { size: number; surface: Surface }[] {
  const composite = compositeDocument(doc, { background: opts.background, textRasterizer: opts.textRasterizer });
  const plan = planExport(doc.width, sizes, { pixelArt: doc.pixelArt !== null, sharpenSmall: opts.sharpenSmall });
  const images = renderPlan(composite, plan);
  return plan.map((step, i) => ({ size: step.size, surface: floatToSurface(images[i]) }));
}

/**
 * Renders the design at every size (default: the ICO sizes; pass
 * `settings.icoSizes`) as base64 PNGs — exactly the `images` of an
 * `ApplyRequest` / Ico `ExportRequest`.
 */
export async function toSizedPngs(
  doc: Doc,
  sizes: readonly number[] = DEFAULT_ICO_SIZES,
  opts: ExportOptions = {},
): Promise<SizedPng[]> {
  const rendered = renderSizes(doc, sizes, opts);
  return Promise.all(rendered.map(async (r) => ({ size: r.size, png: await surfaceToPngBase64(r.surface) })));
}

/** A single composite PNG at `size` px (base64) — for Png `ExportRequest`s and the clipboard. */
export async function exportPng(doc: Doc, size: number = doc.width, opts: ExportOptions = {}): Promise<SizedPng> {
  const [png] = await toSizedPngs(doc, [size], opts);
  return png;
}
