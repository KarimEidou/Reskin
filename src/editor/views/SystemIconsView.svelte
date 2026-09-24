<!-- System icons (This PC, Recycle Bin…) with their current icons; click → edit. -->
<script lang="ts">
  import { commands } from '$lib/ipc/commands';
  import type { ItemInfo, SystemIconId } from '$lib/ipc/types';
  import Button from '$lib/ui/Button.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getShell } from '../chrome/shell.svelte';
  import { getSession } from '../state/context';
  import { errorText } from '../state/session.svelte';
  import ViewScaffold from './ViewScaffold.svelte';

  const shell = getShell();
  const session = getSession();

  const IDS: readonly SystemIconId[] = [
    'thisPc',
    'recycleBinEmpty',
    'recycleBinFull',
    'userFiles',
    'network',
    'controlPanel',
  ];
  const HINTS: Record<SystemIconId, string> = {
    thisPc: 'Your drives and devices',
    recycleBinEmpty: 'Shown while the bin is empty',
    recycleBinFull: 'Shown when it has something in it',
    userFiles: 'Your personal folder',
    network: 'Computers on your network',
    controlPanel: 'Classic settings',
  };

  type Slot = { id: SystemIconId; info: ItemInfo | null; error: string | null };
  let slots = $state.raw<Slot[]>(IDS.map((id) => ({ id, info: null, error: null })));
  let loaded = $state(false);

  async function load(): Promise<void> {
    loaded = false;
    slots = await Promise.all(
      IDS.map(async (id): Promise<Slot> => {
        try {
          return { id, info: await commands.inspectSystemIcon(id), error: null };
        } catch (e) {
          return { id, info: null, error: errorText(e) };
        }
      }),
    );
    loaded = true;
  }

  $effect(() => {
    void shell.openEpoch;
    void load();
  });

  async function edit(slot: Slot): Promise<void> {
    const info = slot.info;
    if (!info) {
      toast({ message: `Could not read this icon: ${slot.error ?? 'unknown error'}`, kind: 'error' });
      return;
    }
    await shell.openItems([info]);
    // Already editing something else: switch to the icon that was picked.
    const i = session.queue.findIndex((q) => q.info.id === info.id);
    try {
      if (i >= 0 && i !== session.currentIndex) await session.select(i);
      session.navigate('edit');
    } catch (e) {
      toast({ message: `Could not open ${info.name}: ${errorText(e)}`, kind: 'error' });
    }
  }
</script>

<ViewScaffold
  title="System icons"
  subtitle="The desktop icons Windows owns. Pick one to give it your own look."
  testid="system-icons-view"
>
  <ul class="grid" data-stagger aria-busy={!loaded}>
    {#each slots as slot (slot.id)}
      <li>
        <button
          type="button"
          class="card"
          disabled={loaded && !slot.info}
          onclick={() => edit(slot)}
          aria-label={slot.info ? `Edit ${slot.info.name}` : undefined}
        >
          <span class="icon" class:skeleton={!slot.info}>
            {#if slot.info?.icon}<img src={slot.info.icon} alt="" draggable="false" />{/if}
          </span>
          <span class="text">
            <span class="name">{slot.info?.name ?? (slot.error ? 'Unavailable' : ' ')}</span>
            <span class="hint">{slot.error ?? HINTS[slot.id]}</span>
          </span>
          {#if slot.info?.customIcon}
            <span class="chip">Customised</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if loaded && slots.every((s) => !s.info)}
    <div class="retry">
      <Button onclick={load}>Try again</Button>
    </div>
  {/if}
</ViewScaffold>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    width: 100%;
    min-height: 96px;
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: rgb(var(--bg-rgb) / 0.25);
    color: var(--text);
    text-align: left;
    transition:
      background-color var(--fade-1) linear,
      border-color var(--fade-1) linear,
      transform var(--dur-2) var(--ease-standard);
  }
  :global([data-theme='light']) .card {
    background: rgb(255 255 255 / 0.55);
  }
  .card:hover:not(:disabled) {
    border-color: var(--accent-border);
    background: var(--surface-selected);
  }
  .card:active:not(:disabled) {
    transform: scale(0.985);
  }
  .card:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }
  .card:disabled {
    opacity: 0.55;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    flex: none;
    border-radius: var(--radius-lg);
    background:
      radial-gradient(70% 70% at 50% 30%, rgb(255 255 255 / 0.1), transparent 70%),
      var(--shell-well);
    box-shadow: inset 0 0 0 1px var(--border-subtle);
  }
  .icon img {
    width: 48px;
    height: 48px;
    object-fit: contain;
    filter: drop-shadow(0 2px 3px rgb(0 0 0 / 0.3));
    -webkit-user-drag: none;
  }
  .skeleton {
    background: var(--surface-hover);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name {
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
  }
  .hint {
    color: var(--text-3);
    font-size: var(--text-sm);
  }
  .chip {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    padding: 1px 8px;
    border-radius: var(--radius-full);
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
  }
  .retry {
    display: flex;
    justify-content: center;
  }
</style>
