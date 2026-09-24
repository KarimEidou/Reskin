// PointerEvent → PointerInput conversion, including coalesced events (the
// intermediate samples browsers batch into one pointermove at high report
// rates — essential for smooth pen strokes).
//
// Written against a structural `PointerEventLike` type so it has no DOM
// dependency and can be unit tested; a real PointerEvent satisfies it.

import type { Modifiers, PointerInput, PointerKind } from './pointer';
import { normalizePressure } from './pointer';

export interface PointerEventLike {
  clientX: number;
  clientY: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  timeStamp: number;
  button: number;
  pointerType: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  getCoalescedEvents?: () => PointerEventLike[];
}

/** Maps client (CSS px) coordinates to document and view coordinates. */
export type ClientToDoc = (clientX: number, clientY: number) => {
  x: number;
  y: number;
  screenX: number;
  screenY: number;
};

/** The coalesced samples of an event (or the event itself). */
export function coalescedEvents(e: PointerEventLike): PointerEventLike[] {
  const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  return list.length > 0 ? list : [e];
}

function kindOf(t: string): PointerKind {
  return t === 'pen' || t === 'touch' ? t : 'mouse';
}

export function modifiersOf(e: Pick<PointerEventLike, 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>): Modifiers {
  return { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey };
}

/**
 * Converts one event. `button` should be the button of the gesture's
 * pointerdown (move events report -1).
 */
export function toPointerInput(e: PointerEventLike, map: ClientToDoc, button = e.button): PointerInput {
  const p = map(e.clientX, e.clientY);
  const pointerType = kindOf(e.pointerType);
  return {
    x: p.x,
    y: p.y,
    screenX: p.screenX,
    screenY: p.screenY,
    pressure: normalizePressure(pointerType, e.pressure),
    tiltX: e.tiltX || 0,
    tiltY: e.tiltY || 0,
    time: e.timeStamp,
    button: button < 0 ? 0 : button,
    pointerType,
    modifiers: modifiersOf(e),
  };
}

/** All coalesced samples of a pointermove as PointerInputs (oldest first). */
export function toPointerInputs(e: PointerEventLike, map: ClientToDoc, button = e.button): PointerInput[] {
  // Modifier state is only reliable on the dispatched event.
  const mods = modifiersOf(e);
  return coalescedEvents(e).map((c) => ({ ...toPointerInput(c, map, button), modifiers: mods }));
}
