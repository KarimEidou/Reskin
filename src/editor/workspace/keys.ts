// Canvas-local keyboard handling, as a pure function (unit tested).
//
// The workspace owns the keys that act on the canvas itself (STAGE_KEYS):
// hold Space for the hand tool, hold `\` for before/after, and it forwards
// Enter / Escape / arrows / Delete / Backspace to the active tool while the
// canvas has focus; Delete / Backspace the tool does not use clear the
// selected pixels (the whole layer without a selection). Everything else,
// view and colour keys included (K, X, D, Ctrl+0 / Ctrl+1 / Ctrl +/-),
// belongs to the app-wide command registry (palette/commands.ts): every key
// has exactly one owner.

export type StageKeyAction =
  | { type: 'hand'; on: boolean }
  | { type: 'compare'; on: boolean }
  /**
   * Forward to `engine.keyDown(key, mods)` (Enter, Escape, arrows, Delete,
   * Backspace). `clear`: when the tool does not use the key, clear the
   * selected pixels instead (`engine.clearPixels`).
   */
  | { type: 'tool'; key: string; clear?: true }
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
  /**
   * A button-like control was reached with the keyboard: Space activates
   * it, so the hand tool must not take the key.
   */
  controlFocused: boolean;
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
/** Tool keys that clear the selected pixels when the tool leaves them. */
const CLEAR_KEYS = new Set(['Delete', 'Backspace']);
const MODIFIER_KEYS = new Set(['Shift', 'Alt', 'Control', 'Meta']);

/**
 * Every key chord the stage acts on, in shortcut notation (palette/keys.ts):
 * the holds and the tool keys, alone or with Shift (Shift+arrow nudges
 * further). The command registry must bind none of them.
 */
export const STAGE_KEYS: readonly string[] = [
  'Space',
  '\\',
  'Enter',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right',
  'Delete',
  'Backspace',
].flatMap((k) => [k, `Shift+${k}`]);

/** The stage's keys as the shortcuts overlay lists them (shortcut notation, or a key cap's text). */
export const STAGE_SHORTCUTS: ReadonlyArray<{ label: string; keys: readonly string[]; note?: string }> = [
  { label: 'Pan the canvas', keys: ['Space'], note: 'hold + drag' },
  { label: 'Compare with the original', keys: ['\\'], note: 'hold' },
  { label: 'Commit a transform, text or lasso polygon', keys: ['Enter'] },
  { label: 'Cancel the current operation', keys: ['Esc'] },
  { label: 'Clear the selection (the layer without one)', keys: ['Delete', 'Backspace'] },
  { label: 'Remove the last lasso corner', keys: ['Backspace', 'Delete'] },
  { label: 'Nudge the layer or selection', keys: ['↑ ↓ ← →'], note: 'Shift: 10 px' },
];

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
  if (c.typing || !plain || c.inOverlay) return null;

  // Holds: Space pans while the pointer is over the canvas (or nothing
  // else wants the key); a button reached with the keyboard keeps Space
  // for its activation.
  if (isSpace(e)) {
    if (c.handHeld || e.repeat) return c.handHeld ? { type: 'hand', on: true } : null;
    if (c.controlFocused && !c.canvasFocus) return null;
    return c.pointerOverStage || c.canvasFocus ? { type: 'hand', on: true } : null;
  }
  if (isBackslash(e)) {
    if (e.repeat || c.compareHeld || !c.canCompare) return null;
    return { type: 'compare', on: true };
  }

  // Keys for the active tool: Escape also cancels a drag from anywhere.
  if (TOOL_KEYS.has(e.key)) {
    if (e.key === 'Escape' && (c.interacting || c.toolBusy)) return { type: 'tool', key: e.key };
    if (!c.canvasFocus) return null;
    return CLEAR_KEYS.has(e.key) && !c.interacting ? { type: 'tool', key: e.key, clear: true } : { type: 'tool', key: e.key };
  }
  return null;
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

const SPACE_ROLES = new Set([
  'button',
  'checkbox',
  'switch',
  'radio',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
]);
const SPACE_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file']);

/** Does Space activate this element (a button, checkbox, radio, tab…)? */
export function isSpaceControl(el: ElementLike | null | undefined): boolean {
  if (!el) return false;
  const role = (el.getAttribute?.('role') ?? '').toLowerCase();
  if (role) return SPACE_ROLES.has(role);
  const tag = el.tagName.toUpperCase();
  if (tag === 'BUTTON' || tag === 'SUMMARY') return true;
  if (tag !== 'INPUT') return false;
  return SPACE_INPUT_TYPES.has((el.getAttribute?.('type') ?? '').toLowerCase());
}

/** Keys that move focus between controls. */
const FOCUS_NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
/** A focus change this soon after a navigation key came from that key. */
const NAV_FOCUS_WINDOW_MS = 400;

/**
 * Tracks whether the focused element was reached with the keyboard (Tab,
 * arrows…) or by a pointer press / script. The browser's `:focus-visible`
 * cannot tell: it turns on for a clicked button as soon as any key is
 * pressed, Space included. Feed it the window's events (capture phase).
 */
export class FocusOrigin {
  private navAt = Number.NEGATIVE_INFINITY;
  private pressing = false;
  /** The focused element was reached by keyboard navigation. */
  keyboard = false;

  keydown(key: string, time: number): void {
    if (FOCUS_NAV_KEYS.has(key)) this.navAt = time;
  }

  pointerdown(): void {
    this.pressing = true;
  }

  pointerup(): void {
    this.pressing = false;
  }

  focusin(time: number): void {
    this.keyboard = !this.pressing && time - this.navAt <= NAV_FOCUS_WINDOW_MS;
  }
}

/** Is the element inside a dialog, popover, menu or listbox? */
export function isInOverlay(el: ElementLike | null | undefined): boolean {
  return !!el?.closest?.(OVERLAY_SELECTOR);
}
