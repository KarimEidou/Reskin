<!--
  Shows the current view: the Edit workspace (another package's
  <Workspace />), Start, or a lazily loaded page. `data-view-host` marks the
  element the morph staggers and aims the icon at.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import Workspace from '../workspace/Workspace.svelte';
  import { getShell } from '../chrome/shell.svelte';
  import { getSession } from '../state/context';
  import StartView from './StartView.svelte';
  import { isLazyView, loadedView, loadView, type LazyView } from './lazy.svelte';

  const session = getSession();
  const shell = getShell();

  type Shown = 'edit' | 'loading' | 'start' | LazyView;

  const shown: Shown = $derived.by(() => {
    const v = session.view === 'about' ? 'settings' : session.view;
    if (v === 'edit') return session.hasDesign ? 'edit' : shell.loading > 0 ? 'loading' : 'start';
    if (v === 'start') return 'start';
    return isLazyView(v) ? v : 'start';
  });

  const Lazy = $derived(isLazyView(shown) ? loadedView(shown) : null);

  $effect(() => {
    if (isLazyView(shown)) void loadView(shown);
  });

  // Release focus before the old view is torn down: a focused element that
  // disappears fires focusout mid-update (Tooltip writes state there).
  let host: HTMLDivElement | undefined = $state();
  $effect.pre(() => {
    void shown;
    untrack(() => {
      const active = document.activeElement;
      if (host && active instanceof HTMLElement && host.contains(active)) active.blur();
    });
  });
</script>

<div class="view-host" data-view-host data-view={shown} bind:this={host}>
  {#if shown === 'edit'}
    <Workspace />
  {:else if shown === 'start'}
    <StartView />
  {:else if shown === 'loading'}
    <div class="pending" role="status">
      <Spinner size={22} label="" />
      <span>Loading the icon…</span>
    </div>
  {:else if Lazy}
    <Lazy />
  {:else}
    <div class="pending" role="status"><Spinner size={22} label="Loading" /></div>
  {/if}
  {#if shell.dragging && shown !== 'start'}
    <!-- Files dragged over the editor (Start has its own drop target). -->
    <div class="veil" aria-hidden="true">
      <span>{session.hasDesign ? 'Drop to add to your design or queue' : 'Drop to start editing'}</span>
    </div>
  {/if}
</div>

<style>
  .view-host {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .veil {
    position: absolute;
    z-index: var(--z-raised);
    inset: var(--space-3);
    display: grid;
    place-items: center;
    border: 2px dashed var(--accent);
    border-radius: var(--radius-lg);
    background: rgb(var(--accent-rgb) / 0.1);
    pointer-events: none;
    animation: veil-in var(--fade-2) linear both;
  }
  .veil span {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-full);
    background: var(--surface-overlay);
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    box-shadow: var(--shadow-3);
  }
  @keyframes veil-in {
    from {
      opacity: 0;
    }
  }
  .pending {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    flex: 1;
    color: var(--text-3);
    font-size: var(--text-md);
  }
</style>
