<!--
  Hex colour entry. Accepts anything `parseColor` understands (hex with or
  without #, rgb(), hsl(), names); commits on Enter or blur, Escape reverts.
-->
<script lang="ts">
  import { parseColor, type Rgba } from '$engine/index';
  import { hexOf } from '../common/color';

  interface Props {
    value: Rgba;
    label?: string;
    hideLabel?: boolean;
    alpha?: boolean;
    onchange: (c: Rgba) => void;
  }

  let { value, label = 'Hex', hideLabel = false, alpha = true, onchange }: Props = $props();
  const id = $props.id();
  let draft = $state<string | null>(null);
  let invalid = $state(false);

  const shown = $derived(draft ?? hexOf(alpha ? value : { ...value, a: 1 }).toUpperCase());

  function commit(): void {
    if (draft === null) return;
    const c = parseColor(draft);
    if (!c) {
      invalid = true;
      return;
    }
    invalid = false;
    draft = null;
    onchange(alpha ? c : { ...c, a: 1 });
  }
</script>

<div class="hex" class:invalid>
  <label for="{id}-hex" class:sr-only={hideLabel}>{label}</label>
  <input
    id="{id}-hex"
    type="text"
    spellcheck="false"
    autocomplete="off"
    aria-invalid={invalid}
    value={shown}
    oninput={(e) => {
      draft = e.currentTarget.value;
      invalid = false;
    }}
    onblur={commit}
    onkeydown={(e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape' && draft !== null) {
        e.preventDefault();
        e.stopPropagation();
        draft = null;
        invalid = false;
      }
    }}
  />
</div>

<style>
  .hex {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  label {
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  input {
    width: 100%;
    height: var(--control-sm);
    padding: 0 var(--space-2);
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    outline: none;
  }
  input:focus {
    border-color: var(--accent);
    box-shadow: inset 0 -1px 0 var(--accent);
  }
  .invalid input {
    border-color: var(--danger);
    box-shadow: inset 0 -1px 0 var(--danger);
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
