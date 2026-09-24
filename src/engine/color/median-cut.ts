// Dominant colours by median cut (Heckbert 1982).
//
// Pixels at or above an alpha threshold are sampled (strided so very large
// images stay fast), then the colour box with the widest channel range —
// weighted by its population so tiny outlier boxes do not win — is split at
// its median until `count` boxes exist or nothing is splittable. Each box
// reports its mean colour and population, largest first.

import type { Rgba } from './color';

export interface DominantColor {
  color: Rgba;
  /** Number of sampled pixels in the box. */
  population: number;
  /** population / total sampled, 0..1. */
  share: number;
}

export interface DominantOptions {
  /** Maximum colours to return (default 5). */
  count?: number;
  /** Pixels with alpha below this (0..255) are ignored (default 128). */
  alphaThreshold?: number;
  /** Sample at most this many pixels (default 65536). */
  maxSamples?: number;
}

interface Box {
  start: number;
  end: number; // exclusive, in pixels
  channel: 0 | 1 | 2;
  range: number;
}

function measure(px: Uint8Array, start: number, end: number): Pick<Box, 'channel' | 'range'> {
  let rMin = 255, gMin = 255, bMin = 255, rMax = 0, gMax = 0, bMax = 0;
  for (let i = start * 3; i < end * 3; i += 3) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }
  const rr = rMax - rMin, gr = gMax - gMin, br = bMax - bMin;
  if (rr >= gr && rr >= br) return { channel: 0, range: rr };
  if (gr >= br) return { channel: 1, range: gr };
  return { channel: 2, range: br };
}

/** Sorts pixels [start,end) by one channel with a counting sort (stable, O(n)). */
function sortByChannel(px: Uint8Array, tmp: Uint8Array, start: number, end: number, ch: number): void {
  const counts = new Uint32Array(257);
  for (let i = start; i < end; i++) counts[px[i * 3 + ch] + 1]++;
  for (let v = 1; v <= 256; v++) counts[v] += counts[v - 1];
  for (let i = start; i < end; i++) {
    const dst = (start + counts[px[i * 3 + ch]]++) * 3;
    tmp[dst] = px[i * 3];
    tmp[dst + 1] = px[i * 3 + 1];
    tmp[dst + 2] = px[i * 3 + 2];
  }
  px.set(tmp.subarray(start * 3, end * 3), start * 3);
}

export function dominantColors(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opts: DominantOptions = {},
): DominantColor[] {
  const count = Math.max(1, Math.floor(opts.count ?? 5));
  const threshold = opts.alphaThreshold ?? 128;
  const maxSamples = Math.max(1, opts.maxSamples ?? 65536);
  const total = width * height;
  const stride = Math.max(1, Math.ceil(total / maxSamples));

  let n = 0;
  for (let i = 0; i < total; i += stride) if (data[i * 4 + 3] >= threshold) n++;
  if (n === 0) return [];
  const px = new Uint8Array(n * 3);
  let o = 0;
  for (let i = 0; i < total; i += stride) {
    const p = i * 4;
    if (data[p + 3] < threshold) continue;
    px[o++] = data[p];
    px[o++] = data[p + 1];
    px[o++] = data[p + 2];
  }
  const tmp = new Uint8Array(n * 3);

  const boxes: Box[] = [{ start: 0, end: n, ...measure(px, 0, n) }];
  while (boxes.length < count) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.range === 0 || b.end - b.start < 2) continue;
      const score = b.range * Math.sqrt(b.end - b.start);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    const box = boxes[best];
    sortByChannel(px, tmp, box.start, box.end, box.channel);
    // Split at the median, nudged so equal values are not divided when a
    // cleaner cut exists (keeps flat regions whole).
    let mid = (box.start + box.end) >> 1;
    const ch = box.channel;
    const v = px[mid * 3 + ch];
    let lo = mid;
    while (lo > box.start && px[(lo - 1) * 3 + ch] === v) lo--;
    let hi = mid;
    while (hi < box.end && px[hi * 3 + ch] === v) hi++;
    mid = lo > box.start && mid - lo <= hi - mid ? lo : hi < box.end ? hi : lo;
    if (mid <= box.start || mid >= box.end) {
      box.range = 0; // cannot split further
      continue;
    }
    boxes.splice(
      best,
      1,
      { start: box.start, end: mid, ...measure(px, box.start, mid) },
      { start: mid, end: box.end, ...measure(px, mid, box.end) },
    );
  }

  const out: DominantColor[] = boxes.map((b) => {
    let r = 0, g = 0, bl = 0;
    for (let i = b.start * 3; i < b.end * 3; i += 3) {
      r += px[i];
      g += px[i + 1];
      bl += px[i + 2];
    }
    const pop = b.end - b.start;
    return {
      color: { r: Math.round(r / pop), g: Math.round(g / pop), b: Math.round(bl / pop), a: 1 },
      population: pop,
      share: pop / n,
    };
  });
  out.sort((a, b) => b.population - a.population);
  return out;
}
