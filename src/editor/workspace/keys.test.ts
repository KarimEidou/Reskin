import { describe, expect, it } from 'vitest';
import {
  FocusOrigin,
  isInOverlay,
  isSpaceControl,
  isTypingTarget,
  stageKeyAction,
  type KeyContext,
  type KeyLike,
} from './keys';

const ctx = (patch: Partial<KeyContext> = {}): KeyContext => ({
  typing: false,
  inOverlay: false,
  canvasFocus: true,
  pointerOverStage: false,
  controlFocused: false,
  interacting: false,
  toolBusy: false,
  handHeld: false,
  compareHeld: false,
  canCompare: true,
  ...patch,
});

const key = (k: string, patch: Partial<KeyLike> = {}): KeyLike => ({
  type: 'keydown',
  key: k,
  code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  ...patch,
});

describe('stageKeyAction — holds', () => {
  it('Space holds the hand tool over the canvas and releases on keyup', () => {
    const space = key(' ', { code: 'Space' });
    expect(stageKeyAction(space, ctx({ canvasFocus: false, pointerOverStage: true }))).toEqual({ type: 'hand', on: true });
    expect(stageKeyAction({ ...space, type: 'keyup' }, ctx({ handHeld: true }))).toEqual({ type: 'hand', on: false });
  });

  it('leaves Space to a focused button when the pointer is elsewhere', () => {
    expect(stageKeyAction(key(' ', { code: 'Space' }), ctx({ canvasFocus: false }))).toBeNull();
  });

  it('never steals Space from a button reached with the keyboard, even with the pointer over the canvas', () => {
    const space = key(' ', { code: 'Space' });
    expect(stageKeyAction(space, ctx({ canvasFocus: false, pointerOverStage: true, controlFocused: true }))).toBeNull();
    // A mouse-clicked rail button (no focus ring) still lets Space pan over the canvas.
    expect(stageKeyAction(space, ctx({ canvasFocus: false, pointerOverStage: true, controlFocused: false }))).toEqual({
      type: 'hand',
      on: true,
    });
    // Once held, the hold continues whatever has focus.
    expect(stageKeyAction({ ...space, repeat: true }, ctx({ handHeld: true, controlFocused: true }))).toEqual({
      type: 'hand',
      on: true,
    });
  });

  it('swallows auto-repeat while held, ignores it otherwise', () => {
    const repeat = key(' ', { code: 'Space', repeat: true });
    expect(stageKeyAction(repeat, ctx({ handHeld: true }))).toEqual({ type: 'hand', on: true });
    expect(stageKeyAction(repeat, ctx())).toBeNull();
  });

  it('\\ peeks at the original while held (only when there is one)', () => {
    const bs = key('\\', { code: 'Backslash' });
    expect(stageKeyAction(bs, ctx())).toEqual({ type: 'compare', on: true });
    expect(stageKeyAction(bs, ctx({ canCompare: false }))).toBeNull();
    expect(stageKeyAction({ ...bs, repeat: true }, ctx())).toBeNull();
    expect(stageKeyAction({ ...bs, type: 'keyup' }, ctx({ compareHeld: true }))).toEqual({ type: 'compare', on: false });
    expect(stageKeyAction({ ...bs, type: 'keyup' }, ctx())).toBeNull();
  });

  it('releases holds even while typing', () => {
    expect(stageKeyAction(key(' ', { code: 'Space', type: 'keyup' }), ctx({ typing: true, handHeld: true }))).toEqual({
      type: 'hand',
      on: false,
    });
  });
});

describe('stageKeyAction — view and colours', () => {
  it('maps Ctrl+0 / Ctrl+1 / Ctrl +/- to the view', () => {
    expect(stageKeyAction(key('0', { code: 'Digit0', ctrlKey: true }), ctx())).toEqual({ type: 'fit' });
    expect(stageKeyAction(key('1', { code: 'Digit1', ctrlKey: true }), ctx())).toEqual({ type: 'actualSize' });
    expect(stageKeyAction(key('=', { code: 'Equal', ctrlKey: true }), ctx())).toEqual({ type: 'zoom', direction: 1 });
    expect(stageKeyAction(key('+', { code: 'NumpadAdd', ctrlKey: true }), ctx())).toEqual({ type: 'zoom', direction: 1 });
    expect(stageKeyAction(key('-', { code: 'Minus', ctrlKey: true }), ctx())).toEqual({ type: 'zoom', direction: -1 });
  });

  it('view shortcuts work from buttons but not from text fields or overlays', () => {
    const fit = key('0', { code: 'Digit0', ctrlKey: true });
    expect(stageKeyAction(fit, ctx({ canvasFocus: false }))).toEqual({ type: 'fit' });
    expect(stageKeyAction(fit, ctx({ typing: true }))).toBeNull();
    expect(stageKeyAction(fit, ctx({ inOverlay: true }))).toBeNull();
  });

  it('K toggles keylines, X swaps and D resets colours', () => {
    expect(stageKeyAction(key('k'), ctx())).toEqual({ type: 'keylines' });
    expect(stageKeyAction(key('K', { code: 'KeyK' }), ctx({ canvasFocus: false }))).toEqual({ type: 'keylines' });
    expect(stageKeyAction(key('x'), ctx())).toEqual({ type: 'swapColors' });
    expect(stageKeyAction(key('d'), ctx())).toEqual({ type: 'resetColors' });
  });

  it('leaves letters with modifiers, repeats and typing alone', () => {
    expect(stageKeyAction(key('x', { ctrlKey: true }), ctx())).toBeNull();
    expect(stageKeyAction(key('x', { shiftKey: true }), ctx())).toBeNull();
    expect(stageKeyAction(key('x', { repeat: true }), ctx())).toBeNull();
    expect(stageKeyAction(key('x'), ctx({ typing: true }))).toBeNull();
    expect(stageKeyAction(key('x'), ctx({ inOverlay: true }))).toBeNull();
    expect(stageKeyAction(key('b'), ctx())).toBeNull();
  });
});

describe('stageKeyAction — tool keys', () => {
  it('forwards Enter / arrows / Delete when the canvas has focus', () => {
    for (const k of ['Enter', 'ArrowLeft', 'ArrowDown', 'Delete', 'Escape']) {
      expect(stageKeyAction(key(k), ctx())).toEqual({ type: 'tool', key: k });
    }
    expect(stageKeyAction(key('ArrowLeft', { shiftKey: true }), ctx())).toEqual({ type: 'tool', key: 'ArrowLeft' });
  });

  it('keeps arrows for other focused controls', () => {
    expect(stageKeyAction(key('ArrowLeft'), ctx({ canvasFocus: false }))).toBeNull();
    expect(stageKeyAction(key('Enter'), ctx({ canvasFocus: false }))).toBeNull();
  });

  it('Escape cancels a drag or pending transform from anywhere', () => {
    expect(stageKeyAction(key('Escape'), ctx({ canvasFocus: false, interacting: true }))).toEqual({
      type: 'tool',
      key: 'Escape',
    });
    expect(stageKeyAction(key('Escape'), ctx({ canvasFocus: false, toolBusy: true }))).toEqual({
      type: 'tool',
      key: 'Escape',
    });
    expect(stageKeyAction(key('Escape'), ctx({ canvasFocus: false }))).toBeNull();
  });

  it('reports modifier changes only during a gesture', () => {
    expect(stageKeyAction(key('Shift', { code: 'ShiftLeft', shiftKey: true }), ctx({ interacting: true }))).toEqual({
      type: 'modifiers',
    });
    expect(stageKeyAction(key('Shift', { code: 'ShiftLeft', type: 'keyup' }), ctx({ interacting: true }))).toEqual({
      type: 'modifiers',
    });
    expect(stageKeyAction(key('Alt', { code: 'AltLeft', altKey: true }), ctx())).toBeNull();
  });
});

describe('focus classification', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({
    tagName,
    getAttribute: (n: string) => (n === 'type' ? ((extra.type as string | undefined) ?? null) : null),
    closest: (sel: string) => (extra.overlay && sel.includes('dialog') ? {} : null),
    isContentEditable: extra.editable === true,
  });

  it('treats text inputs, textareas, selects and editables as typing', () => {
    expect(isTypingTarget(el('INPUT'))).toBe(true);
    expect(isTypingTarget(el('input', { type: 'text' }))).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'number' }))).toBe(true);
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(el('SELECT'))).toBe(true);
    expect(isTypingTarget(el('DIV', { editable: true }))).toBe(true);
  });

  it('does not treat buttons, ranges or checkboxes as typing', () => {
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(el('INPUT', { type: 'range' }))).toBe(false);
    expect(isTypingTarget(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('knows which controls Space activates', () => {
    const withRole = (tagName: string, role: string | null, type: string | null = null) => ({
      tagName,
      getAttribute: (n: string) => (n === 'role' ? role : n === 'type' ? type : null),
    });
    expect(isSpaceControl(withRole('BUTTON', null))).toBe(true);
    expect(isSpaceControl(withRole('DIV', 'switch'))).toBe(true);
    expect(isSpaceControl(withRole('BUTTON', 'menuitemcheckbox'))).toBe(true);
    expect(isSpaceControl(withRole('INPUT', null, 'checkbox'))).toBe(true);
    expect(isSpaceControl(withRole('INPUT', null, 'range'))).toBe(false);
    expect(isSpaceControl(withRole('DIV', 'slider'))).toBe(false);
    expect(isSpaceControl(withRole('CANVAS', null))).toBe(false);
    expect(isSpaceControl(null)).toBe(false);
  });

  it('detects overlays', () => {
    expect(isInOverlay(el('BUTTON', { overlay: true }))).toBe(true);
    expect(isInOverlay(el('BUTTON'))).toBe(false);
    expect(isInOverlay(undefined)).toBe(false);
  });
});

describe('FocusOrigin', () => {
  it('reports focus reached with Tab or arrows as keyboard focus', () => {
    const f = new FocusOrigin();
    f.keydown('Tab', 1000);
    f.focusin(1004);
    expect(f.keyboard).toBe(true);
    f.keydown('ArrowDown', 2000);
    f.focusin(2001);
    expect(f.keyboard).toBe(true);
  });

  it('reports a clicked control as pointer focus, whatever keys came before', () => {
    const f = new FocusOrigin();
    f.keydown('Tab', 1000);
    f.pointerdown();
    f.focusin(1002);
    f.pointerup();
    expect(f.keyboard).toBe(false);
    // Shortcut letters (and Space itself) do not turn a clicked button into keyboard focus.
    f.keydown('b', 1500);
    f.keydown(' ', 1600);
    expect(f.keyboard).toBe(false);
  });

  it('treats a scripted focus long after any navigation key as pointer-driven', () => {
    const f = new FocusOrigin();
    f.keydown('Tab', 1000);
    f.focusin(5000);
    expect(f.keyboard).toBe(false);
  });
});
