// Editor side of the Rust → editor command mailbox.
//
// Rust queues `EditorCmd`s with increasing sequence numbers; the editor
// long-polls `editor_next(after)` and gets every envelope with `seq > after`
// (or a heartbeat after 25 s of silence). A command stays queued in Rust
// until a later poll proves it arrived (`after >= seq`), so the loop below
// only advances `after` once the handler for that envelope has finished.
//
// Guarantees:
// * envelopes are handled strictly in `seq` order, one at a time: the next
//   handler starts only after the previous one (and its promise) settled;
// * duplicates (`seq <= after`) are skipped, so a re-delivered batch is safe;
// * heartbeats reach the handler too, so the page can track liveness;
// * a failing `editor_next` is retried with exponential backoff
//   (50 ms → 2 s), reset after the next successful poll;
// * a throwing handler is reported and skipped; it never stalls the queue;
// * the page never looks dead while a handler runs: Rust recreates an
//   editor whose mailbox has been silent for 2 s (morph.rs ALIVE_GRACE), so
//   a handler that takes longer than `keepAliveMs` gets keep-alive polls
//   every `keepAliveMs`. They poll from the last *handled* envelope, so they
//   acknowledge nothing (the envelope being handled is still queued, and
//   Rust answers at once); their answers are dropped — the loop fetches
//   those envelopes again once the handler is done.

import { commands } from './commands';
import type { EditorCmd, Envelope } from './types';

export type MailboxHandler = (cmd: EditorCmd, seq: number) => void | Promise<void>;

export interface MailboxOptions {
  /** Poll function (defaults to `commands.editorNext`); injectable for tests. */
  next?: (after: number) => Promise<Envelope[]>;
  /** Last sequence number already handled (default 0 = nothing yet). */
  after?: number;
  /** First retry delay after a failed poll (default 50 ms). */
  minBackoffMs?: number;
  /** Retry delay ceiling (default 2000 ms). */
  maxBackoffMs?: number;
  /** Called for every failed poll with the upcoming retry delay. */
  onPollError?: (error: unknown, retryInMs: number) => void;
  /** Called when a handler throws or rejects (default: console.error). */
  onHandlerError?: (error: unknown, envelope: Envelope) => void;
  /** Keep-alive poll interval while a handler runs (default 500 ms). */
  keepAliveMs?: number;
  /** Timer used between retries; injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface MailboxHandle {
  /** Stops polling. An in-flight poll is abandoned; its result is ignored. */
  stop(): void;
  /** Sequence number of the last envelope that was handled. */
  readonly after: number;
  /** Resolves when the loop has fully exited after `stop()`. */
  readonly done: Promise<void>;
}

export const MAILBOX_MIN_BACKOFF_MS = 50;
export const MAILBOX_MAX_BACKOFF_MS = 2000;
/** Well under Rust's 2 s liveness grace, with room for a slow IPC round trip. */
export const MAILBOX_KEEPALIVE_MS = 500;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Starts the mailbox loop and returns a handle to stop it. The loop runs
 * until `stop()` is called; start at most one per page.
 */
export function startMailbox(handler: MailboxHandler, opts: MailboxOptions = {}): MailboxHandle {
  const next = opts.next ?? ((after: number) => commands.editorNext(after));
  const minBackoff = opts.minBackoffMs ?? MAILBOX_MIN_BACKOFF_MS;
  const maxBackoff = Math.max(minBackoff, opts.maxBackoffMs ?? MAILBOX_MAX_BACKOFF_MS);
  const sleep = opts.sleep ?? abortableSleep;
  const keepAliveMs = opts.keepAliveMs ?? MAILBOX_KEEPALIVE_MS;
  const onHandlerError =
    opts.onHandlerError ??
    ((error: unknown, env: Envelope) =>
      console.error(`[mailbox] handler failed for #${env.seq} (${env.cmd.type})`, error));

  const abort = new AbortController();
  let after = opts.after ?? 0;
  let backoff = minBackoff;

  /** Polls every `keepAliveMs` until `finished` aborts (see the guarantees above). */
  async function keepAlive(finished: AbortSignal): Promise<void> {
    for (;;) {
      await abortableSleep(keepAliveMs, finished);
      if (finished.aborted) return;
      try {
        await next(after);
      } catch {
        // The loop's own next poll reports (and retries) a broken mailbox.
      }
    }
  }

  async function handle(envelope: Envelope): Promise<void> {
    const handled = new AbortController();
    void keepAlive(AbortSignal.any([abort.signal, handled.signal]));
    try {
      await handler(envelope.cmd, envelope.seq);
    } catch (error) {
      onHandlerError(error, envelope);
    } finally {
      handled.abort();
    }
  }

  async function run(): Promise<void> {
    while (!abort.signal.aborted) {
      let batch: Envelope[];
      try {
        batch = await next(after);
      } catch (error) {
        if (abort.signal.aborted) return;
        const delay = backoff;
        backoff = Math.min(backoff * 2, maxBackoff);
        opts.onPollError?.(error, delay);
        await sleep(delay, abort.signal);
        continue;
      }
      backoff = minBackoff;
      if (abort.signal.aborted) return;

      // Rust returns envelopes in order already; sorting keeps the contract
      // even if a transport ever reorders them.
      const ordered = [...batch].sort((a, b) => a.seq - b.seq);
      for (const envelope of ordered) {
        if (abort.signal.aborted) return;
        if (envelope.seq <= after) continue;
        await handle(envelope);
        // Advance only after handling so the next poll acknowledges it.
        after = envelope.seq;
      }
    }
  }

  const done = run();
  return {
    stop: () => abort.abort(),
    get after() {
      return after;
    },
    done,
  };
}
