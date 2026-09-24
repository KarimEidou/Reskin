// Separable blurs over interleaved float data (1 channel for alpha planes,
// 4 for premultiplied RGBA). Outside the image counts as 0 (transparent), so
// shadows and glows fade out at the canvas edge instead of smearing.
//
// Gaussian blur uses an exact sampled kernel for small sigmas and three
// successive box blurs (O(1) per pixel regardless of radius) for large ones.

function boxPass(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  ch: number,
  r: number,
  horizontal: boolean,
): void {
  const n = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = (horizontal ? 1 : w) * ch;
  const lineStep = (horizontal ? w : 1) * ch;
  const inv = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    for (let c = 0; c < ch; c++) {
      const base = line * lineStep + c;
      let sum = 0;
      for (let k = 0; k <= r && k < n; k++) sum += src[base + k * step];
      for (let i = 0; i < n; i++) {
        dst[base + i * step] = sum * inv;
        const add = i + r + 1;
        const sub = i - r;
        if (add < n) sum += src[base + add * step];
        if (sub >= 0) sum -= src[base + sub * step];
      }
    }
  }
}

/** One box blur of radius `r` (window 2r+1) in both directions, in place. */
export function boxBlur(data: Float32Array, w: number, h: number, ch: number, r: number): void {
  const rr = Math.floor(r);
  if (rr < 1) return;
  const tmp = new Float32Array(data.length);
  boxPass(data, tmp, w, h, ch, rr, true);
  boxPass(tmp, data, w, h, ch, rr, false);
}

/** Box sizes whose triple convolution approximates a Gaussian (Kutskir). */
function boxesForGauss(sigma: number, n = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

function convolvePass(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  ch: number,
  kernel: Float32Array,
  horizontal: boolean,
): void {
  const r = (kernel.length - 1) >> 1;
  const n = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = (horizontal ? 1 : w) * ch;
  const lineStep = (horizontal ? w : 1) * ch;
  for (let line = 0; line < lines; line++) {
    for (let c = 0; c < ch; c++) {
      const base = line * lineStep + c;
      for (let i = 0; i < n; i++) {
        let v = 0;
        const k0 = Math.max(-r, -i);
        const k1 = Math.min(r, n - 1 - i);
        for (let k = k0; k <= k1; k++) v += src[base + (i + k) * step] * kernel[k + r];
        dst[base + i * step] = v;
      }
    }
  }
}

/** Gaussian blur with standard deviation `sigma` px, in place. */
export function gaussianBlur(data: Float32Array, w: number, h: number, ch: number, sigma: number): void {
  if (!(sigma > 0.2)) return;
  if (sigma < 2) {
    const k = gaussianKernel(sigma);
    const tmp = new Float32Array(data.length);
    convolvePass(data, tmp, w, h, ch, k, true);
    convolvePass(tmp, data, w, h, ch, k, false);
    return;
  }
  const tmp = new Float32Array(data.length);
  for (const size of boxesForGauss(sigma)) {
    const r = (size - 1) >> 1;
    if (r < 1) continue;
    boxPass(data, tmp, w, h, ch, r, true);
    boxPass(tmp, data, w, h, ch, r, false);
  }
}

/** Single-channel convenience. */
export function gaussianBlurPlane(plane: Float32Array, w: number, h: number, sigma: number): void {
  gaussianBlur(plane, w, h, 1, sigma);
}
