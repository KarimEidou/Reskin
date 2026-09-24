import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '$lib/ipc/types';

// Rust's settings_set and the `settings:changed` event, faked.
const backend = vi.hoisted(() => ({
  saves: [] as Array<{ sent: Settings; resolve: (s: Settings) => void; reject: (e: Error) => void }>,
  listeners: new Map<string, (payload: unknown) => void>(),
  unlistened: [] as string[],
}));
vi.mock('$lib/ipc/commands', () => ({
  commands: {
    settingsSet: (settings: Settings) =>
      new Promise<Settings>((resolve, reject) => backend.saves.push({ sent: settings, resolve, reject })),
  },
}));
vi.mock('$lib/ipc/events', () => ({
  on: async (name: string, handler: (payload: unknown) => void) => {
    backend.listeners.set(name, handler);
    return () => {
      backend.unlistened.push(name);
      if (backend.listeners.get(name) === handler) backend.listeners.delete(name);
    };
  },
}));

import { defaultSettings } from './defaults';
import { applySettingsFromMailbox, initSettings, onSettingsChange, settings, updateSettings } from './store.svelte';

const flush = () => new Promise((r) => setTimeout(r, 0));
const boot = (window: 'box' | 'editor', patch: Partial<Settings> = {}) => ({
  window,
  settings: { ...defaultSettings(), ...patch },
});

beforeEach(() => {
  backend.saves = [];
  backend.listeners.clear();
  backend.unlistened = [];
});

describe('settings store', () => {
  it('seeds from boot and follows settings:changed in the box', async () => {
    const seen: Array<[string, string]> = [];
    const off = onSettingsChange((next, prev) => seen.push([next.boxSkin, prev.boxSkin]));
    await initSettings(boot('box', { boxSkin: 'minimal' }));
    expect(settings().boxSkin).toBe('minimal');
    expect(backend.listeners.has('settings:changed')).toBe(true);

    backend.listeners.get('settings:changed')!({ ...defaultSettings(), boxSkin: 'aurora' });
    expect(settings().boxSkin).toBe('aurora');
    expect(seen.at(-1)).toEqual(['aurora', 'minimal']);
    off();
  });

  it('reconciles an optimistic update with the saved value, keeping pending patches over pushes', async () => {
    await initSettings(boot('box'));
    const saved = updateSettings({ idleOpacity: 0.4 });
    expect(settings().idleOpacity).toBe(0.4);
    await flush();
    expect(backend.saves).toHaveLength(1);

    // Another window changes something else while the save is in flight:
    // the local patch stays on top of the pushed value.
    backend.listeners.get('settings:changed')!({ ...defaultSettings(), boxSkin: 'neon' });
    expect(settings()).toMatchObject({ boxSkin: 'neon', idleOpacity: 0.4 });

    backend.saves[0]!.resolve({ ...defaultSettings(), boxSkin: 'neon', idleOpacity: 0.4 });
    await expect(saved).resolves.toMatchObject({ boxSkin: 'neon', idleOpacity: 0.4 });
    expect(settings()).toMatchObject({ boxSkin: 'neon', idleOpacity: 0.4 });
  });

  it('rolls back when Rust refuses the save', async () => {
    await initSettings(boot('editor'));
    const saved = updateSettings({ sounds: true });
    expect(settings().sounds).toBe(true);
    await flush();
    backend.saves[0]!.reject(new Error('disk full'));
    await expect(saved).rejects.toThrow('disk full');
    expect(settings().sounds).toBe(false);
  });

  it('takes the editor’s settings from the mailbox, not from events', async () => {
    await initSettings(boot('editor'));
    expect(backend.listeners.has('settings:changed')).toBe(false);
    applySettingsFromMailbox({ ...defaultSettings(), theme: 'light' });
    expect(settings().theme).toBe('light');
  });

  it('stops listening when re-seeded', async () => {
    await initSettings(boot('box'));
    backend.unlistened = [];
    await initSettings(boot('box', { boxSize: 'large' }));
    expect(backend.unlistened).toEqual(['settings:changed']);
    expect(settings().boxSize).toBe('large');
  });
});
