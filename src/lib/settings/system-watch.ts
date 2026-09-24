// Follows what Windows says while a page lives on (framework-free;
// system.svelte.ts wraps it in runes). Windows settings change behind a
// page's back — the accent colour, "Animation effects", another app taking
// the hotkey — and the box page never reloads, so the state is read again
// whenever the page's window gains focus or becomes visible.
//
// * Overlapping refreshes share a read; one asked for during a read runs
//   once more after it (the change may have come after the read started).
// * `onChange` only fires when something actually changed.
// * A failed read keeps the last state.

import type { BootInfo } from '$lib/ipc/types';

export interface SystemState {
  /** Windows accent `#rrggbb`. */
  accent: string | null;
  /** Windows' "Animation effects" are off. */
  reducedMotion: boolean;
  /** Why the saved global hotkey doesn't work (another app holds it). */
  hotkeyError: string | null;
}

export function systemFrom(b: Pick<BootInfo, 'accent' | 'systemReducedMotion' | 'hotkeyError'>): SystemState {
  return { accent: b.accent, reducedMotion: b.systemReducedMotion, hotkeyError: b.hotkeyError ?? null };
}

function sameSystem(a: SystemState, b: SystemState): boolean {
  return a.accent === b.accent && a.reducedMotion === b.reducedMotion && a.hotkeyError === b.hotkeyError;
}

export interface SystemWatchOptions {
  initial: SystemState;
  read: () => Promise<SystemState>;
  onChange: (next: SystemState, prev: SystemState) => void;
  /** The page's window (`focus`) … */
  window: EventTarget;
  /** … and document (`visibilitychange`). */
  document: EventTarget & { readonly visibilityState: DocumentVisibilityState };
}

export class SystemWatch {
  #current: SystemState;
  #running: Promise<void> | null = null;
  #queued: Promise<void> | null = null;
  #stopped = false;
  readonly #opts: SystemWatchOptions;
  readonly #onFocus = () => void this.refresh();
  readonly #onVisibility = () => {
    if (this.#opts.document.visibilityState === 'visible') void this.refresh();
  };

  constructor(opts: SystemWatchOptions) {
    this.#opts = opts;
    this.#current = opts.initial;
    opts.window.addEventListener('focus', this.#onFocus);
    opts.document.addEventListener('visibilitychange', this.#onVisibility);
  }

  get current(): SystemState {
    return this.#current;
  }

  /** Reads the state again now; resolves once it is applied. */
  refresh(): Promise<void> {
    if (this.#queued) return this.#queued;
    if (this.#running) {
      this.#queued = this.#running.then(() => {
        this.#queued = null;
        return this.#start();
      });
      return this.#queued;
    }
    return this.#start();
  }

  stop(): void {
    this.#stopped = true;
    this.#opts.window.removeEventListener('focus', this.#onFocus);
    this.#opts.document.removeEventListener('visibilitychange', this.#onVisibility);
  }

  #start(): Promise<void> {
    const run = this.#read().finally(() => {
      if (this.#running === run) this.#running = null;
    });
    this.#running = run;
    return run;
  }

  async #read(): Promise<void> {
    let next: SystemState;
    try {
      next = await this.#opts.read();
    } catch (error) {
      console.error('[system] reading the Windows state failed', error);
      return;
    }
    const prev = this.#current;
    if (this.#stopped || sameSystem(prev, next)) return;
    this.#current = next;
    this.#opts.onChange(next, prev);
  }
}
