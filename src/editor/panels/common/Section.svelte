<!--
  A collapsible panel section: a small uppercase heading (a disclosure
  button) with optional trailing actions, and its content.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  interface Props {
    title: string;
    open?: boolean;
    /** Without a toggle the section is always open. */
    collapsible?: boolean;
    actions?: Snippet;
    children: Snippet;
    testid?: string;
  }

  let { title, open = $bindable(true), collapsible = true, actions, children, testid }: Props = $props();
  const id = $props.id();
</script>

<section class="section" data-testid={testid}>
  <header>
    {#if collapsible}
      <button type="button" class="toggle" aria-expanded={open} aria-controls="{id}-body" onclick={() => (open = !open)}>
        <span class="chev" class:open aria-hidden="true"><ChevronRight size={14} /></span>
        <h3>{title}</h3>
      </button>
    {:else}
      <h3 class="static">{title}</h3>
    {/if}
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </header>
  {#if open || !collapsible}
    <div class="body" id="{id}-body">{@render children()}</div>
  {/if}
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-3) var(--space-3);
    border-bottom: 1px solid var(--divider);
  }
  .section:last-child {
    border-bottom: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 24px;
  }
  .toggle {
    display: inline-flex;
    flex: 1;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
    margin: 0 0 0 calc(-1 * var(--space-1));
    padding: 2px var(--space-1);
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--text-2);
    text-align: left;
    cursor: default;
  }
  .toggle:hover {
    color: var(--text);
  }
  .toggle:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 0;
  }
  .chev {
    display: inline-flex;
    transition: transform var(--dur-2) var(--ease-standard);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  h3 {
    margin: 0;
    overflow: hidden;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-caps);
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .static {
    flex: 1;
    color: var(--text-2);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-0-5);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
</style>
