// Turns a stream of pointer samples into evenly spaced dabs along the path.
// Spacing is re-evaluated at every dab (it usually depends on the
// pressure-driven brush size), leftover distance carries across segments,
// and pressure/tilt are interpolated linearly between samples.

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
}

export interface Dab extends StrokePoint {
  /** Arc length from the stroke start, px. */
  distance: number;
}

/** Spacing below this is clamped, so tiny brushes cannot loop forever. */
export const MIN_SPACING = 0.1;

export class StrokeSampler {
  private prev: StrokePoint | null = null;
  private toNext = 0;
  private travelled = 0;

  /** @param spacing distance to the next dab given the dab just placed. */
  constructor(private readonly spacing: (dab: Dab) => number) {}

  get distance(): number {
    return this.travelled;
  }

  get last(): StrokePoint | null {
    return this.prev;
  }

  /** Starts a stroke; always places a dab at the first point. */
  begin(p: StrokePoint): Dab[] {
    this.prev = { ...p };
    this.travelled = 0;
    const dab: Dab = { ...p, distance: 0 };
    this.toNext = Math.max(MIN_SPACING, this.spacing(dab));
    return [dab];
  }

  /** Extends the stroke to `p`, returning the dabs on the new segment. */
  add(p: StrokePoint): Dab[] {
    const a = this.prev;
    if (!a) return this.begin(p);
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    const len = Math.hypot(dx, dy);
    const out: Dab[] = [];
    if (len === 0) {
      this.prev = { ...p };
      return out;
    }
    let pos = 0;
    while (pos + this.toNext <= len) {
      pos += this.toNext;
      const f = pos / len;
      const dab: Dab = {
        x: a.x + dx * f,
        y: a.y + dy * f,
        pressure: a.pressure + (p.pressure - a.pressure) * f,
        tiltX: a.tiltX + (p.tiltX - a.tiltX) * f,
        tiltY: a.tiltY + (p.tiltY - a.tiltY) * f,
        distance: this.travelled + pos,
      };
      out.push(dab);
      this.toNext = Math.max(MIN_SPACING, this.spacing(dab));
    }
    this.toNext -= len - pos;
    this.travelled += len;
    this.prev = { ...p };
    return out;
  }
}
