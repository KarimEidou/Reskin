/**
 * Shape geometry for backdrops (and for the icon helpers' shape clipping).
 *
 * Circle, rounded square and squircle are signed distance functions
 * (analytic, or a first-order distance estimate for the superellipse);
 * hexagon, shield and blob are polygons rendered by the scanline
 * rasterizer. Fillet arcs and the shield's Bézier curves are flattened to
 * within 0.05 px; the blob is sampled at 48 points per control span
 * (≈ 5 px segments at 512 px, well under a pixel of deviation).
 */
import { mulberry32 } from '../filters/prng';
import { insideMask, polygonSdf, rasterizePolygon, type Contour } from './raster';

export type BackdropShape = 'circle' | 'rounded' | 'squircle' | 'hexagon' | 'shield' | 'blob';

export const BACKDROP_SHAPES: readonly { id: BackdropShape; label: string }[] = [
  { id: 'circle', label: 'Circle' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'squircle', label: 'Squircle' },
  { id: 'hexagon', label: 'Hexagon' },
  { id: 'shield', label: 'Shield' },
  { id: 'blob', label: 'Blob' },
];

/** Axis-aligned box in pixels. */
export interface ShapeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Parameters that define a shape's outline inside its box. */
export interface ShapeOptions {
  shape: BackdropShape;
  /** Corner radius as a fraction of the box's shorter side (rounded, hexagon, shield), 0..0.5. */
  cornerRadius: number;
  /** Superellipse exponent for 'squircle' (2 = ellipse, ~5 = iOS-like, large → square). */
  squircleExponent: number;
  hexOrientation: 'pointy' | 'flat';
  blob: BlobOptions;
}

export interface BlobOptions {
  seed: number;
  /** Number of radial control points, 3..16. */
  points: number;
  /** Irregularity 0..1 (0 = a circle). */
  variance: number;
}

/**
 * Signed distance (px, negative inside) at a sample point. `band` is a
 * precision hint: where the true distance is at least `band`, an
 * implementation may return any value of the right sign whose magnitude is
 * ≥ `band` (callers clamp to ±band). Pass `Infinity` for exact values.
 */
export type Sdf = (x: number, y: number, band: number) => number;

/**
 * A shape as an SDF or as polygon contours. `mirror` (SDF shapes) is the
 * point the SDF is mirror-symmetric about in both axes; samplers use it to
 * evaluate one quadrant and mirror the rest when it is the canvas centre.
 */
export type ShapeGeometry = { kind: 'sdf'; sdf: Sdf; mirror?: { x: number; y: number } } | { kind: 'polygon'; contours: Float64Array[] };

// ---------------------------------------------------------------------------
// SDF shapes

export function circleSdf(cx: number, cy: number, r: number): Sdf {
  return (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return Math.sqrt(dx * dx + dy * dy) - r;
  };
}

/** Rounded rectangle centred at (cx, cy) with half-extents (hw, hh) and corner radius r. */
export function roundedRectSdf(cx: number, cy: number, hw: number, hh: number, r: number): Sdf {
  const rr = Math.max(0, Math.min(r, hw, hh));
  return (x, y) => {
    const qx = Math.abs(x - cx) - hw + rr;
    const qy = Math.abs(y - cy) - hh + rr;
    const ox = qx > 0 ? qx : 0;
    const oy = qy > 0 ? qy : 0;
    const inner = qx > qy ? qx : qy;
    return (inner < 0 ? inner : 0) + Math.sqrt(ox * ox + oy * oy) - rr;
  };
}

/** x^e for a small non-negative integer e, by multiplication. */
function ipow(x: number, e: number): number {
  let r = 1;
  let b = x;
  while (e > 0) {
    if (e & 1) r *= b;
    b *= b;
    e >>= 1;
  }
  return r;
}

/**
 * Superellipse |x/a|^n + |y/b|^n = 1 (n ≥ 1) centred at (cx, cy). Distance
 * is the first-order estimate (F − 1)/|∇F| with F the n-norm: exact on the
 * outline and accurate within the anti-aliasing band. Points provably at
 * least `band` away (outside the bounding box, or inside the inscribed
 * ellipse / square) skip the expensive root.
 */
export function superellipseSdf(cx: number, cy: number, a: number, b: number, n: number): Sdf {
  const m = Math.min(a, b);
  const inner = -m;
  const e1 = n - 1;
  const intExp = Number.isInteger(e1) && e1 >= 1 && e1 <= 32;
  const invN = 1 / n;
  // The square [−c, c]² (normalised) touches the outline at its corners: 2c^n = 1.
  const c = Math.pow(0.5, invN);
  const qa = c * a;
  const qb = c * b;
  // For n ≥ 2 the inscribed ellipse lies inside the superellipse.
  const ellipseInside = n >= 2;
  return (x, y, band) => {
    const ax = Math.abs(x - cx);
    const ay = Math.abs(y - cy);
    // Outside the bounding box: its distance is a lower bound.
    const ob = ax - a > ay - b ? ax - a : ay - b;
    if (ob >= band) return ob;
    const u = ax / a;
    const v = ay / b;
    // Inside the inscribed square or ellipse: their depth is a lower bound.
    const sq = qa - ax < qb - ay ? qa - ax : qb - ay;
    const el = ellipseInside ? (1 - Math.sqrt(u * u + v * v)) * m : -1;
    const depth = sq > el ? sq : el;
    if (depth >= band) return -depth;
    const un1 = intExp ? ipow(u, e1) : Math.pow(u, e1);
    const vn1 = intExp ? ipow(v, e1) : Math.pow(v, e1);
    const s = un1 * u + vn1 * v;
    if (s <= 0) return inner;
    const r = Math.pow(s, invN);
    const k = s / r; // r^(n−1)
    const gx = un1 / (a * k);
    const gy = vn1 / (b * k);
    const g = Math.sqrt(gx * gx + gy * gy);
    if (g < 1e-12) return inner;
    const d = (r - 1) / g;
    return d < inner ? inner : d;
  };
}

// ---------------------------------------------------------------------------
// Polygon construction

/** Max chord deviation when flattening arcs and curves, in px. */
const FLATNESS = 0.05;

function arcSteps(r: number, sweep: number): number {
  if (r <= FLATNESS) return 1;
  const step = 2 * Math.acos(1 - FLATNESS / r);
  return Math.max(1, Math.ceil(Math.abs(sweep) / step));
}

/** Appends an arc (centre, radius, start angle, sweep) excluding its start point. */
function pushArc(out: number[], cx: number, cy: number, r: number, a0: number, sweep: number): void {
  const n = arcSteps(r, sweep);
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
}

/**
 * Replaces each vertex of a closed polygon with a circular fillet of radius
 * `r` (reduced where the adjacent edges are too short).
 */
export function roundPolygon(pts: readonly number[], r: number): number[] {
  const m = pts.length >> 1;
  if (r <= 0 || m < 3) return [...pts];
  const out: number[] = [];
  for (let k = 0; k < m; k++) {
    const p = (k + m - 1) % m;
    const q = (k + 1) % m;
    const vx = pts[k * 2];
    const vy = pts[k * 2 + 1];
    let ax = pts[p * 2] - vx;
    let ay = pts[p * 2 + 1] - vy;
    let bx = pts[q * 2] - vx;
    let by = pts[q * 2 + 1] - vy;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) {
      out.push(vx, vy);
      continue;
    }
    ax /= la;
    ay /= la;
    bx /= lb;
    by /= lb;
    const cos = Math.max(-1, Math.min(1, ax * bx + ay * by));
    const theta = Math.acos(cos); // interior angle between the two edges
    if (theta < 1e-6 || Math.PI - theta < 1e-6) {
      out.push(vx, vy);
      continue;
    }
    const tanHalf = Math.tan(theta / 2);
    let t = r / tanHalf;
    const tMax = Math.min(la, lb) / 2;
    if (t > tMax) t = tMax;
    const rr = t * tanHalf;
    const t1x = vx + ax * t;
    const t1y = vy + ay * t;
    const t2x = vx + bx * t;
    const t2y = vy + by * t;
    let hx = ax + bx;
    let hy = ay + by;
    const hl = Math.hypot(hx, hy);
    hx /= hl;
    hy /= hl;
    const dc = rr / Math.sin(theta / 2);
    const cx = vx + hx * dc;
    const cy = vy + hy * dc;
    const a0 = Math.atan2(t1y - cy, t1x - cx);
    const a1 = Math.atan2(t2y - cy, t2x - cx);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    out.push(t1x, t1y);
    pushArc(out, cx, cy, rr, a0, sweep);
  }
  return out;
}

/**
 * Appends a cubic Bézier (excluding its start point), flattened uniformly
 * into the fewest segments whose chord error stays within FLATNESS: for n
 * segments the error is at most max|B''| / (8n²), with max|B''| = 6 · the
 * largest second difference of the control points.
 */
function pushCubic(out: number[], x0: number, y0: number, c1x: number, c1y: number, c2x: number, c2y: number, x1: number, y1: number): void {
  const dd = Math.max(Math.hypot(x0 - 2 * c1x + c2x, y0 - 2 * c1y + c2y), Math.hypot(c1x - 2 * c2x + x1, c1y - 2 * c2y + y1));
  const n = Math.max(4, Math.min(512, Math.ceil(Math.sqrt((0.75 * dd) / FLATNESS))));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push(a * x0 + b * c1x + c * c2x + d * x1, a * y0 + b * c1y + c * c2y + d * y1);
  }
}

/** Regular hexagon (as large as fits the box), optionally with filleted corners. */
export function hexagonPolygon(box: ShapeBox, orientation: 'pointy' | 'flat', cornerRadius: number): number[] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const sq3 = Math.sqrt(3);
  const R = orientation === 'pointy' ? Math.min(box.h / 2, box.w / sq3) : Math.min(box.w / 2, box.h / sq3);
  const start = orientation === 'pointy' ? -Math.PI / 2 : 0;
  const pts: number[] = [];
  for (let k = 0; k < 6; k++) {
    const a = start + (k * Math.PI) / 3;
    pts.push(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
  }
  return roundPolygon(pts, cornerRadius * Math.min(box.w, box.h));
}

/** Width : height of the shield outline. */
export const SHIELD_ASPECT = 0.86;

/** Heater shield: flat top with rounded corners, straight sides, curving to a point. */
export function shieldPolygon(box: ShapeBox, cornerRadius: number): number[] {
  const h = Math.min(box.h, box.w / SHIELD_ASPECT);
  const w = h * SHIELD_ASPECT;
  const x0 = box.x + (box.w - w) / 2;
  const y0 = box.y + (box.h - h) / 2;
  const x1 = x0 + w;
  const side = y0 + h * 0.46;
  const r = Math.max(0, Math.min(cornerRadius * Math.min(box.w, box.h), w / 2, h * 0.46));
  const out: number[] = [];
  out.push(x0 + r, y0);
  out.push(x1 - r, y0);
  if (r > 0) pushArc(out, x1 - r, y0 + r, r, -Math.PI / 2, Math.PI / 2);
  out.push(x1, side);
  pushCubic(out, x1, side, x1, y0 + h * 0.78, x0 + w * 0.76, y0 + h * 0.93, x0 + w / 2, y0 + h);
  pushCubic(out, x0 + w / 2, y0 + h, x0 + w * 0.24, y0 + h * 0.93, x0, y0 + h * 0.78, x0, side);
  out.push(x0, y0 + r);
  if (r > 0) pushArc(out, x0 + r, y0 + r, r, Math.PI, Math.PI / 2);
  // drop the duplicate closing point
  if (out.length >= 4 && Math.abs(out[out.length - 2] - out[0]) < 1e-9 && Math.abs(out[out.length - 1] - out[1]) < 1e-9) {
    out.length -= 2;
  }
  return out;
}

/**
 * The blob's control points as [angle, radius] pairs (radians, unit circle
 * scale), in increasing angle order. Deterministic per seed.
 */
export function blobControlPoints(opts: BlobOptions): number[] {
  const n = Math.max(3, Math.min(16, Math.round(opts.points)));
  const v = Math.max(0, Math.min(1, opts.variance));
  const rand = mulberry32(opts.seed);
  const pts: number[] = [];
  const step = (2 * Math.PI) / n;
  for (let k = 0; k < n; k++) {
    // Angular jitter stays within ±30 % of the spacing, so angles remain ordered.
    const a = -Math.PI / 2 + k * step + (rand() - 0.5) * step * 0.6 * v;
    const r = 1 - v * 0.55 * rand();
    pts.push(a, r);
  }
  return pts;
}

/**
 * Smooth closed blob: the radius is a periodic Catmull–Rom (cubic Hermite)
 * interpolation of the seeded control radii over angle, sampled into a
 * polygon, then scaled uniformly to fit and centred in the box. Being a
 * radial function it is always a simple (non-self-intersecting) outline,
 * and variance 0 gives an exact circle.
 */
export function blobPolygon(box: ShapeBox, opts: BlobOptions): number[] {
  const cp = blobControlPoints(opts);
  const n = cp.length >> 1;
  const TAU = 2 * Math.PI;
  // Periodic access: angle unwrapped by whole turns, radius repeated.
  const ang = (i: number) => cp[(((i % n) + n) % n) * 2] + Math.floor(i / n) * TAU;
  const rad = (i: number) => cp[(((i % n) + n) % n) * 2 + 1];
  const tangent = (i: number) => (rad(i + 1) - rad(i - 1)) / (ang(i + 1) - ang(i - 1));
  const samples = 48;
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = ang(i);
    const a1 = ang(i + 1);
    const da = a1 - a0;
    const r0 = rad(i);
    const r1 = rad(i + 1);
    const m0 = tangent(i) * da;
    const m1 = tangent(i + 1) * da;
    for (let s = 0; s < samples; s++) {
      const t = s / samples;
      const t2 = t * t;
      const t3 = t2 * t;
      const r = (2 * t3 - 3 * t2 + 1) * r0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * r1 + (t3 - t2) * m1;
      const a = a0 + da * t;
      raw.push(Math.cos(a) * r, Math.sin(a) * r);
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i] < minX) minX = raw[i];
    if (raw[i] > maxX) maxX = raw[i];
    if (raw[i + 1] < minY) minY = raw[i + 1];
    if (raw[i + 1] > maxY) maxY = raw[i + 1];
  }
  const scale = Math.min(box.w / (maxX - minX), box.h / (maxY - minY));
  const ox = box.x + box.w / 2 - ((minX + maxX) / 2) * scale;
  const oy = box.y + box.h / 2 - ((minY + maxY) / 2) * scale;
  const out: number[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i += 2) {
    out[i] = ox + raw[i] * scale;
    out[i + 1] = oy + raw[i + 1] * scale;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry → coverage

/** Builds the geometry of a shape filling `box`. */
export function shapeGeometry(opts: ShapeOptions, box: ShapeBox): ShapeGeometry {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const minSide = Math.min(box.w, box.h);
  const mirror = { x: cx, y: cy };
  switch (opts.shape) {
    case 'circle':
      return { kind: 'sdf', sdf: circleSdf(cx, cy, minSide / 2), mirror };
    case 'rounded':
      return { kind: 'sdf', sdf: roundedRectSdf(cx, cy, box.w / 2, box.h / 2, opts.cornerRadius * minSide), mirror };
    case 'squircle':
      return { kind: 'sdf', sdf: superellipseSdf(cx, cy, box.w / 2, box.h / 2, opts.squircleExponent), mirror };
    case 'hexagon':
      return { kind: 'polygon', contours: [Float64Array.from(hexagonPolygon(box, opts.hexOrientation, opts.cornerRadius))] };
    case 'shield':
      return { kind: 'polygon', contours: [Float64Array.from(shieldPolygon(box, opts.cornerRadius))] };
    case 'blob':
      return { kind: 'polygon', contours: [Float64Array.from(blobPolygon(box, opts.blob))] };
  }
}

/**
 * Evaluates an SDF at every pixel centre (clamped to ±band when given).
 * When `mirror` is the canvas centre (the SDF is symmetric about it in both
 * axes), only the top-left quadrant is evaluated and mirrored.
 */
export function sampleSdf(sdf: Sdf, width: number, height: number, band = Infinity, mirror?: { x: number; y: number }): Float32Array {
  const out = new Float32Array(width * height);
  const sym = mirror !== undefined && Math.abs(2 * mirror.x - width) < 1e-9 && Math.abs(2 * mirror.y - height) < 1e-9;
  const w = sym ? (width + 1) >> 1 : width;
  const h = sym ? (height + 1) >> 1 : height;
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5;
    const row = y * width;
    const mrow = (height - 1 - y) * width;
    for (let x = 0; x < w; x++) {
      let d = sdf(x + 0.5, cy, band);
      d = d > band ? band : d < -band ? -band : d;
      out[row + x] = d;
      if (sym) {
        const mx = width - 1 - x;
        out[row + mx] = d;
        out[mrow + x] = d;
        out[mrow + mx] = d;
      }
    }
  }
  return out;
}

/** Anti-aliased area coverage (0..1) of a geometry. */
export function geometryCoverage(g: ShapeGeometry, width: number, height: number): Float32Array {
  if (g.kind === 'polygon') return rasterizePolygon(g.contours as Contour[], width, height);
  const cov = sampleSdf(g.sdf, width, height, 2, g.mirror);
  for (let i = 0; i < cov.length; i++) {
    const c = 0.5 - cov[i];
    cov[i] = c < 0 ? 0 : c > 1 ? 1 : c;
  }
  return cov;
}

/** Signed distance field of a geometry, accurate within ±band px. */
export function geometrySdf(g: ShapeGeometry, width: number, height: number, band: number): Float32Array {
  if (g.kind === 'polygon') return polygonSdf(g.contours as Contour[], width, height, band);
  return sampleSdf(g.sdf, width, height, band, g.mirror);
}

/** 1 where the pixel centre lies inside the geometry. */
export function geometryInside(g: ShapeGeometry, width: number, height: number): Uint8Array {
  if (g.kind === 'polygon') return insideMask(g.contours as Contour[], width, height);
  const out = new Uint8Array(width * height);
  for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) out[i] = g.sdf(x + 0.5, y + 0.5, 1) < 0 ? 1 : 0;
  return out;
}
