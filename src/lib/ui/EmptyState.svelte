<!-- Placeholder for empty lists and views: icon, title, description, actions. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { IconComponent } from './types';

  interface Props {
    icon?: IconComponent;
    title: string;
    description?: string;
    /** Heading level of the title (default 3). */
    level?: 2 | 3 | 4;
    compact?: boolean;
    /** Actions (buttons) under the text. */
    children?: Snippet;
  }

  let { icon: Icon, title, description, level = 3, compact = false, children }: Props = $props();
</script>

<div class="empty" class:compact>
  {#if Icon}
    <span class="badge" aria-hidden="true"><Icon size={compact ? 20 : 26} strokeWidth={1.75} /></span>
  {/if}
  <svelte:element this={`h${level}`} class="title">{title}</svelte:element>
  {#if description}<p class="desc">{description}</p>{/if}
  {#if children}<div class="actions">{@render children()}</div>{/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-10) var(--space-6);
    color: var(--text-2);
    text-align: center;
  }
  .compact {
    padding: var(--space-6) var(--space-4);
  }
  .badge {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    margin-bottom: var(--space-2);
    border-radius: var(--radius-xl);
    background: linear-gradient(160deg, var(--accent-soft-strong), var(--accent-soft));
    color: var(--accent-text);
    box-shadow: var(--inset-highlight);
  }
  .compact .badge {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-lg);
  }
  .title {
    margin: 0;
    color: var(--text);
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }
  .compact .title {
    font-size: var(--text-base);
  }
  .desc {
    max-width: 360px;
    margin: 0;
    font-size: var(--text-md);
    line-height: var(--leading-relaxed);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }
</style>
