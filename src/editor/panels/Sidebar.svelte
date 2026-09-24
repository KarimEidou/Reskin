<!--
  The editor sidebar: tabbed panels (Layers, Color, Adjust, Effects,
  Styles, Backdrop, Stickers, History) bound to session.sidebarTab, and the
  always-visible Previews block pinned at the bottom.

  In 300 px only the active tab shows its label; the others are icons (the
  label stays their accessible name and tooltip). Panels other than Layers
  are loaded on first use and prefetched when the editor is idle; each tab
  remembers its scroll position.
-->
<script lang="ts">
  import { onMount, tick, type Component } from 'svelte';
  import Tabs from '$lib/ui/Tabs.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import { getSession } from '../state/context';
  import type { SidebarTab } from '../state/session.svelte';
  import { whenIdle } from './common/schedule';
  import LayersPanel from './layers/LayersPanel.svelte';
  import PreviewsPanel from './previews/PreviewsPanel.svelte';
  import { PANEL_LOADERS, SIDEBAR_TABS, type LazyTab } from './tabs';

  const session = getSession();

  let panels = $state<Partial<Record<SidebarTab, Component>>>({ layers: LayersPanel });
  let failed = $state<Partial<Record<SidebarTab, string>>>({});
  const loading = new Map<SidebarTab, Promise<void>>();

  function load(id: SidebarTab): Promise<void> {
    if (panels[id] || id === 'layers') return Promise.resolve();
    let p = loading.get(id);
    if (!p) {
      p = PANEL_LOADERS[id as LazyTab]()
        .then((m) => {
          panels[id] = m.default;
          delete failed[id];
        })
        .catch((e: unknown) => {
          loading.delete(id);
          failed[id] = e instanceof Error ? e.message : String(e);
        });
      loading.set(id, p);
    }
    return p;
  }

  $effect(() => {
    void load(session.sidebarTab);
  });

  onMount(() => {
    // Warm the other panels once the editor has settled.
    const ids = SIDEBAR_TABS.map((t) => t.id).filter((id) => id !== 'layers');
    let cancel = () => {};
    const next = (i: number) => {
      if (i >= ids.length) return;
      cancel = whenIdle(() => void load(ids[i]!).then(() => next(i + 1)), 2000);
    };
    next(0);
    return () => cancel();
  });

  // ---- scroll position per tab ----------------------------------------------------
  let scroller: HTMLDivElement | undefined = $state();
  const scrollTops = new Map<SidebarTab, number>();
  let shownTab: SidebarTab = session.sidebarTab;

  function onTabChange(next: string): void {
    if (scroller) scrollTops.set(shownTab, scroller.scrollTop);
    shownTab = next as SidebarTab;
    void tick().then(() => {
      if (scroller) scroller.scrollTop = scrollTops.get(shownTab) ?? 0;
    });
  }

  // Icon-only tabs still get a tooltip: their label.
  let tabsHost: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!tabsHost) return;
    tabsHost.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((el, i) => {
      el.title = SIDEBAR_TABS[i]?.label ?? '';
      el.dataset.tab = SIDEBAR_TABS[i]?.id ?? '';
    });
  });

  const Current = $derived(panels[session.sidebarTab]);
</script>

<aside class="sidebar" data-testid="sidebar" aria-label="Design panels">
  <div class="tabs-host" bind:this={tabsHost}>
    <Tabs tabs={SIDEBAR_TABS} bind:value={session.sidebarTab} label="Panels" size="sm" onchange={onTabChange}>
      {#snippet children(id)}
        <div class="scroll" bind:this={scroller} data-testid="panel-{id}">
          {#if Current}
            <Current />
          {:else if failed[session.sidebarTab]}
            <p class="note" role="alert">This panel could not be loaded ({failed[session.sidebarTab]}).</p>
          {:else}
            <div class="loading"><Spinner size={18} label="Loading panel" /></div>
          {/if}
        </div>
      {/snippet}
    </Tabs>
  </div>
  <PreviewsPanel />
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    width: 300px;
    min-width: 300px;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    border-left: 1px solid var(--divider);
    background: var(--surface-1);
    color: var(--text);
    font-size: var(--text-md);
  }
  .tabs-host {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .tabs-host > :global(.tabs) {
    flex: 1;
    min-height: 0;
  }
  /* Compact tab strip: the active tab shows its label, the others their icon. */
  .tabs-host :global([role='tablist']) {
    justify-content: space-between;
    gap: 0;
    padding: var(--space-1) var(--space-1-5) 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs-host :global([role='tab']) {
    flex: none;
    justify-content: center;
    min-width: 28px;
    padding: 0 6px;
  }
  .tabs-host :global([role='tab'][aria-selected='true']) {
    padding: 0 8px;
  }
  .tabs-host :global([role='tab'][aria-selected='false'] > span:not(.badge)) {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .tabs-host :global([role='tab'][aria-selected='true'] > span:not(.badge)) {
    animation: label-in var(--fade-2) var(--ease-decelerate);
  }
  @keyframes label-in {
    from {
      opacity: 0;
    }
  }
  .tabs-host :global([role='tabpanel']) {
    display: flex;
    flex-direction: column;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
  }
  .loading {
    display: grid;
    place-items: center;
    height: 120px;
    color: var(--text-3);
  }
  .note {
    margin: var(--space-4);
    color: var(--text-2);
    font-size: var(--text-sm);
  }
</style>
