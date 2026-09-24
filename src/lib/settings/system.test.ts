import { describe, expect, it, vi } from 'vitest';
import type { BootInfo } from '$lib/ipc/types';

// What Rust's app_boot says about Windows right now, faked.
const backend = vi.hoisted(() => ({ hotkeyError: null as string | null, reads: 0 }));
vi.mock('$lib/ipc/commands', () => ({
  commands: {
    appBoot: async () => {
      backend.reads++;
      return { accent: null, systemReducedMotion: false, hotkeyError: backend.hotkeyError };
    },
  },
}));
vi.stubGlobal('window', new EventTarget());
vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));

import { followSystem, refreshSystem, system } from './system.svelte';

describe('refreshSystem', () => {
  it('asked for before the state is followed, reads it again as soon as it is', async () => {
    // app_boot read Windows' state, then Rust's start-up check found the
    // hotkey taken and said so (system:changed) before the page followed
    // what app_boot answered.
    const boot = { accent: null, systemReducedMotion: false, hotkeyError: null } as unknown as BootInfo;
    backend.hotkeyError = 'Ctrl+Alt+Shift+R is already in use by another app';
    await refreshSystem();
    expect(backend.reads).toBe(0);
    const changed = vi.fn();
    followSystem(boot, changed);
    await vi.waitFor(() => expect(system.hotkeyError).toBe('Ctrl+Alt+Shift+R is already in use by another app'));
    expect(backend.reads).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
    // The read that was due is done: following again reads nothing.
    followSystem(boot, changed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backend.reads).toBe(1);
  });
});
