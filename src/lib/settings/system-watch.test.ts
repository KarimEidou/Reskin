import { describe, expect, it, vi } from 'vitest';
import { SystemWatch, systemFrom, type SystemState } from './system-watch';

const BLUE: SystemState = { accent: '#0078d4', reducedMotion: false, hotkeyError: null };

/** Lets queued promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(initial = BLUE) {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  let answer: SystemState = initial;
  const reads: Array<(s: SystemState) => void> = [];
  let manual = false;
  const read = vi.fn(
    () =>
      new Promise<SystemState>((resolve) => {
        if (manual) reads.push(resolve);
        else resolve(answer);
      }),
  );
  const changes: Array<[SystemState, SystemState]> = [];
  const watch = new SystemWatch({
    initial,
    read,
    onChange: (next, prev) => changes.push([next, prev]),
    window: win,
    document: doc,
  });
  return {
    watch,
    read,
    changes,
    reads,
    focus: () => win.dispatchEvent(new Event('focus')),
    visibility: (state: DocumentVisibilityState) => {
      doc.visibilityState = state;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    answer: (s: SystemState) => (answer = s),
    manual: () => (manual = true),
  };
}

describe('SystemWatch', () => {
  it('re-reads Windows when the window gains focus and reports changes', async () => {
    const t = setup();
    t.answer({ ...BLUE, accent: '#e81123' });
    t.focus();
    await flush();
    expect(t.read).toHaveBeenCalledTimes(1);
    expect(t.watch.current.accent).toBe('#e81123');
    expect(t.changes).toEqual([[{ ...BLUE, accent: '#e81123' }, BLUE]]);

    // Nothing changed: no notification.
    t.focus();
    await flush();
    expect(t.read).toHaveBeenCalledTimes(2);
    expect(t.changes).toHaveLength(1);
  });

  it('re-reads when the page becomes visible, not when it is hidden', async () => {
    const t = setup();
    t.answer({ ...BLUE, reducedMotion: true, hotkeyError: 'Ctrl+Alt+Shift+R is already in use by another app' });
    t.visibility('hidden');
    await flush();
    expect(t.read).not.toHaveBeenCalled();
    t.visibility('visible');
    await flush();
    expect(t.watch.current).toEqual({
      accent: BLUE.accent,
      reducedMotion: true,
      hotkeyError: 'Ctrl+Alt+Shift+R is already in use by another app',
    });
  });

  it('shares overlapping reads and reads once more after a busy one', async () => {
    const t = setup();
    t.manual();
    const first = t.watch.refresh();
    const second = t.watch.refresh();
    const third = t.watch.refresh();
    expect(second).toBe(third);
    expect(t.read).toHaveBeenCalledTimes(1);
    // The first read started before the accent changed …
    t.reads[0]!(BLUE);
    await first;
    await flush();
    // … so one more read follows it.
    expect(t.read).toHaveBeenCalledTimes(2);
    t.reads[1]!({ ...BLUE, accent: '#107c10' });
    await second;
    expect(t.watch.current.accent).toBe('#107c10');
    expect(t.read).toHaveBeenCalledTimes(2);
  });

  it('keeps the last state when a read fails', async () => {
    const t = setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.read.mockRejectedValueOnce(new Error('ipc closed'));
    await t.watch.refresh();
    expect(t.watch.current).toEqual(BLUE);
    expect(t.changes).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('stops following', async () => {
    const t = setup();
    t.watch.stop();
    t.focus();
    t.visibility('visible');
    await flush();
    expect(t.read).not.toHaveBeenCalled();
  });

  it('takes its state from BootInfo', () => {
    expect(systemFrom({ accent: null, systemReducedMotion: true })).toEqual({
      accent: null,
      reducedMotion: true,
      hotkeyError: null,
    });
    expect(systemFrom({ accent: '#0078d4', systemReducedMotion: false, hotkeyError: 'taken' }).hotkeyError).toBe('taken');
  });
});
