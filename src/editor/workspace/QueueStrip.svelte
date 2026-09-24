<!--
  The batch queue: a thumbnail per dropped item with its status (pending,
  editing, applying, applied, failed). Click switches the design (each item
  keeps its own), × removes an item; "Apply style to all" rebuilds the last
  style on every other item's icon.
-->
<script lang="ts">
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Layers2 from '@lucide/svelte/icons/layers-2';
  import X from '@lucide/svelte/icons/x';
  import Button from '$lib/ui/Button.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import Tooltip from '$lib/ui/Tooltip.svelte';
  import { errorText, type QueueStatus } from '../state/session.svelte';
  import { getSession } from '../state/context';

  const session = getSession();

  const STATUS_TEXT: Record<QueueStatus, string> = {
    pending: 'not started',
    editing: 'editing',
    applying: 'applying',
    applied: 'applied',
    failed: 'failed',
  };

  const many = $derived(session.queue.length > 1);
  const canApplyAll = $derived(!!session.recipe && session.queue.length >= 2 && session.busy === null);
  const applyAllHint = $derived(
    session.busy
      ? 'Wait for the current job to finish'
      : !session.recipe
        ? 'Apply a style, backdrop or adjustment first'
        : `Rebuild "${session.recipe.label}" on every other icon and apply it`,
  );

  /** One switch at a time: each loads and stashes a whole design. */
  let switching = false;

  async function select(i: number): Promise<void> {
    if (switching || session.busy || i === session.currentIndex) return;
    switching = true;
    try {
      await session.select(i);
    } catch (e) {
      toast({ message: `Could not open ${session.queue[i]?.info.name ?? 'that icon'}: ${errorText(e)}`, kind: 'error' });
    } finally {
      switching = false;
    }
  }

  async function remove(i: number): Promise<void> {
    if (switching || session.busy) return;
    switching = true;
    try {
      await session.remove(i);
    } catch (e) {
      toast({ message: `Could not switch icons: ${errorText(e)}`, kind: 'error' });
    } finally {
      switching = false;
    }
  }

  async function applyAll(): Promise<void> {
    if (!canApplyAll) return;
    try {
      await session.applyStyleToAll();
    } catch (e) {
      toast({ message: `Could not apply to all: ${errorText(e)}`, kind: 'error' });
    }
  }
</script>

{#if session.queue.length > 0}
  <div class="queue" data-testid="queue-strip">
    <ul class="items" aria-label="Queued icons">
      {#each session.queue as entry, i (entry.info.id)}
        {@const current = i === session.currentIndex}
        <li class="item" class:current data-status={entry.status}>
          <Tooltip text="{entry.info.name} — {STATUS_TEXT[entry.status]}" placement="top" describe={false}>
            <button
              type="button"
              class="thumb"
              aria-label="{entry.info.name}, {STATUS_TEXT[entry.status]}"
              aria-current={current ? 'true' : undefined}
              aria-disabled={session.busy !== null && !current}
              data-testid="queue-item"
              onclick={() => select(i)}
            >
              {#if entry.thumb ?? entry.info.icon}
                <img src={entry.thumb ?? entry.info.icon} alt="" draggable="false" />
              {:else}
                <span class="placeholder" aria-hidden="true">{entry.info.name.slice(0, 1)}</span>
              {/if}
              <span class="badge {entry.status}" aria-hidden="true">
                {#if entry.status === 'applying'}
                  <Spinner size={10} label="" />
                {:else if entry.status === 'applied'}
                  <CircleCheck size={12} strokeWidth={2.5} />
                {:else if entry.status === 'failed'}
                  <CircleAlert size={12} strokeWidth={2.5} />
                {/if}
              </span>
            </button>
          </Tooltip>
          {#if many}
            <button
              type="button"
              class="remove"
              aria-label="Remove {entry.info.name} from the queue"
              disabled={session.busy !== null}
              onclick={() => remove(i)}
            >
              <X size={10} strokeWidth={2.5} aria-hidden="true" />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if !many && session.item}
      <div class="single">
        <span class="name">{session.item.name}</span>
        <span class="status">{STATUS_TEXT[session.current?.status ?? 'editing']}</span>
      </div>
    {/if}
    {#if many}
      <Tooltip text={applyAllHint} placement="top">
        <Button
          size="sm"
          variant="ghost"
          icon={Layers2}
          aria-label="Apply style to all"
          aria-disabled={!canApplyAll}
          class={canApplyAll ? '' : 'soft-disabled'}
          data-testid="apply-style-all"
          onclick={applyAll}
        >
          <span class="apply-all-label">Apply style to all</span>
        </Button>
      </Tooltip>
    {/if}
  </div>
{/if}

<style>
  .queue {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .items {
    display: flex;
    align-items: center;
    gap: 8px;
    /* At least one thumbnail stays visible however narrow the bar gets. */
    min-width: 50px;
    /* Room inside the scroll box for the corner remove buttons, badges and
       focus rings (the negative margin keeps the bar's layout unchanged). */
    margin: -4px 0 -4px -6px;
    padding: 8px 8px 8px 6px;
    overflow-x: auto;
    list-style: none;
    scrollbar-width: none;
  }
  .item {
    position: relative;
    flex: none;
  }
  .thumb {
    position: relative;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-sunken);
    cursor: default;
    transition:
      border-color var(--fade-1) linear,
      box-shadow var(--fade-1) linear,
      transform var(--dur-1) var(--ease-standard);
  }
  .thumb:hover {
    border-color: var(--border-strong);
  }
  .thumb:active {
    transform: scale(0.95);
  }
  .thumb:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }
  .current .thumb {
    border-color: var(--accent);
    box-shadow:
      0 0 0 1px var(--accent),
      0 2px 10px rgb(var(--accent-rgb) / 0.3);
  }
  .thumb[aria-disabled='true'] {
    opacity: 0.55;
  }
  img {
    width: 28px;
    height: 28px;
    object-fit: contain;
    image-rendering: auto;
  }
  .placeholder {
    color: var(--text-3);
    font-weight: var(--weight-semibold);
  }

  .badge {
    position: absolute;
    right: -4px;
    bottom: -4px;
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border: 2px solid var(--surface-1);
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--text-2);
  }
  .badge.pending {
    width: 10px;
    height: 10px;
    right: -2px;
    bottom: -2px;
    background: var(--text-3);
  }
  .badge.editing {
    width: 10px;
    height: 10px;
    right: -2px;
    bottom: -2px;
    background: var(--accent);
  }
  .badge.applying {
    color: var(--accent-text);
  }
  .badge.applied {
    background: var(--success);
    color: var(--surface-1);
  }
  .badge.failed {
    background: var(--danger);
    color: var(--surface-1);
  }
  .badge :global(svg) {
    display: block;
  }
  .badge.applied :global(svg),
  .badge.failed :global(svg) {
    width: 10px;
    height: 10px;
  }

  .remove {
    position: absolute;
    top: -5px;
    right: -5px;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--text-2);
    opacity: 0;
    scale: 0.8;
    cursor: default;
    transition:
      opacity var(--fade-1) linear,
      scale var(--dur-1) var(--ease-standard);
  }
  .item:hover .remove,
  .remove:focus-visible {
    opacity: 1;
    scale: 1;
  }
  .remove:hover {
    background: var(--danger);
    border-color: transparent;
    color: var(--on-danger);
  }
  .remove:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }

  .single {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.2;
  }
  .name {
    overflow: hidden;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .status {
    color: var(--text-3);
    font-size: var(--text-xs);
  }

  .queue :global(.soft-disabled) {
    opacity: 0.45;
  }

  /* Narrow windows: the batch button keeps its icon, the thumbnails keep the room. */
  @container (max-width: 1000px) {
    .queue :global(.label:has(> .apply-all-label)) {
      display: none;
    }
  }
</style>
