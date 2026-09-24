<!-- Circular progress (role="progressbar"). `value` 0..1, or null for indeterminate. -->
<script lang="ts">
  interface Props {
    value?: number | null;
    /** Diameter in px. */
    size?: number;
    /** Stroke width in px. */
    stroke?: number;
    label?: string;
  }

  let { value = null, size = 20, stroke = 2.5, label = 'Progress' }: Props = $props();

  const r = $derived((size - stroke) / 2);
  const pct = $derived(value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100));
</script>

<span
  class="ring"
  class:indeterminate={pct === null}
  role="progressbar"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={pct ?? undefined}
>
  <svg width={size} height={size} viewBox="0 0 {size} {size}" aria-hidden="true">
    <circle class="track" cx={size / 2} cy={size / 2} {r} stroke-width={stroke} />
    <circle
      class="bar"
      cx={size / 2}
      cy={size / 2}
      {r}
      stroke-width={stroke}
      pathLength="100"
      stroke-dasharray={pct === null ? '25 75' : `${pct} ${100 - pct}`}
    />
  </svg>
</span>

<style>
  .ring {
    display: inline-flex;
    flex: none;
  }
  svg {
    display: block;
    fill: none;
    transform: rotate(-90deg);
  }
  .track {
    stroke: var(--track);
  }
  .bar {
    stroke: var(--accent);
    stroke-linecap: round;
    transition: stroke-dasharray var(--dur-3) var(--ease-standard);
  }
  .indeterminate svg {
    animation: spin calc(900ms * var(--motion-fade-k)) linear infinite;
  }
  @keyframes spin {
    from {
      transform: rotate(-90deg);
    }
    to {
      transform: rotate(270deg);
    }
  }
</style>
