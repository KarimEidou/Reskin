// Toast queue logic (framework-free; toasts.svelte.ts adds runes).
//
// * Each toast auto-dismisses after its timeout (0 = stays until closed).
// * Timers pause while the user hovers/focuses the toast stack and resume
//   with the remaining time.
// * Showing a toast with an existing id replaces it in place and restarts
//   its timer (e.g. "Saving…" → "Saved").
// * At most `max` toasts are visible; the oldest is dropped.
// * Toasts with an action stay at least ACTION_MIN_MS (the 6 s Undo window).

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastOptions {
  message: string;
  kind?: ToastKind;
  action?: ToastAction;
  /** Auto-dismiss after this many ms; 0 keeps it until closed. */
  timeout?: number;
  /** Replace the toast with this id instead of adding a new one. */
  id?: string;
}

export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
  timeout: number;
}

export const DEFAULT_TIMEOUT: Record<ToastKind, number> = {
  info: 4000,
  success: 4000,
  warning: 6000,
  error: 8000,
};
export const ACTION_MIN_MS = 6000;

export interface Clock {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface Timer {
  handle: unknown;
  /** When the running timer was (re)started. */
  startedAt: number;
  remaining: number;
}

export class ToastQueue {
  #toasts: Toast[] = [];
  #timers = new Map<string, Timer>();
  #paused = false;
  #nextId = 1;
  readonly #max: number;
  readonly #clock: Clock;
  readonly #onChange: (toasts: readonly Toast[]) => void;

  constructor(opts: { onChange: (toasts: readonly Toast[]) => void; max?: number; clock?: Clock }) {
    this.#onChange = opts.onChange;
    this.#max = opts.max ?? 4;
    this.#clock = opts.clock ?? realClock;
  }

  get toasts(): readonly Toast[] {
    return this.#toasts;
  }

  get paused(): boolean {
    return this.#paused;
  }

  show(opts: ToastOptions): string {
    const kind = opts.kind ?? 'info';
    let timeout = opts.timeout ?? DEFAULT_TIMEOUT[kind];
    if (opts.action && timeout > 0) timeout = Math.max(timeout, ACTION_MIN_MS);
    const id = opts.id ?? `toast-${this.#nextId++}`;
    const toast: Toast = { id, message: opts.message, kind, action: opts.action, timeout };

    const existing = this.#toasts.findIndex((t) => t.id === id);
    if (existing >= 0) {
      this.#stopTimer(id);
      this.#toasts = this.#toasts.map((t, i) => (i === existing ? toast : t));
    } else {
      this.#toasts = [...this.#toasts, toast];
      while (this.#toasts.length > this.#max) {
        const dropped = this.#toasts[0]!;
        this.#stopTimer(dropped.id);
        this.#toasts = this.#toasts.slice(1);
      }
    }
    if (timeout > 0) this.#startTimer(id, timeout);
    this.#emit();
    return id;
  }

  dismiss(id: string): void {
    if (!this.#toasts.some((t) => t.id === id)) return;
    this.#stopTimer(id);
    this.#toasts = this.#toasts.filter((t) => t.id !== id);
    this.#emit();
  }

  clear(): void {
    for (const id of this.#timers.keys()) this.#stopTimer(id);
    if (this.#toasts.length === 0) return;
    this.#toasts = [];
    this.#emit();
  }

  /** Runs the toast's action, then dismisses it. Errors propagate. */
  async runAction(id: string): Promise<void> {
    const toast = this.#toasts.find((t) => t.id === id);
    if (!toast?.action) return;
    this.dismiss(id);
    await toast.action.run();
  }

  /** Freezes every timer (pointer or focus inside the toast stack). */
  pause(): void {
    if (this.#paused) return;
    this.#paused = true;
    const now = this.#clock.now();
    for (const timer of this.#timers.values()) {
      if (timer.handle === null) continue;
      this.#clock.clear(timer.handle);
      timer.handle = null;
      timer.remaining = Math.max(0, timer.remaining - (now - timer.startedAt));
    }
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    for (const [id, timer] of this.#timers) this.#arm(id, timer);
  }

  #startTimer(id: string, ms: number): void {
    const timer: Timer = { handle: null, startedAt: this.#clock.now(), remaining: ms };
    this.#timers.set(id, timer);
    if (!this.#paused) this.#arm(id, timer);
  }

  #arm(id: string, timer: Timer): void {
    timer.startedAt = this.#clock.now();
    timer.handle = this.#clock.set(() => {
      this.#timers.delete(id);
      this.dismiss(id);
    }, timer.remaining);
  }

  #stopTimer(id: string): void {
    const timer = this.#timers.get(id);
    if (!timer) return;
    if (timer.handle !== null) this.#clock.clear(timer.handle);
    this.#timers.delete(id);
  }

  #emit(): void {
    this.#onChange(this.#toasts);
  }
}
