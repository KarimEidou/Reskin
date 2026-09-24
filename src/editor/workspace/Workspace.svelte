<!--
  The Edit view (docs/UI.md "Editor layout"): tool rail (left), tool
  options bar (top), canvas stage (centre), sidebar (right, 300 px) and the
  bottom bar. It fills its container and takes no props; everything comes
  from getSession(). Each region carries `data-panel` (rail, options,
  stage, sidebar, bottom) so the open morph can stagger them in.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Sidebar from '../panels/Sidebar.svelte';
  import { getSession } from '../state/context';
  import BottomBar from './BottomBar.svelte';
  import CanvasStage from './CanvasStage.svelte';
  import ToolOptions from './ToolOptions.svelte';
  import ToolRail from './ToolRail.svelte';
  import { preloadWhenIdle } from './lazy.svelte';

  const session = getSession();

  // The lazy pieces load once the editor is open (not while it morphs open).
  onMount(() => {
    let cancel: (() => void) | null = null;
    let mounted = true;
    void session.whenInteractive().then(() => {
      if (mounted) cancel = preloadWhenIdle();
    });
    return () => {
      mounted = false;
      cancel?.();
    };
  });
</script>

<div class="workspace" data-testid="workspace">
  <div class="rail" data-panel="rail">
    <ToolRail />
  </div>
  <div class="options" data-panel="options">
    <ToolOptions />
  </div>
  <section class="stage" data-panel="stage" aria-label="Canvas">
    <CanvasStage />
  </section>
  <div class="sidebar" data-panel="sidebar">
    <Sidebar />
  </div>
  <div class="bottom" data-panel="bottom">
    <BottomBar />
  </div>
</div>

<style>
  .workspace {
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr) 300px;
    grid-template-rows: 40px minmax(0, 1fr) 52px;
    grid-template-areas:
      'rail options sidebar'
      'rail stage sidebar'
      'bottom bottom bottom';
    flex: 1;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    /* Never scrollable (focus or a caret near an edge must not shift it). */
    overflow: clip;
  }

  .rail {
    grid-area: rail;
    min-height: 0;
  }
  .options {
    grid-area: options;
    min-width: 0;
  }
  .stage {
    grid-area: stage;
    min-width: 0;
    min-height: 0;
    padding: 0 8px 10px 0;
  }
  .sidebar {
    grid-area: sidebar;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: clip;
  }
  .sidebar > :global(*) {
    flex: 1;
    min-height: 0;
  }
  .bottom {
    grid-area: bottom;
    min-width: 0;
    border-top: 1px solid var(--divider);
  }

  /* Open popover triggers in the workspace read as active. */
  .workspace :global(.icon-btn[aria-expanded='true']) {
    background: var(--surface-selected);
    color: var(--accent-text);
  }
</style>
