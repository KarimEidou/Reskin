import { describe, expect, it } from 'vitest';
import { dropListIndex, rowShift, toDocIndex } from './reorder';

describe('layer reordering', () => {
  it('snaps a drag to whole rows within the list', () => {
    expect(dropListIndex(0, 10, 44, 4)).toBe(0);
    expect(dropListIndex(0, 30, 44, 4)).toBe(1);
    expect(dropListIndex(0, 44 * 2.4, 44, 4)).toBe(2);
    expect(dropListIndex(3, -44 * 3, 44, 4)).toBe(0);
    expect(dropListIndex(1, 999, 44, 4)).toBe(3);
    expect(dropListIndex(2, -999, 44, 4)).toBe(0);
    expect(dropListIndex(2, 10, 0, 4)).toBe(2);
  });

  it('maps list order to document order', () => {
    expect(toDocIndex(0, 3)).toBe(2);
    expect(toDocIndex(2, 3)).toBe(0);
  });

  it('shifts the rows between the old and new position', () => {
    // Dragging row 0 down to 2: rows 1 and 2 move up.
    expect([0, 1, 2, 3].map((i) => rowShift(i, 0, 2, 40))).toEqual([0, -40, -40, 0]);
    // Dragging row 3 up to 1: rows 1 and 2 move down.
    expect([0, 1, 2, 3].map((i) => rowShift(i, 3, 1, 40))).toEqual([0, 40, 40, 0]);
    expect([0, 1, 2].map((i) => rowShift(i, 1, 1, 40))).toEqual([0, 0, 0]);
  });
});
