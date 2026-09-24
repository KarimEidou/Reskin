<!--
  A labelled colour control: a swatch button that opens a popover with the
  HSV picker, a hex field and the recent colours. Values are CSS colour
  strings (`#rrggbb` / `#rrggbbaa`), as filter params and backdrop specs use.
    <ColorField label="Shadow colour" value={hex} onchange={(v) => …} />
-->
<script lang="ts">
  import { parseColor, type Rgba } from '$engine/index';
  import { settings } from '$lib/settings/store.svelte';
  import ColorSwatch from '$lib/ui/ColorSwatch.svelte';
  import Popover from '$lib/ui/Popover.svelte';
  import { hexOf, rememberColor } from '../common/color';
  import { onSliderPress } from '../common/seal';
  import HexInput from './HexInput.svelte';
  import HsvPicker from './HsvPicker.svelte';

  interface Props {
    value: string;
    label: string;
    /** Show the label next to the swatch (otherwise only as its name). */
    showLabel?: boolean;
    alpha?: boolean;
    disabled?: boolean;
    /** While picking. */
    oninput?: (hex: string) => void;
    /** Committed. */
    onchange?: (hex: string) => void;
    /** A new pointer drag begins in the picker (e.g. to start a new undo step). */
    onstart?: () => void;
  }

  let { value, label, showLabel = true, alpha = true, disabled = false, oninput, onchange, onstart }: Props = $props();

  let open = $state(false);
  let anchor: HTMLButtonElement | undefined = $state();
  const rgba = $derived<Rgba>(parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 });
  const recent = $derived(settings().recentColors.slice(0, 8));

  function input(c: Rgba): void {
    oninput?.(hexOf(alpha ? c : { ...c, a: 1 }));
  }

  function commit(c: Rgba): void {
    const hex = hexOf(alpha ? c : { ...c, a: 1 });
    oninput?.(hex);
    onchange?.(hex);
    rememberColor(hex);
  }
</script>

<div class="field" class:disabled>
  <button
    bind:this={anchor}
    type="button"
    class="trigger"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="{label}: {value}"
    {disabled}
    onclick={() => (open = !open)}
  >
    <span class="chip" style:--c={value} aria-hidden="true"></span>
    {#if showLabel}<span class="text">{label}</span>{/if}
    <span class="value">{hexOf(rgba).toUpperCase()}</span>
  </button>
</div>

<Popover bind:open {anchor} label={label} placement="bottom-start" width="240px" initialFocus="first">
  <div class="pop" {@attach onSliderPress(() => onstart?.())}>
    <HsvPicker value={rgba} {alpha} {label} oninput={input} onchange={commit} />
    <HexInput value={rgba} {alpha} label="Hex" hideLabel onchange={commit} />
    {#if recent.length > 0}
      <div class="recent" role="group" aria-label="Recent colours">
        {#each recent as c (c)}
          <ColorSwatch color={c} size="sm" label="Use {c}" onclick={() => commit(parseColor(c)!)} />
        {/each}
      </div>
    {/if}
  </div>
</Popover>

<style>
  .field {
    min-width: 0;
  }
  .disabled {
    opacity: 0.5;
  }
  .trigger {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    height: var(--control-sm);
    padding: 0 var(--space-2) 0 3px;
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text);
    font-size: var(--text-sm);
    cursor: default;
    transition: background-color var(--fade-1) linear;
  }
  .trigger:hover:not(:disabled) {
    background: var(--control-fill-hover);
  }
  .trigger[aria-expanded='true'] {
    border-color: var(--accent);
  }
  .chip {
    flex: none;
    width: 20px;
    height: 18px;
    border-radius: 4px;
    background:
      linear-gradient(var(--c), var(--c)),
      repeating-conic-gradient(#c8cbd2 0 25%, #fff 0 50%) 0 0 / 8px 8px;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.18);
  }
  .text {
    flex: 1;
    overflow: hidden;
    color: var(--text-2);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value {
    margin-left: auto;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .pop {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .recent {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
</style>
