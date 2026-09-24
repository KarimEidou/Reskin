<!-- Common frame of the non-canvas views: a scrolling page with a title row. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    subtitle?: string;
    /** Buttons on the right of the title row. */
    actions?: Snippet;
    children: Snippet;
    /** data-testid of the view root. */
    testid?: string;
    /** Narrow, centred column (settings-like pages). */
    narrow?: boolean;
  }

  let { title, subtitle, actions, children, testid, narrow = false }: Props = $props();
  const id = $props.id();
</script>

<section class="view" class:narrow aria-labelledby="{id}-title" data-testid={testid}>
  <div class="inner">
    <header class="head" data-stagger>
      <div class="text">
        <h1 id="{id}-title">{title}</h1>
        {#if subtitle}<p>{subtitle}</p>{/if}
      </div>
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </header>
    {@render children()}
  </div>
</section>

<style>
  .view {
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }
  .inner {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    max-width: 1040px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-8) var(--space-8);
  }
  .narrow .inner {
    max-width: 880px;
  }
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
  }
  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
    letter-spacing: var(--tracking-tight);
  }
  p {
    margin: var(--space-1) 0 0;
    color: var(--text-2);
    font-size: var(--text-md);
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    flex: none;
  }
</style>
