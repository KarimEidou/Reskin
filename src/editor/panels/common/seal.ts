// Undo steps for continuous controls: a panel's slider updates share a merge
// key so one drag is one history entry — and each new drag must start a new
// entry (Engine.sealHistory), even when it follows the last one within the
// merge window. Keyboard steps on one slider keep merging.

import type { Attachment } from 'svelte/attachments';

/** A control whose drags merge into one undo step (a range input or an ARIA slider). */
function isSlider(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return target.type === 'range';
  return target.closest('[role="slider"]') !== null;
}

/**
 * Runs `start` whenever a pointer presses a slider inside the element (a
 * new drag begins), before the slider sees the press.
 *   <div {@attach onSliderPress(() => engine.sealHistory())}>…</div>
 */
export function onSliderPress(start: () => void): Attachment<HTMLElement> {
  return (node) => {
    const onPress = (e: PointerEvent) => {
      if (isSlider(e.target)) start();
    };
    node.addEventListener('pointerdown', onPress, true);
    return () => node.removeEventListener('pointerdown', onPress, true);
  };
}
