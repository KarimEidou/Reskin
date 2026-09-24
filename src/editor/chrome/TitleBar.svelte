<!--
  The editor's title bar (40 px): logo (→ Start), the current item (a menu
  over the batch queue), view tabs, the command-palette button and Close.
  Empty space is the window drag region — `data-tauri-drag-region` sits only
  on non-interactive elements.
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import House from '@lucide/svelte/icons/house';
  import Plus from '@lucide/svelte/icons/plus';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';
  import type { EditorView } from '$lib/ipc/types';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Kbd from '$lib/ui/Kbd.svelte';
  import Menu, { type MenuEntry } from '$lib/ui/Menu.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import Tooltip from '$lib/ui/Tooltip.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getSession } from '../state/context';
  import { errorText } from '../state/session.svelte';
  import LogoMark from './LogoMark.svelte';
  import { getShell } from './shell.svelte';

  const session = getSession();
  const shell = getShell();

  const TABS: ReadonlyArray<{ view: EditorView; label: string }> = [
    { view: 'edit', label: 'Edit' },
    { view: 'library', label: 'Library' },
    { view: 'history', label: 'History' },
    { view: 'settings', label: 'Settings' },
  ];

  const VIEW_NAMES: Partial<Record<EditorView, string>> = {
    start: 'Start',
    welcome: 'Welcome',
    systemIcons: 'System icons',
    library: 'Library',
    history: 'History',
    settings: 'Settings',
    about: 'Settings',
    edit: 'Edit',
  };

  const tabs = $derived(TABS.filter((t) => t.view !== 'edit' || session.hasDesign));
  const current = $derived(session.view === 'about' ? 'settings' : session.view);
  const docName = $derived.by(() => {
    void session.rev.document;
    void session.rev.layers;
    return session.hasDesign ? session.engine.doc.meta.name || 'Untitled' : null;
  });
  const item = $derived(session.item);
  const queued = $derived(session.queue.length);
  const title = $derived(item?.name ?? docName);

  const STATUS: Record<string, string> = {
    pending: 'waiting',
    editing: '',
    applying: 'applying…',
    applied: 'done',
    failed: 'failed',
  };

  const queueMenu = $derived<MenuEntry[]>([
    { heading: queued > 1 ? `Queue · ${queued} icons` : 'Editing' },
    ...session.queue.map((q, i) => ({
      id: `q:${i}`,
      label: STATUS[q.status] ? `${q.info.name} — ${STATUS[q.status]}` : q.info.name,
      checked: i === session.currentIndex,
    })),
    { separator: true },
    { id: 'add', label: 'Add images or shortcuts…', icon: Plus, shortcut: 'Ctrl+O' },
    { id: 'start', label: 'Start page', icon: House },
  ]);

  function close(): void {
    session.requestClose().catch((e: unknown) => {
      toast({ message: `Could not close the editor: ${errorText(e)}`, kind: 'error' });
    });
  }

  function onQueue(id: string): void {
    if (id.startsWith('q:')) {
      const i = Number(id.slice(2));
      session.navigate('edit');
      session.select(i).catch((e: unknown) => {
        toast({ message: `Could not switch icons: ${errorText(e)}`, kind: 'error' });
      });
    } else if (id === 'add') {
      void shell.openImage();
    } else if (id === 'start') {
      shell.navigate('start');
    }
  }
</script>

<header class="titlebar" data-tauri-drag-region data-stagger>
  <Tooltip text="Start page" placement="bottom">
    <button type="button" class="home" aria-label="Start page" onclick={() => shell.navigate('start')}>
      <LogoMark size={22} />
    </button>
  </Tooltip>

  <div class="title" data-tauri-drag-region>
    {#if item}
      <Menu items={queueMenu} label="Queue" placement="bottom-start" onselect={onQueue}>
        {#snippet trigger(props)}
          <button type="button" class="item" {...props} aria-label="{item.name}{queued > 1 ? `, 1 of ${queued} queued` : ''}">
            {#if session.current?.thumb ?? item.icon}
              <img class="thumb" src={session.current?.thumb ?? item.icon} alt="" draggable="false" />
            {/if}
            <span class="name">{item.name}</span>
            {#if queued > 1}<span class="count" aria-hidden="true">{session.currentIndex + 1}/{queued}</span>{/if}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        {/snippet}
      </Menu>
    {:else if title}
      <span class="doc" data-tauri-drag-region>{title}</span>
    {:else}
      <span class="brand" data-tauri-drag-region>Reskin</span>
      <span class="crumb" data-tauri-drag-region>{VIEW_NAMES[session.view] ?? ''}</span>
    {/if}
    {#if shell.loading > 0}
      <span class="loading"><Spinner size={14} label="Loading" /></span>
    {/if}
  </div>

  <nav class="views" aria-label="Views">
    {#each tabs as tab (tab.view)}
      <button
        type="button"
        class="tab"
        aria-current={current === tab.view ? 'page' : undefined}
        onclick={() => shell.navigate(tab.view)}
      >
        {tab.label}
      </button>
    {/each}
  </nav>

  <div class="drag" data-tauri-drag-region></div>

  <button type="button" class="search" onclick={() => (shell.paletteOpen = true)} aria-keyshortcuts="Control+K">
    <Search size={14} aria-hidden="true" />
    <span>Search commands</span>
    <Kbd keys="Ctrl+K" size="sm" />
  </button>
  <IconButton
    label="Close editor"
    icon={X}
    shortcut="Esc"
    placement="bottom"
    class="close"
    onclick={close}
  />
</header>

<style>
  .titlebar {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
    height: 40px;
    padding: 0 var(--space-2);
    border-bottom: 1px solid var(--divider);
    user-select: none;
  }

  .home {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    transition:
      background-color var(--fade-1) linear,
      transform var(--dur-1) var(--ease-standard);
  }
  .home:hover {
    background: var(--surface-hover);
  }
  .home:active {
    transform: scale(0.94);
  }
  .home:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }

  .title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    flex: 0 1 auto;
    max-width: 280px;
  }
  .brand {
    font-family: var(--font-display);
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
  }
  .crumb {
    color: var(--text-3);
    font-size: var(--text-md);
  }
  .crumb:not(:empty)::before {
    content: '/';
    margin-right: var(--space-2);
    color: var(--text-disabled);
  }
  .doc {
    overflow: hidden;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    height: 30px;
    padding: 0 var(--space-2) 0 var(--space-1-5);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    transition: background-color var(--fade-1) linear;
  }
  .item:hover,
  .item[aria-expanded='true'] {
    background: var(--surface-hover);
  }
  .item:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .item :global(svg) {
    flex: none;
    color: var(--text-3);
  }
  .thumb {
    width: 20px;
    height: 20px;
    flex: none;
    object-fit: contain;
    -webkit-user-drag: none;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    flex: none;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    background: var(--surface-selected);
    color: var(--accent-text);
    font-size: var(--text-2xs);
    font-weight: var(--weight-bold);
    font-variant-numeric: tabular-nums;
  }
  .loading {
    display: grid;
    color: var(--text-3);
  }

  .views {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: var(--space-2);
    padding: 3px;
    border-radius: var(--radius-full);
    background: var(--shell-well);
    box-shadow: inset 0 0 0 1px var(--border-subtle);
  }
  .tab {
    height: 26px;
    padding: 0 var(--space-3);
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    transition:
      background-color var(--fade-1) linear,
      color var(--fade-1) linear,
      box-shadow var(--fade-1) linear;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab[aria-current='page'] {
    background: var(--surface-3);
    color: var(--text);
    box-shadow:
      0 1px 2px rgb(0 0 0 / 0.25),
      inset 0 1px 0 rgb(255 255 255 / 0.06);
  }
  :global([data-theme='light']) .tab[aria-current='page'] {
    background: var(--surface-2);
    box-shadow:
      0 1px 2px rgb(16 18 24 / 0.12),
      0 0 0 1px rgb(0 0 0 / 0.04);
  }
  .tab:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }

  .drag {
    flex: 1;
    align-self: stretch;
    min-width: var(--space-4);
  }

  .search {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    height: 30px;
    padding: 0 var(--space-1-5) 0 var(--space-2-5, 10px);
    border: 1px solid var(--control-border);
    border-radius: var(--radius-md);
    background: var(--control-fill);
    color: var(--text-3);
    font-size: var(--text-sm);
    box-shadow: var(--inset-highlight);
    transition:
      background-color var(--fade-1) linear,
      color var(--fade-1) linear;
  }
  .search:hover {
    background: var(--control-fill-hover);
    color: var(--text-2);
  }
  .search:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .search span {
    min-width: 96px;
    text-align: left;
  }

  .titlebar :global(.close:hover) {
    background: rgb(var(--danger-rgb) / 0.16);
    color: var(--danger);
  }
</style>
