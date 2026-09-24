// Debounced autosave. Call `schedule()` after every change; the data is
// produced and saved once things have been quiet for `delayMs`, but at
// least every `maxWaitMs` during continuous editing. `produce` may answer
// null: nothing worth saving (e.g. no unsaved changes). Saves never
// overlap — every storage task runs after the ones before it — and a
// change during a save triggers another save afterwards. `flush()` saves
// a pending change immediately (e.g. before the window hides); `write()`
// saves given data in its place (e.g. a design being put away), and
// `enqueue()` runs any other storage task in the same order.

export interface AutosaveOptions {
  /**
   * Produces the data to save (e.g. `engine.serialize()`), or null when
   * there is nothing to save. Called when its save's turn comes; it takes
   * the data as it is at that moment (a promise may finish encoding it).
   */
  produce: () => Promise<string | null> | string | null;
  /** Persists it (e.g. `commands.autosave`). */
  save: (data: string) => Promise<void>;
  /** Quiet period before saving, ms (default 2000). */
  delayMs?: number;
  /** Longest a pending change may wait, ms (default 15000). */
  maxWaitMs?: number;
  /** Failures of the scheduled saves (`write` and `enqueue` reject instead). */
  onError?: (error: unknown) => void;
}

export class Autosave {
  private readonly delay: number;
  private readonly maxWait: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  private dirty = false;
  /** Saves handed a change that have not produced their data yet. */
  private unproduced = 0;
  /** The last storage task; the next one runs after it. */
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly opts: AutosaveOptions) {
    this.delay = opts.delayMs ?? 2000;
    this.maxWait = Math.max(opts.maxWaitMs ?? 15000, this.delay);
  }

  /**
   * True when a change has not been produced for a save yet: not handed to
   * one, or handed to one still waiting for the saves before it (which
   * produces whatever is current when its turn comes).
   */
  get pending(): boolean {
    return this.dirty || this.unproduced > 0;
  }

  /** Marks the document changed. */
  schedule(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (!this.dirty) {
      this.dirty = true;
      this.firstPendingAt = now;
    }
    const wait = Math.max(0, Math.min(this.delay, this.firstPendingAt + this.maxWait - now));
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, wait);
  }

  /** Saves a pending change now; resolves once every save so far is done. */
  flush(): Promise<void> {
    this.clearTimer();
    if (this.dirty) this.run();
    return this.tail;
  }

  /** Saves `data` (after the saves before it) instead of a pending change. */
  write(data: string): Promise<void> {
    this.cancel();
    return this.enqueue(() => this.opts.save(data));
  }

  /** Runs `task` once the storage tasks before it are done; rejects when it fails. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Drops a pending change. */
  cancel(): void {
    this.clearTimer();
    this.dirty = false;
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Hands the pending change to a save (produced when its turn comes, so it is the latest). */
  private run(): void {
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    this.unproduced += 1;
    void this.enqueue(async () => {
      try {
        let produced: ReturnType<AutosaveOptions['produce']>;
        try {
          produced = this.disposed ? null : this.opts.produce();
        } finally {
          this.unproduced -= 1;
        }
        const data = await produced;
        if (data !== null) await this.opts.save(data);
      } catch (e) {
        this.opts.onError?.(e);
      }
    });
  }
}
