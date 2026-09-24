// Pointer-drag reordering maths for the Layers list (pure, unit tested).
//
// The list shows layers top-first, the document stores them bottom-first:
// list index i ⇔ document index count − 1 − i.

/** List index (top-first) the dragged row lands on after moving `dy` px. */
export function dropListIndex(from: number, dy: number, rowHeight: number, count: number): number {
  if (count <= 0 || rowHeight <= 0) return from;
  const shift = Math.round(dy / rowHeight);
  return Math.max(0, Math.min(count - 1, from + shift));
}

/** Converts between the list order (top-first) and document order (bottom-first). */
export function toDocIndex(listIndex: number, count: number): number {
  return count - 1 - listIndex;
}

/**
 * Vertical offset (px) for a row that is not being dragged, so the others
 * make room for the dragged one while it hovers over position `to`.
 */
export function rowShift(index: number, from: number, to: number, rowHeight: number): number {
  if (index === from) return 0;
  if (from < to && index > from && index <= to) return -rowHeight;
  if (from > to && index < from && index >= to) return rowHeight;
  return 0;
}
