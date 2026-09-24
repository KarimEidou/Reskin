// Keyboard-shortcut strings ("Ctrl+Shift+Z", "Shift+G", "?") and matching
// them against KeyboardEvents. Pure (no DOM globals), unit tested.
//
// Matching rules:
// * Ctrl, Alt and Win must match exactly (Win = `metaKey`).
// * Shift must match exactly for letters, digits and named keys. Keys that
//   are themselves shifted characters ("?", "+") ignore Shift unless the
//   shortcut names it, so "?" works on every layout that has a "?" key.
// * Letters compare case-insensitively on `key` (what the keycap says), with
//   `code` as a fallback for digits (Shift+1 reports "!").

export interface KeyCombo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  /** Normalised key: "A", "1", "?", "Enter", "Plus", "Minus", "F5", … */
  key: string;
}

/** The KeyboardEvent fields the matcher reads. */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const NAMED: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  ' ': 'Space',
  tab: 'Tab',
  delete: 'Delete',
  del: 'Delete',
  backspace: 'Backspace',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  plus: 'Plus',
  '+': 'Plus',
  '=': 'Plus',
  minus: 'Minus',
  '-': 'Minus',
  _: 'Minus',
};

/** Keys whose character already needs Shift on common layouts. */
const SHIFTED = new Set(['?', 'Plus', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', ':', '"', '<', '>', '{', '}', '|', '~']);

/** Normalises one key token (from a shortcut string or `KeyboardEvent.key`). */
export function normalizeKey(token: string): string {
  if (token.length === 1 && token !== ' ' && token !== '+' && token !== '=' && token !== '-' && token !== '_') {
    return /[a-z]/i.test(token) ? token.toUpperCase() : token;
  }
  const named = NAMED[token.toLowerCase()];
  if (named) return named;
  const f = /^f([1-9][0-9]?)$/i.exec(token);
  if (f) return `F${f[1]}`;
  return token;
}

/** Parses "Ctrl+Shift+Z" (also "Ctrl++" for the plus key). */
export function parseCombo(text: string): KeyCombo {
  const combo: KeyCombo = { ctrl: false, alt: false, shift: false, win: false, key: '' };
  // "Ctrl++" → ["Ctrl", "+"]; a lone "+" is the key itself.
  const tokens = text === '+' ? ['+'] : text.replace(/\+\+$/, '+Plus').split('+');
  for (const raw of tokens) {
    const t = raw.trim();
    const lower = t.toLowerCase();
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmdorctrl') combo.ctrl = true;
    else if (lower === 'alt' || lower === 'option') combo.alt = true;
    else if (lower === 'shift') combo.shift = true;
    else if (lower === 'win' || lower === 'meta' || lower === 'super') combo.win = true;
    else if (t) combo.key = normalizeKey(t);
  }
  return combo;
}

/** Every key name the event could stand for (key first, then code-based). */
function eventKeys(e: KeyLike): string[] {
  const out = [normalizeKey(e.key)];
  const code = e.code ?? '';
  if (code.startsWith('Digit')) out.push(code.slice(5));
  else if (code.startsWith('Numpad') && /^\d$/.test(code.slice(6))) out.push(code.slice(6));
  else if (code === 'NumpadAdd' || code === 'Equal') out.push('Plus');
  else if (code === 'NumpadSubtract' || code === 'Minus') out.push('Minus');
  else if (code.startsWith('Key')) out.push(code.slice(3));
  return out;
}

/** True when the keyboard event is exactly this shortcut. */
export function matchesCombo(combo: KeyCombo | string, e: KeyLike): boolean {
  const c = typeof combo === 'string' ? parseCombo(combo) : combo;
  if (!c.key) return false;
  if (c.ctrl !== e.ctrlKey || c.alt !== e.altKey || c.win !== e.metaKey) return false;
  const shiftFree = SHIFTED.has(c.key) && !c.shift;
  if (!shiftFree && c.shift !== e.shiftKey) return false;
  const keys = eventKeys(e);
  // Letters prefer the printed key; the code fallback only helps when the
  // printed key is not a letter at all (e.g. a non-Latin layout).
  if (/^[A-Z]$/.test(c.key)) {
    const printed = keys[0]!;
    return printed === c.key || (!/^[A-Z]$/.test(printed) && keys.includes(c.key));
  }
  return keys.includes(c.key);
}

/** A shortcut that is a single printable key without Ctrl/Alt/Win. */
export function isBareKey(combo: KeyCombo | string): boolean {
  const c = typeof combo === 'string' ? parseCombo(combo) : combo;
  return !c.ctrl && !c.alt && !c.win;
}

/** Display form for Kbd: "Ctrl+Plus" → ["Ctrl", "+"]. */
export function comboKeys(text: string): string[] {
  const c = parseCombo(text);
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  if (c.win) parts.push('Win');
  const label: Record<string, string> = { Plus: '+', Minus: '−', Up: '↑', Down: '↓', Left: '←', Right: '→', Escape: 'Esc' };
  parts.push(label[c.key] ?? c.key);
  return parts;
}

/** Minimal element shape used by the focus checks (keeps this module DOM-free). */
export interface ElementLike {
  closest(selector: string): unknown;
  isContentEditable?: boolean;
}

/** Text entry: shortcuts without Ctrl/Alt must not fire while typing here. */
export const TYPING_SELECTOR =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="color"]), textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], [role="spinbutton"]';

/** Composite widgets that use letter/arrow keys themselves (typeahead, roving focus). */
export const WIDGET_SELECTOR = '[role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [role="slider"], [role="tree"], [role="grid"]';

export function isTypingTarget(el: ElementLike | null | undefined): boolean {
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.isContentEditable || el.closest(TYPING_SELECTOR) !== null;
}

export function isWidgetTarget(el: ElementLike | null | undefined): boolean {
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest(WIDGET_SELECTOR) !== null;
}
