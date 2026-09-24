<!--
  A colour chip (#rrggbb or #rrggbbaa; transparency shows over a checker).
  With `onclick` it is a button (pressed = selected), otherwise an image.
-->
<script lang="ts">
  interface Props {
    color: string;
    /** Accessible name (defaults to the hex value). */
    label?: string;
    selected?: boolean;
    size?: 'sm' | 'md' | 'lg';
    /** Round instead of rounded-square. */
    round?: boolean;
    onclick?: (color: string) => void;
  }

  let { color, label, selected = false, size = 'md', round = false, onclick }: Props = $props();
  const name = $derived(label ?? color);
</script>

{#if onclick}
  <button
    type="button"
    class="swatch size-{size}"
    class:round
    aria-label={name}
    aria-pressed={selected}
    title={name}
    onclick={() => onclick(color)}
  >
    <span class="chip" style:--c={color}></span>
  </button>
{:else}
  <span class="swatch size-{size}" class:round role="img" aria-label={name}>
    <span class="chip" style:--c={color}></span>
  </span>
{/if}

<style>
  .swatch {
    --s: 24px;
    position: relative;
    display: inline-grid;
    flex: none;
    width: var(--s);
    height: var(--s);
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--checker);
    cursor: default;
  }
  .size-sm {
    --s: 18px;
    border-radius: var(--radius-xs);
  }
  .size-lg {
    --s: 32px;
    border-radius: var(--radius-md);
  }
  .round {
    border-radius: 50%;
  }
  .chip {
    border-radius: inherit;
    background: var(--c);
    box-shadow: inset 0 0 0 1px rgb(var(--text-rgb) / 0.14);
  }
  button.swatch {
    transition: transform var(--dur-1) var(--ease-standard);
  }
  button.swatch:hover {
    transform: scale(1.08);
  }
  button.swatch:active {
    transform: scale(0.96);
  }
  button.swatch:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }
  button.swatch[aria-pressed='true'] {
    box-shadow:
      0 0 0 2px var(--surface-1),
      0 0 0 4px var(--accent);
  }
</style>
