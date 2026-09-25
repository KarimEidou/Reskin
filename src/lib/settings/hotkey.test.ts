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

  it('needs Ctrl, Alt or Win, or for F1–F24 at least Shift', () => {
    expect(parseHotkey('Shift+Q')).toEqual({ ok: false, error: "Add Ctrl, Alt or Win (Shift alone isn't enough)" });
    expect(parseHotkey('Shift+F9')).toEqual({
      ok: true,
      hotkey: { ctrl: false, alt: false, shift: true, win: false, key: 'F9' },
    });
    expect(canonicalHotkey('shift+f24', '')).toBe('Shift+F24');
    expect(canonicalHotkey('Alt+Q', '')).toBe('Alt+Q');
  });

  it('asks a bare key only for the modifiers that would do', () => {
    // Shift would not do for these: it is never suggested.
    for (const key of ['Q', '5', 'Space', 'Up', 'Plus', 'Escape']) {
      expect(parseHotkey(key)).toEqual({ ok: false, error: 'Add Ctrl, Alt or Win' });
    }
    // Function keys type nothing: Shift alone will do.
    for (const key of ['F1', 'F9', 'F24']) {
      expect(parseHotkey(key)).toEqual({ ok: false, error: 'Add Ctrl, Alt, Shift or Win' });
    }
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
