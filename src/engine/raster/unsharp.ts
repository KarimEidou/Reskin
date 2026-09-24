// Unsharp mask on premultiplied float images: out = in + amount·(in − blur).
// All four premultiplied channels are sharpened; the result is then clamped
// to valid premultiplied data, which removes overshoot on both sides of
// alpha edges (no light/dark halos around the silhouette).

import type { FloatImage } from './float-image';
import { sanitizePremultiplied } from './float-image';
import { gaussianBlur } from './blur';

export interface UnsharpOptions {
  /** Strength, typically 0.2..1.5. */
  amount: number;
  /** Gaussian sigma in px. */
  radius: number;
  /** Ignore differences smaller than this (0..1). */
  threshold?: number;
}

/** Sharpens `img` in place and returns it. */
export function unsharpMask(img: FloatImage, opts: UnsharpOptions): FloatImage {
  const { amount, radius } = opts;
  const threshold = opts.threshold ?? 0;
  if (amount <= 0 || radius <= 0) return img;
  const blurred = img.data.slice();
  gaussianBlur(blurred, img.width, img.height, 4, radius);
  const d = img.data;
  for (let i = 0; i < d.length; i++) {
    const diff = d[i] - blurred[i];
    if (Math.abs(diff) >= threshold) d[i] += amount * diff;
  }
  sanitizePremultiplied(img);
  return img;
}
