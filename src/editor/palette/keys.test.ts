import { describe, expect, it } from 'vitest';
import { comboKeys, isBareKey, isTypingTarget, isWidgetTarget, matchesCombo, normalizeKey, parseCombo, type KeyLike } from './keys';

function key(k: string, mods: Partial<KeyLike> = {}, code = ''): KeyLike {
  const guessed =
    code ||
    (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^\d$/.test(k) ? `Digit${k}` : k === '=' || k === '+' ? 'Equal' : '');
  return { key: k, code: guessed, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

describe('parseCombo', () => {
  it('parses modifiers and normalises the key', () => {
    expect(parseCombo('Ctrl+Shift+Z')).toEqual({ ctrl: true, alt: false, shift: true, win: false, key: 'Z' });
    expect(parseCombo('Shift+g')).toMatchObject({ shift: true, key: 'G' });
    expect(parseCombo('Alt+F4')).toMatchObject({ alt: true, key: 'F4' });
    expect(parseCombo('Win+Esc')).toMatchObject({ win: true, key: 'Escape' });
  });

  it('understands the plus and minus keys', () => {
    expect(parseCombo('Ctrl++')).toMatchObject({ ctrl: true, key: 'Plus' });
    expect(parseCombo('Ctrl+=')).toMatchObject({ ctrl: true, key: 'Plus' });
    expect(parseCombo('Ctrl+-')).toMatchObject({ ctrl: true, key: 'Minus' });
    expect(parseCombo('+')).toMatchObject({ key: 'Plus' });
    expect(parseCombo('?')).toMatchObject({ shift: false, key: '?' });
  });

  it('normalises event key names', () => {
    expect(normalizeKey('ArrowUp')).toBe('Up');
    expect(normalizeKey(' ')).toBe('Space');
    expect(normalizeKey('a')).toBe('A');
    expect(normalizeKey('f12')).toBe('F12');
    expect(normalizeKey('\\')).toBe('\\');
  });
});

describe('matchesCombo', () => {
  it('requires modifiers to match exactly', () => {
    expect(matchesCombo('Ctrl+Z', key('z', { ctrlKey: true }))).toBe(true);
    expect(matchesCombo('Ctrl+Z', key('z'))).toBe(false);
    expect(matchesCombo('Ctrl+Z', key('Z', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matchesCombo('Ctrl+Shift+Z', key('Z', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesCombo('Ctrl+Z', key('z', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(matchesCombo('Ctrl+Z', key('z', { ctrlKey: true, metaKey: true }))).toBe(false);
  });

  it('tells G from Shift+G', () => {
    expect(matchesCombo('G', key('g'))).toBe(true);
    expect(matchesCombo('G', key('G', { shiftKey: true }))).toBe(false);
    expect(matchesCombo('Shift+G', key('G', { shiftKey: true }))).toBe(true);
    expect(matchesCombo('Shift+G', key('g'))).toBe(false);
  });

  it('ignores Shift for shifted characters', () => {
    expect(matchesCombo('?', key('?', { shiftKey: true }, 'Slash'))).toBe(true);
    expect(matchesCombo('?', key('?', { shiftKey: false }, 'Minus'))).toBe(true);
    expect(matchesCombo('Ctrl++', key('+', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesCombo('Ctrl++', key('=', { ctrlKey: true }))).toBe(true);
    expect(matchesCombo('Ctrl++', key('+', { ctrlKey: true }, 'NumpadAdd'))).toBe(true);
    expect(matchesCombo('Ctrl+-', key('-', { ctrlKey: true }, 'Minus'))).toBe(true);
  });

  it('falls back to the physical key for digits and non-Latin letters', () => {
    expect(matchesCombo('Ctrl+1', key('1', { ctrlKey: true }))).toBe(true);
    expect(matchesCombo('Ctrl+Shift+1', key('!', { ctrlKey: true, shiftKey: true }, 'Digit1'))).toBe(true);
    expect(matchesCombo('Ctrl+Z', key('я', { ctrlKey: true }, 'KeyZ'))).toBe(true);
    // A Latin layout where the printed letter differs from the position (AZERTY Z key).
    expect(matchesCombo('Ctrl+Z', key('w', { ctrlKey: true }, 'KeyZ'))).toBe(false);
    expect(matchesCombo('Ctrl+Z', key('z', { ctrlKey: true }, 'KeyW'))).toBe(true);
  });

  it('matches named keys', () => {
    expect(matchesCombo('Ctrl+Enter', key('Enter', { ctrlKey: true }, 'Enter'))).toBe(true);
    expect(matchesCombo('Escape', key('Escape', {}, 'Escape'))).toBe(true);
    expect(matchesCombo('Ctrl+,', key(',', { ctrlKey: true }, 'Comma'))).toBe(true);
    expect(matchesCombo('', key('a'))).toBe(false);
  });
});

describe('helpers', () => {
  it('formats keys for display', () => {
    expect(comboKeys('Ctrl+Shift+Z')).toEqual(['Ctrl', 'Shift', 'Z']);
    expect(comboKeys('Ctrl++')).toEqual(['Ctrl', '+']);
    expect(comboKeys('Ctrl+-')).toEqual(['Ctrl', '−']);
    expect(comboKeys('?')).toEqual(['?']);
  });

  it('knows bare keys', () => {
    expect(isBareKey('B')).toBe(true);
    expect(isBareKey('Shift+G')).toBe(true);
    expect(isBareKey('Ctrl+B')).toBe(false);
    expect(isBareKey('Alt+B')).toBe(false);
  });

  it('recognises typing and widget targets through closest()', () => {
    const el = (matches: (sel: string) => boolean, isContentEditable = false) => ({
      closest: (sel: string) => (matches(sel) ? {} : null),
      isContentEditable,
    });
    expect(isTypingTarget(el((s) => s.includes('textarea')))).toBe(true);
    expect(isTypingTarget(el(() => false, true))).toBe(true);
    expect(isTypingTarget(el(() => false))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isWidgetTarget(el((s) => s.includes('role="menu"')))).toBe(true);
    expect(isWidgetTarget({} as never)).toBe(false);
  });
});
