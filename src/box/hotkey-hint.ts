// What the box says when the saved global hotkey doesn't work (Windows
// would not register it: `BootInfo.hotkeyError`, e.g. "Ctrl+Alt+Shift+R is
// already in use by another app"). The hint bubble inside the box is short
// enough for the small box; the box's tooltip and accessible description
// say it in full.

const TAKEN = / is already in use by another app\.?$/;

/** Rust's reason without a closing full stop. */
function reason(error: string): string {
  return error.trim().replace(/\.$/, '');
}

/** The hint bubble the box shows once, at start-up. */
export function hotkeyHint(error: string): string {
  const why = TAKEN.test(error.trim()) ? error.trim().replace(TAKEN, ' is taken') : reason(error);
  return `${why} — change it in Settings`;
}

/** The box's tooltip and accessible description while the hotkey doesn't work. */
export function hotkeyProblem(error: string): string {
  return `The global shortcut doesn't work: ${reason(error)}. Change it in Settings.`;
}
