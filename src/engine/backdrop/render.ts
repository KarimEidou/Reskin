/**
 * Backdrop renderer: shape coverage → fill (+ border) → gloss → drop shadow,
 * composited in premultiplied float and written out as straight RGBA8.
 *
 * Border compositing splits each pixel's area by signed distance d into
 * {d < lo} (fill), {lo ≤ d < 0} (border over fill) and {0 ≤ d < hi}
 * (border alone), where [lo, hi] is the stroke band for the chosen
 * position. The pieces tile the pixel exactly, so there is no conflation
 * seam between fill and border.
 */
import { fromPremultiplied, gaussianBlur } from '../filters/blur-core';
import { colorOr } from '../filters/colormath';
import { gradientLutPremultiplied, resolveStops } from '../filters/gradient';
import { createPixels, type Pixels } from '../filters/types';
import { geometryCoverage, geometrySdf, shapeGeometry, type ShapeBox, type ShapeGeometry } from './shapes';
import { DEFAULT_STOPS, resolveBackdropSpec, type BackdropFill, type BackdropGloss, type BackdropSpec, type BackdropSpecInput } from './spec';

const LUT_SIZE = 1024;

/** The shape's box: a centred square of the shorter side, shrunk by `inset` × that side on every edge. */
export function shapeBox(inset: number, width: number, height: number): ShapeBox {
  const side = Math.min(width, height);
  const m = side * inset;
  return { x: (width - side) / 2 + m, y: (height - side) / 2 + m, w: side - 2 * m, h: side - 2 * m };
}

type FillFn = (x: number, y: number, out: Float64Array) => void;

/** Premultiplied (0..255) fill colour at a pixel centre. */
function makeFill(fill: BackdropFill, box: ShapeBox): FillFn {
  if (fill.type === 'solid') {
    const [r, g, b, a] = colorOr(fill.color, '#000000');
    const k = a / 255;
    const pr = r * k;
    const pg = g * k;
    const pb = b * k;
    return (_x, _y, out) => {
      out[0] = pr;
      out[1] = pg;
      out[2] = pb;
      out[3] = a;
    };
  }
  const lut = gradientLutPremultiplied(resolveStops(fill.stops, DEFAULT_STOPS), LUT_SIZE);
  const last = LUT_SIZE - 1;
  const read = (t: number, out: Float64Array) => {
    const i = (t <= 0 ? 0 : t >= 1 ? last : Math.round(t * last)) * 4;
    out[0] = lut[i];
    out[1] = lut[i + 1];
    out[2] = lut[i + 2];
    out[3] = lut[i + 3];
  };
  if (fill.type === 'linear') {
    const rad = (fill.angle * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const len = Math.abs(box.w * dx) + Math.abs(box.h * dy) || 1;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    return (x, y, out) => read(((x - cx) * dx + (y - cy) * dy) / len + 0.5, out);
  }
  const cx = box.x + fill.cx * box.w;
  const cy = box.y + fill.cy * box.h;
  const r = fill.radius * Math.min(box.w, box.h) || 1;
  return (x, y, out) => {
    const dx = x - cx;
    const dy = y - cy;
    read(Math.sqrt(dx * dx + dy * dy) / r, out);
  };
}

/** Gloss alpha (0..1) at a pixel centre, before clipping to the shape. */
function makeGloss(g: BackdropGloss, box: ShapeBox): (x: number, y: number) => number {
  const top = box.y - box.h * 0.06;
  const bottom = box.y + box.h * g.size;
  const rx = box.w * 0.5 * 0.94;
  const ry = (bottom - top) / 2;
  const ecx = box.x + box.w / 2;
  const ecy = (top + bottom) / 2;
  const span = bottom - top;
  return (x, y) => {
    const dx = x - ecx;
    const dy = y - ecy;
    const ux = dx / rx;
    const uy = dy / ry;
    const k = Math.sqrt(ux * ux + uy * uy);
    let sd: number;
    if (k < 1e-9) sd = -Math.min(rx, ry);
    else {
      const gx = dx / (rx * rx);
      const gy = dy / (ry * ry);
      sd = ((k - 1) * k) / Math.sqrt(gx * gx + gy * gy);
    }
    const edge = sd >= 0.5 ? 0 : sd <= -0.5 ? 1 : 0.5 - sd;
    if (edge <= 0) return 0;
    const t = (y - top) / span;
    const fade = t <= 0 ? 1 : t >= 1 ? 0 : (1 - t) * (1 - t);
    return edge * g.opacity * (0.1 + 0.9 * fade);
  };
}

/** Bilinear shift of a single-channel image by (dx, dy); samples outside read as 0. */
function shiftZero(src: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  const out = new Float32Array(w * h);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[y * w + x]);
  for (let y = 0, i = 0; y < h; y++) {
    const sy = y - dy;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < w; x++, i++) {
      const sx = x - dx;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
      const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
      out[i] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}

function assertSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw new RangeError(`invalid backdrop size ${width}x${height}`);
  }
}

function geometryOf(spec: BackdropSpec, width: number, height: number): ShapeGeometry {
  return shapeGeometry(spec, shapeBox(spec.inset, width, height));
}

/**
 * Anti-aliased coverage (0..1) of the backdrop's shape alone (no border,
 * shadow or gloss) at width × height.
 */
export function backdropCoverage(input: BackdropSpecInput | BackdropSpec | null | undefined, width: number, height = width): Float32Array {
  assertSize(width, height);
  const spec = resolveBackdropSpec(input);
  return geometryCoverage(geometryOf(spec, width, height), width, height);
}

/** The backdrop's shape as a byte mask (0..255), e.g. for clipping an icon with `fitToShape`. */
export function backdropShapeMask(input: BackdropSpecInput | BackdropSpec | null | undefined, width: number, height = width): Uint8Array {
  const cov = backdropCoverage(input, width, height);
  const out = new Uint8Array(cov.length);
  for (let i = 0; i < cov.length; i++) out[i] = Math.round(cov[i] * 255);
  return out;
}

/** Renders a backdrop spec (partial specs are completed with defaults) as a size × size image. */
export function renderBackdrop(input?: BackdropSpecInput | BackdropSpec | null, size = 256): Pixels {
  assertSize(size, size);
  const spec = resolveBackdropSpec(input);
  const W = size;
  const H = size;
  const N = W * H;
  const box = shapeBox(spec.inset, W, H);
  const geom = shapeGeometry(spec, box);
  const res = new Float32Array(N * 4);
  const fill = makeFill(spec.fill, box);
  const F = new Float64Array(4);
  // Shape coverage per pixel (for clipping the gloss).
  let shapeCov: Float32Array;

  const bw = spec.border ? spec.border.width * size : 0;
  if (spec.border && bw > 0.01) {
    const pos = spec.border.position;
    const lo = pos === 'inside' ? -bw : pos === 'center' ? -bw / 2 : 0;
    const hi = lo + bw;
    const sd = geometrySdf(geom, W, H, bw + 2);
    shapeCov = new Float32Array(N);
    const [br, bg, bb, ba] = colorOr(spec.border.color, '#ffffff');
    const bk = ba / 255;
    const Br = br * bk;
    const Bg = bg * bk;
    const Bb = bb * bk;
    const Ba = ba;
    const keep = 1 - bk;
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i++) {
        const s = sd[i];
        let cLo = 0.5 + lo - s;
        cLo = cLo < 0 ? 0 : cLo > 1 ? 1 : cLo;
        let c0 = 0.5 - s;
        c0 = c0 < 0 ? 0 : c0 > 1 ? 1 : c0;
        let cHi = 0.5 + hi - s;
        cHi = cHi < 0 ? 0 : cHi > 1 ? 1 : cHi;
        shapeCov[i] = c0;
        if (cHi <= 0) continue;
        const inBand = c0 - cLo; // border over fill
        const outBand = cHi - c0; // border over nothing
        const o = i * 4;
        if (cLo > 0 || inBand > 0) {
          fill(x + 0.5, y + 0.5, F);
          res[o] = F[0] * cLo + (Br + F[0] * keep) * inBand + Br * outBand;
          res[o + 1] = F[1] * cLo + (Bg + F[1] * keep) * inBand + Bg * outBand;
          res[o + 2] = F[2] * cLo + (Bb + F[2] * keep) * inBand + Bb * outBand;
          res[o + 3] = F[3] * cLo + (Ba + F[3] * keep) * inBand + Ba * outBand;
        } else {
          res[o] = Br * outBand;
          res[o + 1] = Bg * outBand;
          res[o + 2] = Bb * outBand;
          res[o + 3] = Ba * outBand;
        }
      }
    }
  } else {
    shapeCov = geometryCoverage(geom, W, H);
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i++) {
        const c = shapeCov[i];
        if (c <= 0) continue;
        fill(x + 0.5, y + 0.5, F);
        const o = i * 4;
        res[o] = F[0] * c;
        res[o + 1] = F[1] * c;
        res[o + 2] = F[2] * c;
        res[o + 3] = F[3] * c;
      }
    }
  }

  if (spec.gloss && spec.gloss.opacity > 0) {
    const gloss = makeGloss(spec.gloss, box);
    const [gr, gg, gb, ga] = colorOr(spec.gloss.color, '#ffffff');
    const gk = ga / 255;
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i++) {
        const c = shapeCov[i];
        if (c <= 0) continue;
        const a = gloss(x + 0.5, y + 0.5) * c * gk;
        if (a <= 0) continue;
        const o = i * 4;
        const keep = 1 - a;
        res[o] = gr * a + res[o] * keep;
        res[o + 1] = gg * a + res[o + 1] * keep;
        res[o + 2] = gb * a + res[o + 2] * keep;
        res[o + 3] = 255 * a + res[o + 3] * keep;
      }
    }
  }

  if (spec.shadow && spec.shadow.opacity > 0) {
    const sh = spec.shadow;
    const [sr, sg, sb, sa0] = colorOr(sh.color, '#000000');
    const strength = sh.opacity * (sa0 / 255);
    if (strength > 0) {
      const alpha = new Float32Array(N);
      for (let i = 0; i < N; i++) alpha[i] = res[i * 4 + 3] / 255;
      const shadow = shiftZero(alpha, W, H, sh.offsetX * size, sh.offsetY * size);
      gaussianBlur(shadow, W, H, 1, sh.blur * size);
      for (let i = 0; i < N; i++) {
        const v = shadow[i] * strength;
        if (v <= 0) continue;
        const o = i * 4;
        const under = 1 - res[o + 3] / 255;
        if (under <= 0) continue;
        const k = v * under;
        res[o] += sr * k;
        res[o + 1] += sg * k;
        res[o + 2] += sb * k;
        res[o + 3] += 255 * k;
      }
    }
  }

  const out = createPixels(W, H);
  fromPremultiplied(res, out.data);
  return out;
}
