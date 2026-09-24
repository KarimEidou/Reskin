// Keyboard focus helpers: focusable-element queries, Tab trapping and the
// roving-tabindex arrow-key maths used by menus, tabs and segmented controls.

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** Focusable, rendered descendants of `root`, in DOM order. */
export function focusableIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.getClientRects().length > 0 && !el.closest('[inert]'),
  );
}

/** Keeps Tab / Shift+Tab cycling inside `root`. Returns true when handled. */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  if (e.key !== 'Tab') return false;
  const items = focusableIn(root);
  if (items.length === 0) {
    e.preventDefault();
    root.focus();
    return true;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export type Orientation = 'horizontal' | 'vertical' | 'both';

/**
 * Next index for a roving-tabindex widget, skipping disabled entries and
 * wrapping around. Returns null when the key is not a navigation key.
 */
export function rovingIndex(
  key: string,
  current: number,
  disabled: readonly boolean[],
  orientation: Orientation = 'horizontal',
): number | null {
  const count = disabled.length;
  if (count === 0) return null;
  const nextKeys = orientation === 'vertical' ? ['ArrowDown'] : orientation === 'horizontal' ? ['ArrowRight'] : ['ArrowRight', 'ArrowDown'];
  const prevKeys = orientation === 'vertical' ? ['ArrowUp'] : orientation === 'horizontal' ? ['ArrowLeft'] : ['ArrowLeft', 'ArrowUp'];
  let step: number;
  let start: number;
  if (nextKeys.includes(key)) {
    step = 1;
    start = current;
  } else if (prevKeys.includes(key)) {
    step = -1;
    start = current;
  } else if (key === 'Home') {
    step = 1;
    start = -1;
  } else if (key === 'End') {
    step = -1;
    start = count;
  } else {
    return null;
  }
  for (let i = 1; i <= count; i++) {
    const idx = (((start + step * i) % count) + count) % count;
    if (!disabled[idx]) return idx;
  }
  return null;
}

/**
 * Typeahead: the first enabled label after `current` that starts with
 * `query` (case-insensitive), wrapping around.
 */
export function typeaheadIndex(
  query: string,
  current: number,
  labels: readonly string[],
  disabled: readonly boolean[],
): number | null {
  const q = query.toLowerCase();
  if (!q) return null;
  const n = labels.length;
  // A repeated single letter cycles through matches; longer queries may
  // match the current item itself.
  const from = q.length > 1 ? 0 : 1;
  for (let i = from; i < n + from; i++) {
    const idx = (current + i + n) % n;
    if (!disabled[idx] && labels[idx]!.toLowerCase().startsWith(q)) return idx;
  }
  return null;
}
