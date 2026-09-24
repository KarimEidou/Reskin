<!--
  Exact number entry for the "More options" popover (role="spinbutton"):
  typing edits a draft that is parsed, clamped and snapped on Enter or
  blur; ↑/↓ step (Shift ×10), PageUp/PageDown ×10, Home/End jump to the
  ends, Escape reverts. It stands in for $lib/ui NumberField, whose value
  text drops the trailing zeros of whole numbers (80 → "8", 100 → "1").
-->
<script lang="ts">
  import { formatNumber, stepDecimals } from './options-schema';

  interface Props {
    value: number;
    min: number;
    max: number;
    step?: number;
    /** Accessible name (the popover shows the visible label). */
    label: string;
    /** Suffix inside the field, e.g. "px" or "%". */
    unit?: string;
    onchange: (value: number) => void;
  }

  let { value, min, max, step = 1, label, unit, onchange }: Props = $props();

  let editing = $state(false);
  let draft = $state('');

  const decimals = $derived(stepDecimals(step));
  const shown = $derived(editing ? draft : formatNumber(value, step));

  function normalise(v: number): number {
    const snapped = step > 0 ? min + Math.round((v - min) / step) * step : v;
    return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals));
  }

  function commit(next: number): void {
    const v = normalise(next);
    editing = false;
    if (v !== value) onchange(v);
  }

  function commitDraft(): void {
    if (!editing) return;
    const parsed = Number(draft.replace(',', '.').trim());
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      editing = false;
      return;
    }
    commit(parsed);
  }

  function onKeyDown(e: KeyboardEvent): void {
    const big = step * 10;
    const current = editing && Number.isFinite(Number(draft)) ? Number(draft) : value;
    switch (e.key) {
      case 'ArrowUp':
        commit(current + (e.shiftKey ? big : step));
        break;
      case 'ArrowDown':
        commit(current - (e.shiftKey ? big : step));
        break;
      case 'PageUp':
        commit(current + big);
        break;
      case 'PageDown':
        commit(current - big);
        break;
      case 'Home':
        commit(min);
        break;
      case 'End':
        commit(max);
        break;
      case 'Enter':
        commitDraft();
        break;
      case 'Escape':
        if (!editing) return;
        editing = false;
        break;
      default:
        return;
    }
    e.preventDefault();
  }
</script>

<div class="box">
  <input
    type="text"
    inputmode="decimal"
    role="spinbutton"
    autocomplete="off"
    spellcheck="false"
    aria-label={label}
    aria-valuenow={value}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuetext="{formatNumber(value, step)}{unit ? ` ${unit}` : ''}"
    value={shown}
    oninput={(e) => {
      editing = true;
      draft = e.currentTarget.value;
    }}
    onblur={commitDraft}
    onkeydown={onKeyDown}
  />
  {#if unit}<span class="unit" aria-hidden="true">{unit}</span>{/if}
</div>

<style>
  .box {
    display: flex;
    flex: none;
    align-items: center;
    width: 72px;
    height: var(--control-sm);
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    transition: border-color var(--fade-1) linear;
  }
  .box:hover {
    border-color: var(--border-strong);
  }
  .box:focus-within {
    border-color: var(--accent);
    box-shadow: inset 0 -1px 0 var(--accent);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0 var(--space-2);
    border: 0;
    background: transparent;
    color: var(--text);
    font-size: var(--text-md);
    font-variant-numeric: tabular-nums;
    outline: none;
  }
  .unit {
    padding-right: var(--space-2);
    color: var(--text-3);
    font-size: var(--text-sm);
  }
</style>
