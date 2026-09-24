// requestAnimationFrame helpers.
//
// A double rAF resolves after the frame that contains the current DOM state
// has been produced: the first callback runs before the next paint, the
// second one right after it. The morph handoff acks on it ("the picture is
// on screen").
//
// Chromium pauses rAF in hidden/occluded webviews. Callers that must not
// hang in that case pass `timeoutMs`: the promise then also resolves after
// that many ms (with `timedOut: true` from `frames`).

export interface FrameOptions {
  /** Resolve anyway after this many ms if frames stop coming. */
  timeoutMs?: number;
}

export interface FramesResult {
  /** rAF timestamp of the last frame (or `performance.now()` on timeout). */
  time: number;
  /** True when the timeout fired before the frames arrived. */
  timedOut: boolean;
}

/** Waits for `count` animation frames. */
export function frames(count: number, opts: FrameOptions = {}): Promise<FramesResult> {
  return new Promise((resolve) => {
    let settled = false;
    let rafId = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (time: number, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(rafId);
      if (timer !== undefined) clearTimeout(timer);
      resolve({ time, timedOut });
    };
    let left = Math.max(1, Math.floor(count));
    const tick = (time: number) => {
      left -= 1;
      if (left <= 0) finish(time, false);
      else rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => finish(performance.now(), true), Math.max(0, opts.timeoutMs));
    }
  });
}

/** Resolves on the next animation frame with its timestamp. */
export async function nextFrame(opts?: FrameOptions): Promise<number> {
  return (await frames(1, opts)).time;
}

/** Resolves once the current DOM state has been painted (two frames). */
export async function doubleRaf(opts?: FrameOptions): Promise<number> {
  return (await frames(2, opts)).time;
}
