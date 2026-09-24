<!--
  Labelled range slider on a native <input type="range"> (full keyboard
  support: arrows, PageUp/Down, Home/End), with the formatted value or,
  with `input`, a NumberField for exact entry.
-->
<script lang="ts">
  import NumberField from './NumberField.svelte';

  interface Props {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    label: string;
    hideLabel?: boolean;
    unit?: string;
    /** Value text (also announced as aria-valuetext). */
    format?: (value: number) => string;
    /** Show a number field for exact values. */
    input?: boolean;
    disabled?: boolean;
    /** Every change while dragging. */
    oninput?: (value: number) => void;
    /** Committed changes (release, keyboard, number field). */
    onchange?: (value: number) => void;
  }

  let {
    value = $bindable(0),
    min = 0,
    max = 100,
    step = 1,
    label,
    hideLabel = false,
    unit,
    format,
    input = false,
    disabled = false,
    oninput,
    onchange,
  }: Props = $props();

  const id = $props.id();
  const text = $derived(format ? format(value) : `${value}${unit ?? ''}`);
  const pct = $derived(max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0);
</script>

<div class="slider" class:disabled>
  <div class="head" class:sr-only={hideLabel}>
    <label for="{id}-range">{label}</label>
    {#if !input}<output for="{id}-range">{text}</output>{/if}
  </div>
  <div class="row">
    <input
      id="{id}-range"
      type="range"
      {min}
      {max}
      {step}
      {disabled}
      bind:value
      aria-valuetext={text}
      style:--pct="{pct}%"
      oninput={() => oninput?.(value)}
      onchange={() => onchange?.(value)}
    />
    {#if input}
      <NumberField bind:value {min} {max} {step} {label} hideLabel {unit} {disabled} {onchange} />
    {/if}
  </div>
</div>

<style>
  .slider {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
    min-width: 0;
  }
  .disabled {
    opacity: 0.5;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  output {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  input[type='range'] {
    --track-h: 4px;
    --thumb: 18px;
    flex: 1;
    min-width: 0;
    height: var(--thumb);
    margin: 0;
    background: transparent;
    appearance: none;
    cursor: default;
  }
  input[type='range']::-webkit-slider-runnable-track {
    height: var(--track-h);
    border-radius: var(--radius-full);
    background: linear-gradient(to right, var(--accent) var(--pct), var(--track) var(--pct));
  }
  input[type='range']::-webkit-slider-thumb {
    width: var(--thumb);
    height: var(--thumb);
    margin-top: calc((var(--track-h) - var(--thumb)) / 2);
    border: 1px solid var(--control-border);
    border-radius: 50%;
    background: radial-gradient(circle, var(--accent) 0 32%, var(--surface-3) 36%);
    box-shadow: var(--shadow-1);
    appearance: none;
    transition: background var(--fade-1) linear;
  }
  input[type='range']:hover::-webkit-slider-thumb {
    background: radial-gradient(circle, var(--accent-hover) 0 40%, var(--surface-3) 44%);
  }
  input[type='range']:active::-webkit-slider-thumb {
    background: radial-gradient(circle, var(--accent-pressed) 0 28%, var(--surface-3) 32%);
  }
  input[type='range']:focus-visible {
    outline: none;
  }
  input[type='range']:focus-visible::-webkit-slider-thumb {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
