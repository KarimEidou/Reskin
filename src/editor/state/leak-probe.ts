// E2E builds only: counts what the editor page keeps alive — workers,
// pending timers, animation frames and idle callbacks, listeners on window,
// document and media queries — so a spec can open and close the editor
// again and again (the page is reused) and check that nothing piles up.
// Installed once by createSession(); counts start at installation.

export interface LiveCounts {
  workers: number;
  timeouts: number;
  intervals: number;
  frames: number;
  idleCallbacks: number;
  /** Listeners on window, document and MediaQueryLists (`once` ones excluded: they clean up themselves). */
  listeners: number;
}

type Listener = EventListenerOrEventListenerObject;

let probe: (() => LiveCounts) | null = null;

export function installLeakProbe(): () => LiveCounts {
  probe ??= install();
  return probe;
}

function install(): () => LiveCounts {
  const w = window;
  const workers = new Set<Worker>();
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  const frames = new Set<number>();
  const idle = new Set<number>();
  const listeners = new Map<EventTarget, Map<string, Set<Listener>>>();

  if (typeof w.Worker === 'function') {
    const Native = w.Worker;
    w.Worker = class CountedWorker extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        workers.add(this);
      }

      override terminate(): void {
        workers.delete(this);
        super.terminate();
      }
    };
  }

  const setTimeoutNative = w.setTimeout.bind(w);
  const clearTimeoutNative = w.clearTimeout.bind(w);
  const setIntervalNative = w.setInterval.bind(w);
  const clearIntervalNative = w.clearInterval.bind(w);
  // Browsers share one id pool: either clear function cancels either kind.
  const clearTimer = (id: number | undefined) => {
    if (id === undefined) return;
    timeouts.delete(id);
    intervals.delete(id);
  };
  w.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (typeof handler !== 'function') return setTimeoutNative(handler, ms, ...args);
    const id: number = setTimeoutNative(
      (...a: unknown[]) => {
        timeouts.delete(id);
        (handler as (...a: unknown[]) => void)(...a);
      },
      ms,
      ...args,
    );
    timeouts.add(id);
    return id;
  }) as typeof w.setTimeout;
  w.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id: number = setIntervalNative(handler, ms, ...args);
    intervals.add(id);
    return id;
  }) as typeof w.setInterval;
  w.clearTimeout = ((id?: number) => {
    clearTimer(id);
    clearTimeoutNative(id);
  }) as typeof w.clearTimeout;
  w.clearInterval = ((id?: number) => {
    clearTimer(id);
    clearIntervalNative(id);
  }) as typeof w.clearInterval;

  const rafNative = w.requestAnimationFrame.bind(w);
  const cancelRafNative = w.cancelAnimationFrame.bind(w);
  w.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = rafNative((t) => {
      frames.delete(id);
      cb(t);
    });
    frames.add(id);
    return id;
  };
  w.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
    cancelRafNative(id);
  };

  if (typeof w.requestIdleCallback === 'function') {
    const idleNative = w.requestIdleCallback.bind(w);
    const cancelIdleNative = w.cancelIdleCallback.bind(w);
    w.requestIdleCallback = (cb: IdleRequestCallback, options?: IdleRequestOptions) => {
      const id = idleNative((deadline) => {
        idle.delete(id);
        cb(deadline);
      }, options);
      idle.add(id);
      return id;
    };
    w.cancelIdleCallback = (id: number) => {
      idle.delete(id);
      cancelIdleNative(id);
    };
  }

  const tracked = (target: EventTarget) => target === w || target === document || target instanceof MediaQueryList;
  const slot = (target: EventTarget, type: string, options: boolean | EventListenerOptions | undefined) => {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    let byType = listeners.get(target);
    if (!byType) {
      byType = new Map();
      listeners.set(target, byType);
    }
    const key = `${type}:${capture}`;
    let set = byType.get(key);
    if (!set) {
      set = new Set();
      byType.set(key, set);
    }
    return set;
  };
  const proto = EventTarget.prototype;
  const addNative = proto.addEventListener;
  const removeNative = proto.removeEventListener;
  proto.addEventListener = function (this: EventTarget, type: string, listener: Listener | null, options?: boolean | AddEventListenerOptions) {
    addNative.call(this, type, listener, options);
    if (!listener || !tracked(this) || (typeof options === 'object' && options.once)) return;
    const set = slot(this, type, options);
    set.add(listener);
    const signal = typeof options === 'object' ? options.signal : undefined;
    signal?.addEventListener('abort', () => set.delete(listener), { once: true });
  };
  proto.removeEventListener = function (this: EventTarget, type: string, listener: Listener | null, options?: boolean | EventListenerOptions) {
    removeNative.call(this, type, listener, options);
    if (listener && tracked(this)) slot(this, type, options).delete(listener);
  };

  return () => {
    let n = 0;
    for (const byType of listeners.values()) for (const set of byType.values()) n += set.size;
    return {
      workers: workers.size,
      timeouts: timeouts.size,
      intervals: intervals.size,
      frames: frames.size,
      idleCallbacks: idle.size,
      listeners: n,
    };
  };
}
