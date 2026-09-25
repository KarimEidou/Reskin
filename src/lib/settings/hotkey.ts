// Global-hotkey strings, mirroring `reskin_core::settings::parse_hotkey` so
// the UI can validate and canonicalise before Rust does.
//
// Canonical form: modifiers in the order Ctrl, Alt, Shift, Win, then one key
// by its user-facing name, joined with "+": "Ctrl+Alt+Shift+R". "" = off.

export interface Hotkey {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  /** User-facing key name: "R", "5", "F5", "Up", "Plus", "Space", … */
  key: string;
}

/** Named keys: [user-facing name, W3C `KeyboardEvent.code`]. */
const NAMED_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['Space', 'Space'],
  ['Enter', 'Enter'],
  ['Tab', 'Tab'],
  ['Escape', 'Escape'],
  ['Backspace', 'Backspace'],
  ['Delete', 'Delete'],
  ['Insert', 'Insert'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
  ['Up', 'ArrowUp'],
  ['Down', 'ArrowDown'],
  ['Left', 'ArrowLeft'],
  ['Right', 'ArrowRight'],
  ['Plus', 'Equal'],
  ['Minus', 'Minus'],
  ['Comma', 'Comma'],
  ['Period', 'Period'],
  ['Slash', 'Slash'],
  ['Backquote', 'Backquote'],
  ['BracketLeft', 'BracketLeft'],
  ['BracketRight', 'BracketRight'],
  ['Backslash', 'Backslash'],
  ['Semicolon', 'Semicolon'],
  ['Quote', 'Quote'],
];

const CTRL = new Set(['ctrl', 'control', 'commandorcontrol', 'commandorctrl', 'cmdorctrl', 'cmdorcontrol']);
const WIN = new Set(['win', 'super', 'meta', 'cmd', 'command']);

/** Parses one key token (case-insensitive) to its user-facing name. */
export function parseKey(token: string): string | null {
  const upper = token.toUpperCase();
  const letter = /^(?:KEY)?([A-Z])$/.exec(upper);
  if (letter) return letter[1]!;
  const digit = /^(?:DIGIT)?([0-9])$/.exec(upper);
  if (digit) return digit[1]!;
  const f = /^F([1-9][0-9]?)$/.exec(upper);
  if (f) {
    const n = Number(f[1]);
    return n >= 1 && n <= 24 ? `F${n}` : null;
  }
  if (upper === 'ESC') return 'Escape';
  const named = NAMED_KEYS.find(([name, code]) => name.toUpperCase() === upper || code.toUpperCase() === upper);
  return named ? named[0] : null;
}

export type HotkeyParse = { ok: true; hotkey: Hotkey | null } | { ok: false; error: string };

/** Parses "Ctrl+Alt+R"-style strings. `""` → `{ ok: true, hotkey: null }`. */
export function parseHotkey(input: string): HotkeyParse {
  const s = input.trim();
  if (!s) return { ok: true, hotkey: null };
  const hk: Hotkey = { ctrl: false, alt: false, shift: false, win: false, key: '' };
  for (const raw of s.split('+')) {
    const token = raw.trim();
    if (!token) return { ok: false, error: 'Empty key name (use "Plus" for the + key)' };
    const lower = token.toLowerCase();
    if (CTRL.has(lower)) hk.ctrl = true;
    else if (lower === 'alt') hk.alt = true;
    else if (lower === 'shift') hk.shift = true;
    else if (WIN.has(lower)) hk.win = true;
    else {
      const key = parseKey(token);
      if (!key) return { ok: false, error: `Unknown key "${token}"` };
      if (hk.key) return { ok: false, error: 'Only one non-modifier key is allowed' };
      hk.key = key;
    }
  }
  if (!hk.key) return { ok: false, error: 'A key is missing' };
  // Mirrors Rust: a global hotkey needs at least one modifier. Shift alone
  // would swallow that character system-wide, so it needs Ctrl, Alt or Win —
  // except for F1–F24, which type nothing: Shift alone will do for them. A
  // bare key is only told about Shift when Shift would do.
  const functionKey = /^F\d{1,2}$/.test(hk.key);
  if (!(hk.ctrl || hk.alt || hk.shift || hk.win)) {
    return { ok: false, error: functionKey ? 'Add Ctrl, Alt, Shift or Win' : 'Add Ctrl, Alt or Win' };
  }
  if (!(hk.ctrl || hk.alt || hk.win) && !functionKey) {
    return { ok: false, error: "Add Ctrl, Alt or Win (Shift alone isn't enough)" };
  }
  return { ok: true, hotkey: hk };
}

export function formatHotkey(hk: Hotkey): string {
  const parts: string[] = [];
  if (hk.ctrl) parts.push('Ctrl');
  if (hk.alt) parts.push('Alt');
  if (hk.shift) parts.push('Shift');
  if (hk.win) parts.push('Win');
  parts.push(hk.key);
  return parts.join('+');
}

/** Canonical form; "" when disabled, `fallback` when it does not parse. */
export function canonicalHotkey(input: string, fallback: string): string {
  const r = parseHotkey(input);
  if (!r.ok) return fallback;
  return r.hotkey ? formatHotkey(r.hotkey) : '';
}

/**
 * Builds a hotkey from a keydown (for "press the new shortcut" fields).
 * Returns null while only modifiers are held or the key is unsupported.
 */
export function hotkeyFromEvent(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): Hotkey | null {
  const key = parseKey(e.code);
  if (!key) return null;
  return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, win: e.metaKey, key };
}
