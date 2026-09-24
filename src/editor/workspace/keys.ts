// Canvas-local keyboard handling, as a pure function (unit tested).
//
// The workspace owns the keys that act on the canvas itself: hold Space for
// the hand tool, hold `\` for before/after, K for keyline guides, Ctrl+0 /
// Ctrl+1 / Ctrl +/- for the view, X / D for the colour chips, and it
// forwards Enter / Escape / arrows (and Delete) to the active tool while
// the canvas has focus. Tool letters, undo/redo and the rest live in the
// app-wide command registry.

export type StageKeyAction =
  | { type: 'hand'; on: boolean }
  | { type: 'compare'; on: boolean }
  | { type: 'fit' }
  | { type: 'actualSize' }
  | { type: 'zoom'; direction: 1 | -1 }
  | { type: 'keylines' }
  | { type: 'swapColors' }
  | { type: 'resetColors' }
  /** Forward to `engine.keyDown(key, mods)` (Enter, Escape, arrows, Delete). */
  | { type: 'tool'; key: string }
  /** Modifier keys changed during a drag: `engine.updateModifiers`. */
  | { type: 'modifiers' };

export interface KeyLike {
  type: 'keydown' | 'keyup';
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

export interface KeyContext {
  /** Focus is in a text field / editable element (or the inline text editor). */
  typing: boolean;
  /** Focus is inside a dialog, popover, menu or listbox. */
  inOverlay: boolean;
  /** Focus is on the canvas (or nothing in particular: the page body). */
  canvasFocus: boolean;
  /** The pointer is over the canvas stage. */
  pointerOverStage: boolean;
  /** A pointer gesture is in progress on the canvas. */
  interacting: boolean;
  /** The engine holds a pending transform, or a gesture could be cancelled. */
  toolBusy: boolean;
  /** Space is currently held for the hand tool. */
  handHeld: boolean;
  /** `\` is currently held for before/after. */
  compareHeld: boolean;
  /** An original icon exists to compare against. */
  canCompare: boolean;
}

const TOOL_KEYS = new Set(['Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace']);
const MODIFIER_KEYS = new Set(['Shift', 'Alt', 'Control', 'Meta']);

function isBackslash(e: Pick<KeyLike, 'key' | 'code'>): boolean {
  return e.code === 'Backslash' || e.code === 'IntlBackslash' || e.key === '\\';
}

function isSpace(e: Pick<KeyLike, 'key' | 'code'>): boolean {
  return e.code === 'Space' || e.key === ' ';
}

/** What a key event means for the stage, or null to leave it alone. */
export function stageKeyAction(e: KeyLike, c: KeyContext): StageKeyAction | null {
  const plain = !e.ctrlKey && !e.altKey && !e.metaKey;

  // Releases always go through so a hold can never get stuck.
  if (e.type === 'keyup') {
    if (isSpace(e) && c.handHeld) return { type: 'hand', on: false };
    if (isBackslash(e) && c.compareHeld) return { type: 'compare', on: false };
    if (MODIFIER_KEYS.has(e.key) && c.interacting) return { type: 'modifiers' };
    return null;
  }

  if (MODIFIER_KEYS.has(e.key)) return c.interacting ? { type: 'modifiers' } : null;
  if (c.typing) return null;

  // View shortcuts work from anywhere in the editor except text fields.
  if (e.ctrlKey && !e.altKey && !e.metaKey && !c.inOverlay) {
    if (e.code === 'Digit0' || e.code === 'Numpad0' || e.key === '0') return { type: 'fit' };
    if (e.code === 'Digit1' || e.code === 'Numpad1' || e.key === '1') return { type: 'actualSize' };
    if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' || e.code === 'Equal') return { type: 'zoom', direction: 1 };
    if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract' || e.code === 'Minus') {
      return { type: 'zoom', direction: -1 };
    }
    return null;
  }
  if (!plain || c.inOverlay) return null;

  // Holds: Space pans while the pointer is over the canvas (or nothing
  // else wants the key); focused buttons keep Space for activation.
  if (isSpace(e)) {
    if (c.handHeld || e.repeat) return c.handHeld ? { type: 'hand', on: true } : null;
    return c.pointerOverStage || c.canvasFocus ? { type: 'hand', on: true } : null;
  }
  if (isBackslash(e)) {
    if (e.repeat || c.compareHeld || !c.canCompare) return null;
    return { type: 'compare', on: true };
  }

  // Keys for the active tool: Escape also cancels a drag from anywhere.
  if (TOOL_KEYS.has(e.key)) {
    if (e.key === 'Escape' && (c.interacting || c.toolBusy)) return { type: 'tool', key: e.key };
    return c.canvasFocus ? { type: 'tool', key: e.key } : null;
  }

  if (e.repeat || e.shiftKey) return null;
  switch (e.key.toLowerCase()) {
    case 'k':
      return { type: 'keylines' };
    case 'x':
      return { type: 'swapColors' };
    case 'd':
      return { type: 'resetColors' };
    default:
      return null;
  }
}

/** Minimal element shape for `focusContext` (unit tests pass plain objects). */
export interface ElementLike {
  tagName: string;
  isContentEditable?: boolean;
  closest?(selector: string): unknown;
  getAttribute?(name: string): string | null;
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);
const OVERLAY_SELECTOR = 'dialog, [role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"]';

/** Is the element a place where keys type text? */
export function isTypingTarget(el: ElementLike | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (el.getAttribute?.('type') ?? '').toLowerCase();
  return TEXT_INPUT_TYPES.has(type);
}

/** Is the element inside a dialog, popover, menu or listbox? */
export function isInOverlay(el: ElementLike | null | undefined): boolean {
  return !!el?.closest?.(OVERLAY_SELECTOR);
}
