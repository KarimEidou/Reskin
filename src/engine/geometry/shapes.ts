// Shape geometry → flat polygons for the coverage rasterizer, plus stroke
// outlines. Curves are flattened finely enough (≤ 0.05 px deviation) that
// the anti-aliased result is indistinguishable from an analytic one.
//
// Strokes are built as a union of positively oriented pieces — one quad per
// segment, a join wedge per vertex and caps — so they are correct for any
// path (concave, self-intersecting) under the nonzero rule.

import { orientPositive } from './rasterize';

export type ShapeKind =
  | 'rect'
  | 'roundedRect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'polygon'
  | 'star'
  | 'heart'
  | 'squircle';

export const SHAPE_KINDS: readonly ShapeKind[] = [
  'rect',
  'roundedRect',
  'ellipse',
  'line',
  'arrow',
  'polygon',
  'star',
  'heart',
  'squircle',
];

export type LineJoin = 'miter' | 'round';
export type LineCap = 'butt' | 'round' | 'square';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Maximum distance between a flattened curve and the true one, px. */
const FLATNESS = 0.02;

/** Segments needed to flatten an arc of `radius` spanning `angle` radians. */
export function arcSegments(radius: number, angle = Math.PI * 2): number {
  if (radius <= FLATNESS) return 4;
  const step = 2 * Math.acos(Math.max(-1, 1 - FLATNESS / radius));
  return Math.min(2048, Math.max(4, Math.ceil(Math.abs(angle) / step)));
}

export function boxFromPoints(x0: number, y0: number, x1: number, y1: number): Box {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

export function rectPolygon(b: Box): number[] {
  return [b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.h, b.x, b.y + b.h];
}

/**
 * Radius scale that gives a regular n-gon the same area as its circle, so
 * the flattened outline straddles the true curve instead of sitting inside
 * it (no systematic area loss on small circles).
 */
function areaPreservingScale(n: number): number {
  const a = (2 * Math.PI) / n;
  return Math.sqrt(a / Math.sin(a));
}

export function ellipsePolygon(b: Box): number[] {
  const n = arcSegments(Math.max(b.w, b.h) / 2);
  const k = areaPreservingScale(n);
  const rx = (b.w / 2) * k;
  const ry = (b.h / 2) * k;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry);
  }
  return out;
}

export function roundedRectPolygon(b: Box, radius: number): number[] {
  const r = Math.max(0, Math.min(radius, b.w / 2, b.h / 2));
  if (r <= 0) return rectPolygon(b);
  const n = arcSegments(r, Math.PI / 2);
  const out: number[] = [];
  const corners: [number, number, number][] = [
    [b.x + b.w - r, b.y + r, -Math.PI / 2],
    [b.x + b.w - r, b.y + b.h - r, 0],
    [b.x + r, b.y + b.h - r, Math.PI / 2],
    [b.x + r, b.y + r, Math.PI],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= n; i++) {
      const t = start + (i / n) * (Math.PI / 2);
      out.push(cx + Math.cos(t) * r, cy + Math.sin(t) * r);
    }
  }
  return out;
}

/** Regular N-gon inscribed in the box's ellipse, first vertex at the top. */
export function regularPolygon(b: Box, sides: number): number[] {
  const n = Math.max(3, Math.floor(sides));
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = -Math.PI / 2 + (i / n) * Math.PI * 2;
    out.push(cx + (Math.cos(t) * b.w) / 2, cy + (Math.sin(t) * b.h) / 2);
  }
  return out;
}

/** N-pointed star; `innerRatio` is the inner radius as a fraction of the outer. */
export function starPolygon(b: Box, points: number, innerRatio: number): number[] {
  const n = Math.max(2, Math.floor(points));
  const k = Math.max(0.01, Math.min(1, innerRatio));
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const out: number[] = [];
  for (let i = 0; i < n * 2; i++) {
    const t = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? 1 : k;
    out.push(cx + (Math.cos(t) * b.w * r) / 2, cy + (Math.sin(t) * b.h * r) / 2);
  }
  return out;
}

/** Classic parametric heart, scaled to fill the box. */
export function heartPolygon(b: Box): number[] {
  const n = arcSegments(Math.max(b.w, b.h) / 2) * 2;
  const raw: number[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const s = Math.sin(t);
    const x = 16 * s * s * s;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    raw.push(x, y);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const sx = b.w / (x1 - x0);
  const sy = b.h / (y1 - y0);
  const out: number[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i += 2) {
    out[i] = b.x + (raw[i] - x0) * sx;
    out[i + 1] = b.y + (raw[i + 1] - y0) * sy;
  }
  return out;
}

/** Superellipse |x/a|^n + |y/b|^n = 1 (n = 4 is the classic squircle). */
export function squirclePolygon(b: Box, exponent = 4): number[] {
  const a = b.w / 2;
  const bb = b.h / 2;
  const cx = b.x + a;
  const cy = b.y + bb;
  const e = 2 / Math.max(2, exponent);
  const n = arcSegments(Math.max(a, bb)) * 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push(cx + Math.sign(c) * Math.abs(c) ** e * a, cy + Math.sign(s) * Math.abs(s) ** e * bb);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strokes
// ---------------------------------------------------------------------------

function discPolygon(cx: number, cy: number, r: number): number[] {
  return ellipsePolygon({ x: cx - r, y: cy - r, w: 2 * r, h: 2 * r });
}

/** Removes consecutive duplicate points (and the closing duplicate when closed). */
function dedupe(pts: ArrayLike<number>, closed: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2] - x) < 1e-9 && Math.abs(out[n - 1] - y) < 1e-9) continue;
    out.push(x, y);
  }
  if (closed && out.length >= 4) {
    const n = out.length;
    if (Math.abs(out[0] - out[n - 2]) < 1e-9 && Math.abs(out[1] - out[n - 1]) < 1e-9) out.length = n - 2;
  }
  return out;
}

export interface StrokeOptions {
  width: number;
  closed: boolean;
  join?: LineJoin;
  cap?: LineCap;
  /** Miter length limit in multiples of half the width (default 4). */
  miterLimit?: number;
}

/** Outline pieces of a stroked polyline; rasterize them with the nonzero rule. */
export function strokePolygons(points: ArrayLike<number>, opts: StrokeOptions): number[][] {
  const hw = opts.width / 2;
  if (!(hw > 0)) return [];
  const join = opts.join ?? 'miter';
  const cap = opts.cap ?? 'butt';
  const limit = opts.miterLimit ?? 4;
  const pts = dedupe(points, opts.closed);
  const n = pts.length >> 1;
  if (n === 0) return [];
  if (n === 1) return cap === 'butt' ? [] : [orientPositive(discPolygon(pts[0], pts[1], hw))];

  const segs = opts.closed ? n : n - 1;
  const out: number[][] = [];
  // Segment directions and left normals.
  const dx: number[] = [];
  const dy: number[] = [];
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const vx = pts[j * 2] - pts[i * 2];
    const vy = pts[j * 2 + 1] - pts[i * 2 + 1];
    const len = Math.hypot(vx, vy);
    dx.push(vx / len);
    dy.push(vy / len);
  }
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    let ax = pts[i * 2], ay = pts[i * 2 + 1];
    let bx = pts[j * 2], by = pts[j * 2 + 1];
    if (!opts.closed && cap === 'square') {
      if (i === 0) {
        ax -= dx[i] * hw;
        ay -= dy[i] * hw;
      }
      if (i === segs - 1) {
        bx += dx[i] * hw;
        by += dy[i] * hw;
      }
    }
    const nx = -dy[i] * hw;
    const ny = dx[i] * hw;
    out.push(orientPositive([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]));
  }
  // Joins.
  const first = opts.closed ? 0 : 1;
  const last = opts.closed ? n - 1 : n - 2;
  for (let v = first; v <= last; v++) {
    const i1 = (v - 1 + segs) % segs; // incoming segment
    const i2 = v % segs; // outgoing segment
    const piece = joinPiece(pts[v * 2], pts[v * 2 + 1], dx[i1], dy[i1], dx[i2], dy[i2], hw, join, limit);
    if (piece) out.push(piece);
  }
  if (!opts.closed && cap === 'round') {
    out.push(orientPositive(discPolygon(pts[0], pts[1], hw)));
    out.push(orientPositive(discPolygon(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1], hw)));
  }
  return out;
}

function joinPiece(
  vx: number,
  vy: number,
  d1x: number,
  d1y: number,
  d2x: number,
  d2y: number,
  hw: number,
  join: LineJoin,
  limit: number,
): number[] | null {
  const cross = d1x * d2y - d1y * d2x;
  const dot = d1x * d2x + d1y * d2y;
  if (Math.abs(cross) < 1e-9 && dot > 0) return null; // straight through
  // Left normals; the outer side is opposite to the turn.
  let n1x = -d1y, n1y = d1x, n2x = -d2y, n2y = d2x;
  if ((n1x + n2x) * (d1x - d2x) + (n1y + n2y) * (d1y - d2y) < 0) {
    n1x = -n1x;
    n1y = -n1y;
    n2x = -n2x;
    n2y = -n2y;
  }
  const ax = vx + n1x * hw, ay = vy + n1y * hw;
  const bx = vx + n2x * hw, by = vy + n2y * hw;
  if (join === 'round') {
    const a0 = Math.atan2(n1y, n1x);
    let da = Math.atan2(n2y, n2x) - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const steps = arcSegments(hw, da);
    const pts = [vx, vy];
    for (let s = 0; s <= steps; s++) {
      const t = a0 + (da * s) / steps;
      pts.push(vx + Math.cos(t) * hw, vy + Math.sin(t) * hw);
    }
    return orientPositive(pts);
  }
  // Miter: intersection of the two offset edges along the bisector.
  const mx = n1x + n2x;
  const my = n1y + n2y;
  const mlen = Math.hypot(mx, my);
  if (mlen > 1e-9) {
    const ux = mx / mlen;
    const uy = my / mlen;
    const cosHalf = ux * n1x + uy * n1y;
    const miter = cosHalf > 1e-9 ? hw / cosHalf : Infinity;
    if (miter <= limit * hw) {
      return orientPositive([vx, vy, ax, ay, vx + ux * miter, vy + uy * miter, bx, by]);
    }
  }
  return orientPositive([vx, vy, ax, ay, bx, by]); // bevel
}

// ---------------------------------------------------------------------------
// Shape tool geometry
// ---------------------------------------------------------------------------

export interface ShapeSpec {
  kind: ShapeKind;
  /** Drag start / end in document px (for lines: the endpoints). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** roundedRect corner radius, px. */
  cornerRadius: number;
  /** polygon sides / star points. */
  sides: number;
  /** star inner radius ratio 0..1. */
  innerRatio: number;
  /** Stroke width used to inset closed shapes so the stroke stays inside the dragged box. */
  strokeWidth: number;
  stroke: boolean;
}

export interface ShapeGeometry {
  /** Fillable outline (closed shapes only). */
  fill: number[][];
  /** Stroke outline pieces (nonzero union). */
  stroke: number[][];
}

/** Arrow head length and half-width for a given stroke width. */
export function arrowHeadSize(width: number): { length: number; halfWidth: number } {
  return { length: Math.max(width * 3.5, 12), halfWidth: Math.max(width * 2, 7) };
}

export function shapeGeometry(spec: ShapeSpec): ShapeGeometry {
  const sw = spec.stroke ? Math.max(0, spec.strokeWidth) : 0;
  if (spec.kind === 'line' || spec.kind === 'arrow') {
    return lineGeometry(spec, Math.max(sw, 1));
  }
  const outer = boxFromPoints(spec.x0, spec.y0, spec.x1, spec.y1);
  // Inset by half the stroke so the stroke's outer edge meets the drag box.
  const inset = sw / 2;
  const b: Box = {
    x: outer.x + inset,
    y: outer.y + inset,
    w: Math.max(0, outer.w - sw),
    h: Math.max(0, outer.h - sw),
  };
  let poly: number[];
  let join: LineJoin = 'round';
  switch (spec.kind) {
    case 'rect':
      poly = rectPolygon(b);
      join = 'miter';
      break;
    case 'roundedRect':
      poly = roundedRectPolygon(b, Math.max(0, spec.cornerRadius - inset));
      break;
    case 'ellipse':
      poly = ellipsePolygon(b);
      break;
    case 'polygon':
      poly = regularPolygon(b, spec.sides);
      join = 'miter';
      break;
    case 'star':
      poly = starPolygon(b, spec.sides, spec.innerRatio);
      join = 'miter';
      break;
    case 'heart':
      poly = heartPolygon(b);
      break;
    case 'squircle':
      poly = squirclePolygon(b);
      break;
  }
  const degenerate = b.w <= 0 && b.h <= 0;
  return {
    fill: degenerate ? [] : [poly],
    stroke: sw > 0 ? strokePolygons(poly, { width: sw, closed: true, join, miterLimit: 8 }) : [],
  };
}

function lineGeometry(spec: ShapeSpec, width: number): ShapeGeometry {
  const { x0, y0, x1, y1 } = spec;
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (spec.kind === 'line' || len === 0) {
    return { fill: [], stroke: strokePolygons([x0, y0, x1, y1], { width, closed: false, cap: 'round' }) };
  }
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  const head = arrowHeadSize(width);
  const hl = Math.min(head.length, len);
  // The shaft stops inside the head so the round cap does not poke through the tip.
  const sx = x1 - ux * hl * 0.6;
  const sy = y1 - uy * hl * 0.6;
  const bx = x1 - ux * hl;
  const by = y1 - uy * hl;
  const nx = -uy * head.halfWidth;
  const ny = ux * head.halfWidth;
  const stroke = strokePolygons([x0, y0, sx, sy], { width, closed: false, cap: 'round' });
  stroke.push(orientPositive([x1, y1, bx + nx, by + ny, bx - nx, by - ny]));
  return { fill: [], stroke };
}
