<!--
  Numeric input (role="spinbutton") for the panels — the shared
  NumberField's behaviour, with integer formatting that keeps trailing
  zeros (its formatter shows 100 as "1"; see the report). Typing edits a draft that is parsed,
  clamped and snapped to `step` on Enter or blur; ↑/↓ step (Shift ×10),
  PageUp/PageDown step ×10, Home/End jump to min/max, Escape reverts.
-->
<script lang="ts">
  interface Props {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    label: string;
    hideLabel?: boolean;
    /** Suffix shown inside the field, e.g. "px" or "%". */
    unit?: string;
    disabled?: boolean;
    /** Field width in CSS (default fits ~5 digits). */
    width?: string;
    onchange?: (value: number) => void;
  }

  let {
    value = $bindable(0),
    min = -Infinity,
    max = Infinity,
    step = 1,
    label,
    hideLabel = false,
    unit,
    disabled = false,
    width = '72px',
    onchange,
  }: Props = $props();

  const id = $props.id();
  let editing = $state(false);
  let draft = $state('');

  const decimals = $derived(Math.max(0, (String(step).split('.')[1] ?? '').length));
  const format = (v: number) => {
    if (!Number.isFinite(v)) return '';
    const s = v.toFixed(decimals);
    return decimals > 0 ? s.replace(/\.?0+$/, '') : s;
  };
  const shown = $derived(editing ? draft : format(value));

  function normalise(v: number): number {
    const base = Number.isFinite(min) ? min : 0;
    const snapped = step > 0 ? base + Math.round((v - base) / step) * step : v;
    return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals));
  }

  function commit(next: number): void {
    const v = normalise(next);
    editing = false;
    if (v === value) return;
    value = v;
    onchange?.(v);
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
        if (!Number.isFinite(min)) return;
        commit(min);
        break;
      case 'End':
        if (!Number.isFinite(max)) return;
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

<div class="field" class:disabled>
  <label for="{id}-input" class:sr-only={hideLabel}>{label}</label>
  <div class="box" style:width>
    <input
      id="{id}-input"
      type="text"
      inputmode="decimal"
      role="spinbutton"
      autocomplete="off"
      spellcheck="false"
      aria-valuenow={value}
      aria-valuemin={Number.isFinite(min) ? min : undefined}
      aria-valuemax={Number.isFinite(max) ? max : undefined}
      value={shown}
      {disabled}
      oninput={(e) => {
        editing = true;
        draft = e.currentTarget.value;
      }}
      onblur={commitDraft}
      onkeydown={onKeyDown}
    />
    {#if unit}<span class="unit" aria-hidden="true">{unit}</span>{/if}
  </div>
</div>

<style>
  .field {
    display: inline-flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .disabled {
    opacity: 0.5;
  }
  label {
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  .box {
    position: relative;
    display: flex;
    align-items: center;
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
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
