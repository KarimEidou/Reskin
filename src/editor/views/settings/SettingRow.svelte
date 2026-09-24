<!-- One settings row: label + description on the left, the control on the right. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    description?: string;
    /** id of the control the label names (for a real <label for>). */
    for?: string;
    /** Stack the control under the text (wide controls). */
    stacked?: boolean;
    children: Snippet;
  }

  let { label, description, for: htmlFor, stacked = false, children }: Props = $props();
</script>

<div class="row" class:stacked>
  <div class="text">
    {#if htmlFor}
      <label class="label" for={htmlFor}>{label}</label>
    {:else}
      <span class="label">{label}</span>
    {/if}
    {#if description}<span class="desc">{description}</span>{/if}
  </div>
  <div class="control">{@render children()}</div>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-6);
    min-height: 56px;
    padding: var(--space-3) var(--space-4);
  }
  .stacked {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-3);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .label {
    color: var(--text);
    font-size: var(--text-md);
  }
  .desc {
    max-width: 440px;
    color: var(--text-3);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }
  .control {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    flex: none;
  }
  .stacked .control {
    justify-content: flex-start;
  }
</style>
