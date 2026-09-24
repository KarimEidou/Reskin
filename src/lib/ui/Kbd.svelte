<!-- A key or key combination: <Kbd keys="Ctrl+K" /> or <Kbd keys={['Ctrl', 'Shift', 'P']} />. -->
<script lang="ts">
  interface Props {
    /** "Ctrl+Shift+K" (split on "+") or explicit key names. */
    keys: string | readonly string[];
    size?: 'sm' | 'md';
  }

  let { keys, size = 'md' }: Props = $props();
  const parts = $derived(
    typeof keys === 'string'
      ? keys
          .split('+')
          .map((k) => k.trim())
          .filter(Boolean)
      : keys,
  );
</script>

<kbd class="combo size-{size}">
  {#each parts as key, i (i)}
    {#if i > 0}<span class="plus" aria-hidden="true">+</span>{/if}<kbd class="key">{key}</kbd>
  {/each}
</kbd>

<style>
  .combo {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-family: var(--font-ui);
    white-space: nowrap;
  }
  .key {
    display: inline-grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    color: var(--text-2);
    font-family: inherit;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    line-height: 1;
  }
  .size-sm .key {
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    font-size: var(--text-2xs);
  }
  .plus {
    color: var(--text-3);
    font-size: var(--text-2xs);
  }
</style>
