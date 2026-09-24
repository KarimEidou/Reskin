// Undo/redo stack with labelled entries, merging and a byte cap.
//
// - `push` drops any redo tail, then either merges the command into the top
//   entry (same `mergeKey`, within `mergeWindowMs`, and the command agrees)
//   or appends it.
// - Memory is capped (default 256 MB, `DEFAULT_HISTORY_BYTES`): when the
//   total exceeds the cap the OLDEST entries are dropped (never the newest
//   one, so the last action can always be undone).
// - `index` is the number of applied entries: 0 = the oldest reachable state,
//   `length` = the latest. `jumpTo(n)` undoes/redoes until `index === n`.

import type { Rect } from '../util/rect';

export type Change =
  | { kind: 'pixels'; layerId: string; rect: Rect }
  | { kind: 'layers' }
  | { kind: 'selection' }
  | { kind: 'document' };

export interface Command<T> {
  readonly label: string;
  /** Memory this command keeps alive, bytes. */
  readonly bytes: number;
  undo(target: T): Change[];
  redo(target: T): Change[];
  /** Absorbs `next` (pushed right after with the same merge key). */
  merge?(next: Command<T>): boolean;
}

export interface HistoryEntryInfo {
  id: number;
  label: string;
  bytes: number;
  /** Unix ms of the last push/merge. */
  time: number;
}

export interface PushOptions {
  /** Consecutive pushes with the same key may merge into one entry. */
  mergeKey?: string;
  /** Maximum gap between merged pushes, ms (default 1000). */
  mergeWindowMs?: number;
}

export interface HistoryOptions {
  maxBytes?: number;
  /** Clock for merge windows and timestamps (tests). */
  now?: () => number;
}

export const DEFAULT_HISTORY_BYTES = 256 * 1024 * 1024;

interface Entry<T> {
  id: number;
  cmd: Command<T>;
  mergeKey: string | null;
  time: number;
}

export class History<T> {
  private list: Entry<T>[] = [];
  private applied = 0;
  private nextId = 1;
  private cap: number;
  private readonly now: () => number;
  private dropped = 0;

  constructor(opts: HistoryOptions = {}) {
    this.cap = opts.maxBytes ?? DEFAULT_HISTORY_BYTES;
    this.now = opts.now ?? Date.now;
  }

  get maxBytes(): number {
    return this.cap;
  }

  set maxBytes(bytes: number) {
    this.cap = Math.max(0, bytes);
    this.trim();
  }

  /** Number of applied entries (see the file comment). */
  get index(): number {
    return this.applied;
  }

  get length(): number {
    return this.list.length;
  }

  get canUndo(): boolean {
    return this.applied > 0;
  }

  get canRedo(): boolean {
    return this.applied < this.list.length;
  }

  /** How many old entries the byte cap has dropped since the last clear. */
  get droppedCount(): number {
    return this.dropped;
  }

  get totalBytes(): number {
    let n = 0;
    for (const e of this.list) n += e.cmd.bytes;
    return n;
  }

  /** Every entry, oldest first; entries at positions ≥ `index` are redoable. */
  get entries(): HistoryEntryInfo[] {
    return this.list.map((e) => ({ id: e.id, label: e.cmd.label, bytes: e.cmd.bytes, time: e.time }));
  }

  /** The most recently applied command. */
  peek(): Command<T> | null {
    return this.applied > 0 ? this.list[this.applied - 1].cmd : null;
  }

  /** The command at position `i` (0 = oldest), or null. */
  commandAt(i: number): Command<T> | null {
    return this.list[i]?.cmd ?? null;
  }

  push(cmd: Command<T>, opts: PushOptions = {}): void {
    this.discardRedo();
    const t = this.now();
    const key = opts.mergeKey ?? null;
    const top = this.list[this.list.length - 1];
    if (
      key !== null &&
      top &&
      top.mergeKey === key &&
      t - top.time <= (opts.mergeWindowMs ?? 1000) &&
      top.cmd.merge?.(cmd)
    ) {
      top.time = t;
    } else {
      this.list.push({ id: this.nextId++, cmd, mergeKey: key, time: t });
      this.applied = this.list.length;
    }
    this.trim();
  }

  undo(target: T): Change[] | null {
    if (!this.canUndo) return null;
    const e = this.list[--this.applied];
    return e.cmd.undo(target);
  }

  redo(target: T): Change[] | null {
    if (!this.canRedo) return null;
    const e = this.list[this.applied++];
    return e.cmd.redo(target);
  }

  /** Undoes/redoes until `index === n` (clamped). Returns every change. */
  jumpTo(target: T, n: number): Change[] {
    const goal = Math.max(0, Math.min(this.list.length, Math.floor(n)));
    const out: Change[] = [];
    while (this.applied > goal) out.push(...(this.undo(target) ?? []));
    while (this.applied < goal) out.push(...(this.redo(target) ?? []));
    return out;
  }

  /** Forgets the redo tail. */
  discardRedo(): void {
    if (this.applied < this.list.length) this.list.length = this.applied;
  }

  /** Stops the top entry from absorbing later pushes. */
  sealTop(): void {
    const top = this.list[this.list.length - 1];
    if (top) top.mergeKey = null;
  }

  clear(): void {
    this.list = [];
    this.applied = 0;
    this.dropped = 0;
  }

  private trim(): void {
    let total = this.totalBytes;
    while (total > this.cap && this.list.length > 1) {
      if (this.applied > 0) {
        // Oldest undo entry: its "before" state becomes unreachable.
        const e = this.list.shift() as Entry<T>;
        this.applied--;
        total -= e.cmd.bytes;
      } else {
        // Nothing applied: drop the furthest redo entry instead.
        const e = this.list.pop() as Entry<T>;
        total -= e.cmd.bytes;
      }
      this.dropped++;
    }
  }
}
