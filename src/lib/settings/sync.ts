// Optimistic settings synchronisation (framework-free; store.svelte.ts wraps
// it in runes).
//
// * `current` = last value confirmed by Rust + every pending local patch,
//   normalised like Rust would — the UI shows changes instantly.
// * Saves run one at a time, in order, each sending the full current value;
//   a save therefore also carries every patch queued before it started, and
//   later queued saves whose patches were already carried are skipped
//   (bursts such as slider drags coalesce into few writes).
// * Rust's normalised answer becomes the new confirmed value; still-pending
//   patches are re-applied on top of it.
// * Values pushed from elsewhere (the `settings:changed` event, the editor
//   mailbox) replace the confirmed value the same way.
// * A failed save drops its own patch (the UI snaps back) and rejects.

import type { Settings } from '$lib/ipc/types';
import { jsonEqual, normalizeSettings } from './defaults';

export interface SettingsSyncOptions {
  /** Persists settings and returns the normalised value (commands.settingsSet). */
  save: (settings: Settings) => Promise<Settings>;
  /** Called whenever `current` changes. */
  onChange?: (next: Settings, prev: Settings) => void;
}

interface Pending {
  id: number;
  patch: Partial<Settings>;
}

export class SettingsSync {
  #confirmed: Settings;
  #current: Settings;
  #pending: Pending[] = [];
  #nextId = 1;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #opts: SettingsSyncOptions;

  constructor(initial: Settings, opts: SettingsSyncOptions) {
    this.#confirmed = initial;
    this.#current = initial;
    this.#opts = opts;
  }

  /** What the UI should show right now. */
  get current(): Settings {
    return this.#current;
  }

  /** The last value Rust confirmed (or pushed). */
  get confirmed(): Settings {
    return this.#confirmed;
  }

  /** Local patches not yet confirmed by a save. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /**
   * Applies `patch` optimistically and persists it. Resolves with the
   * reconciled settings once saved; rejects (after rolling the patch back)
   * when the save fails.
   */
  update(patch: Partial<Settings>): Promise<Settings> {
    const id = this.#nextId++;
    this.#pending.push({ id, patch });
    this.#recompute();

    const run = async (): Promise<Settings> => {
      // Already carried (and confirmed) by an earlier save of the burst.
      if (!this.#pending.some((p) => p.id === id)) return this.#current;
      const carriedUpTo = this.#nextId - 1;
      try {
        const saved = await this.#opts.save(this.#current);
        this.#confirmed = saved;
        this.#pending = this.#pending.filter((p) => p.id > carriedUpTo);
        this.#recompute();
        return this.#current;
      } catch (error) {
        this.#pending = this.#pending.filter((p) => p.id !== id);
        this.#recompute();
        throw error;
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Authoritative settings pushed from elsewhere (event / mailbox). */
  external(settings: Settings): void {
    this.#confirmed = settings;
    this.#recompute();
  }

  /** Resolves once every queued save has settled. */
  async idle(): Promise<void> {
    await this.#queue;
  }

  #recompute(): void {
    let next = this.#confirmed;
    if (this.#pending.length > 0) {
      for (const { patch } of this.#pending) next = { ...next, ...patch };
      next = normalizeSettings(next);
    }
    const prev = this.#current;
    if (jsonEqual(prev, next)) return;
    this.#current = next;
    this.#opts.onChange?.(next, prev);
  }
}
