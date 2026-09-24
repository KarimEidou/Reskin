// Device-independent pointer samples in DOCUMENT coordinates. The UI maps
// screen → document with the viewport (see ./coalesced.ts for PointerEvent
// conversion) and feeds these to the Engine.

export interface Modifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

export const NO_MODIFIERS: Readonly<Modifiers> = Object.freeze({
  shift: false,
  alt: false,
  ctrl: false,
  meta: false,
});

export type PointerKind = 'mouse' | 'pen' | 'touch';

export interface PointerInput {
  /** Document px, continuous (pixel i spans [i, i+1)). */
  x: number;
  y: number;
  /** 0..1. Mice report 1 while a button is down (see normalizePressure). */
  pressure: number;
  /** Pen tilt in degrees, -90..90. */
  tiltX: number;
  tiltY: number;
  /** Timestamp, ms. */
  time: number;
  /** Button that started the gesture: 0 primary, 1 middle, 2 secondary. */
  button: number;
  pointerType: PointerKind;
  modifiers: Modifiers;
  /** Position in view (CSS px) — used by viewport tools (hand/zoom). */
  screenX?: number;
  screenY?: number;
}

/** Builds a PointerInput with defaults (mouse, pressure 1, primary button). */
export function pointerInput(p: Partial<PointerInput> & { x: number; y: number }): PointerInput {
  return {
    pressure: 1,
    tiltX: 0,
    tiltY: 0,
    time: 0,
    button: 0,
    pointerType: 'mouse',
    ...p,
    modifiers: { ...NO_MODIFIERS, ...p.modifiers },
  };
}

/**
 * Mice report 0.5 while pressed (and 0 otherwise): treat them as full
 * pressure so pressure-driven size/opacity behave. Pens/touch are clamped.
 */
export function normalizePressure(pointerType: PointerKind, pressure: number): number {
  if (pointerType === 'mouse') return 1;
  if (!Number.isFinite(pressure)) return 1;
  return pressure < 0 ? 0 : pressure > 1 ? 1 : pressure;
}
