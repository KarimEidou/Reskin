<!--
  Shows the current view: the Edit workspace (another package's
  <Workspace />), Start, or a lazily loaded page. `data-view-host` marks the
  element the morph staggers and aims the icon at; it also takes focus
  that a view change takes away. It is the page's main landmark, named
  after the view, so a screen reader landing on it says which view it is.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import { stage } from '../workspace/stage.svelte';
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

  /** What the view is called (the title bar's names). */
  const NAMES: Record<Shown, string> = {
    edit: 'Edit',
    loading: 'Edit',
    start: 'Start',
    library: 'Library',
    history: 'History',
    settings: 'Settings',
    systemIcons: 'System icons',
    welcome: 'Welcome',
  };

  $effect(() => {
    if (isLazyView(shown)) void loadView(shown);
  });

  // Release focus before the old view is torn down: a focused element that
  // disappears fires focusout mid-update, where a field committing its
  // draft on blur would write state. Once the new view is in, focus goes to
  // the host (unless the view took it): left on the page, it would count as
  // the canvas in the Edit view, where Delete clears the layer.
  let host: HTMLDivElement | undefined = $state();
  $effect.pre(() => {
    void shown;
    untrack(() => {
      const active = document.activeElement;
      if (!host || active === host || !(active instanceof HTMLElement) || !host.contains(active)) return;
      active.blur();
      void tick().then(() => {
        if (host && (document.activeElement === document.body || document.activeElement === null)) host.focus({ preventScroll: true });
      });
    });
  });

  /** What a mouse press focuses: the nearest element that takes focus from a click. */
  const CLICK_FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';

  /**
   * A press on empty space of the Edit view — the bars around the canvas,
   * where nothing takes focus, so the host would — is for the canvas, as it
   * was before the host took focus: its keys (arrows, Enter, Delete) keep
   * going to it. The host's own focus (after a view change) stays the
   * keyboard's: Delete there clears nothing.
   */
  function pressesToCanvas(node: HTMLElement) {
    const onPress = (e: MouseEvent) => {
      if (shown !== 'edit' || e.button !== 0 || !(e.target instanceof Element)) return;
      if (e.target.closest(CLICK_FOCUSABLE) !== node) return;
      e.preventDefault();
      stage.focusCanvas({ pointer: true });
    };
    node.addEventListener('mousedown', onPress);
    return () => node.removeEventListener('mousedown', onPress);
  }
</script>

<div
  class="view-host"
  role="main"
  aria-label={NAMES[shown]}
  data-view-host
  data-view={shown}
  tabindex="-1"
  bind:this={host}
  {@attach pressesToCanvas}
>
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
  .view-host:focus {
    outline: none;
  }
  .view-host:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: calc(-1 * var(--focus-width));
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
