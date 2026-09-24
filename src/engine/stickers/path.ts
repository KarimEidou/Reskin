/**
 * A small SVG path-data reader: parses `d` strings (M L H V C S Q T A Z,
 * absolute and relative) and flattens every subpath into a closed polygon
 * (`[x0, y0, x1, y1, …]`) for the engine's anti-aliased polygon rasterizer.
 *
 * Curves are flattened with Wang's bound, so the chord error stays under
 * `tolerance` in the *output* space (after `scale`); elliptical arcs use the
 * SVG endpoint → centre conversion (F.6.5) with out-of-range radii scaled up.
 */

export interface FlattenOptions {
  /** Output units per path unit (default 1). */
  scale?: number;
  /** Added after scaling. */
  offsetX?: number;
  offsetY?: number;
  /** Maximum chord error in output units (default 0.2). */
  tolerance?: number;
}

type Cmd = { op: string; args: number[] };

const ARG_COUNT: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

export class PathSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSyntaxError';
  }
}

/** Splits path data into commands with their numeric arguments (repeated argument groups are expanded). */
export function parsePath(d: string): Cmd[] {
  const out: Cmd[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([\s,]+)|(.)/g;
  let op: string | null = null;
  let args: number[] = [];
  const flush = () => {
    if (op === null) return;
    const lower = op.toLowerCase();
    const n = ARG_COUNT[lower]!;
    if (n === 0) {
      out.push({ op, args: [] });
    } else {
      if (args.length === 0 || args.length % n !== 0) throw new PathSyntaxError(`"${op}" needs a multiple of ${n} numbers, got ${args.length}`);
      for (let i = 0; i < args.length; i += n) {
        // Extra pairs after a moveto are implicit linetos.
        const cmd = i > 0 && lower === 'm' ? (op === 'M' ? 'L' : 'l') : op;
        out.push({ op: cmd, args: args.slice(i, i + n) });
      }
    }
    args = [];
  };
  let m: RegExpExecArray | null;
  // Arc flags may be written without separators ("a1 1 0 01 10 10"): read them digit by digit.
  let arcIndex = 0;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) {
      flush();
      op = m[1];
      arcIndex = 0;
    } else if (m[2]) {
      if (op === null) throw new PathSyntaxError('path data must start with a command');
      if ((op === 'a' || op === 'A') && (arcIndex % 7 === 3 || arcIndex % 7 === 4) && m[2].length > 1 && /^[01]/.test(m[2])) {
        // Compact flags ("a1 1 0 1050 0"): a flag is one digit; re-read the rest.
        args.push(Number(m[2][0]));
        arcIndex++;
        re.lastIndex = m.index + 1;
        continue;
      }
      args.push(Number(m[2]));
      arcIndex++;
    } else if (m[4]) {
      throw new PathSyntaxError(`unexpected "${m[4]}" in path data`);
    }
  }
  flush();
  return out;
}

/**
 * Flattens path data into closed polygons (one per subpath, at least three
 * points each), transformed by `scale` / `offset`.
 */
export function flattenPath(d: string, opts: FlattenOptions = {}): number[][] {
  const s = opts.scale ?? 1;
  const ox = opts.offsetX ?? 0;
  const oy = opts.offsetY ?? 0;
  const tol = Math.max(1e-3, opts.tolerance ?? 0.2);
  const polys: number[][] = [];
  let poly: number[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // Reflection points for S / T.
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;

  const emit = (px: number, py: number) => poly.push(px * s + ox, py * s + oy);
  const close = () => {
    if (poly.length >= 6) polys.push(poly);
    poly = [];
  };
  const cubic = (c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number) => {
    const dd = Math.max(Math.hypot(x - 2 * c1x + c2x, y - 2 * c1y + c2y), Math.hypot(c1x - 2 * c2x + ex, c1y - 2 * c2y + ey)) * s;
    const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt((0.75 * dd) / tol))));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const e = t * t * t;
      emit(a * x + b * c1x + c * c2x + e * ex, a * y + b * c1y + c * c2y + e * ey);
    }
  };
  const quad = (cx: number, cy: number, ex: number, ey: number) => {
    const dd = Math.hypot(x - 2 * cx + ex, y - 2 * cy + ey) * s;
    const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt((0.25 * dd) / tol))));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      emit(u * u * x + 2 * u * t * cx + t * t * ex, u * u * y + 2 * u * t * cy + t * t * ey);
    }
  };
  const arc = (rx0: number, ry0: number, rotDeg: number, large: boolean, sweep: boolean, ex: number, ey: number) => {
    let rx = Math.abs(rx0);
    let ry = Math.abs(ry0);
    if (rx < 1e-9 || ry < 1e-9 || (x === ex && y === ey)) {
      emit(ex, ey);
      return;
    }
    const phi = (rotDeg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx2 = (x - ex) / 2;
    const dy2 = (y - ey) / 2;
    const x1 = cos * dx2 + sin * dy2;
    const y1 = -sin * dx2 + cos * dy2;
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
      const k = Math.sqrt(lambda);
      rx *= k;
      ry *= k;
    }
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let coef = Math.sqrt(Math.max(0, num / den));
    if (large === sweep) coef = -coef;
    const cx1 = (coef * rx * y1) / ry;
    const cy1 = (-coef * ry * x1) / rx;
    const cx = cos * cx1 - sin * cy1 + (x + ex) / 2;
    const cy = sin * cx1 + cos * cy1 + (y + ey) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number) => {
      const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      return a;
    };
    const theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let dTheta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
    if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
    else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
    const r = Math.max(rx, ry) * s;
    const step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 2;
    const n = Math.max(2, Math.min(512, Math.ceil(Math.abs(dTheta) / Math.max(1e-3, step))));
    for (let i = 1; i <= n; i++) {
      const t = theta1 + (dTheta * i) / n;
      const px = rx * Math.cos(t);
      const py = ry * Math.sin(t);
      emit(cos * px - sin * py + cx, sin * px + cos * py + cy);
    }
  };

  for (const { op, args: a } of parsePath(d)) {
    const rel = op === op.toLowerCase();
    const bx = rel ? x : 0;
    const by = rel ? y : 0;
    let nextC: [number, number] | null = null;
    let nextQ: [number, number] | null = null;
    switch (op.toLowerCase()) {
      case 'm':
        close();
        x = bx + a[0]!;
        y = by + a[1]!;
        startX = x;
        startY = y;
        emit(x, y);
        break;
      case 'l':
        x = bx + a[0]!;
        y = by + a[1]!;
        emit(x, y);
        break;
      case 'h':
        x = bx + a[0]!;
        emit(x, y);
        break;
      case 'v':
        y = by + a[0]!;
        emit(x, y);
        break;
      case 'c': {
        const c2: [number, number] = [bx + a[2]!, by + a[3]!];
        cubic(bx + a[0]!, by + a[1]!, c2[0], c2[1], bx + a[4]!, by + a[5]!);
        x = bx + a[4]!;
        y = by + a[5]!;
        nextC = c2;
        break;
      }
      case 's': {
        const c1x = lastC ? 2 * x - lastC[0] : x;
        const c1y = lastC ? 2 * y - lastC[1] : y;
        const c2: [number, number] = [bx + a[0]!, by + a[1]!];
        cubic(c1x, c1y, c2[0], c2[1], bx + a[2]!, by + a[3]!);
        x = bx + a[2]!;
        y = by + a[3]!;
        nextC = c2;
        break;
      }
      case 'q': {
        const c: [number, number] = [bx + a[0]!, by + a[1]!];
        quad(c[0], c[1], bx + a[2]!, by + a[3]!);
        x = bx + a[2]!;
        y = by + a[3]!;
        nextQ = c;
        break;
      }
      case 't': {
        const c: [number, number] = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
        quad(c[0], c[1], bx + a[0]!, by + a[1]!);
        x = bx + a[0]!;
        y = by + a[1]!;
        nextQ = c;
        break;
      }
      case 'a':
        arc(a[0]!, a[1]!, a[2]!, a[3] !== 0, a[4] !== 0, bx + a[5]!, by + a[6]!);
        x = bx + a[5]!;
        y = by + a[6]!;
        break;
      case 'z':
        close();
        x = startX;
        y = startY;
        break;
    }
    lastC = nextC;
    lastQ = nextQ;
  }
  close();
  return polys;
}

/** SVG path data for closed polygons (`M x y L … Z`), rounded to `digits` decimals. */
export function polygonsToPath(polys: readonly (readonly number[])[], digits = 2): string {
  const f = (v: number) => {
    const r = Number(v.toFixed(digits));
    return Object.is(r, -0) ? '0' : String(r);
  };
  const parts: string[] = [];
  for (const p of polys) {
    if (p.length < 6) continue;
    let s = `M${f(p[0]!)} ${f(p[1]!)}`;
    for (let i = 2; i < p.length; i += 2) s += `L${f(p[i]!)} ${f(p[i + 1]!)}`;
    parts.push(`${s}Z`);
  }
  return parts.join('');
}
