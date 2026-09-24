/**
 * Anti-aliased polygon coverage.
 *
 * Coordinates are in pixels: pixel (i, j) covers [i, i+1) × [j, j+1) and its
 * centre is (i + ½, j + ½). Contours are flat `[x0, y0, x1, y1, …]` lists,
 * implicitly closed, filled with the non-zero winding rule.
 *
 * `rasterizePolygon` is a scanline rasterizer with `samplesY` sub-scanlines
 * per pixel row and exact horizontal span coverage (fractional span ends),
 * i.e. an ∞ × N supersampling. Cost is O(rows × N × edges + pixels).
 */

export type Contour = Float64Array | readonly number[];

interface Edges {
  x0: Float64Array;
  y0: Float64Array;
  y1: Float64Array;
  slope: Float64Array;
  dir: Int8Array;
  count: number;
  yMin: number;
  yMax: number;
}

function buildEdges(contours: readonly Contour[]): Edges {
  let total = 0;
  for (const c of contours) total += c.length >> 1;
  const x0 = new Float64Array(total);
  const y0 = new Float64Array(total);
  const y1 = new Float64Array(total);
  const slope = new Float64Array(total);
  const dir = new Int8Array(total);
  let n = 0;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const c of contours) {
    const m = c.length >> 1;
    for (let k = 0; k < m; k++) {
      const ax = c[k * 2];
      const ay = c[k * 2 + 1];
      const j = k + 1 === m ? 0 : k + 1;
      const bx = c[j * 2];
      const by = c[j * 2 + 1];
      if (ay === by || !Number.isFinite(ax + ay + bx + by)) continue;
      const down = ay < by;
      x0[n] = down ? ax : bx;
      y0[n] = down ? ay : by;
      y1[n] = down ? by : ay;
      slope[n] = (bx - ax) / (by - ay);
      dir[n] = down ? 1 : -1;
      if (y0[n] < yMin) yMin = y0[n];
      if (y1[n] > yMax) yMax = y1[n];
      n++;
    }
  }
  return { x0, y0, y1, slope, dir, count: n, yMin, yMax };
}

/**
 * Collects the crossings of the horizontal line `sy` with all edges into
 * xs/ds (sorted by x) and returns how many there are.
 */
function crossings(e: Edges, sy: number, xs: Float64Array, ds: Int8Array): number {
  let n = 0;
  for (let k = 0; k < e.count; k++) {
    if (sy >= e.y0[k] && sy < e.y1[k]) {
      const x = e.x0[k] + (sy - e.y0[k]) * e.slope[k];
      const d = e.dir[k];
      // insertion sort (crossing counts per line are small)
      let j = n;
      while (j > 0 && xs[j - 1] > x) {
        xs[j] = xs[j - 1];
        ds[j] = ds[j - 1];
        j--;
      }
      xs[j] = x;
      ds[j] = d;
      n++;
    }
  }
  return n;
}

/** Coverage in [0, 1] per pixel (row-major w×h) of the contours' non-zero fill. */
export function rasterizePolygon(contours: readonly Contour[], width: number, height: number, samplesY = 16): Float32Array {
  const cov = new Float32Array(width * height);
  const e = buildEdges(contours);
  if (e.count === 0 || width === 0 || height === 0) return cov;
  const xs = new Float64Array(e.count);
  const ds = new Int8Array(e.count);
  const part = new Float64Array(width + 2);
  const diff = new Float64Array(width + 2);
  const wgt = 1 / samplesY;
  const rowStart = Math.max(0, Math.floor(e.yMin));
  const rowEnd = Math.min(height, Math.ceil(e.yMax));
  for (let py = rowStart; py < rowEnd; py++) {
    part.fill(0);
    diff.fill(0);
    let any = false;
    for (let s = 0; s < samplesY; s++) {
      const n = crossings(e, py + (s + 0.5) * wgt, xs, ds);
      let wind = 0;
      let start = 0;
      for (let k = 0; k < n; k++) {
        const prev = wind;
        wind += ds[k];
        if (prev === 0 && wind !== 0) start = xs[k];
        else if (prev !== 0 && wind === 0) {
          const xa = start < 0 ? 0 : start;
          const xb = xs[k] > width ? width : xs[k];
          if (xb <= xa) continue;
          any = true;
          const ia = Math.floor(xa);
          const ib = Math.floor(xb);
          if (ia === ib) {
            part[ia] += (xb - xa) * wgt;
          } else {
            part[ia] += (ia + 1 - xa) * wgt;
            diff[ia + 1] += wgt;
            diff[ib] -= wgt;
            if (ib < width) part[ib] += (xb - ib) * wgt;
          }
        }
      }
    }
    if (!any) continue;
    const row = py * width;
    let run = 0;
    for (let x = 0; x < width; x++) {
      run += diff[x];
      const v = part[x] + run;
      cov[row + x] = v > 1 ? 1 : v < 0 ? 0 : v;
    }
  }
  return cov;
}

/** 1 where the pixel centre is inside the contours (non-zero rule), else 0. */
export function insideMask(contours: readonly Contour[], width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const e = buildEdges(contours);
  if (e.count === 0) return out;
  const xs = new Float64Array(e.count);
  const ds = new Int8Array(e.count);
  const rowStart = Math.max(0, Math.floor(e.yMin - 0.5));
  const rowEnd = Math.min(height, Math.ceil(e.yMax));
  for (let py = rowStart; py < rowEnd; py++) {
    const n = crossings(e, py + 0.5, xs, ds);
    let wind = 0;
    let start = 0;
    for (let k = 0; k < n; k++) {
      const prev = wind;
      wind += ds[k];
      if (prev === 0 && wind !== 0) start = xs[k];
      else if (prev !== 0 && wind === 0) {
        // pixel centres x + ½ in [start, xs[k])
        const x0 = Math.max(0, Math.ceil(start - 0.5));
        const x1 = Math.min(width, Math.ceil(xs[k] - 0.5));
        out.fill(1, py * width + x0, py * width + Math.max(x0, x1));
      }
    }
  }
  return out;
}

/**
 * Signed distance (px) from each pixel centre to the contours' outline,
 * negative inside, clamped to ±`band`. Distances are exact within the band
 * (closest point on any edge). Each edge only visits the pixels of its
 * band-wide capsule (per row: the x-range within `band` of the edge's
 * extent), and compares squared distances, so cost is about
 * edges × (π·band² + 2·band·length) cheap evaluations.
 */
export function polygonSdf(contours: readonly Contour[], width: number, height: number, band: number): Float32Array {
  const n = width * height;
  const b2 = band * band;
  const d2 = new Float64Array(n).fill(b2);
  for (const c of contours) {
    const m = c.length >> 1;
    for (let k = 0; k < m; k++) {
      const ax = c[k * 2];
      const ay = c[k * 2 + 1];
      const j = k + 1 === m ? 0 : k + 1;
      const bx = c[j * 2];
      const by = c[j * 2 + 1];
      if (!Number.isFinite(ax + ay + bx + by)) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const inv = len2 > 0 ? 1 / len2 : 0;
      const exMin = ax < bx ? ax : bx;
      const exMax = ax < bx ? bx : ax;
      const eyMin = ay < by ? ay : by;
      const eyMax = ay < by ? by : ay;
      const y0 = Math.max(0, Math.floor(eyMin - band - 0.5));
      const y1 = Math.min(height - 1, Math.ceil(eyMax + band - 0.5));
      for (let py = y0; py <= y1; py++) {
        const cy = py + 0.5;
        // Every point within `band` of the edge lies within `reach` (horizontally) of its x-extent on this row.
        const gy = cy < eyMin ? eyMin - cy : cy > eyMax ? cy - eyMax : 0;
        const rem = b2 - gy * gy;
        if (rem < 0) continue;
        const reach = Math.sqrt(rem);
        const x0 = Math.max(0, Math.floor(exMin - reach - 0.5));
        const x1 = Math.min(width - 1, Math.ceil(exMax + reach - 0.5));
        const qy = cy - ay;
        const row = py * width;
        let qx = x0 + 0.5 - ax;
        for (let px = x0; px <= x1; px++, qx++) {
          let t = (qx * dx + qy * dy) * inv;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = qx - t * dx;
          const ey = qy - t * dy;
          const e2 = ex * ex + ey * ey;
          if (e2 < d2[row + px]) d2[row + px] = e2;
        }
      }
    }
  }
  const inside = insideMask(contours, width, height);
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(d2[i]);
    dist[i] = inside[i] ? -d : d;
  }
  return dist;
}

/** Shoelace area of a contour (positive for clockwise in y-down coordinates). */
export function contourArea(c: Contour): number {
  const m = c.length >> 1;
  let a = 0;
  for (let k = 0; k < m; k++) {
    const j = k + 1 === m ? 0 : k + 1;
    a += c[k * 2] * c[j * 2 + 1] - c[j * 2] * c[k * 2 + 1];
  }
  return a / 2;
}
