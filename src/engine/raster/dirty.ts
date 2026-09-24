// Accumulates changed regions between redraws.

import type { Rect } from '../util/rect';
import { clipRect, unionRect } from '../util/rect';

export class DirtyRegion {
  private area: Rect | null = null;

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {}

  /** Adds `r` (clipped to the surface). */
  add(r: Rect | null): void {
    if (!r) return;
    const c = clipRect(r, this.width, this.height);
    if (c) this.area = unionRect(this.area, c);
  }

  get isEmpty(): boolean {
    return this.area === null;
  }

  peek(): Rect | null {
    return this.area ? { ...this.area } : null;
  }

  /** Returns and resets the accumulated region. */
  take(): Rect | null {
    const a = this.area;
    this.area = null;
    return a;
  }

  clear(): void {
    this.area = null;
  }
}
