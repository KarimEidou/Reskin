// The dropped item's icon flying from the drop point into the box: it pops
// out of the cursor, accelerates in, stretched along its flight direction,
// and lands exactly on BoxVisual's icon rect (where BoxVisual takes over).

import type { Rect } from '$lib/ipc/types';

type Point = { x: number; y: number };

const SAMPLES = 18;

/** Keyframes for a flight from `from` (CSS px) onto `to`; exported for tests. */
export function absorbKeyframes(from: Point, to: Rect): Keyframe[] {
  const cx = to.x + to.w / 2;
  const cy = to.y + to.h / 2;
  const dx = from.x - cx;
  const dy = from.y - cy;
  const dist = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Short hops barely stretch; long ones up to 24 %.
  const stretchMax = 0.24 * Math.min(1, dist / 60);
  const frames: Keyframe[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const p = i / (SAMPLES - 1);
    // Accelerating pull (ease-in cubic) toward the box.
    const e = p * p * p;
    const x = dx * (1 - e);
    const y = dy * (1 - e);
    const stretch = stretchMax * Math.sin(Math.PI * Math.min(1, p * 1.1));
    const scale = 0.55 + 0.45 * (1 - (1 - p) * (1 - p));
    const f = (n: number) => Math.round(n * 1000) / 1000;
    frames.push({
      offset: p,
      opacity: p < 0.12 ? f(p / 0.12) : 1,
      transform:
        i === SAMPLES - 1
          ? 'none'
          : `translate(${f(x)}px, ${f(y)}px) rotate(${f(angle)}deg) scale(${f(1 + stretch)}, ${f(1 - stretch * 0.55)}) rotate(${f(-angle)}deg) scale(${f(scale)})`,
    });
  }
  return frames;
}

/**
 * Animates `src` from `from` into `to` inside `layer` and resolves on
 * impact (after `durationMs`). The flying image is removed on impact.
 */
export async function flyIconIn(
  layer: HTMLElement,
  src: string,
  from: Point,
  to: Rect,
  durationMs: number,
): Promise<void> {
  if (durationMs <= 0) return;
  const img = new Image();
  img.src = src;
  img.alt = '';
  img.draggable = false;
  img.className = 'flyer';
  try {
    await img.decode();
  } catch {
    // Undecodable icon: skip the flight, BoxVisual will show what it can.
    return;
  }
  Object.assign(img.style, {
    position: 'absolute',
    left: `${to.x}px`,
    top: `${to.y}px`,
    width: `${to.w}px`,
    height: `${to.h}px`,
    objectFit: 'contain',
    pointerEvents: 'none',
    filter: 'drop-shadow(0 6px 8px rgb(0 0 0 / 0.35))',
    willChange: 'transform, opacity',
  });
  layer.append(img);
  try {
    await img.animate(absorbKeyframes(from, to), { duration: durationMs, easing: 'linear', fill: 'both' })
      .finished;
  } catch {
    // Cancelled (e.g. the page is going away) — nothing to clean up but the node.
  } finally {
    img.remove();
  }
}
