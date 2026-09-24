// Point sampling of premultiplied float images. Coordinates are continuous:
// pixel (i, j) covers [i, i+1) × [j, j+1) and its centre is (i+0.5, j+0.5).

import type { FloatImage } from './float-image';
import type { Surface } from './surface';
import type { Rgba } from '../color/color';

/** Outside the image: transparent black, or the nearest edge pixel. */
export type EdgeMode = 'transparent' | 'clamp';

export function sampleNearest(
  img: FloatImage,
  x: number,
  y: number,
  out: Float32Array | number[],
  o = 0,
  edge: EdgeMode = 'transparent',
): void {
  let ix = Math.floor(x);
  let iy = Math.floor(y);
  const { width: w, height: h, data } = img;
  if (ix < 0 || iy < 0 || ix >= w || iy >= h) {
    if (edge === 'transparent') {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      return;
    }
    ix = ix < 0 ? 0 : ix >= w ? w - 1 : ix;
    iy = iy < 0 ? 0 : iy >= h ? h - 1 : iy;
  }
  const i = (iy * w + ix) * 4;
  out[o] = data[i];
  out[o + 1] = data[i + 1];
  out[o + 2] = data[i + 2];
  out[o + 3] = data[i + 3];
}

export function sampleBilinear(
  img: FloatImage,
  x: number,
  y: number,
  out: Float32Array | number[],
  o = 0,
  edge: EdgeMode = 'transparent',
): void {
  const { width: w, height: h, data } = img;
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 2; j++) {
    let yy = y0 + j;
    const wy = j === 0 ? 1 - ty : ty;
    if (wy === 0) continue;
    if (yy < 0 || yy >= h) {
      if (edge === 'transparent') continue;
      yy = yy < 0 ? 0 : h - 1;
    }
    for (let i = 0; i < 2; i++) {
      let xx = x0 + i;
      const wgt = (i === 0 ? 1 - tx : tx) * wy;
      if (wgt === 0) continue;
      if (xx < 0 || xx >= w) {
        if (edge === 'transparent') continue;
        xx = xx < 0 ? 0 : w - 1;
      }
      const p = (yy * w + xx) * 4;
      r += data[p] * wgt;
      g += data[p + 1] * wgt;
      b += data[p + 2] * wgt;
      a += data[p + 3] * wgt;
    }
  }
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
  out[o + 3] = a;
}

/**
 * Average colour (premultiplied mean, returned straight) of the `size`×`size`
 * square of pixels centred on pixel (px, py). Pixels outside the surface are
 * not counted. Used by the eyedropper (1/3/5 px).
 */
export function averageColor(src: Surface, px: number, py: number, size = 1): Rgba {
  const half = Math.floor(Math.max(1, size) / 2);
  const d = src.data;
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let y = py - half; y <= py + half; y++) {
    if (y < 0 || y >= src.height) continue;
    for (let x = px - half; x <= px + half; x++) {
      if (x < 0 || x >= src.width) continue;
      const i = (y * src.width + x) * 4;
      const al = d[i + 3] / 255;
      r += d[i] * al;
      g += d[i + 1] * al;
      b += d[i + 2] * al;
      a += al;
      n++;
    }
  }
  if (n === 0 || a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: r / a, g: g / a, b: b / a, a: a / n };
}
