import { describe, expect, it } from 'vitest';
import { hotkeyHint, hotkeyProblem } from './hotkey-hint';

describe('the box on a hotkey that does not work', () => {
  it('says briefly, in the hint, that another app has it', () => {
    expect(hotkeyHint('Ctrl+Alt+Shift+R is already in use by another app')).toBe(
      'Ctrl+Alt+Shift+R is taken — change it in Settings',
    );
    expect(hotkeyHint(' Ctrl+K is already in use by another app. ')).toBe('Ctrl+K is taken — change it in Settings');
  });

  it('passes any other reason on as it is', () => {
    expect(hotkeyHint("Ctrl+Q isn't a valid shortcut")).toBe("Ctrl+Q isn't a valid shortcut — change it in Settings");
  });

  it('says it in full in the tooltip and the accessible description', () => {
    expect(hotkeyProblem('Ctrl+Alt+Shift+R is already in use by another app.')).toBe(
      "The global shortcut doesn't work: Ctrl+Alt+Shift+R is already in use by another app. Change it in Settings.",
    );
  });
});
