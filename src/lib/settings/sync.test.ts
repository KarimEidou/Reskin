import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '$lib/ipc/types';

// Rust's settings_set, faked: a queue of controllable responses.
const backend = vi.hoisted(() => ({
  saves: [] as Array<{
    sent: Settings;
    resolve: (s: Settings) => void;
    reject: (e: Error) => void;
  }>,
}));
vi.mock('$lib/ipc/commands', () => ({
  commands: {
    settingsSet: (settings: Settings) =>
      new Promise<Settings>((resolve, reject) => backend.saves.push({ sent: settings, resolve, reject })),
  },
}));

import { commands } from '$lib/ipc/commands';
import { defaultSettings, normalizeSettings } from './defaults';
import { SettingsSync } from './sync';

/** Lets queued promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeSync(initial = defaultSettings()) {
  const changes: Array<[Settings, Settings]> = [];
  const sync = new SettingsSync(initial, {
    save: (s) => commands.settingsSet(s),
    onChange: (next, prev) => changes.push([next, prev]),
  });
  return { sync, changes };
}

beforeEach(() => {
  backend.saves = [];
});

describe('SettingsSync', () => {
  it('applies a patch optimistically, then adopts the normalised answer', async () => {
    const { sync, changes } = makeSync();
    const done = sync.update({ idleOpacity: 0.5, boxSkin: 'neon' });
    expect(sync.current.idleOpacity).toBe(0.5);
    expect(sync.current.boxSkin).toBe('neon');
    expect(changes).toHaveLength(1);
    expect(sync.pendingCount).toBe(1);

    await flush();
    expect(backend.saves).toHaveLength(1);
    expect(backend.saves[0]!.sent).toMatchObject({ idleOpacity: 0.5, boxSkin: 'neon' });
    // Rust normalises (e.g. canonicalises the hotkey).
    backend.saves[0]!.resolve({ ...backend.saves[0]!.sent, hotkey: 'Ctrl+Alt+Q' });
    await expect(done).resolves.toMatchObject({ idleOpacity: 0.5, hotkey: 'Ctrl+Alt+Q' });
    expect(sync.current.hotkey).toBe('Ctrl+Alt+Q');
    expect(sync.confirmed.hotkey).toBe('Ctrl+Alt+Q');
    expect(sync.pendingCount).toBe(0);
  });

  it('normalises optimistic values like Rust does', () => {
    const { sync } = makeSync();
    void sync.update({ idleOpacity: 7, animationSpeed: 0.1, pixelGrid: 13 });
    expect(sync.current.idleOpacity).toBe(1);
    expect(sync.current.animationSpeed).toBe(0.5);
    expect(sync.current.pixelGrid).toBe(32);
  });

  it('serialises saves and coalesces a burst of updates', async () => {
    const { sync } = makeSync();
    const a = sync.update({ idleOpacity: 0.3 });
    await flush();
    const b = sync.update({ idleOpacity: 0.4 });
    const c = sync.update({ idleOpacity: 0.5 });
    await flush();
    // Only the first save is in flight; the others wait their turn.
    expect(backend.saves).toHaveLength(1);
    expect(sync.current.idleOpacity).toBe(0.5);

    backend.saves[0]!.resolve(backend.saves[0]!.sent);
    await a;
    // The pending patches survive the first answer.
    expect(sync.current.idleOpacity).toBe(0.5);
    await flush();
    // One save carries both queued patches; the third run is skipped.
    expect(backend.saves).toHaveLength(2);
    expect(backend.saves[1]!.sent.idleOpacity).toBe(0.5);
    backend.saves[1]!.resolve(backend.saves[1]!.sent);
    await expect(b).resolves.toMatchObject({ idleOpacity: 0.5 });
    await expect(c).resolves.toMatchObject({ idleOpacity: 0.5 });
    await flush();
    expect(backend.saves).toHaveLength(2);
    expect(sync.pendingCount).toBe(0);
  });

  it('rolls back a failed save and rejects', async () => {
    const { sync, changes } = makeSync();
    const failed = sync.update({ boxSkin: 'aurora' });
    expect(sync.current.boxSkin).toBe('aurora');
    await flush();
    backend.saves[0]!.reject(new Error('disk full'));
    await expect(failed).rejects.toThrow('disk full');
    expect(sync.current.boxSkin).toBe('glass');
    expect(changes.map(([next]) => next.boxSkin)).toEqual(['aurora', 'glass']);

    // The queue keeps working after a failure.
    const ok = sync.update({ boxSkin: 'minimal' });
    await flush();
    backend.saves[1]!.resolve(backend.saves[1]!.sent);
    await expect(ok).resolves.toMatchObject({ boxSkin: 'minimal' });
  });

  it('ends on what Rust saved when it refuses part of a change', async () => {
    // Rust saves the change without what Windows refused (a hotkey another
    // app holds), pushes that value to the page, and rejects with why. The
    // push may come before or after the rejection.
    for (const pushFirst of [true, false]) {
      backend.saves = [];
      const { sync } = makeSync();
      const done = sync.update({ hotkey: 'Ctrl+Alt+K', sounds: true });
      await flush();
      const saved = { ...defaultSettings(), sounds: true };
      if (pushFirst) sync.external(saved);
      backend.saves[0]!.reject(new Error('Global shortcut: Ctrl+Alt+K is already in use by another app'));
      await expect(done).rejects.toThrow('already in use');
      if (!pushFirst) sync.external(saved);
      expect(sync.current).toMatchObject({ hotkey: 'Ctrl+Alt+Shift+R', sounds: true });
      expect(sync.pendingCount).toBe(0);
    }
  });

  it('keeps pending patches on top of values pushed from elsewhere', async () => {
    const { sync } = makeSync();
    const pending = sync.update({ sounds: true });
    await flush();
    // Another window changed the theme while our save is in flight.
    sync.external({ ...defaultSettings(), theme: 'light' });
    expect(sync.current).toMatchObject({ theme: 'light', sounds: true });

    backend.saves[0]!.resolve({ ...defaultSettings(), theme: 'light', sounds: true });
    await pending;
    expect(sync.current).toMatchObject({ theme: 'light', sounds: true });

    // With nothing pending an external value wins outright.
    sync.external({ ...defaultSettings(), sounds: false });
    expect(sync.current.sounds).toBe(false);
    expect(sync.current.theme).toBe('system');
  });

  it('does not notify when nothing changed', () => {
    const { sync, changes } = makeSync();
    sync.external(defaultSettings());
    expect(changes).toHaveLength(0);
  });
});

describe('normalizeSettings', () => {
  it('mirrors the Rust rules', () => {
    const s = normalizeSettings({
      ...defaultSettings(),
      schema: 0,
      idleOpacity: Number.NaN,
      animationSpeed: 9,
      icoSizes: [256, 999, 20, 20],
      pixelGrid: 64,
      recentColors: [' #AABBCC ', '#aabbcc', 'red', '#11223344', ...Array.from({ length: 20 }, (_, i) => `#0000${String(i).padStart(2, '0')}`)],
      hotkey: 'shift + alt + ctrl + r',
    });
    expect(s.schema).toBe(1);
    expect(s.idleOpacity).toBe(0.92);
    expect(s.animationSpeed).toBe(2);
    expect(s.icoSizes).toEqual([16, 20, 32, 48, 256]);
    expect(s.pixelGrid).toBe(64);
    expect(s.recentColors[0]).toBe('#aabbcc');
    expect(s.recentColors[1]).toBe('#11223344');
    expect(s.recentColors).toHaveLength(16);
    expect(s.hotkey).toBe('Ctrl+Alt+Shift+R');
    expect(normalizeSettings({ ...defaultSettings(), hotkey: 'R' }).hotkey).toBe('Ctrl+Alt+Shift+R');
    expect(normalizeSettings({ ...defaultSettings(), hotkey: '  ' }).hotkey).toBe('');
  });

  it('keeps defaults unchanged', () => {
    expect(normalizeSettings(defaultSettings())).toEqual(defaultSettings());
  });
});
