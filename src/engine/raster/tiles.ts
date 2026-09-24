// 64×64 tile grid used by history snapshots: an edit stores only the tiles
// it actually changed. Tiles at the right/bottom edge are clipped to the
// surface, so any surface size works (pixel-art docs are a single tile).

import type { Rect } from '../util/rect';
import { clipRect } from '../util/rect';
import type { Pixels } from './surface';

export const TILE_SIZE = 64;

export interface TileGrid {
  cols: number;
  rows: number;
  count: number;
}

export function tileGrid(width: number, height: number): TileGrid {
  const cols = Math.ceil(width / TILE_SIZE);
  const rows = Math.ceil(height / TILE_SIZE);
  return { cols, rows, count: cols * rows };
}

export function tileRect(index: number, width: number, height: number): Rect {
  const cols = Math.ceil(width / TILE_SIZE);
  const tx = index % cols;
  const ty = (index - tx) / cols;
  const x = tx * TILE_SIZE;
  const y = ty * TILE_SIZE;
  return { x, y, w: Math.min(TILE_SIZE, width - x), h: Math.min(TILE_SIZE, height - y) };
}

/** Calls `fn(index)` for every tile intersecting `area` (clipped to the surface). */
export function forEachTile(
  area: Rect,
  width: number,
  height: number,
  fn: (index: number) => void,
): void {
  const c = clipRect(area, width, height);
  if (!c) return;
  const cols = Math.ceil(width / TILE_SIZE);
  const tx0 = Math.floor(c.x / TILE_SIZE);
  const ty0 = Math.floor(c.y / TILE_SIZE);
  const tx1 = Math.floor((c.x + c.w - 1) / TILE_SIZE);
  const ty1 = Math.floor((c.y + c.h - 1) / TILE_SIZE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) fn(ty * cols + tx);
}

/** Copies a tile's pixels out of a full-surface buffer. */
export function readTile(data: Uint8ClampedArray, width: number, r: Rect): Pixels {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  const row = r.w * 4;
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * width + r.x) * 4;
    out.set(data.subarray(s, s + row), y * row);
  }
  return out;
}

/** Writes tile pixels back into a full-surface buffer. */
export function writeTile(data: Uint8ClampedArray, width: number, r: Rect, tile: Uint8ClampedArray): void {
  const row = r.w * 4;
  for (let y = 0; y < r.h; y++) {
    data.set(tile.subarray(y * row, y * row + row), ((r.y + y) * width + r.x) * 4);
  }
}

/** Exchanges tile pixels with the surface in place (used by undo/redo). */
export function swapTile(data: Uint8ClampedArray, width: number, r: Rect, tile: Uint8ClampedArray): void {
  const row = r.w * 4;
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * width + r.x) * 4;
    const t = y * row;
    for (let i = 0; i < row; i++) {
      const v = data[s + i];
      data[s + i] = tile[t + i];
      tile[t + i] = v;
    }
  }
}

/** True when the tile area is byte-identical in two same-sized buffers. */
export function tileEquals(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, r: Rect): boolean {
  const row = r.w * 4;
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * width + r.x) * 4;
    for (let i = 0; i < row; i++) if (a[s + i] !== b[s + i]) return false;
  }
  return true;
}
