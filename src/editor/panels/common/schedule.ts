// Small timing helpers for panels: coalesce bursts of events so expensive
// work (thumbnails, previews, engine updates from sliders) runs at most once
// per frame / interval.

export interface Scheduled<A extends unknown[]> {
  (...args: A): void;
  /** Runs a pending call now. */
  flush(): void;
  cancel(): void;
}

/** Calls `fn` with the latest arguments on the next animation frame. */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): Scheduled<A> {
  let frame = 0;
  let args: A | null = null;
  const run = () => {
    frame = 0;
    const a = args;
    args = null;
    if (a) fn(...a);
  };
  const call = ((...a: A) => {
    args = a;
    frame ||= requestAnimationFrame(run);
  }) as Scheduled<A>;
  call.flush = () => {
    if (frame) cancelAnimationFrame(frame);
    run();
  };
  call.cancel = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    args = null;
  };
  return call;
}

/** Calls `fn` `ms` after the last call (trailing debounce). */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Scheduled<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let args: A | null = null;
  const run = () => {
    timer = undefined;
    const a = args;
    args = null;
    if (a) fn(...a);
  };
  const call = ((...a: A) => {
    args = a;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }) as Scheduled<A>;
  call.flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    run();
  };
  call.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    args = null;
  };
  return call;
}

/**
 * Throttle with a trailing call: runs immediately, then at most every `ms`
 * while calls keep coming, always ending with the latest arguments.
 */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): Scheduled<A> {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let args: A | null = null;
  const run = () => {
    timer = undefined;
    last = performance.now();
    const a = args;
    args = null;
    if (a) fn(...a);
  };
  const call = ((...a: A) => {
    args = a;
    const wait = last + ms - performance.now();
    if (wait <= 0) {
      if (timer !== undefined) clearTimeout(timer);
      run();
    } else if (timer === undefined) {
      timer = setTimeout(run, wait);
    }
  }) as Scheduled<A>;
  call.flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    run();
  };
  call.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    args = null;
  };
  return call;
}

/** Runs `fn` when the browser is idle (or soon, where idle callbacks are missing). */
export function whenIdle(fn: () => void, timeout = 500): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(fn, { timeout });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 60);
  return () => clearTimeout(id);
}
