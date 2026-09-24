<!--
  History: every change Reskin made (thumb, target, when, state) with Undo
  (back to the previous icon) and Restore original (the whole chain for that
  target) per row, and "Restore all".
-->
<script lang="ts">
  import ClockFading from '@lucide/svelte/icons/clock-fading';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import { commands } from '$lib/ipc/commands';
  import type { EntryState, HistoryEntry, RestoreReport } from '$lib/ipc/types';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Tooltip from '$lib/ui/Tooltip.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getShell, reportRestore } from '../chrome/shell.svelte';
  import { errorText } from '../state/session.svelte';
  import { dayGroup, fullDate, pngSrc, shortPath, timeAgo } from './format';
  import ViewScaffold from './ViewScaffold.svelte';

  const shell = getShell();

  /** Longest chain "Restore original" walks back through. */
  const MAX_CHAIN = 64;

  let entries = $state.raw<HistoryEntry[] | null>(null);
  let failed = $state<string | null>(null);
  let busy = $state<string | null>(null);

  const STATE_LABEL: Record<EntryState, string> = {
    applied: 'Current',
    superseded: 'Replaced',
    restored: 'Restored',
    failed: 'Failed',
    pending: 'Pending',
  };

  const groups = $derived.by(() => {
    const out: Array<{ label: string; items: HistoryEntry[] }> = [];
    for (const e of entries ?? []) {
      const label = dayGroup(e.appliedAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  });
  const active = $derived((entries ?? []).filter((e) => e.state === 'applied').length);

  async function load(): Promise<void> {
    try {
      entries = await commands.historyList();
      failed = null;
    } catch (e) {
      failed = errorText(e);
      entries = [];
    }
  }

  $effect(() => {
    void shell.openEpoch;
    void shell.historyEpoch;
    void load();
  });

  async function undo(entry: HistoryEntry): Promise<void> {
    busy = entry.id;
    try {
      reportRestore(await commands.restore({ type: 'entry', id: entry.id }), 'one');
    } catch (e) {
      toast({ message: `Could not undo: ${errorText(e)}`, kind: 'error' });
    } finally {
      busy = null;
      shell.historyEpoch += 1;
    }
  }

  /** Undoes the target's changes one by one until its original icon is back. */
  async function restoreOriginal(entry: HistoryEntry): Promise<void> {
    busy = entry.id;
    const total: RestoreReport = { restored: 0, failed: [], needsElevation: 0 };
    try {
      let id: string | null = entry.id;
      for (let n = 0; id && n < MAX_CHAIN; n++) {
        const r = await commands.restore({ type: 'entry', id });
        total.restored += r.restored;
        total.failed.push(...r.failed);
        total.needsElevation += r.needsElevation;
        if (r.failed.length > 0 || r.needsElevation > 0 || r.restored === 0) break;
        const now = await commands.historyList();
        id = now.find((e) => e.target === entry.target && e.state === 'applied')?.id ?? null;
      }
      reportRestore(total, 'one');
    } catch (e) {
      toast({ message: `Could not restore: ${errorText(e)}`, kind: 'error' });
    } finally {
      busy = null;
      shell.historyEpoch += 1;
    }
  }
</script>

<ViewScaffold
  title="History"
  subtitle={active > 0
    ? `${active} icon${active === 1 ? ' is' : 's are'} currently reskinned. Undo any change, or put the originals back.`
    : 'Every change Reskin makes shows up here, ready to undo.'}
  testid="history-view"
>
  {#snippet actions()}
    <Button variant="secondary" icon={RotateCcw} disabled={active === 0} onclick={() => shell.restoreAll()}>
      Restore all…
    </Button>
  {/snippet}

  {#if entries === null}
    <div class="list skeleton" aria-hidden="true">
      {#each [0, 1, 2] as i (i)}<span class="row-skel"></span>{/each}
    </div>
  {:else if entries.length === 0}
    <div data-stagger>
      <EmptyState
        icon={ClockFading}
        title={failed ? 'Could not load the history' : 'No changes yet'}
        description={failed ?? 'When you apply an icon it is listed here with its original, so you can always go back.'}
      >
        {#if failed}<Button onclick={load}>Try again</Button>{/if}
      </EmptyState>
    </div>
  {:else}
    {#each groups as group (group.label)}
      <section class="group" data-stagger aria-label={group.label}>
        <h2>{group.label}</h2>
        <ul class="list">
          {#each group.items as e (e.id)}
            <li class="row" class:dim={e.state !== 'applied'} data-testid="history-row" data-state={e.state}>
              <span class="thumb"><img src={pngSrc(e.thumb)} alt="" draggable="false" /></span>
              <span class="what">
                <span class="name">
                  {e.name}
                  {#if e.designName && e.designName !== e.name}<span class="design">· {e.designName}</span>{/if}
                </span>
                <span class="target" title={e.target}>{shortPath(e.target)}</span>
              </span>
              <span class="when" title={fullDate(e.appliedAt)}>{timeAgo(e.appliedAt)}</span>
              <span class="chips">
                {#if e.elevated}
                  <Tooltip text="Changed with administrator rights (Public Desktop)">
                    <span class="chip admin" role="img" aria-label="Administrator"><ShieldCheck size={12} /></span>
                  </Tooltip>
                {/if}
                <span class="chip state-{e.state}">{STATE_LABEL[e.state]}</span>
              </span>
              <span class="actions">
                {#if e.state === 'applied'}
                  {#if e.supersedes}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onclick={() => restoreOriginal(e)}
                      aria-label="Restore the original icon of {e.name}">Restore original</Button
                    >
                  {/if}
                  <Button
                    size="sm"
                    icon={Undo2}
                    loading={busy === e.id}
                    disabled={busy !== null && busy !== e.id}
                    onclick={() => undo(e)}
                    aria-label="Undo the change to {e.name}">Undo</Button
                  >
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</ViewScaffold>

<style>
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  h2 {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
  }
  .list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: rgb(var(--bg-rgb) / 0.25);
    list-style: none;
    overflow: hidden;
  }
  :global([data-theme='light']) .list {
    background: rgb(255 255 255 / 0.6);
  }
  .row {
    display: grid;
    /* Fixed tracks so every row lines up. */
    grid-template-columns: 40px minmax(0, 1fr) 84px 128px 208px;
    align-items: center;
    gap: var(--space-3);
    min-height: 60px;
    padding: var(--space-2) var(--space-3);
  }
  .row + .row {
    border-top: 1px solid var(--divider);
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .thumb {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-md);
    background: var(--checker);
    overflow: hidden;
  }
  .thumb img {
    width: 32px;
    height: 32px;
    object-fit: contain;
  }
  .dim .thumb img {
    opacity: 0.6;
  }
  .what {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .design {
    color: var(--text-3);
    font-weight: var(--weight-regular);
  }
  .target {
    overflow: hidden;
    color: var(--text-3);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    color: var(--text-2);
    font-size: var(--text-sm);
    text-align: right;
    white-space: nowrap;
  }
  .chips {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 8px;
    border-radius: var(--radius-full);
    background: var(--surface-hover);
    color: var(--text-2);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    white-space: nowrap;
  }
  .chip.admin {
    padding: 0 5px;
    color: var(--warning);
    background: rgb(var(--warning-rgb) / 0.14);
  }
  .state-applied {
    background: rgb(var(--success-rgb) / 0.14);
    color: var(--success);
  }
  .state-failed {
    background: rgb(var(--danger-rgb) / 0.14);
    color: var(--danger);
  }
  .state-pending {
    background: rgb(var(--warning-rgb) / 0.14);
    color: var(--warning);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-1);
  }
  .skeleton {
    border: 0;
    gap: var(--space-1);
    background: none;
  }
  .row-skel {
    display: block;
    height: 60px;
    border-radius: var(--radius-md);
    background: var(--surface-hover);
  }
</style>
