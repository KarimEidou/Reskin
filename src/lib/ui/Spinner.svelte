<!-- Small indeterminate spinner. With a label it is announced as a status. -->
<script lang="ts">
  interface Props {
    /** Diameter in px. */
    size?: number;
    /** Accessible text; empty = decorative. */
    label?: string;
  }

  let { size = 16, label = 'Loading' }: Props = $props();
  const stroke = $derived(Math.max(1.5, size / 9));
  const r = $derived((size - stroke) / 2);
</script>

<span class="spinner" role={label ? 'status' : undefined} aria-hidden={label ? undefined : 'true'}>
  <svg width={size} height={size} viewBox="0 0 {size} {size}" aria-hidden="true">
    <circle class="track" cx={size / 2} cy={size / 2} {r} stroke-width={stroke} />
    <circle
      class="arc"
      cx={size / 2}
      cy={size / 2}
      {r}
      stroke-width={stroke}
      pathLength="100"
      stroke-dasharray="28 72"
    />
  </svg>
  {#if label}<span class="sr-only">{label}</span>{/if}
</span>

<style>
  .spinner {
    display: inline-flex;
    flex: none;
  }
  svg {
    display: block;
    fill: none;
    animation: spin calc(800ms * var(--motion-fade-k)) linear infinite;
  }
  .track {
    stroke: currentColor;
    opacity: 0.18;
  }
  .arc {
    stroke: currentColor;
    stroke-linecap: round;
  }
  :global([data-motion='reduced']) svg {
    animation-duration: 2.4s;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
