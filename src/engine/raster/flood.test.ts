import { describe, expect, it } from 'vitest';
import { floodFill } from './flood';
import { Surface } from './surface';

/**
 * 8×4 image:
 *   columns 0-2: grey 100, column 3: a wall of grey 100+d, columns 4-7: grey 100
 * so the left and right regions are only connected through the wall.
 */
function walled(d: number): Surface {
  const s = new Surface(8, 4);
  s.fill(100, 100, 100, 255);
  s.fill(100 + d, 100 + d, 100 + d, 255, { x: 3, y: 0, w: 1, h: 4 });
  return s;
}

describe('floodFill', () => {
  it('contiguous fill stops at a wall above tolerance', () => {
    const r = floodFill(walled(20).data, 8, 4, 0, 0, { tolerance: 19, contiguous: true });
    expect(r.count).toBe(12);
    expect(r.bounds).toEqual({ x: 0, y: 0, w: 3, h: 4 });
    expect(r.mask[4]).toBe(0);
  });

  it('tolerance is inclusive: distance == tolerance matches, +1 does not', () => {
    expect(floodFill(walled(20).data, 8, 4, 0, 0, { tolerance: 20, contiguous: true }).count).toBe(32);
    expect(floodFill(walled(21).data, 8, 4, 0, 0, { tolerance: 20, contiguous: true }).count).toBe(12);
    expect(floodFill(walled(1).data, 8, 4, 0, 0, { tolerance: 0, contiguous: true }).count).toBe(12);
  });

  it('global fill ignores connectivity', () => {
    const r = floodFill(walled(50).data, 8, 4, 0, 0, { tolerance: 10, contiguous: false });
    expect(r.count).toBe(28);
    expect(r.mask[3]).toBe(0);
    expect(r.mask[7]).toBe(1);
  });

  it('uses the max channel difference, alpha included', () => {
    const s = new Surface(3, 1);
    s.setPixel(0, 0, 10, 10, 10, 255);
    s.setPixel(1, 0, 10, 40, 10, 255); // one channel differs by 30
    s.setPixel(2, 0, 10, 10, 10, 225); // alpha differs by 30
    expect(floodFill(s.data, 3, 1, 0, 0, { tolerance: 29, contiguous: false }).count).toBe(1);
    expect(floodFill(s.data, 3, 1, 0, 0, { tolerance: 30, contiguous: false }).count).toBe(3);
  });

  it('treats all fully transparent pixels as the same colour', () => {
    const s = new Surface(4, 1);
    s.setPixel(1, 0, 255, 0, 0, 0); // invisible red
    s.setPixel(2, 0, 0, 255, 0, 0); // invisible green
    s.setPixel(3, 0, 0, 0, 0, 255);
    expect(floodFill(s.data, 4, 1, 0, 0, { tolerance: 0, contiguous: true }).count).toBe(3);
  });

  it('fills concave regions with scanlines (U shape)', () => {
    // A 7×5 U-shaped hole in an opaque frame, seeded at one arm.
    const rows = ['#######', '#.###.#', '#.###.#', '#.....#', '#######'];
    const s = new Surface(7, 5);
    rows.forEach((row, y) => [...row].forEach((c, x) => c === '#' && s.setPixel(x, y, 0, 0, 0, 255)));
    const r = floodFill(s.data, 7, 5, 1, 1, { tolerance: 0, contiguous: true });
    expect(r.count).toBe(9);
    expect(r.mask[1 * 7 + 5]).toBe(1); // reached the other arm
  });

  it('seed outside the image does nothing', () => {
    expect(floodFill(new Surface(2, 2).data, 2, 2, -1, 0, { tolerance: 255, contiguous: true }).bounds).toBeNull();
  });
});
