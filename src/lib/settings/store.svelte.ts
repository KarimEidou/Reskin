// Reactive settings for both pages.
//
//   initSettings(boot)            once, from boot() — the box also starts
//                                 listening to `settings:changed`
//   settings()                    current settings (reactive in components)
//   updateSettings(patch)         optimistic update + settings_set, reconciled
//                                 with Rust's normalised answer
//   applySettingsFromMailbox(s)   the editor's `Settings{…}` mailbox command
//   onSettingsChange(cb)          plain callback (theme, motion, sounds)
//
// The logic lives in ./sync.ts (unit tested); this module adds runes.

import { commands } from '$lib/ipc/commands';
import { on } from '$lib/ipc/events';
import type { BootInfo, Settings } from '$lib/ipc/types';
import { defaultSettings } from './defaults';
import { SettingsSync } from './sync';

export type SettingsListener = (next: Settings, prev: Settings) => void;

// Replaced wholesale on every change (never mutated), so `raw` suffices and
// the value stays a plain object that can cross the IPC boundary as is.
let current = $state.raw<Settings>(defaultSettings());
let sync: SettingsSync | null = null;
let unlisten: (() => void) | null = null;
const listeners = new Set<SettingsListener>();

function publish(next: Settings, prev: Settings): void {
  current = next;
  for (const listener of listeners) {
    try {
      listener(next, prev);
    } catch (error) {
      console.error('[settings] listener failed', error);
    }
  }
}

export interface InitSettingsOptions {
  /** Follow `settings:changed` events (default: only in the box window). */
  listen?: boolean;
}

/** Seeds the store from boot info. Safe to call again (re-seeds). */
export async function initSettings(
  boot: Pick<BootInfo, 'settings' | 'window'>,
  opts: InitSettingsOptions = {},
): Promise<void> {
  unlisten?.();
  unlisten = null;
  const prev = current;
  sync = new SettingsSync(boot.settings, {
    save: (s) => commands.settingsSet(s),
    onChange: publish,
  });
  publish(boot.settings, prev);
  if (opts.listen ?? boot.window === 'box') {
    unlisten = await on('settings:changed', (s) => sync?.external(s));
  }
}

/** The current settings (reactive when read inside components/effects). */
export function settings(): Settings {
  return current;
}

/**
 * Changes settings. The UI updates immediately; the returned promise
 * resolves with the reconciled value, or rejects (after rolling back) when
 * Rust refuses the save.
 */
export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  if (!sync) return Promise.reject(new Error('settings are not initialised (call boot() first)'));
  return sync.update(patch);
}

/** Applies settings delivered through the editor mailbox. */
export function applySettingsFromMailbox(next: Settings): void {
  if (sync) sync.external(next);
  else publish(next, current);
}

/** Subscribes to changes; returns an unsubscribe function. */
export function onSettingsChange(listener: SettingsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
