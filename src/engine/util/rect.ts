// Integer pixel rectangles used for dirty tracking, tiles and bounds.
// `w`/`h` are always > 0 for a non-empty rect; functions that can produce an
// empty result return `null` instead of a zero-sized rect.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

/** The smallest integer rect covering the float box [x0,x1)×[y0,y1). */
export function coverRect(x0: number, y0: number, x1: number, y1: number): Rect | null {
  const lx = Math.floor(Math.min(x0, x1));
  const ly = Math.floor(Math.min(y0, y1));
  const hx = Math.ceil(Math.max(x0, x1));
  const hy = Math.ceil(Math.max(y0, y1));
  if (hx <= lx || hy <= ly) return null;
  return { x: lx, y: ly, w: hx - lx, h: hy - ly };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || bt <= y) return null;
  return { x, y, w: r - x, h: bt - y };
}

/** Clips `r` to the canvas [0,width)×[0,height). */
export function clipRect(r: Rect, width: number, height: number): Rect | null {
  return intersectRect(r, { x: 0, y: 0, w: width, h: height });
}

export function inflateRect(r: Rect, n: number): Rect {
  return { x: r.x - n, y: r.y - n, w: r.w + 2 * n, h: r.h + 2 * n };
}

export function rectsEqual(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

export function rectArea(r: Rect | null): number {
  return r ? r.w * r.h : 0;
}

export function fullRect(width: number, height: number): Rect {
  return { x: 0, y: 0, w: width, h: height };
}
