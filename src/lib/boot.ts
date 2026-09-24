// Page bootstrap shared by the box and the editor:
//   const info = await boot();
// fetches BootInfo, seeds the settings store, applies theme, motion and
// sound preferences, and keeps them in sync with later settings changes and
// with what Windows changes meanwhile (accent colour, animation effects, a
// hotkey another app holds: re-read when the window gains focus or becomes
// visible, and when Rust says so — `system:changed`).

import { commands } from '$lib/ipc/commands';
import { EVENTS, on } from '$lib/ipc/events';
import type { BootInfo } from '$lib/ipc/types';
import { initMotion, updateMotion } from '$lib/motion/speed.svelte';
import { initSettings, onSettingsChange, settings } from '$lib/settings/store.svelte';
import { followSystem, refreshSystem, system } from '$lib/settings/system.svelte';
import { setSoundEnabled } from '$lib/sound/synth';
import { applyTheme } from '$lib/theme/theme';

let booting: Promise<BootInfo> | null = null;
let info: BootInfo | null = null;
/** Stops following settings changes (replaced when a failed boot is retried). */
let unfollow: (() => void) | null = null;
/** Listening for `system:changed` (once per page). */
let systemEvents: Promise<unknown> | null = null;

async function run(): Promise<BootInfo> {
  // Before app_boot reads Windows' state: a change announced after that
  // read must not be missed.
  systemEvents ??= on(EVENTS.system, () => void refreshSystem()).catch((e: unknown) =>
    console.warn('[boot] cannot follow system:changed', e),
  );
  await systemEvents;
  const b = await commands.appBoot();
  info = b;
  document.documentElement.dataset.window = b.window;
  applyTheme({ settings: b.settings, accent: b.accent });
  initMotion(b);
  setSoundEnabled(b.settings.sounds);
  unfollow?.();
  unfollow = onSettingsChange((s) => {
    applyTheme({ settings: s, accent: system.accent });
    updateMotion(s);
    setSoundEnabled(s.sounds);
  });
  followSystem(b, (next) => {
    const s = settings();
    applyTheme({ settings: s, accent: next.accent });
    initMotion({ settings: s, systemReducedMotion: next.reducedMotion });
  });
  await initSettings(b);
  return b;
}

/** Boots the page once; later calls return the same result. */
export function boot(): Promise<BootInfo> {
  booting ??= run().catch((error: unknown) => {
    booting = null;
    throw error;
  });
  return booting;
}

/** BootInfo of this page; only valid after `boot()` resolved. */
export function bootInfo(): BootInfo {
  if (!info) throw new Error('bootInfo() called before boot() finished');
  return info;
}
