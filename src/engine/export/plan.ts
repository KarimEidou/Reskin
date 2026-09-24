// Export size planning and rendering: one composite at the document size,
// then every icon size derived from it.
//
// Normal documents (512 master): halve (2×2 box, premultiplied) while the
// next half is still ≥ the target, i.e. start from the nearest larger
// power-of-two step, then one exact area resample to the target size; sizes
// ≤ 32 px get a light unsharp mask (optional) to restore crispness.
// Halving steps are shared between sizes (512→256→128→…).
//
// Pixel-art documents (grid G): nearest-neighbour integer scaling —
// sizes ≥ G use the largest integer factor k = ⌊size/G⌋, sizes < G an
// integer box reduction by d = ⌈G/size⌉ — centred on a transparent canvas
// when the result is smaller than the size (e.g. 32→40 gives 32 px + 4 px
// padding each side). No sub-pixel blur ever.

import type { FloatImage } from '../raster/float-image';
import { downscaleInteger, halve, padCentered, resize, upscaleInteger } from '../raster/resample';
import { unsharpMask } from '../raster/unsharp';

/** Mirrors `ICO_SIZES` in crates/reskin-core/src/model.rs. */
export const DEFAULT_ICO_SIZES: readonly number[] = [16, 20, 24, 32, 40, 48, 60, 64, 72, 96, 128, 256];

/** Largest size an export may request. */
export const MAX_EXPORT_SIZE = 4096;

export type SizeStep =
  | {
      size: number;
      kind: 'smooth';
      /** Sizes after each 2× halving, e.g. [256, 128, 64] for 48 from 512. */
      halvings: number[];
      /** Final area resample from the last step (or the source) to `size`. */
      finalResample: boolean;
      /** Upscale (size larger than the document): bilinear/area resize. */
      upscale: boolean;
      sharpen: boolean;
    }
  | {
      size: number;
      kind: 'pixel';
      /** Integer factor: > 1 upscales (nearest), < 1 means box-reduce by 1/factor. */
      factor: number;
      /** Scaled content size before padding. */
      content: number;
      /** Transparent padding on the left/top. */
      offset: number;
    };

export interface PlanOptions {
  /** Document is pixel art (nearest-neighbour integer scaling). */
  pixelArt: boolean;
  /** Light unsharp mask at ≤ 32 px (smooth mode only, default true). */
  sharpenSmall?: boolean;
}

/** Validated, de-duplicated, ascending sizes. */
export function normalizeSizes(sizes: readonly number[]): number[] {
  const out = new Set<number>();
  for (const s of sizes) {
    if (!Number.isInteger(s) || s < 1 || s > MAX_EXPORT_SIZE) throw new RangeError(`Invalid export size ${s}`);
    out.add(s);
  }
  return [...out].sort((a, b) => a - b);
}

export function planExport(sourceSize: number, sizes: readonly number[], opts: PlanOptions): SizeStep[] {
  return normalizeSizes(sizes).map((size) => {
    if (opts.pixelArt) {
      if (size >= sourceSize) {
        const k = Math.floor(size / sourceSize);
        const content = sourceSize * k;
        return { size, kind: 'pixel', factor: k, content, offset: Math.floor((size - content) / 2) };
      }
      const d = Math.ceil(sourceSize / size);
      const content = Math.floor(sourceSize / d);
      return { size, kind: 'pixel', factor: 1 / d, content, offset: Math.floor((size - content) / 2) };
    }
    const halvings: number[] = [];
    let cur = sourceSize;
    while (cur / 2 >= size && cur % 2 === 0) {
      cur /= 2;
      halvings.push(cur);
    }
    return {
      size,
      kind: 'smooth',
      halvings,
      finalResample: cur !== size,
      upscale: size > sourceSize,
      sharpen: (opts.sharpenSmall ?? true) && size <= 32 && size < sourceSize,
    };
  });
}

/** Light sharpening used for small icon sizes. */
export const SMALL_SIZE_UNSHARP = { amount: 0.35, radius: 0.5, threshold: 0.004 } as const;

/**
 * Renders every planned size from a square premultiplied composite. Returns
 * images in plan order.
 */
export function renderPlan(source: FloatImage, plan: readonly SizeStep[]): FloatImage[] {
  const halves = new Map<number, FloatImage>([[source.width, source]]);
  const halfOf = (size: number): FloatImage => {
    const hit = halves.get(size);
    if (hit) return hit;
    const parent = halfOf(size * 2);
    const img = halve(parent);
    halves.set(size, img);
    return img;
  };
  return plan.map((step) => {
    if (step.kind === 'pixel') {
      const scaled =
        step.factor >= 1 ? upscaleInteger(source, step.factor) : downscaleInteger(source, Math.round(1 / step.factor));
      return scaled.width === step.size ? scaled : padCentered(scaled, step.size);
    }
    const from = step.halvings.length ? halfOf(step.halvings[step.halvings.length - 1]) : source;
    let img = step.finalResample ? resize(from, step.size, step.size) : { ...from, data: from.data.slice() };
    if (step.sharpen) img = unsharpMask(img, SMALL_SIZE_UNSHARP);
    return img;
  });
}
