<!--
  Compact labelled slider for the options bar: a pill that fills with the
  value, its label on the left and the value on the right. The control is a
  real <input type="range"> (keyboard, screen readers), optionally on a log
  scale; double-click or Enter types an exact value.
-->
<script lang="ts">
  import {
    formatOption,
    fromDisplay,
    fromSliderPos,
    keyStep,
    sliderRange,
    toDisplay,
    toSliderPos,
    type SliderSpec,
  } from './options-schema';

  interface Props {
    spec: SliderSpec;
    value: number;
    /** CSS width of the pill. */
    width?: string;
    disabled?: boolean;
    onchange: (value: number) => void;
  }

  let { spec, value, width = '132px', disabled = false, onchange }: Props = $props();

  const id = $props.id();
  const range = $derived(sliderRange(spec));
  const pos = $derived(toSliderPos(spec, value));
  const pct = $derived(range.max > range.min ? ((pos - range.min) / (range.max - range.min)) * 100 : 0);
  const text = $derived(formatOption(spec, value));

  let editing = $state(false);
  let draft = $state('');
  let rangeEl: HTMLInputElement | undefined = $state();

  function startEdit(): void {
    if (disabled) return;
    draft = String(Math.round(toDisplay(spec, value) * 100) / 100);
    editing = true;
  }

  function finishEdit(commit: boolean): void {
    if (!editing) return;
    editing = false;
    if (commit) {
      const n = Number(draft.replace(',', '.').replace(/[^\d.-]/g, ''));
      if (draft.trim() !== '' && Number.isFinite(n)) {
        const next = fromDisplay(spec, n);
        if (next !== value) onchange(next);
      }
    }
    queueMicrotask(() => rangeEl?.focus({ preventScroll: true }));
  }

  function focusEntry(node: HTMLInputElement) {
    queueMicrotask(() => {
      node.focus();
      node.select();
    });
  }

  /**
   * Keys step the VALUE (not the slider travel), so every press changes it
   * even on log scales: arrows ±1 step, Shift or Page keys ±10, Home/End.
   */
  function onRangeKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      startEdit();
      return;
    }
    const next = keyStep(spec, value, e.key, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    if (next !== value) onchange(next);
  }

  function onEntryKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishEdit(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finishEdit(false);
    }
  }
</script>

<div class="pill" class:disabled class:editing style:width style:--pct="{pct}%" data-option={spec.key}>
  <span class="fill" aria-hidden="true"></span>
  <label class="label" for="{id}-range">{spec.label}</label>
  {#if editing}
    <input
      class="entry"
      type="text"
      inputmode="decimal"
      aria-label="{spec.label}{spec.unit ? ` (${spec.unit})` : ''}"
      bind:value={draft}
      onkeydown={onEntryKey}
      onblur={() => finishEdit(true)}
      {@attach focusEntry}
    />
  {:else}
    <span class="value" aria-hidden="true">{text}</span>
  {/if}
  <input
    bind:this={rangeEl}
    id="{id}-range"
    class="range"
    type="range"
    min={range.min}
    max={range.max}
    step={range.step}
    value={pos}
    {disabled}
    tabindex={editing ? -1 : 0}
    aria-valuetext={text}
    title="{spec.label}: {text} — double-click to type"
    oninput={(e) => onchange(fromSliderPos(spec, Number(e.currentTarget.value)))}
    ondblclick={startEdit}
    onkeydown={onRangeKey}
  />
</div>

<style>
  .pill {
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    height: var(--control-sm);
    padding: 0 10px;
    overflow: hidden;
    border: 1px solid var(--control-border);
    border-radius: var(--radius-full);
    background: var(--surface-sunken);
    font-size: var(--text-sm);
    isolation: isolate;
    transition: border-color var(--fade-1) linear;
  }
  .pill:hover:not(.disabled) {
    border-color: var(--border-strong);
  }
  .pill:has(.range:focus-visible),
  .pill.editing {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .disabled {
    opacity: 0.45;
  }

  .fill {
    position: absolute;
    z-index: -1;
    inset: 0 auto 0 0;
    width: var(--pct);
    background: linear-gradient(to right, rgb(var(--accent-rgb) / 0.16), rgb(var(--accent-rgb) / 0.3));
    /* A soft leading edge: it passes behind the label / value text. */
    box-shadow: inset -1px 0 0 rgb(var(--accent-rgb) / 0.55);
  }
  .pill:hover:not(.disabled) .fill {
    background: linear-gradient(to right, rgb(var(--accent-rgb) / 0.2), rgb(var(--accent-rgb) / 0.36));
  }

  .label {
    overflow: hidden;
    color: var(--text-2);
    white-space: nowrap;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .value {
    flex: none;
    color: var(--text);
    font-weight: var(--weight-medium);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  .range {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: ew-resize;
    appearance: none;
  }
  .range:disabled {
    cursor: default;
  }
  /* A hairline thumb: the value under the pointer is exactly where the
     fill ends (a default 16 px thumb insets the track by 8 px each side). */
  .range::-webkit-slider-thumb {
    width: 1px;
    height: var(--control-sm);
    appearance: none;
  }
  .range::-moz-range-thumb {
    width: 1px;
    height: var(--control-sm);
    border: 0;
  }

  .entry {
    position: relative;
    z-index: 1;
    width: 56px;
    height: 20px;
    padding: 0 6px;
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    color: var(--text);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    text-align: right;
    outline: none;
  }
</style>
