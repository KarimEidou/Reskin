<!--
  Library: saved designs (thumb, name, date). Open one (asking before
  unsaved changes are replaced), rename it, delete it, or apply it straight
  to the queued item. The open design remembers the Library design it came
  from or was saved as: saving updates that one ("Save changes"), or
  "Save as new" adds another.
-->
<script lang="ts">
  import CopyPlus from '@lucide/svelte/icons/copy-plus';
  import LibraryIcon from '@lucide/svelte/icons/library';
  import Save from '@lucide/svelte/icons/save';
  import Search from '@lucide/svelte/icons/search';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash from '@lucide/svelte/icons/trash';
  import Wand from '@lucide/svelte/icons/wand-sparkles';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import { tick } from 'svelte';
  import { commands } from '$lib/ipc/commands';
  import type { LibraryEntry } from '$lib/ipc/types';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Menu, { type MenuEntry } from '$lib/ui/Menu.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getShell } from '../chrome/shell.svelte';
  import { confirm } from '../dialogs/confirm.svelte';
  import { getSession } from '../state/context';
  import { errorText } from '../state/session.svelte';
  import { formatBytes, fullDate, pngSrc, timeAgo } from './format';
  import ViewScaffold from './ViewScaffold.svelte';

  const session = getSession();
  const shell = getShell();

  let entries = $state.raw<LibraryEntry[] | null>(null);
  let failed = $state<string | null>(null);
  let query = $state('');
  let renaming = $state<string | null>(null);
  let draft = $state('');
  /** Which save runs: over the open design's Library design, or as a new one. */
  let saving = $state<'update' | 'new' | null>(null);
  let renameInput: HTMLInputElement | undefined = $state();
  let grid: HTMLUListElement | undefined = $state();

  const shown = $derived.by(() => {
    const list = entries ?? [];
    const q = query.trim().toLowerCase();
    return q ? list.filter((e) => e.name.toLowerCase().includes(q)) : list;
  });
  const target = $derived(session.item && session.canApply ? session.item : null);
  /** The Library design the open design came from or was saved as. */
  const savedAs = $derived(session.hasDesign ? (entries?.find((e) => e.id === session.libraryId) ?? null) : null);

  async function refresh(): Promise<void> {
    try {
      entries = await commands.libraryList();
      failed = null;
    } catch (e) {
      failed = errorText(e);
      entries = [];
    }
  }

  $effect(() => {
    void shell.openEpoch;
    void shell.libraryEpoch;
    void refresh();
  });

  /** Saves the open design over its Library design, or as a copy of it with `asNew`. */
  async function saveCurrent(asNew: boolean): Promise<void> {
    if (saving) return;
    saving = asNew ? 'new' : 'update';
    try {
      await shell.saveToLibrary(asNew && savedAs ? `${savedAs.name} copy` : undefined, { asNew });
    } finally {
      saving = null;
    }
  }

  async function open(entry: LibraryEntry): Promise<void> {
    try {
      await shell.openLibraryDesign(entry);
    } catch (e) {
      toast({ message: `Could not open "${entry.name}": ${errorText(e)}`, kind: 'error' });
    }
  }

  async function startRename(entry: LibraryEntry): Promise<void> {
    renaming = entry.id;
    draft = entry.name;
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  async function commitRename(entry: LibraryEntry): Promise<void> {
    if (renaming !== entry.id) return;
    renaming = null;
    const name = draft.trim();
    if (!name || name === entry.name) return;
    try {
      const data = await commands.libraryLoad(entry.id);
      await commands.librarySave({ id: entry.id, name, thumb: entry.thumb, data });
      // The designs that save over this entry keep the new name.
      session.libraryDesignRenamed(entry.id, name);
      toast({ message: `Renamed to "${name}".`, kind: 'success' });
      await refresh();
    } catch (e) {
      toast({ message: `Could not rename: ${errorText(e)}`, kind: 'error' });
    }
  }

  function onRenameKey(e: KeyboardEvent, entry: LibraryEntry): void {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    // Keyboard users continue from the card's menu button, not from <body>.
    const card = (e.currentTarget as HTMLElement).closest('li');
    if (e.key === 'Enter') {
      void commitRename(entry);
    } else {
      e.stopPropagation();
      renaming = null;
    }
    void tick().then(() => card?.querySelector<HTMLElement>('.more [aria-haspopup="menu"]')?.focus());
  }

  async function remove(entry: LibraryEntry): Promise<void> {
    const ok = await confirm({
      title: `Delete "${entry.name}"?`,
      message: 'The design is removed from your Library. Icons already applied with it stay as they are.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const at = shown.findIndex((e) => e.id === entry.id);
    try {
      await commands.libraryDelete(entry.id);
      session.forgetLibraryDesign(entry.id);
      toast({ message: `Deleted "${entry.name}".`, kind: 'success' });
      await refresh();
      await tick();
      // Focus went with the card (the dialog gave it back to its menu
      // button): keyboard users continue from the card now in its place.
      if (document.activeElement === document.body) {
        const buttons = grid?.querySelectorAll<HTMLElement>('.more [aria-haspopup="menu"]') ?? [];
        buttons[Math.min(at, buttons.length - 1)]?.focus();
      }
    } catch (e) {
      toast({ message: `Could not delete: ${errorText(e)}`, kind: 'error' });
    }
  }

  async function applyToCurrent(entry: LibraryEntry): Promise<void> {
    try {
      if (await shell.openLibraryDesign(entry)) await session.apply();
    } catch (e) {
      toast({ message: `Could not apply "${entry.name}": ${errorText(e)}`, kind: 'error' });
    }
  }

  function menuFor(): MenuEntry[] {
    return [
      { id: 'open', label: 'Open', icon: FolderOpen },
      ...(target ? [{ id: 'apply', label: `Apply to “${target.name}”`, icon: Wand }] : []),
      { id: 'rename', label: 'Rename', icon: Pencil },
      { separator: true },
      { id: 'delete', label: 'Delete…', icon: Trash, danger: true },
    ];
  }

  function onMenu(entry: LibraryEntry, id: string): void {
    if (id === 'open') void open(entry);
    else if (id === 'apply') void applyToCurrent(entry);
    else if (id === 'rename') void startRename(entry);
    else if (id === 'delete') void remove(entry);
  }
</script>

<ViewScaffold
  title="Library"
  subtitle={entries && entries.length > 0
    ? `${entries.length} saved design${entries.length === 1 ? '' : 's'} — reuse them on any icon.`
    : 'Designs you save stay here, ready for any icon.'}
  testid="library-view"
>
  {#snippet actions()}
    {#if entries && entries.length > 0}
      <label class="filter">
        <Search size={14} aria-hidden="true" />
        <span class="sr-only">Filter designs</span>
        <input type="search" placeholder="Filter" bind:value={query} />
      </label>
    {/if}
    {#if savedAs}
      <Button icon={CopyPlus} loading={saving === 'new'} disabled={saving === 'update'} onclick={() => saveCurrent(true)}>
        Save as new
      </Button>
      <Button
        variant="primary"
        icon={Save}
        loading={saving === 'update'}
        disabled={saving === 'new'}
        aria-label="Save changes to {savedAs.name}"
        onclick={() => saveCurrent(false)}>Save changes</Button
      >
    {:else if session.hasDesign}
      <Button variant="primary" icon={Save} loading={saving !== null} onclick={() => saveCurrent(false)}>Save current design</Button>
    {/if}
  {/snippet}

  {#if entries === null}
    <ul class="grid" aria-hidden="true">
      {#each [0, 1, 2, 3] as i (i)}<li class="card skeleton"><span class="thumb"></span></li>{/each}
    </ul>
  {:else if entries.length === 0}
    <div data-stagger>
      <EmptyState
        icon={LibraryIcon}
        title={failed ? 'Could not load the Library' : 'Your Library is empty'}
        description={failed ?? 'Save a design (Ctrl+S) to reuse it on other icons — great for giving a whole set of apps one look.'}
      >
        {#if failed}
          <Button onclick={refresh}>Try again</Button>
        {:else if session.hasDesign}
          <Button variant="primary" icon={Save} onclick={() => saveCurrent(false)}>Save current design</Button>
        {/if}
      </EmptyState>
    </div>
  {:else if shown.length === 0}
    <p class="none" role="status">No designs match “{query}”.</p>
  {:else}
    <ul class="grid" data-stagger bind:this={grid}>
      {#each shown as entry (entry.id)}
        <li class="card" data-testid="library-card">
          <button type="button" class="open" onclick={() => open(entry)} aria-label="Open {entry.name}">
            <span class="thumb"><img src={pngSrc(entry.thumb)} alt="" draggable="false" /></span>
          </button>
          {#if savedAs?.id === entry.id}<span class="editing">Editing</span>{/if}
          <div class="meta">
            {#if renaming === entry.id}
              <input
                class="rename"
                bind:this={renameInput}
                bind:value={draft}
                aria-label="New name for {entry.name}"
                maxlength="80"
                onkeydown={(e) => onRenameKey(e, entry)}
                onblur={() => commitRename(entry)}
              />
            {:else}
              <span class="name" title={entry.name}>{entry.name}</span>
            {/if}
            <span class="sub" title={fullDate(entry.updatedAt)}>{timeAgo(entry.updatedAt)} · {formatBytes(entry.bytes)}</span>
          </div>
          <div class="more">
            <Menu
              items={menuFor()}
              label="More actions for {entry.name}"
              iconOnly
              icon={Ellipsis}
              size="sm"
              placement="bottom-end"
              onselect={(id) => onMenu(entry, id)}
            />
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</ViewScaffold>

<style>
  .filter {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    height: var(--control-md);
    padding: 0 var(--space-2);
    border: 1px solid var(--control-border);
    border-radius: var(--radius-md);
    background: var(--control-fill);
    color: var(--text-3);
  }
  .filter:focus-within {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .filter input {
    width: 140px;
    border: 0;
    background: transparent;
    font-size: var(--text-md);
    outline: none;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: rgb(var(--bg-rgb) / 0.25);
    overflow: hidden;
    transition:
      border-color var(--fade-1) linear,
      box-shadow var(--fade-2) linear;
  }
  :global([data-theme='light']) .card {
    background: rgb(255 255 255 / 0.6);
  }
  .card:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-2);
  }
  .open {
    display: block;
    width: 100%;
    padding: var(--space-2) var(--space-2) 0;
    border: 0;
    background: transparent;
  }
  .open:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: -3px;
    border-radius: var(--radius-lg);
  }
  .thumb {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    border-radius: var(--radius-md);
    background: var(--checker);
    box-shadow: inset 0 0 0 1px var(--border-subtle);
  }
  .thumb img {
    width: 70%;
    height: 70%;
    object-fit: contain;
    filter: drop-shadow(0 3px 5px rgb(0 0 0 / 0.28));
    transition: transform var(--dur-3) var(--ease-spring);
    -webkit-user-drag: none;
  }
  .open:hover .thumb img {
    transform: scale(1.05);
  }
  .skeleton .thumb {
    margin: var(--space-2);
    background: var(--surface-hover);
    box-shadow: none;
  }
  .skeleton {
    min-height: 220px;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    padding: var(--space-2) 40px var(--space-3) var(--space-3);
  }
  .name {
    overflow: hidden;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    color: var(--text-3);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  /* The design open in the editor saves over this one. */
  .editing {
    position: absolute;
    top: calc(var(--space-2) + 6px);
    left: calc(var(--space-2) + 6px);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--on-accent);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.02em;
    pointer-events: none;
  }
  .rename {
    width: 100%;
    height: 24px;
    margin: -2px 0 -1px -4px;
    padding: 0 4px;
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    outline: none;
  }
  .more {
    position: absolute;
    right: var(--space-1-5);
    bottom: var(--space-2-5, 10px);
  }
  .more :global(.icon-btn[aria-expanded='true']) {
    background: var(--surface-hover);
    color: var(--text);
  }
  .none {
    margin: 0;
    color: var(--text-3);
    text-align: center;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
