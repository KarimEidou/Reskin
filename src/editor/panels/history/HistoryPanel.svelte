<!--
  History panel: every undo step, oldest first, with the current state
  highlighted; steps after it are redoable (dimmed). Clicking a row jumps
  there (engine.jumpTo). Arrow keys move through the list. "Clear history"
  asks first.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Redo2 from '@lucide/svelte/icons/redo-2';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import FileImage from '@lucide/svelte/icons/file-image';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import ToolButton from '../common/ToolButton.svelte';
  import { getSession } from '../../state/context';

  const session = getSession();
  const engine = session.engine;

  interface Row {
    n: number;
    id: number;
    label: string;
    time: number | null;
  }

  const hist = $derived.by(() => {
    void session.rev.history;
    void session.rev.document;
    const entries = engine.historyEntries;
    const rows: Row[] = [{ n: 0, id: 0, label: engine.doc.meta.name ? `Opened ${engine.doc.meta.name}` : 'Start', time: null }];
    entries.forEach((e, i) => rows.push({ n: i + 1, id: e.id, label: e.label, time: e.time }));
    const bytes = entries.reduce((s, e) => s + e.bytes, 0);
    return {
      rows,
      index: engine.historyIndex,
      bytes,
      dropped: engine.history.droppedCount,
      canUndo: engine.canUndo,
      canRedo: engine.canRedo,
    };
  });

  const buttons: HTMLButtonElement[] = $state([]);
  let confirmClear = $state(false);

  // Keep the current step in view.
  $effect(() => {
    const i = hist.index;
    void tick().then(() => buttons[i]?.scrollIntoView({ block: 'nearest' }));
  });

  function jump(n: number): void {
    if (n === hist.index) return;
    engine.jumpTo(n);
  }

  function onKey(e: KeyboardEvent, n: number): void {
    let next = n;
    if (e.key === 'ArrowUp') next = n - 1;
    else if (e.key === 'ArrowDown') next = n + 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = hist.rows.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    next = Math.max(0, Math.min(hist.rows.length - 1, next));
    jump(next);
    buttons[next]?.focus();
  }

  const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

  function when(t: number | null, _tick: number): string {
    if (t === null) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return clock.format(t);
  }

  function size(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // Relative times refresh every half minute while visible.
  let now = $state(0);
  $effect(() => {
    const t = setInterval(() => (now += 1), 30_000);
    return () => clearInterval(t);
  });
</script>

<div class="history" data-testid="history-panel">
  <div class="toolbar">
    <ToolButton label="Undo" shortcut="Ctrl+Z" icon={Undo2} size="sm" disabled={!hist.canUndo} onclick={() => engine.undo()} />
    <ToolButton label="Redo" shortcut="Ctrl+Y" icon={Redo2} size="sm" disabled={!hist.canRedo} onclick={() => engine.redo()} />
    <span class="meta">{hist.rows.length - 1} step{hist.rows.length === 2 ? '' : 's'} · {size(hist.bytes)}</span>
    <ToolButton label="Clear history" icon={Trash2} size="sm" disabled={hist.rows.length <= 1} onclick={() => (confirmClear = true)} />
  </div>

  {#if hist.rows.length <= 1}
    <EmptyState icon={FileImage} title="Nothing to undo yet" description="Every change you make appears here. Click a step to go back to it." compact />
  {:else}
    <ol class="list" aria-label="History steps">
      {#if hist.dropped > 0}
        <li class="dropped">Older steps were dropped to save memory.</li>
      {/if}
      {#each hist.rows as row (row.id)}
        {@const current = row.n === hist.index}
        <li>
          <button
            bind:this={buttons[row.n]}
            type="button"
            class="row"
            class:current
            class:future={row.n > hist.index}
            aria-current={current ? 'step' : undefined}
            tabindex={current ? 0 : -1}
            data-step={row.n}
            onclick={() => jump(row.n)}
            onkeydown={(e) => onKey(e, row.n)}
          >
            <span class="dot" aria-hidden="true"></span>
            <span class="label">{row.label}</span>
            <span class="time">{when(row.time, now)}</span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<Dialog bind:open={confirmClear} title="Clear history?" description="You will not be able to undo the changes made so far. The design itself stays as it is." size="sm">
  {#snippet footer()}
    <Button onclick={() => (confirmClear = false)}>Cancel</Button>
    <Button
      variant="danger"
      onclick={() => {
        engine.clearHistory();
        confirmClear = false;
      }}>Clear history</Button
    >
  {/snippet}
</Dialog>

<style>
  .history {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: var(--space-0-5);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--divider);
    background: var(--surface-1);
  }
  .meta {
    flex: 1;
    padding-left: var(--space-2);
    color: var(--text-3);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .list {
    margin: 0;
    padding: var(--space-2) var(--space-2) var(--space-3);
    list-style: none;
  }
  .dropped {
    padding: var(--space-1) var(--space-2) var(--space-2);
    color: var(--text-3);
    font-size: var(--text-xs);
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    height: 30px;
    padding: 0 var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font-size: var(--text-sm);
    text-align: left;
    cursor: default;
    transition: background-color var(--fade-1) linear;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row.current {
    background: var(--surface-selected);
    color: var(--text);
    font-weight: var(--weight-medium);
  }
  .row.future {
    color: var(--text-3);
  }
  .row:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: -2px;
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border: 2px solid var(--text-3);
    border-radius: 50%;
  }
  .row:not(.future) .dot {
    border-color: var(--accent);
    background: var(--accent);
  }
  .row.current .dot {
    box-shadow: 0 0 0 3px rgb(var(--accent-rgb) / 0.25);
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time {
    color: var(--text-3);
    font-size: var(--text-xs);
    font-weight: var(--weight-regular);
    white-space: nowrap;
  }
</style>
