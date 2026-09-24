import { describe, expect, it } from 'vitest';
import { canonicalHotkey, formatHotkey, hotkeyFromEvent, parseHotkey, parseKey } from './hotkey';

describe('parseKey', () => {
  it('accepts names and W3C codes', () => {
    expect(parseKey('r')).toBe('R');
    expect(parseKey('KeyR')).toBe('R');
    expect(parseKey('Digit5')).toBe('5');
    expect(parseKey('f12')).toBe('F12');
    expect(parseKey('F24')).toBe('F24');
    expect(parseKey('F25')).toBeNull();
    expect(parseKey('F05')).toBeNull();
    expect(parseKey('esc')).toBe('Escape');
    expect(parseKey('ArrowUp')).toBe('Up');
    expect(parseKey('Equal')).toBe('Plus');
    expect(parseKey('Nope')).toBeNull();
  });
});

describe('parseHotkey', () => {
  it('canonicalises modifiers in a fixed order', () => {
    const r = parseHotkey(' shift+ win + control + keyk ');
    expect(r).toEqual({ ok: true, hotkey: { ctrl: true, alt: false, shift: true, win: true, key: 'K' } });
    if (r.ok && r.hotkey) expect(formatHotkey(r.hotkey)).toBe('Ctrl+Shift+Win+K');
    expect(canonicalHotkey('CmdOrCtrl+Plus', 'x')).toBe('Ctrl+Plus');
  });

  it('treats empty as disabled and reports errors', () => {
    expect(parseHotkey('')).toEqual({ ok: true, hotkey: null });
    expect(parseHotkey('R').ok).toBe(false);
    expect(parseHotkey('Ctrl+').ok).toBe(false);
    expect(parseHotkey('Ctrl+A+B').ok).toBe(false);
    expect(parseHotkey('Ctrl+Shift').ok).toBe(false);
    expect(canonicalHotkey('Ctrl+Bogus', 'Ctrl+Alt+Shift+R')).toBe('Ctrl+Alt+Shift+R');
  });

  it('builds hotkeys from key events', () => {
    expect(
      hotkeyFromEvent({ code: 'KeyR', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }),
    ).toEqual({ ctrl: true, alt: true, shift: false, win: false, key: 'R' });
    expect(
      hotkeyFromEvent({ code: 'ShiftLeft', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }),
    ).toBeNull();
  });
});
