<!--
  Primary / secondary colour chips at the bottom of the tool rail, with
  swap (X) and reset to black/white (D). Clicking a chip opens a compact
  colour picker; picked colours join the recent colours when it closes.
-->
<script lang="ts">
  import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
  import { toHex, type Rgba } from '$engine/index';
  import { MAX_RECENT_COLORS } from '$lib/settings/defaults';
  import { settings, updateSettings } from '$lib/settings/store.svelte';
  import Popover from '$lib/ui/Popover.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import Tooltip from '$lib/ui/Tooltip.svelte';
  import { getSession } from '../state/context';
  import { hexOf, pushRecent } from './color-picker';
  import { colorPicker } from './lazy.svelte';

  const session = getSession();
  const engine = session.engine;

  type Which = 'primary' | 'secondary';

  const colors = $derived.by(() => {
    void session.rev.color;
    return { primary: engine.primary, secondary: engine.secondary };
  });

  let editing = $state<Which | null>(null);
  let anchors: Record<Which, HTMLButtonElement | undefined> = $state({ primary: undefined, secondary: undefined });
  let openedWith = '';

  const css = (c: Rgba) => toHex(c, 'auto');
  const NAMES: Record<Which, string> = { primary: 'Primary colour', secondary: 'Secondary colour' };

  function open(which: Which): void {
    colorPicker.preload();
    if (editing === which) {
      close();
      return;
    }
    editing = which;
    openedWith = hexOf(colors[which]);
  }

  function close(): void {
    const which = editing;
    editing = null;
    if (!which) return;
    const hex = hexOf(engine[which]);
    if (hex === openedWith) return;
    const next = pushRecent(settings().recentColors, hex, MAX_RECENT_COLORS);
    updateSettings({ recentColors: next }).catch((e: unknown) => console.warn('could not save recent colours', e));
  }
</script>

<div class="chips" role="group" aria-label="Colours" onpointerenter={() => colorPicker.preload()} onfocusin={() => colorPicker.preload()}>
  <div class="pair">
    {#each ['secondary', 'primary'] as const as which (which)}
      <Tooltip text="{NAMES[which]} {css(colors[which])}" placement="right" describe={false}>
        <button
          bind:this={anchors[which]}
          type="button"
          class="swatch {which}"
          aria-label="{NAMES[which]} {css(colors[which])}"
          aria-haspopup="dialog"
          aria-expanded={editing === which}
          data-testid="color-{which}"
          onclick={() => open(which)}
        >
          <span style:background={css(colors[which])}></span>
        </button>
      </Tooltip>
    {/each}
  </div>
  <div class="actions">
    <Tooltip text="Swap colours" shortcut="X" placement="right">
      <button type="button" class="mini" aria-label="Swap colours" onclick={() => engine.swapColors()}>
        <ArrowLeftRight size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </Tooltip>
    <Tooltip text="Default colours" shortcut="D" placement="right">
      <button type="button" class="mini reset" aria-label="Default colours (black and white)" onclick={() => engine.resetColors()}>
        <span class="bw" aria-hidden="true"></span>
      </button>
    </Tooltip>
  </div>
</div>

{#each ['primary', 'secondary'] as const as which (which)}
  <Popover
    open={editing === which}
    anchor={anchors[which]}
    label={NAMES[which]}
    placement="right-end"
    offset={10}
    initialFocus="first"
    onclose={close}
  >
    {#if colorPicker.current}
      {@const Picker = colorPicker.current}
      <Picker color={colors[which]} label={NAMES[which]} onchange={(c) => engine.setColor(which, c)} />
    {:else}
      <div class="loading"><Spinner size={18} label="Loading the colour picker" /></div>
    {/if}
  </Popover>
{/each}

<style>
  .chips {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .pair {
    position: relative;
    width: 40px;
    height: 40px;
  }
  .swatch {
    position: absolute;
    display: grid;
    width: 26px;
    height: 26px;
    padding: 0;
    overflow: hidden;
    border: 2px solid var(--surface-1);
    border-radius: var(--radius-sm);
    background: var(--checker);
    box-shadow:
      0 0 0 1px rgb(var(--text-rgb) / 0.18),
      var(--shadow-1);
    cursor: default;
    transition: transform var(--dur-1) var(--ease-standard);
  }
  .swatch > span {
    display: block;
  }
  .swatch:hover {
    transform: scale(1.06);
  }
  .swatch:active {
    transform: scale(0.96);
  }
  .swatch:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
    z-index: 2;
  }
  .swatch.primary {
    top: 0;
    left: 0;
    z-index: 1;
  }
  .swatch.secondary {
    right: 0;
    bottom: 0;
  }
  .swatch[aria-expanded='true'] {
    box-shadow:
      0 0 0 2px var(--accent),
      var(--shadow-1);
  }

  .loading {
    display: grid;
    place-items: center;
    width: 216px;
    height: 240px;
    color: var(--text-3);
  }
  .actions {
    display: flex;
    gap: 2px;
  }
  .mini {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--text-3);
    cursor: default;
    transition:
      background-color var(--fade-1) linear,
      color var(--fade-1) linear;
  }
  .mini:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .mini:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .bw {
    position: relative;
    width: 12px;
    height: 12px;
  }
  .bw::before,
  .bw::after {
    content: '';
    position: absolute;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    box-shadow: 0 0 0 1px rgb(var(--text-rgb) / 0.35);
  }
  .bw::before {
    right: 0;
    bottom: 0;
    background: #fff;
  }
  .bw::after {
    top: 0;
    left: 0;
    background: #000;
  }
</style>
