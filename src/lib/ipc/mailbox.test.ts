import { describe, expect, it, vi } from 'vitest';
import { startMailbox, type MailboxOptions } from './mailbox';
import type { EditorCmd, Envelope } from './types';

const reveal = (session: number): EditorCmd => ({ type: 'reveal', session });
const heartbeat: EditorCmd = { type: 'heartbeat' };

/**
 * A scripted `editor_next`: each poll takes the next scripted step; once the
 * script is exhausted polls hang until the test stops the mailbox.
 */
function scriptedNext(steps: Array<Envelope[] | Error>) {
  const polls: number[] = [];
  let idle: (() => void) | null = null;
  const next = (after: number): Promise<Envelope[]> => {
    polls.push(after);
    const step = steps.shift();
    if (step === undefined) {
      return new Promise<Envelope[]>((resolve) => {
        idle = () => resolve([]);
      });
    }
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  };
  return { next, polls, release: () => idle?.() };
}

/** Resolves once `cond` holds, polling the microtask/timer queue. */
async function until(cond: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const instantSleep: MailboxOptions['sleep'] = () => Promise.resolve();

describe('startMailbox', () => {
  it('handles envelopes in seq order and acknowledges them on the next poll', async () => {
    const script = scriptedNext([
      [
        { seq: 2, cmd: reveal(1) },
        { seq: 1, cmd: { type: 'navigate', view: 'library' } },
      ],
      [{ seq: 3, cmd: heartbeat }],
    ]);
    const seen: number[] = [];
    const mb = startMailbox((_cmd, seq) => void seen.push(seq), { next: script.next });

    await until(() => script.polls.length === 3, 'third poll');
    expect(seen).toEqual([1, 2, 3]);
    expect(script.polls).toEqual([0, 2, 3]);
    expect(mb.after).toBe(3);
    mb.stop();
    script.release();
    await mb.done;
  });

  it('awaits each handler before starting the next one', async () => {
    const script = scriptedNext([
      [
        { seq: 1, cmd: reveal(1) },
        { seq: 2, cmd: { type: 'expand', session: 1, morph: true } },
      ],
    ]);
    const log: string[] = [];
    let finishFirst!: () => void;
    const mb = startMailbox(
      async (cmd, seq) => {
        log.push(`start ${seq} ${cmd.type}`);
        if (seq === 1) await new Promise<void>((r) => (finishFirst = r));
        log.push(`end ${seq}`);
      },
      { next: script.next },
    );

    await until(() => log.length === 1, 'first handler');
    await new Promise((r) => setTimeout(r, 5));
    // The second envelope must not start while the first is pending, and
    // the loop must not poll again yet.
    expect(log).toEqual(['start 1 reveal']);
    expect(script.polls).toEqual([0]);

    finishFirst();
    await until(() => script.polls.length === 2, 'second poll');
    expect(log).toEqual(['start 1 reveal', 'end 1', 'start 2 expand', 'end 2']);
    expect(script.polls).toEqual([0, 2]);
    mb.stop();
    script.release();
    await mb.done;
  });

  it('ignores duplicates and envelopes at or below the start position', async () => {
    const script = scriptedNext([
      [
        { seq: 4, cmd: reveal(1) },
        { seq: 5, cmd: reveal(2) },
      ],
      // Re-delivery of an already handled envelope plus a new one.
      [
        { seq: 5, cmd: reveal(2) },
        { seq: 6, cmd: reveal(3) },
      ],
    ]);
    const seen: number[] = [];
    const mb = startMailbox((_c, seq) => void seen.push(seq), { next: script.next, after: 4 });
    await until(() => script.polls.length === 3, 'third poll');
    expect(seen).toEqual([5, 6]);
    expect(script.polls).toEqual([4, 5, 6]);
    mb.stop();
    script.release();
    await mb.done;
  });

  it('delivers heartbeats to the handler', async () => {
    const script = scriptedNext([[{ seq: 1, cmd: heartbeat }], [{ seq: 2, cmd: heartbeat }]]);
    const types: string[] = [];
    const mb = startMailbox((cmd) => void types.push(cmd.type), { next: script.next });
    await until(() => types.length === 2, 'two heartbeats');
    expect(types).toEqual(['heartbeat', 'heartbeat']);
    mb.stop();
    script.release();
    await mb.done;
  });

  it('retries failed polls with exponential backoff capped at 2 s, reset on success', async () => {
    const fail = () => new Error('ipc down');
    const script = scriptedNext([
      fail(),
      fail(),
      fail(),
      fail(),
      fail(),
      fail(),
      fail(),
      [{ seq: 1, cmd: heartbeat }],
      fail(),
    ]);
    const delays: number[] = [];
    const errors: number[] = [];
    const mb = startMailbox(() => {}, {
      next: script.next,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      onPollError: (_e, retryIn) => errors.push(retryIn),
    });
    await until(() => script.polls.length === 10, 'tenth poll');
    expect(delays).toEqual([50, 100, 200, 400, 800, 1600, 2000, 50]);
    expect(errors).toEqual(delays);
    // The poll after the failures resumes from the right position.
    expect(script.polls.slice(7)).toEqual([0, 1, 1]);
    mb.stop();
    script.release();
    await mb.done;
  });

  it('keeps going when a handler throws, and reports the error', async () => {
    const script = scriptedNext([
      [
        { seq: 1, cmd: reveal(1) },
        { seq: 2, cmd: reveal(2) },
      ],
    ]);
    const onHandlerError = vi.fn();
    const seen: number[] = [];
    const mb = startMailbox(
      (_c, seq) => {
        seen.push(seq);
        if (seq === 1) throw new Error('boom');
      },
      { next: script.next, onHandlerError },
    );
    await until(() => script.polls.length === 2, 'second poll');
    expect(seen).toEqual([1, 2]);
    expect(onHandlerError).toHaveBeenCalledTimes(1);
    expect(onHandlerError.mock.calls[0]![1]).toMatchObject({ seq: 1 });
    expect(script.polls).toEqual([0, 2]);
    mb.stop();
    script.release();
    await mb.done;
  });

  it('keeps polling (without acknowledging) while a slow handler runs', async () => {
    // Like Rust: a poll returns at once while an unacknowledged envelope is queued.
    const queued: Envelope[] = [{ seq: 1, cmd: { type: 'smokeCycle', item: 'item-1' } }];
    const polls: number[] = [];
    const waiting: Array<() => void> = [];
    const next = (after: number): Promise<Envelope[]> => {
      polls.push(after);
      const ready = queued.filter((e) => e.seq > after);
      if (ready.length > 0) return Promise.resolve(ready);
      return new Promise((resolve) => waiting.push(() => resolve([])));
    };
    const log: string[] = [];
    let finish!: () => void;
    const mb = startMailbox(
      async (_cmd, seq) => {
        log.push(`start ${seq}`);
        await new Promise<void>((r) => (finish = r));
        log.push(`end ${seq}`);
      },
      { next, keepAliveMs: 5 },
    );

    await until(() => polls.length >= 4, 'keep-alive polls');
    // Every keep-alive polls from before the envelope being handled, and
    // its answer (that same envelope) does not start it a second time.
    expect(polls.every((after) => after === 0)).toBe(true);
    expect(log).toEqual(['start 1']);
    expect(mb.after).toBe(0);

    finish();
    await until(() => polls.at(-1) === 1, 'the acknowledging poll');
    const settled = polls.length;
    await new Promise((r) => setTimeout(r, 30));
    // Once the handler is done the keep-alives stop: one long poll waits.
    expect(polls).toHaveLength(settled);
    expect(log).toEqual(['start 1', 'end 1']);
    mb.stop();
    waiting.forEach((release) => release());
    await mb.done;
  });

  it('never keeps a fast handler alive', async () => {
    const script = scriptedNext([[{ seq: 1, cmd: heartbeat }]]);
    const mb = startMailbox(() => {}, { next: script.next, keepAliveMs: 5 });
    await until(() => script.polls.length === 2, 'second poll');
    await new Promise((r) => setTimeout(r, 30));
    expect(script.polls).toEqual([0, 1]);
    mb.stop();
    script.release();
    await mb.done;
  });

  it('stop() ends the keep-alives of a handler that never settles', async () => {
    const next = vi.fn((after: number): Promise<Envelope[]> =>
      after === 0 ? Promise.resolve([{ seq: 1, cmd: heartbeat }]) : new Promise<Envelope[]>(() => {}),
    );
    const mb = startMailbox(() => new Promise<void>(() => {}), { next, keepAliveMs: 5 });
    await until(() => next.mock.calls.length >= 3, 'keep-alive polls');
    mb.stop();
    const calls = next.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(next).toHaveBeenCalledTimes(calls);
  });

  it('stop() ends the loop and ignores the result of an in-flight poll', async () => {
    let resolvePoll!: (v: Envelope[]) => void;
    const next = vi.fn(
      () =>
        new Promise<Envelope[]>((r) => {
          resolvePoll = r;
        }),
    );
    const handler = vi.fn();
    const mb = startMailbox(handler, { next, sleep: instantSleep });
    await until(() => next.mock.calls.length === 1, 'first poll');
    mb.stop();
    resolvePoll([{ seq: 1, cmd: heartbeat }]);
    await mb.done;
    expect(handler).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(mb.after).toBe(0);
  });

  it('stop() interrupts a backoff sleep', async () => {
    const next = vi.fn(() => Promise.reject(new Error('down')));
    const mb = startMailbox(() => {}, { next, minBackoffMs: 60_000, maxBackoffMs: 60_000 });
    await until(() => next.mock.calls.length === 1, 'first poll');
    mb.stop();
    // Would hang for a minute if the real sleep were not abortable.
    await mb.done;
    expect(next).toHaveBeenCalledTimes(1);
  });
});
