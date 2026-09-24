import { describe, expect, it, vi } from 'vitest';
import { ACTION_MIN_MS, DEFAULT_TIMEOUT, ToastQueue, type Clock, type Toast } from './toast-queue';

/** Deterministic clock with manually advanced time. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    set: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  return { clock, advance, pending: () => timers.size };
}

function makeQueue(max?: number) {
  const { clock, advance, pending } = fakeClock();
  const seen: Array<readonly Toast[]> = [];
  const queue = new ToastQueue({ onChange: (t) => seen.push(t), clock, max });
  return { queue, advance, pending, seen };
}

describe('ToastQueue', () => {
  it('shows toasts and dismisses them after the kind-specific timeout', () => {
    const { queue, advance } = makeQueue();
    queue.show({ message: 'Saved', kind: 'success' });
    queue.show({ message: 'Failed', kind: 'error' });
    expect(queue.toasts.map((t) => t.message)).toEqual(['Saved', 'Failed']);
    advance(DEFAULT_TIMEOUT.success);
    expect(queue.toasts.map((t) => t.message)).toEqual(['Failed']);
    advance(DEFAULT_TIMEOUT.error - DEFAULT_TIMEOUT.success);
    expect(queue.toasts).toHaveLength(0);
  });

  it('keeps sticky toasts (timeout 0) until dismissed', () => {
    const { queue, advance, pending } = makeQueue();
    const id = queue.show({ message: 'Needs you', timeout: 0 });
    expect(pending()).toBe(0);
    advance(60_000);
    expect(queue.toasts).toHaveLength(1);
    queue.dismiss(id);
    expect(queue.toasts).toHaveLength(0);
  });

  it('gives actions at least the undo window and runs them once', async () => {
    const { queue, advance } = makeQueue();
    const run = vi.fn();
    const id = queue.show({ message: 'Applied', action: { label: 'Undo', run }, timeout: 1000 });
    expect(queue.toasts[0]!.timeout).toBe(ACTION_MIN_MS);
    advance(ACTION_MIN_MS - 1);
    expect(queue.toasts).toHaveLength(1);
    await queue.runAction(id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.toasts).toHaveLength(0);
    await queue.runAction(id);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('replaces a toast with the same id and restarts its timer', () => {
    const { queue, advance } = makeQueue();
    queue.show({ id: 'save', message: 'Saving…', timeout: 0 });
    queue.show({ message: 'Other' });
    advance(1000);
    queue.show({ id: 'save', message: 'Saved', kind: 'success' });
    expect(queue.toasts.map((t) => t.message)).toEqual(['Saved', 'Other']);
    advance(DEFAULT_TIMEOUT.info - 1000);
    expect(queue.toasts.map((t) => t.message)).toEqual(['Saved']);
    advance(1000);
    expect(queue.toasts).toHaveLength(0);
  });

  it('pauses and resumes with the remaining time', () => {
    const { queue, advance } = makeQueue();
    queue.show({ message: 'Hello', timeout: 1000 });
    advance(600);
    queue.pause();
    expect(queue.paused).toBe(true);
    advance(10_000);
    expect(queue.toasts).toHaveLength(1);
    // Toasts added while paused wait too.
    queue.show({ message: 'Later', timeout: 500 });
    advance(10_000);
    expect(queue.toasts).toHaveLength(2);
    queue.resume();
    advance(399);
    expect(queue.toasts.map((t) => t.message)).toEqual(['Hello', 'Later']);
    advance(1);
    expect(queue.toasts.map((t) => t.message)).toEqual(['Later']);
    advance(100);
    expect(queue.toasts).toHaveLength(0);
  });

  it('caps the stack and drops the oldest', () => {
    const { queue, pending } = makeQueue(2);
    queue.show({ message: 'a' });
    queue.show({ message: 'b' });
    queue.show({ message: 'c' });
    expect(queue.toasts.map((t) => t.message)).toEqual(['b', 'c']);
    expect(pending()).toBe(2);
  });

  it('notifies on every change and clears everything', () => {
    const { queue, seen, pending } = makeQueue();
    queue.show({ message: 'a' });
    queue.show({ message: 'b' });
    queue.clear();
    expect(seen.map((t) => t.length)).toEqual([1, 2, 0]);
    expect(pending()).toBe(0);
    queue.clear();
    expect(seen).toHaveLength(3);
  });
});
