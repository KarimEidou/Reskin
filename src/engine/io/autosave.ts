// Debounced autosave. Call `schedule()` after every change; the data is
// produced and saved once things have been quiet for `delayMs`, but at
// least every `maxWaitMs` during continuous editing. Saves never overlap: a
// change during a save triggers another save afterwards. `flush()` saves
// immediately (e.g. before the window hides).

export interface AutosaveOptions {
  /** Produces the data to save (e.g. `engine.serialize()`). */
  produce: () => Promise<string> | string;
  /** Persists it (e.g. `commands.autosave`). */
  save: (data: string) => Promise<void>;
  /** Quiet period before saving, ms (default 2000). */
  delayMs?: number;
  /** Longest a pending change may wait, ms (default 15000). */
  maxWaitMs?: number;
  onError?: (error: unknown) => void;
}

export class Autosave {
  private readonly delay: number;
  private readonly maxWait: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  private dirty = false;
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly opts: AutosaveOptions) {
    this.delay = opts.delayMs ?? 2000;
    this.maxWait = Math.max(opts.maxWaitMs ?? 15000, this.delay);
  }

  /** True when a change has not been saved yet. */
  get pending(): boolean {
    return this.dirty;
  }

  get saving(): boolean {
    return this.running !== null;
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
      void this.run();
    }, wait);
  }

  /** Saves now if anything is pending; resolves when saved. */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.running) await this.running;
    if (this.dirty) await this.run();
  }

  /** Drops any pending save. */
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

  private run(): Promise<void> {
    if (this.running) {
      // A save is in flight; the change will be picked up right after it.
      return this.running.then(() => (this.dirty && !this.disposed ? this.run() : undefined));
    }
    if (!this.dirty || this.disposed) return Promise.resolve();
    this.dirty = false;
    const task = (async () => {
      try {
        const data = await this.opts.produce();
        await this.opts.save(data);
      } catch (e) {
        this.opts.onError?.(e);
      } finally {
        this.running = null;
      }
    })();
    this.running = task;
    return task.then(() => {
      if (this.dirty && !this.disposed && this.timer === null) this.schedule();
    });
  }
}
