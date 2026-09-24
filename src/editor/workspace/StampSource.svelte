<!--
  The stamp tool's image in the options bar: a thumbnail of the chosen
  sticker (or "No sticker") and "Choose sticker…", which opens the
  Stickers panel of the sidebar.
-->
<script lang="ts">
  import Sticker from '@lucide/svelte/icons/sticker';
  import type { Surface } from '$engine/index';
  import Tooltip from '$lib/ui/Tooltip.svelte';
  import { getSession } from '../state/context';

  interface Props {
    stamp: Surface | null;
  }

  let { stamp }: Props = $props();

  const session = getSession();
  /** Thumbnail size, CSS px. */
  const THUMB = 24;
  /** The sticker itself: the thumbnail redraws when it changes, not with every stamp option. */
  const sticker = $derived(stamp);

  /** Draws the stamp fitted into the thumbnail at the device pixel ratio. */
  function thumbnail(image: Surface) {
    return (canvas: HTMLCanvasElement) => {
      const dpr = window.devicePixelRatio || 1;
      const size = Math.round(THUMB * dpr);
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const source = new OffscreenCanvas(image.width, image.height);
      source.getContext('2d')?.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
      const k = size / Math.max(image.width, image.height);
      const w = image.width * k;
      const h = image.height * k;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, (size - w) / 2, (size - h) / 2, w, h);
    };
  }
</script>

<div class="source" data-testid="stamp-source">
  {#if sticker}
    <span class="thumb" role="img" aria-label="Current sticker">
      <canvas aria-hidden="true" {@attach thumbnail(sticker)}></canvas>
    </span>
  {:else}
    <span class="none">No sticker</span>
  {/if}
  <Tooltip text="Choose sticker…" placement="bottom">
    <button type="button" class="choose" aria-label="Choose sticker…" onclick={() => (session.sidebarTab = 'stickers')}>
      <Sticker size={16} strokeWidth={1.75} aria-hidden="true" />
      <span class="text">Choose sticker…</span>
    </button>
  </Tooltip>
</div>

<style>
  .source {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
  }
  .thumb {
    display: grid;
    flex: none;
    width: 24px;
    height: 24px;
    overflow: hidden;
    border-radius: var(--radius-xs);
    background: var(--surface-sunken);
    box-shadow: inset 0 0 0 1px var(--border-subtle);
  }
  .thumb canvas {
    width: 100%;
    height: 100%;
  }
  .none {
    color: var(--text-3);
    font-size: var(--text-sm);
    white-space: nowrap;
  }
  .choose {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-1-5);
    height: var(--control-sm);
    padding: 0 var(--space-2);
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    box-shadow: var(--inset-highlight);
    cursor: default;
  }
  .choose:hover {
    background: var(--control-fill-hover);
  }
  .choose:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  /* Narrow bars keep the icon; the button keeps its name. */
  @container (max-width: 700px) {
    .text {
      display: none;
    }
  }
</style>
