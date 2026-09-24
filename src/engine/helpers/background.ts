/**
 * Background removal for icons on a solid backdrop.
 *
 * 1. The reference background colour is the per-channel median of the
 *    image border (premultiplied, so transparent borders compare equal).
 * 2. A 4-connected flood fill starts from every border pixel within
 *    `tolerance` of that colour and spreads through similar pixels. Regions
 *    of the same colour that do not connect to the border (e.g. a white
 *    shape inside the icon) are never touched.
 * 3. Pixels bordering the removed region get fractional alpha from how far
 *    their colour is from the background relative to nearby solid
 *    foreground (un-mixing anti-aliased edges), with the background colour
 *    removed from their RGB ("decontamination").
 * 4. Optional `feather` fades alpha over that many px inwards, using an
 *    exact distance transform to the removed region.
 */
import type { Rgba } from '../filters/colormath';
import { assertPixels, type Mask, type Pixels } from '../filters/types';
import { beginOutput, finishOutput, identityOutput, smoothstep } from '../filters/util';
import { distanceTransform } from './distance';

export interface RemoveBackgroundOptions {
  /** Colour tolerance 0..100 (% of full RMS channel difference). Default 12. */
  tolerance?: number;
  /** Inward edge fade in px, 0..20. Default 1. */
  feather?: number;
}

export interface BackgroundDetection {
  /** 1 where the pixel belongs to the removable background region. */
  region: Uint8Array;
  /** Reference background colour (straight RGBA). */
  color: Rgba;
  /** Number of background pixels. */
  count: number;
}

interface Detection extends BackgroundDetection {
  /** Colour distance of every pixel from the reference (0..255 scale). */
  distance: Float32Array;
  /** Tolerance threshold on that scale. */
  threshold: number;
  /** Premultiplied reference colour. */
  ref: Float64Array;
}

function median(hist: Uint32Array, total: number): number {
  const half = total / 2;
  let acc = 0;
  for (let v = 0; v < hist.length; v++) {
    acc += hist[v];
    if (acc >= half) return v;
  }
  return hist.length - 1;
}

function detect(src: Pixels, tolerance: number): Detection {
  assertPixels(src, 'src');
  const { width: w, height: h, data: s } = src;
  const n = w * h;
  const region = new Uint8Array(n);
  const distance = new Float32Array(n);
  const ref = new Float64Array(4);
  const threshold = (Math.max(0, Math.min(100, tolerance)) / 100) * 255;
  if (n === 0) return { region, color: [0, 0, 0, 0], count: 0, distance, threshold, ref };

  // Border pixels, each once.
  const border: number[] = [];
  for (let x = 0; x < w; x++) {
    border.push(x);
    if (h > 1) border.push((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    border.push(y * w);
    if (w > 1) border.push(y * w + w - 1);
  }
  const hists = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (const p of border) {
    const i = p * 4;
    const k = s[i + 3] / 255;
    hists[0][Math.round(s[i] * k)]++;
    hists[1][Math.round(s[i + 1] * k)]++;
    hists[2][Math.round(s[i + 2] * k)]++;
    hists[3][s[i + 3]]++;
  }
  for (let c = 0; c < 4; c++) ref[c] = median(hists[c], border.length);
  const ra = ref[3];
  const color: Rgba = ra > 0 ? [Math.round((ref[0] * 255) / ra), Math.round((ref[1] * 255) / ra), Math.round((ref[2] * 255) / ra), ra] : [0, 0, 0, 0];

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const k = s[i + 3] / 255;
    const dr = s[i] * k - ref[0];
    const dg = s[i + 1] * k - ref[1];
    const db = s[i + 2] * k - ref[2];
    const dc = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
    const da = Math.abs(s[i + 3] - ra);
    distance[p] = dc > da ? dc : da;
  }

  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (const p of border) {
    if (!region[p] && distance[p] <= threshold) {
      region[p] = 1;
      queue[tail++] = p;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    if (x > 0 && !region[p - 1] && distance[p - 1] <= threshold) {
      region[p - 1] = 1;
      queue[tail++] = p - 1;
    }
    if (x < w - 1 && !region[p + 1] && distance[p + 1] <= threshold) {
      region[p + 1] = 1;
      queue[tail++] = p + 1;
    }
    if (p >= w && !region[p - w] && distance[p - w] <= threshold) {
      region[p - w] = 1;
      queue[tail++] = p - w;
    }
    if (p + w < n && !region[p + w] && distance[p + w] <= threshold) {
      region[p + w] = 1;
      queue[tail++] = p + w;
    }
  }
  return { region, color, count: tail, distance, threshold, ref };
}

/** Finds the background region `removeBackground` would clear (for previews / selections). */
export function detectBackground(src: Pixels, opts: RemoveBackgroundOptions = {}): BackgroundDetection {
  const { region, color, count } = detect(src, opts.tolerance ?? 12);
  return { region, color, count };
}

/**
 * Makes the background connected to the image border transparent, with
 * anti-aliased, decontaminated and optionally feathered edges. With a
 * selection `mask`, only selected pixels change.
 */
export function removeBackground(src: Pixels, opts: RemoveBackgroundOptions = {}, mask?: Mask | null): Pixels {
  const det = detect(src, opts.tolerance ?? 12);
  if (det.count === 0) return identityOutput(src, mask, undefined);
  const feather = Math.max(0, Math.min(20, opts.feather ?? 1));
  const { width: w, height: h, data: s } = src;
  const { region, distance, ref } = det;
  const toBg = distanceTransform(region, w, h);
  const dst = beginOutput(src, mask, undefined);
  const d = dst.data;
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      const i = p * 4;
      if (region[p]) {
        d[i] = 0;
        d[i + 1] = 0;
        d[i + 2] = 0;
        d[i + 3] = 0;
        continue;
      }
      // Work premultiplied: an edge pixel is P = mix·F + (1 − mix)·B, so its
      // foreground part is P − (1 − mix)·B. For an opaque B that both lowers
      // alpha and removes the background tint; for a transparent B it is a no-op.
      const k = s[i + 3] / 255;
      let pr = s[i] * k;
      let pg = s[i + 1] * k;
      let pb = s[i + 2] * k;
      let pa = s[i + 3];
      const near = toBg[p];
      if (near < 1.5) {
        // Solid foreground contrast nearby: the largest distance in the 5×5 neighbourhood.
        let fg = 0;
        for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2); yy++) {
          for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) {
            const q = yy * w + xx;
            if (!region[q] && distance[q] > fg) fg = distance[q];
          }
        }
        const mix = fg > det.threshold ? Math.min(1, distance[p] / fg) : 1;
        const bgShare = 1 - mix;
        if (bgShare > 0) {
          pa = Math.max(0, pa - bgShare * ref[3]);
          pr = Math.min(pa, Math.max(0, pr - bgShare * ref[0]));
          pg = Math.min(pa, Math.max(0, pg - bgShare * ref[1]));
          pb = Math.min(pa, Math.max(0, pb - bgShare * ref[2]));
        }
      }
      if (pa <= 0) {
        d[i] = 0;
        d[i + 1] = 0;
        d[i + 2] = 0;
        d[i + 3] = 0;
        continue;
      }
      const inv = 255 / pa;
      d[i] = pr * inv;
      d[i + 1] = pg * inv;
      d[i + 2] = pb * inv;
      // The feather fades alpha only; straight colour is unaffected.
      d[i + 3] = feather > 0 ? pa * smoothstep(0.5, 0.5 + feather, near) : pa;
    }
  }
  return finishOutput(src, dst, mask);
}
