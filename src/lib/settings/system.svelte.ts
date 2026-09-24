// What Windows says right now, for both pages (reactive):
//
//   system.accent / .reducedMotion / .hotkeyError
//   followSystem(boot, onChange)   once, from boot(): seeds the state and
//                                  re-reads it (app_boot) whenever the
//                                  window gains focus or becomes visible
//   refreshSystem()                re-reads it now (e.g. after a hotkey change;
//                                  asked for before followSystem, as soon
//                                  as it follows)
//
// The logic lives in ./system-watch.ts (unit tested); this module adds runes.

import { commands } from '$lib/ipc/commands';
import type { BootInfo } from '$lib/ipc/types';
import { SystemWatch, systemFrom, type SystemState } from './system-watch';

export type { SystemState } from './system-watch';

export const system = $state<SystemState>({ accent: null, reducedMotion: false, hotkeyError: null });

let watch: SystemWatch | null = null;
/** `refreshSystem` was called before `followSystem`: the state is read again once it follows. */
let refreshDue = false;

/** Seeds the state from boot info and follows later changes. Safe to call again. */
export function followSystem(boot: BootInfo, onChange: (next: SystemState) => void): void {
  watch?.stop();
  const initial = systemFrom(boot);
  Object.assign(system, initial);
  watch = new SystemWatch({
    initial,
    read: async () => systemFrom(await commands.appBoot()),
    onChange: (next) => {
      Object.assign(system, next);
      onChange(next);
    },
    window,
    document,
  });
  // A change announced while the boot info was on its way (read before it,
  // perhaps): read again.
  if (refreshDue) {
    refreshDue = false;
    void watch.refresh();
  }
}

/**
 * Reads the state again now; resolves once it is applied. Before
 * `followSystem` it resolves at once, and the state is read again as soon
 * as it follows.
 */
export function refreshSystem(): Promise<void> {
  if (watch) return watch.refresh();
  refreshDue = true;
  return Promise.resolve();
}
