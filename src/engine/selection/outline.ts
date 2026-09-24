// Selection outline for marching ants: the boundary between selected
// (coverage ≥ 50 %) and unselected pixels as axis-aligned segments on pixel
// edges, with collinear neighbours merged so a large rectangle is 4
// segments, not thousands.

import type { SelectionMask } from './mask';

/** Flat list of segments: [x0, y0, x1, y1, …] in document px. */
export type Segments = number[];

export function selectionOutline(m: SelectionMask): Segments {
  const { width: w, height: h, data } = m;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] >= 128;
  const out: Segments = [];
  // Horizontal edges: the line y between rows y-1 and y.
  for (let y = 0; y <= h; y++) {
    let start = -1;
    let startSide = false;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && inside(x, y - 1) !== inside(x, y);
      const side = x < w && inside(x, y);
      if (edge && start >= 0 && side === startSide) continue;
      if (start >= 0) {
        out.push(start, y, x, y);
        start = -1;
      }
      if (edge) {
        start = x;
        startSide = side;
      }
    }
  }
  // Vertical edges: the line x between columns x-1 and x.
  for (let x = 0; x <= w; x++) {
    let start = -1;
    let startSide = false;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && inside(x - 1, y) !== inside(x, y);
      const side = y < h && inside(x, y);
      if (edge && start >= 0 && side === startSide) continue;
      if (start >= 0) {
        out.push(x, start, x, y);
        start = -1;
      }
      if (edge) {
        start = y;
        startSide = side;
      }
    }
  }
  return out;
}
